/**
 * Cart checkout flow tests.
 *
 * `window.api.checkout` is stubbed per-test; the real SQLite layer is
 * never touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import type { CheckoutParams } from '../src/renderer/src/stores/cartStore.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const checkoutParams: CheckoutParams = {
  staffId: 1,
  paymentMethod: 'cash',
  tenderedAmount: 20,
  changeDue: 7.5
}

const sampleItem = (overrides: Partial<CartItem> = {}): CartItem => ({
  id: 'gid://shopify/ProductVariant/201',
  productId: '101',
  title: 'RUBIS Mug',
  variantTitle: 'Small',
  price: 12.5,
  quantity: 1,
  image: 'https://cdn.example/mug.jpg',
  ...overrides
})

const itemInput = (overrides: Partial<CartItem> = {}) => {
  const full = sampleItem(overrides)
  return {
    id: full.id,
    productId: full.productId,
    title: full.title,
    variantTitle: full.variantTitle,
    price: full.price,
    image: full.image
  }
}

describe('cart store checkout', () => {
  beforeEach(() => {
    localStorage.clear()
    useCartStore.setState({
      items: [],
      cartDiscount: null,
      checkoutStatus: 'idle',
      lastReceipt: null,
      checkoutError: null
    })
    window.api = {
      ping: vi.fn(),
      getAppVersion: vi.fn(),
      openExternal: vi.fn(),
      fetchProducts: vi.fn(),
      getCachedProducts: vi.fn(),
      getNetworkStatus: vi.fn(),
      onNetworkStatus: vi.fn(() => () => undefined),
      checkout: vi.fn()
    } as unknown as typeof window.api
  })

  it('does nothing when the cart is empty', async () => {
    await useCartStore.getState().checkout(checkoutParams)

    expect(window.api.checkout).not.toHaveBeenCalled()
    expect(useCartStore.getState().checkoutStatus).toBe('idle')
  })

  it('submits items and total to the main process', async () => {
    const checkout = window.api.checkout as unknown as ReturnType<typeof vi.fn>
    checkout.mockResolvedValue({
      success: true,
      data: { localId: 1, mode: 'synced', shopifyOrderId: 'gid://shopify/Order/9' }
    })
    useCartStore.getState().addItem(itemInput())

    await useCartStore.getState().checkout(checkoutParams)

    expect(checkout).toHaveBeenCalledTimes(1)
    const request = checkout.mock.calls[0][0]
    expect(request.items).toHaveLength(1)
    expect(request.total).toBe(12.5)
  })

  it('submits an M-Pesa manual-code checkout with the verified reference number', async () => {
    const checkout = window.api.checkout as unknown as ReturnType<typeof vi.fn>
    checkout.mockResolvedValue({
      success: true,
      data: { localId: 3, mode: 'synced', shopifyOrderId: 'gid://shopify/Order/11' }
    })
    useCartStore.getState().addItem(itemInput())

    await useCartStore.getState().checkout({
      staffId: 1,
      paymentMethod: 'mpesa',
      tenderedAmount: 12.5,
      changeDue: 0,
      referenceNumber: 'QDF73H'
    })

    const request = checkout.mock.calls[0][0]
    expect(request.paymentMethod).toBe('mpesa')
    expect(request.referenceNumber).toBe('QDF73H')
  })

  it('includes the cart-level discount set via setCartDiscount in the checkout request', async () => {
    const checkout = window.api.checkout as unknown as ReturnType<typeof vi.fn>
    checkout.mockResolvedValue({
      success: true,
      data: { localId: 4, mode: 'synced' }
    })
    useCartStore.getState().addItem(itemInput({ price: 100 }))
    useCartStore.getState().setCartDiscount({ type: 'percent', value: 10 })

    await useCartStore.getState().checkout(checkoutParams)

    const request = checkout.mock.calls[0][0]
    expect(request.cartDiscount).toEqual({ type: 'percent', value: 10 })
    expect(request.total).toBe(90)
  })

  it('clears the cart and stores the receipt when synced', async () => {
    const checkout = window.api.checkout as unknown as ReturnType<typeof vi.fn>
    checkout.mockResolvedValue({
      success: true,
      data: { localId: 1, mode: 'synced', shopifyOrderId: 'gid://shopify/Order/9' }
    })
    useCartStore.getState().addItem(itemInput())

    await useCartStore.getState().checkout(checkoutParams)

    const state = useCartStore.getState()
    expect(state.items).toHaveLength(0)
    expect(state.checkoutStatus).toBe('synced')
    expect(state.lastReceipt?.shopifyOrderId).toBe('gid://shopify/Order/9')
  })

  it('marks queued-offline and clears the cart when sync is deferred', async () => {
    const checkout = window.api.checkout as unknown as ReturnType<typeof vi.fn>
    checkout.mockResolvedValue({
      success: true,
      data: { localId: 2, mode: 'queued-offline' }
    })
    useCartStore.getState().addItem(itemInput())

    await useCartStore.getState().checkout(checkoutParams)

    const state = useCartStore.getState()
    expect(state.items).toHaveLength(0)
    expect(state.checkoutStatus).toBe('queued-offline')
    expect(state.lastReceipt?.mode).toBe('queued-offline')
  })

  it('keeps the cart intact when the service reports a failure', async () => {
    const checkout = window.api.checkout as unknown as ReturnType<typeof vi.fn>
    checkout.mockResolvedValue({ success: false, error: 'Disk full' })
    useCartStore.getState().addItem(itemInput())

    await useCartStore.getState().checkout(checkoutParams)

    const state = useCartStore.getState()
    expect(state.items).toHaveLength(1)
    expect(state.checkoutStatus).toBe('error')
    expect(state.checkoutError).toBe('Disk full')
  })

  it('handles bridge exceptions with an error status', async () => {
    const checkout = window.api.checkout as unknown as ReturnType<typeof vi.fn>
    checkout.mockRejectedValue(new Error('bridge down'))
    useCartStore.getState().addItem(itemInput())

    await useCartStore.getState().checkout(checkoutParams)

    const state = useCartStore.getState()
    expect(state.checkoutStatus).toBe('error')
    expect(state.checkoutError).toBe('bridge down')
    expect(state.items).toHaveLength(1)
  })

  /**
   * phase-78, Rule 4: a fiscal outcome that needs attention (queued or
   * flagged) must never block the till. The cart clears and
   * `checkoutStatus` still resolves to a startable state exactly as it
   * does for a clean success — the sale is done, and the next one can
   * begin immediately; the fiscal notice is a separate, non-blocking
   * overlay (`FiscalNotice.tsx`) driven off `lastReceipt`, not off
   * `checkoutStatus`.
   */
  it('clears the cart and stays startable even when the sale needs fixing (fiscal outcome never blocks the till)', async () => {
    const checkout = window.api.checkout as unknown as ReturnType<typeof vi.fn>
    checkout.mockResolvedValue({
      success: true,
      data: {
        localId: 5,
        mode: 'queued-offline',
        fiscalStatus: 'needs_fixing',
        fiscalErrorReason: 'Wrong client PIN',
        fiscalErrorKind: 'data',
        fiscalDataIssue: 'wrong-pin'
      }
    })
    useCartStore.getState().addItem(itemInput())

    await useCartStore.getState().checkout(checkoutParams)

    const state = useCartStore.getState()
    // Cart is empty and ready for the next sale...
    expect(state.items).toHaveLength(0)
    // ...checkoutStatus resolved to a normal terminal state, not stuck
    // "submitting" or blocked on the fiscal outcome...
    expect(state.checkoutStatus).toBe('queued-offline')
    // ...and the fiscal detail is available for the (separate) notice.
    expect(state.lastReceipt?.fiscalStatus).toBe('needs_fixing')

    // A second sale can start immediately — checkout is callable again
    // right away, with no gate on the previous sale's fiscal outcome.
    checkout.mockResolvedValue({ success: true, data: { localId: 6, mode: 'synced' } })
    useCartStore.getState().addItem(itemInput())
    await useCartStore.getState().checkout(checkoutParams)
    expect(checkout).toHaveBeenCalledTimes(2)
    expect(useCartStore.getState().checkoutStatus).toBe('synced')
  })

  it('no longer writes the cart to localStorage: the SQLite cart draft replaces it (docs/phase-197)', () => {
    useCartStore.getState().addItem(itemInput())

    expect(localStorage.getItem('rubis-pos-cart')).toBeNull()
    expect(useCartStore.getState().items).toHaveLength(1)
  })
})

