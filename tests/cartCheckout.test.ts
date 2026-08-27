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

  it('persists items to localStorage under the rubis-pos-cart key', () => {
    useCartStore.getState().addItem(itemInput())

    const stored = JSON.parse(
      localStorage.getItem('rubis-pos-cart') ?? '{}'
    ) as { state?: { items?: CartItem[] } }
    expect(stored.state?.items).toHaveLength(1)
    expect(stored.state?.items?.[0].title).toBe('RUBIS Mug')
  })
})
