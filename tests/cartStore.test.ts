import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import { useToastStore } from '../src/renderer/src/stores/toastStore.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'
import type { CheckoutReceipt, FiscalResendResult } from '../src/main/services/database.js'

/**
 * Factory that produces a valid CartItem-minus-quantity with
 * overridable fields, for concise test setup.
 */
const makeItem = (overrides: Partial<CartItem> = {}): CartItem => ({
  id: 'variant-1',
  productId: 'product-1',
  title: 'Test Product',
  variantTitle: 'Small / Red',
  price: 10.5,
  quantity: 1,
  image: 'https://example.com/img.jpg',
  ...overrides
})

/**
 * Factory for a CartItem sans quantity — used to test addItem
 * which accepts Omit<CartItem, 'quantity'>.
 */
const makeItemInput = (
  overrides: Partial<CartItem> = {}
): Omit<CartItem, 'quantity'> => {
  const full = makeItem(overrides)
  return { id: full.id, productId: full.productId, title: full.title, variantTitle: full.variantTitle, price: full.price, image: full.image }
}

describe('Cart Store', () => {
  beforeEach(() => {
    useCartStore.setState({ items: [] })
  })

  it('starts empty', () => {
    const { items } = useCartStore.getState()
    expect(items).toHaveLength(0)
  })

  it('addItem adds a new line item with default quantity of 1', () => {
    useCartStore.getState().addItem(makeItemInput())
    const { items } = useCartStore.getState()
    expect(items).toHaveLength(1)
    expect(items[0].quantity).toBe(1)
  })

  it('addItem merges quantity for duplicate variant ids', () => {
    useCartStore.getState().addItem(makeItemInput(), 1)
    useCartStore.getState().addItem(makeItemInput(), 1)
    useCartStore.getState().addItem(makeItemInput(), 1)
    const { items } = useCartStore.getState()
    expect(items).toHaveLength(1)
    expect(items[0].quantity).toBe(3)
  })

  it('addItem accepts an explicit quantity > 1', () => {
    useCartStore.getState().addItem(makeItemInput(), 5)
    const { items } = useCartStore.getState()
    expect(items[0].quantity).toBe(5)
  })

  it('removeItem deletes the line by variant id', () => {
    useCartStore
      .getState()
      .addItem(makeItemInput({ id: 'v1' }), 2)
    useCartStore.getState().addItem(makeItemInput({ id: 'v2' }), 1)

    useCartStore.getState().removeItem('v1')

    expect(useCartStore.getState().items).toHaveLength(1)
    expect(useCartStore.getState().items[0].id).toBe('v2')
  })

  it('updateQuantity sets the new quantity value', () => {
    useCartStore.getState().addItem(makeItemInput(), 1)
    useCartStore.getState().updateQuantity('variant-1', 5)
    expect(useCartStore.getState().items[0].quantity).toBe(5)
  })

  it('updateQuantity with 0 removes the item entirely', () => {
    useCartStore.getState().addItem(makeItemInput(), 2)
    useCartStore.getState().updateQuantity('variant-1', 0)
    expect(useCartStore.getState().items).toHaveLength(0)
  })

  it('getTotal sums price * quantity across all items', () => {
    useCartStore
      .getState()
      .addItem(makeItemInput({ id: 'v1', price: 10.5 }), 1)
    useCartStore
      .getState()
      .addItem(makeItemInput({ id: 'v2', price: 25 }), 2)

    const total = useCartStore.getState().getTotal()
    expect(total).toBe(10.5 + 25 * 2)
  })

  it('getItemCount returns the sum of all quantities', () => {
    useCartStore
      .getState()
      .addItem(makeItemInput({ id: 'v1' }), 2)
    useCartStore
      .getState()
      .addItem(makeItemInput({ id: 'v2' }), 3)
    useCartStore
      .getState()
      .addItem(makeItemInput({ id: 'v3' }), 5)

    expect(useCartStore.getState().getItemCount()).toBe(10)
  })

  it('clearCart empties all items and resets totals', () => {
    useCartStore.getState().addItem(makeItemInput(), 1)
    useCartStore.getState().addItem(makeItemInput({ id: 'v2' }), 3)
    useCartStore
      .getState()
      .clearCart()

    const { items, getTotal, getItemCount } = useCartStore.getState()
    expect(items).toHaveLength(0)
    expect(getTotal()).toBe(0)
    expect(getItemCount()).toBe(0)
  })
})

/** A minimal, valid CheckoutReceipt — overridable for each scenario. */
function makeReceipt(overrides: Partial<CheckoutReceipt> = {}): CheckoutReceipt {
  return {
    localId: 42,
    mode: 'synced',
    fiscalStatus: 'fiscalized',
    fiscalErrorReason: null,
    fiscalErrorKind: null,
    fiscalDataIssue: null,
    fiscal: { invoiceNumber: 'KRA-0001', qrCode: 'base64qr' },
    ...overrides
  }
}

const CHECKOUT_PARAMS = {
  staffId: 1,
  paymentMethod: 'cash' as const,
  tenderedAmount: 100,
  changeDue: 0
}

