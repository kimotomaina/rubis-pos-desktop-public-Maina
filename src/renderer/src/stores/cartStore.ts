/**
 * Zustand cart store with offline support.
 *
 * The in-memory cart, upgraded with:
 *   - `checkout()`: submits the cart through the IPC bridge.  The main
 *     process decides whether the sale synced immediately or queued
 *     offline, and the store reflects the outcome for UI banners.
 *
 * The cart is no longer persisted by zustand: `cartDraft.ts` saves it to
 * SQLite through the main process instead (docs/phase-197), so a force-kill
 * cannot lose the last edits and an order recorded just before one cannot
 * bring its cart back.
 */

import { create } from 'zustand'
import type { CartItem, Discount } from '../types/shopify.js'
import type {
  CardManualEntry,
  CheckoutReceipt,
  FiscalResendResult,
  ManualMpesaEntry,
  PaymentMethod
} from '../../../main/services/database.js'
import { calculateCartTotal, calculateSubtotal, validatePriceOverride } from '../lib/checkoutMath.js'
import { AUTO_PRINT_FAILURE_MESSAGE, getAutoPrintOfflineMessage } from '../lib/autoPrintToast.js'
import { AUTO_PRINT_OFFLINE_TOAST_TIMEOUT_MS } from '../lib/toastTimeouts.js'
import { useToastStore } from './toastStore.js'

const AUTO_PRINT_OFFLINE_TOAST_ID = 'auto-print-offline'

/** Shows one of the automatic-print toasts, upserted by id (docs/phase-165, docs/phase-166 Commit 0). */
function showAutoPrintToast(message: string): void {
  useToastStore.getState().show({
    id: AUTO_PRINT_OFFLINE_TOAST_ID,
    tone: 'warning',
    message,
    timeoutMs: AUTO_PRINT_OFFLINE_TOAST_TIMEOUT_MS,
    onDismiss: () => useToastStore.getState().dismiss(AUTO_PRINT_OFFLINE_TOAST_ID)
  })
}

/**
 * Fires the automatic end-of-sale print (docs/phase-165, docs/
 * phase-164-1 Part A item 4) — once per checkout, from the ONE place a
 * checkout actually completes, never from a component watching
 * `lastReceipt` (which would also fire on a same-visit fiscal resend, or
 * — if `lastReceipt` were ever persisted, which it deliberately is not,
 * see this store's `partialize` — on an app restart).
 *
 * Deliberately NOT awaited by `checkout()`: a print failure (thrown or
 * `{ success: false }`) must never change `checkoutStatus`, reopen the
 * cart, or delay the next sale. The only visible effect of failure here
 * is a toast (docs/phase-166 Commit 0: a distinct message for an
 * outright failure vs. a PDF fallback) — anything else about the failure
 * is silently ignored.
 *
 * The whole call is wrapped in a `try` — not just a `.catch()` on the
 * returned promise — because calling `window.api.printReceipt` itself
 * can throw SYNCHRONOUSLY (not just return a rejected promise), and a
 * synchronous throw here would otherwise propagate straight into
 * `checkout()`'s own `try` block and stomp its already-set
 * `checkoutStatus` with `'error'`. A `.catch()` alone cannot protect
 * against that — it only ever sees a promise that was successfully
 * returned in the first place.
 *
 * @param {number} localId
 */
function triggerAutomaticPrint(localId: number): void {
  try {
    window.api
      .printReceipt(localId, { auto: true })
      .then((result) => {
        const message = getAutoPrintOfflineMessage(result)
        if (message) showAutoPrintToast(message)
      })
      .catch(() => {
        // The IPC call rejected — treat it the same as any other
        // outright failure. checkoutStatus is never touched here; see
        // this function's own doc comment.
        showAutoPrintToast(AUTO_PRINT_FAILURE_MESSAGE)
      })
  } catch {
    // A synchronous throw from the call itself — see this function's own
    // doc comment on why this can't be caught by `.catch()` alone.
    showAutoPrintToast(AUTO_PRINT_FAILURE_MESSAGE)
  }
}

/** Lifecycle of the most recent checkout submission. */
export type CheckoutStatus =
  | 'idle'
  | 'submitting'
  | 'synced'
  | 'queued-offline'
  | 'error'

