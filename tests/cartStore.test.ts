import { describe, it, expect, beforeEach } from 'vitest'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

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