/** Lets the fire-and-forget automatic print's own promise chain settle before assertions. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('Cart Store — automatic receipt print (docs/phase-165)', () => {
  beforeEach(() => {
    useCartStore.setState({ items: [], checkoutStatus: 'idle', checkoutError: null, lastReceipt: null })
    useToastStore.setState({ toasts: [] })
  })

  it.each(['cash', 'mpesa'] as const)(
    'prints exactly once per checkout, %s included',
    async (paymentMethod) => {
      const printReceipt = vi.fn().mockResolvedValue({ success: true, data: { printed: true, mock: false } })
      window.api = {
        checkout: vi.fn().mockResolvedValue({ success: true, data: makeReceipt() }),
        printReceipt
      } as unknown as typeof window.api

      useCartStore.getState().addItem(makeItemInput())
      await useCartStore.getState().checkout({ ...CHECKOUT_PARAMS, paymentMethod })

      expect(printReceipt).toHaveBeenCalledTimes(1)
      expect(printReceipt).toHaveBeenCalledWith(42, { auto: true })
    }
  )

  it('never prints merely from lastReceipt being set — there is no watcher, only checkout() itself calls it', () => {
    const printReceipt = vi.fn()
    window.api = { printReceipt } as unknown as typeof window.api

    // Simulates what a restored/rehydrated lastReceipt would look like —
    // this store never actually persists it (see partialize), so this
    // can't happen via a real app restart, but the point stands either
    // way: setting the field alone must never trigger a print.
    useCartStore.setState({ lastReceipt: makeReceipt() })

    expect(printReceipt).not.toHaveBeenCalled()
  })

  it('never prints again on a same-visit fiscal resend (applyFiscalResendResult)', () => {
    const printReceipt = vi.fn()
    window.api = { printReceipt } as unknown as typeof window.api
    useCartStore.setState({ lastReceipt: makeReceipt({ fiscalStatus: 'needs_fixing' }) })

    const resendResult: FiscalResendResult = {
      localId: 42,
      fiscal: { invoiceNumber: 'KRA-0002', qrCode: 'base64qr' },
      fiscalStatus: 'fiscalized',
      fiscalErrorReason: null,
      fiscalErrorKind: null,
      fiscalDataIssue: null
    }
    useCartStore.getState().applyFiscalResendResult(resendResult)

    expect(printReceipt).not.toHaveBeenCalled()
  })

  it('a print that throws never changes checkoutStatus, never leaves the cart non-empty, never surfaces as checkoutError', async () => {
    const printReceipt = vi.fn().mockRejectedValue(new Error('printer exploded'))
    window.api = {
      checkout: vi.fn().mockResolvedValue({ success: true, data: makeReceipt() }),
      printReceipt
    } as unknown as typeof window.api

    useCartStore.getState().addItem(makeItemInput())
    await useCartStore.getState().checkout(CHECKOUT_PARAMS)

    // Already true synchronously, before the print promise even settles —
    // the sale's own state is never made to depend on the print outcome.
    expect(useCartStore.getState().checkoutStatus).toBe('synced')
    expect(useCartStore.getState().items).toHaveLength(0)
    expect(useCartStore.getState().checkoutError).toBeNull()

    await flushMicrotasks()

    // Still true once the rejected print promise has actually settled.
    expect(useCartStore.getState().checkoutStatus).toBe('synced')
    expect(useCartStore.getState().checkoutError).toBeNull()
  })

  it('shows one "printer offline" toast when the automatic print falls back to a PDF', async () => {
    const printReceipt = vi.fn().mockResolvedValue({
      success: true,
      data: { printed: false, mock: false, mode: 'pdf', filePath: 'C:\\Desktop\\r.pdf' }
    })
    window.api = {
      checkout: vi.fn().mockResolvedValue({ success: true, data: makeReceipt() }),
      printReceipt
    } as unknown as typeof window.api

    useCartStore.getState().addItem(makeItemInput())
    await useCartStore.getState().checkout(CHECKOUT_PARAMS)
    await flushMicrotasks()

    const toasts = useToastStore.getState().toasts
    expect(toasts.some((t) => t.message.includes('Printer offline'))).toBe(true)
  })

  it('shows the failure toast when the automatic print rejects outright, while the sale stays complete (docs/phase-166 Commit 0)', async () => {
    const printReceipt = vi.fn().mockRejectedValue(new Error('printer exploded'))
    window.api = {
      checkout: vi.fn().mockResolvedValue({ success: true, data: makeReceipt() }),
      printReceipt
    } as unknown as typeof window.api

    useCartStore.getState().addItem(makeItemInput())
    await useCartStore.getState().checkout(CHECKOUT_PARAMS)

    expect(useCartStore.getState().checkoutStatus).toBe('synced')
    expect(useCartStore.getState().checkoutError).toBeNull()

    await flushMicrotasks()

    expect(useCartStore.getState().checkoutStatus).toBe('synced')
    expect(useCartStore.getState().checkoutError).toBeNull()
    const toasts = useToastStore.getState().toasts
    expect(toasts.some((t) => t.message.includes('Receipt did not print'))).toBe(true)
  })

  it('shows no toast when the automatic print succeeds physically', async () => {
    const printReceipt = vi.fn().mockResolvedValue({ success: true, data: { printed: true, mock: false } })
    window.api = {
      checkout: vi.fn().mockResolvedValue({ success: true, data: makeReceipt() }),
      printReceipt
    } as unknown as typeof window.api

    useCartStore.getState().addItem(makeItemInput())
    await useCartStore.getState().checkout(CHECKOUT_PARAMS)
    await flushMicrotasks()

    expect(useToastStore.getState().toasts).toHaveLength(0)
  })
})