/** Payment details collected by `PosCheckoutPanel` and submitted with the sale. */
export interface CheckoutParams {
  staffId: number
  paymentMethod: PaymentMethod
  tenderedAmount: number
  changeDue: number
  referenceNumber?: string
  /** Customer's KRA PIN, when captured for a B2B eTIMS invoice — omitted for a walk-in B2C sale. */
  customerPin?: string
  /** Customer's company/trading name, when captured for a B2B eTIMS invoice. */
  companyName?: string
  /** Cart-level discount to persist with the order. */
  cartDiscount?: Discount
  /**
   * Present only when this M-Pesa sale is being completed on a manually
   * entered code nobody confirmed. No manager credentials travel with it
   * (docs/phase-150.md step 3) — the main process establishes the
   * cashier from the authenticated session and needs no PIN to allow the
   * sale through.
   */
  mpesaManual?: ManualMpesaEntry
  /**
   * Present only when this sale is a card (PDQ) tender, recorded
   * manually the same way as `mpesaManual` above (docs/phase-176.md
   * Part 2) — no manager credentials travel with it; the main process
   * establishes the cashier from the authenticated session.
   */
  cardManual?: CardManualEntry
}

/**
 * The public contract of the cart store.
 */
export interface CartState {
  /** Line items currently in the cart. */
  items: CartItem[]
  /** Cart-level discount, applied on top of the discounted line subtotal. */
  cartDiscount: Discount | null
  /** Status of the last (or in-flight) checkout. */
  checkoutStatus: CheckoutStatus
  /** Receipt from the last successful/queued checkout. */
  lastReceipt: CheckoutReceipt | null
  /** Human-readable reason when checkoutStatus is `error`. */
  checkoutError: string | null
  /**
   * Identifies the cart being built; new whenever the cart goes from empty to
   * non-empty. Ties approved removals and the saved draft to this cart
   * (docs/phase-197).
   */
  cartToken: string | null
  /** Add one unit (or `qty`) of a variant; merges if already present. */
  addItem: (item: Omit<CartItem, 'quantity'>, qty?: number) => void
  /** Remove a line item by its variant id. */
  removeItem: (id: string) => void
  /** Set an explicit quantity; removes the item when `qty <= 0`. */
  updateQuantity: (id: string, qty: number) => void
  /** Overrides a line item's unit price (manager PIN-gated in the UI). */
  setItemPrice: (id: string, price: number) => void
  /** Sets or clears a line item's discount. */
  setItemDiscount: (id: string, discount: Discount | null) => void
  /** Sets or clears the cart-level discount. */
  setCartDiscount: (discount: Discount | null) => void
  /** Drop every item from the cart. */
  clearCart: () => void
  /** Puts a restored cart back (docs/phase-197). */
  restoreCart: (items: CartItem[], cartToken: string) => void
  /** Sum of `price * quantity` across all items, before any discount. */
  getRawSubtotal: () => number
  /** Sum of line totals after line-level discounts, before the cart-level discount. */
  getSubtotal: () => number
  /** Final total: line discounts then the cart-level discount, floored at 0. */
  getTotal: () => number
  /** Total units in the cart (Σ quantity). */
  getItemCount: () => number
  /** Submit the cart to the main process for persistence + sync. */
  checkout: (params: CheckoutParams) => Promise<void>
  /** Clears a terminal `checkoutStatus` back to `idle` once the UI has reacted to it. */
  resetCheckoutStatus: () => void
  /**
   * Merges a manual fiscalization resend's new outcome (phase-78,
   * Part C) into `lastReceipt`, so `FiscalNotice` reflects it — a no-op
   * if `lastReceipt` has since moved on to a different sale.
   */
  applyFiscalResendResult: (result: FiscalResendResult) => void
}

/**
 * Cart store. The saved draft of the cart is written by `cartDraft.ts`;
 * checkout status is ephemeral per session.
 */