describe('cart store applyFiscalResendResult (phase-78, Part C)', () => {
  beforeEach(() => {
    useCartStore.setState({
      items: [],
      cartDiscount: null,
      checkoutStatus: 'idle',
      lastReceipt: {
        localId: 7,
        mode: 'queued-offline',
        fiscalStatus: 'needs_fixing',
        fiscalErrorReason: 'Wrong client PIN',
        fiscalErrorKind: 'data',
        fiscalDataIssue: 'wrong-pin'
      },
      checkoutError: null
    })
  })

  it('merges a successful resend into lastReceipt, leaving mode/localId untouched', () => {
    useCartStore.getState().applyFiscalResendResult({
      localId: 7,
      fiscal: { invoiceNumber: 'KRA-FIXED', qrCode: 'base64qr' },
      fiscalStatus: 'fiscalized',
      fiscalErrorReason: null,
      fiscalErrorKind: null,
      fiscalDataIssue: null
    })

    const receipt = useCartStore.getState().lastReceipt
    expect(receipt?.fiscalStatus).toBe('fiscalized')
    expect(receipt?.fiscal).toEqual({ invoiceNumber: 'KRA-FIXED', qrCode: 'base64qr' })
    expect(receipt?.fiscalErrorReason).toBeNull()
    // Untouched by the merge:
    expect(receipt?.localId).toBe(7)
    expect(receipt?.mode).toBe('queued-offline')
  })

  it('is a no-op when lastReceipt has since moved on to a different sale', () => {
    useCartStore.getState().applyFiscalResendResult({
      localId: 999, // a different, stale sale
      fiscal: { invoiceNumber: 'KRA-STALE', qrCode: '' },
      fiscalStatus: 'fiscalized',
      fiscalErrorReason: null,
      fiscalErrorKind: null,
      fiscalDataIssue: null
    })

    const receipt = useCartStore.getState().lastReceipt
    expect(receipt?.localId).toBe(7)
    expect(receipt?.fiscalStatus).toBe('needs_fixing')
  })

  it('is a no-op when there is no lastReceipt at all', () => {
    useCartStore.setState({ lastReceipt: null })

    useCartStore.getState().applyFiscalResendResult({
      localId: 7,
      fiscal: undefined,
      fiscalStatus: 'fiscalized',
      fiscalErrorReason: null,
      fiscalErrorKind: null,
      fiscalDataIssue: null
    })

    expect(useCartStore.getState().lastReceipt).toBeNull()
  })
})
