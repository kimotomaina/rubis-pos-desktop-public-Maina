/**
 * Zustand cart store with offline support.
 *
 * The in-memory cart, upgraded with:
 *   - `persist` middleware: items survive renderer restarts via
 *     localStorage (key: `rubis-pos-cart`).
 *   - `checkout()`: submits the cart through the IPC bridge.  The main
 *     process decides whether the sale synced immediately or queued
 *     offline, and the store reflects the outcome for UI banners.
 *
 * The `create<CartState>()(persist(...))` curried signature is required
 * for TypeScript inference with Zustand v5 middleware.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CartItem, Discount } from '../types/shopify.js'
import type { CheckoutReceipt, PaymentMethod } from '../../../main/services/database.js'
import { calculateCartTotal, calculateSubtotal, validatePriceOverride } from '../lib/checkoutMath.js'

/** Lifecycle of the most recent checkout submission. */
export type CheckoutStatus =
  | 'idle'
  | 'submitting'
  | 'synced'
  | 'queued-offline'
  | 'error'

/** Payment details collected by `CheckoutModal` and submitted with the sale. */
export interface CheckoutParams {
  staffId: number
  paymentMethod: PaymentMethod
  tenderedAmount: number
  changeDue: number
  referenceNumber?: string
  /** Cart-level discount to persist with the order. */
  cartDiscount?: Discount
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
}

/**
 * Persistent cart store.  Only `items` are persisted; checkout status
 * is ephemeral per session.
 */
export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],
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
            items: [...state.items, { ...item, quantity: qty, basePrice: item.price }]
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

      clearCart: () => set({ items: [], cartDiscount: null }),

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
          const result = await window.api.checkout({ items, total, ...params, cartDiscount })

          if (result.success && result.data) {
            const receipt = result.data
            set({
              checkoutStatus:
                receipt.mode === 'synced' ? 'synced' : 'queued-offline',
              lastReceipt: receipt
            })
            get().clearCart()
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
      }
    }),
    {
      name: 'rubis-pos-cart',
      partialize: (state) => ({ items: state.items }) as Partial<CartState>
    }
  )
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
