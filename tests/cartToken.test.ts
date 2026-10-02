/**
 * The cart token (docs/phase-197): new whenever a cart starts, kept while
 * it is being built, sent with the sale, and no longer persisted by zustand.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const input = (id: string): Omit<CartItem, 'quantity'> => ({
  id,
  productId: 'p',
  title: id,
  variantTitle: '',
  price: 10,
  image: null
})

describe('cart token', () => {
  beforeEach(() => {
    localStorage.clear()
    useCartStore.setState({ items: [], cartToken: null, cartDiscount: null, checkoutStatus: 'idle' })
  })

  it('is set when the first line is added and kept while the cart is built', () => {
    expect(useCartStore.getState().cartToken).toBeNull()

    useCartStore.getState().addItem(input('a'))
    const first = useCartStore.getState().cartToken
    useCartStore.getState().addItem(input('b'))
    useCartStore.getState().addItem(input('a'))

    expect(first).toBeTruthy()
    expect(useCartStore.getState().cartToken).toBe(first)
  })

  it('is new for the next cart after the cart is emptied, however it was emptied', () => {
    useCartStore.getState().addItem(input('a'))
    const first = useCartStore.getState().cartToken
    useCartStore.getState().removeItem('a')

    useCartStore.getState().addItem(input('b'))

    expect(useCartStore.getState().cartToken).not.toBe(first)
  })

  it('is cleared with the cart', () => {
    useCartStore.getState().addItem(input('a'))

    useCartStore.getState().clearCart()

    expect(useCartStore.getState().cartToken).toBeNull()
  })

  it('is put back with a restored cart, and the cart discount is not', () => {
    useCartStore.setState({ cartDiscount: { type: 'percent', value: 5 } })

    useCartStore.getState().restoreCart([{ ...input('a'), quantity: 2 }], 'restored-token')

    expect(useCartStore.getState().cartToken).toBe('restored-token')
    expect(useCartStore.getState().items).toHaveLength(1)
    expect(useCartStore.getState().cartDiscount).toBeNull()
  })

  it('is sent with the checkout so the sale can stamp this cart\'s removals', async () => {
    const checkout = vi.fn().mockResolvedValue({ success: true, data: { localId: 1, mode: 'synced' } })
    window.api = { checkout, printReceipt: vi.fn().mockResolvedValue({ success: true }) } as unknown as typeof window.api
    useCartStore.getState().addItem(input('a'))
    const token = useCartStore.getState().cartToken

    await useCartStore.getState().checkout({
      staffId: 1,
      paymentMethod: 'cash',
      tenderedAmount: 10,
      changeDue: 0
    })

    expect(checkout).toHaveBeenCalledWith(expect.objectContaining({ cartToken: token }))
  })

  it('does not write the cart to localStorage: the SQLite draft replaces it', () => {
    useCartStore.getState().addItem(input('a'))

    expect(localStorage.getItem('rubis-pos-cart')).toBeNull()
  })
})