export const useCartStore = create<CartState>()(
  (set, get) => ({
    items: [],
    cartToken: null,
    cartDiscount: null,
    checkoutStatus: 'idle',
    lastReceipt: null,
    checkoutError: null,

    addItem: (item, qty = 1) => {
      set((state) => {
        const existing = state.items.find((i) => i.id === item.id)
        if (existing) {
          const updated = state.items.map((i) =>
            i.id === item.id ? { ...i, quantity: i.quantity + qty } : i
          )
          return { items: updated }
        }
        return {
          items: [...state.items, { ...item, quantity: qty, basePrice: item.price }],
          cartToken: state.items.length === 0 || !state.cartToken ? crypto.randomUUID() : state.cartToken
        }
      })
    },

    removeItem: (id: string) => {
      set((state) => ({ items: state.items.filter((i) => i.id !== id) }))
    },

    updateQuantity: (id: string, qty: number) => {
      if (qty <= 0) {
        get().removeItem(id)
        return
      }
      set((state) => ({
        items: state.items.map((i) =>
          i.id === id ? { ...i, quantity: qty } : i
        )
      }))
    },

    setItemPrice: (id: string, price: number) => {
      set((state) => {
        const target = state.items.find((i) => i.id === id)
        if (!target) return state
        const validation = validatePriceOverride(price, target.basePrice ?? target.price)
        if (!validation.valid) return state
        return { items: state.items.map((i) => (i.id === id ? { ...i, price } : i)) }
      })
    },

    setItemDiscount: (id: string, discount: Discount | null) => {
      set((state) => ({
        items: state.items.map((i) =>
          i.id === id ? { ...i, discount: discount ?? undefined } : i
        )
      }))
    },

    setCartDiscount: (discount: Discount | null) => set({ cartDiscount: discount }),

    clearCart: () => set({ items: [], cartToken: null, cartDiscount: null }),

    restoreCart: (items, cartToken) => set({ items, cartToken, cartDiscount: null }),

    getRawSubtotal: () =>
      get().items.reduce((sum, item) => sum + item.price * item.quantity, 0),

    getSubtotal: () => calculateSubtotal(get().items),

    getTotal: () => calculateCartTotal(get().items, get().cartDiscount),

    getItemCount: () =>
      get().items.reduce((sum, item) => sum + item.quantity, 0),

    checkout: async (params) => {
      const { items } = get()
      if (items.length === 0 || get().checkoutStatus === 'submitting') {
        return
      }

      set({ checkoutStatus: 'submitting', checkoutError: null })

      try {
        const total = get().getTotal()
        const cartDiscount = params.cartDiscount ?? get().cartDiscount ?? undefined
        const cartToken = get().cartToken ?? undefined
      const result = await window.api.checkout({ items, total, ...params, cartDiscount, cartToken })

        if (result.success && result.data) {
          const receipt = result.data
          set({
            checkoutStatus:
              receipt.mode === 'synced' ? 'synced' : 'queued-offline',
            lastReceipt: receipt
          })
          get().clearCart()
          // docs/phase-165: fired after the sale is fully recorded
          // above, not awaited — see triggerAutomaticPrint's doc
          // comment for why.
          triggerAutomaticPrint(receipt.localId)
        } else {
          set({
            checkoutStatus: 'error',
            checkoutError: result.error ?? 'Checkout failed'
          })
        }
      } catch (error) {
        set({
          checkoutStatus: 'error',
          checkoutError:
            error instanceof Error ? error.message : 'Checkout failed'
        })
      }
    },

    resetCheckoutStatus: () => set({ checkoutStatus: 'idle', checkoutError: null }),

    applyFiscalResendResult: (result) => {
      set((state) => {
        if (!state.lastReceipt || state.lastReceipt.localId !== result.localId) {
          return state
        }
        return {
          lastReceipt: {
            ...state.lastReceipt,
            fiscal: result.fiscal,
            fiscalStatus: result.fiscalStatus,
            fiscalErrorReason: result.fiscalErrorReason,
            fiscalErrorKind: result.fiscalErrorKind,
            fiscalDataIssue: result.fiscalDataIssue
          }
        }
      })
    }
  }),
)

/**
 * Direct accessor that bypasses React — useful for tests and non-React
 * callers that only need the data, not a subscription.
 */
export const cartStore = {
  get items() {
    return useCartStore.getState().items
  },
  get total() {
    return useCartStore.getState().getTotal()
  },
  get count() {
    return useCartStore.getState().getItemCount()
  },
  add: (item: Omit<CartItem, 'quantity'>, qty?: number) =>
    useCartStore.getState().addItem(item, qty),
  remove: (id: string) => useCartStore.getState().removeItem(id),
  setQuantity: (id: string, qty: number) =>
    useCartStore.getState().updateQuantity(id, qty),
  clear: () => useCartStore.getState().clearCart(),
  checkout: (params: CheckoutParams) => useCartStore.getState().checkout(params)
}
