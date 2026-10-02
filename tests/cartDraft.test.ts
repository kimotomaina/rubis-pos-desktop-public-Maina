/**
 * The cart draft (docs/phase-197): the debounced saver, and rebuilding a
 * saved cart against today's catalogue.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  CART_DRAFT_DEBOUNCE_MS,
  createCartDraftSaver,
  restoreCartDraft,
  restoreToastMessage
} from '../src/renderer/src/lib/cartDraft.js'
import type { CartItem, ProductSummary } from '../src/renderer/src/types/shopify.js'

const line = (overrides: Partial<CartItem> = {}): CartItem => ({
  id: 'v1',
  productId: 'p1',
  title: 'Mug',
  variantTitle: 'Small',
  price: 60,
  basePrice: 60,
  quantity: 2,
  image: null,
  ...overrides
})

const catalogue = (price = 75): ProductSummary[] => [
  {
    id: 'p1',
    title: 'Mug',
    handle: 'mug',
    featuredImage: null,
    variants: [
      {
        id: 'v1',
        productId: 'p1',
        title: 'Small',
        price,
        availableForSale: true,
        inventoryQuantity: 5,
        image: null,
        barcode: null,
        vatClass: 'C'
      }
    ]
  }
]

describe('createCartDraftSaver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes once, with the last cart, after a burst of changes', () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const saver = createCartDraftSaver({ save, clear: vi.fn() })

    saver.update({ items: [line({ quantity: 1 })], cartToken: 't' })
    vi.advanceTimersByTime(100)
    saver.update({ items: [line({ quantity: 2 })], cartToken: 't' })
    vi.advanceTimersByTime(100)
    saver.update({ items: [line({ quantity: 3 })], cartToken: 't' })
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(CART_DRAFT_DEBOUNCE_MS)

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ items: [line({ quantity: 3 })], cartToken: 't' })
  })

  it('debounces by 300 ms', () => {
    expect(CART_DRAFT_DEBOUNCE_MS).toBe(300)
  })

  it('deletes the draft, rather than saving an empty one, when the cart is empty', () => {
    const save = vi.fn()
    const clear = vi.fn().mockResolvedValue(undefined)
    const saver = createCartDraftSaver({ save, clear })

    saver.update({ items: [], cartToken: null })
    vi.advanceTimersByTime(CART_DRAFT_DEBOUNCE_MS)

    expect(clear).toHaveBeenCalledTimes(1)
    expect(save).not.toHaveBeenCalled()
  })

  it('writes nothing when cancelled', () => {
    const save = vi.fn()
    const clear = vi.fn()
    const saver = createCartDraftSaver({ save, clear })

    saver.update({ items: [line()], cartToken: 't' })
    saver.cancel()
    vi.advanceTimersByTime(CART_DRAFT_DEBOUNCE_MS * 2)

    expect(save).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('swallows a failed write so a sale is never held up by it', async () => {
    const save = vi.fn().mockRejectedValue(new Error('disk full'))
    const saver = createCartDraftSaver({ save, clear: vi.fn() })

    saver.update({ items: [line()], cartToken: 't' })
    await vi.advanceTimersByTimeAsync(CART_DRAFT_DEBOUNCE_MS)

    expect(save).toHaveBeenCalledTimes(1)
  })
})

describe('restoreCartDraft', () => {
  const payload = (items: CartItem[], cartToken = 'token-1'): string => JSON.stringify({ cartToken, items })

  it('rebuilds each line with today\'s catalogue price and keeps the quantity and token', () => {
    const restored = restoreCartDraft(payload([line({ price: 60, basePrice: 60, quantity: 4 })]), catalogue(75))

    expect(restored?.cartToken).toBe('token-1')
    expect(restored?.items).toHaveLength(1)
    expect(restored?.items[0]).toMatchObject({ id: 'v1', quantity: 4, price: 75, basePrice: 75, vatClass: 'C' })
    expect(restored?.droppedLines).toBe(0)
    expect(restored?.overridesRemoved).toBe(0)
  })

  it('drops a line whose variant is no longer in the catalogue and counts it', () => {
    const restored = restoreCartDraft(payload([line(), line({ id: 'gone', title: 'Old' })]), catalogue())

    expect(restored?.items.map((item) => item.id)).toEqual(['v1'])
    expect(restored?.droppedLines).toBe(1)
  })

  it('removes a manager price override and a discount, and counts them', () => {
    const overridden = line({ price: 50, basePrice: 60 })
    const discounted = line({ id: 'v1', discount: { type: 'percent', value: 20 } })
    const restored = restoreCartDraft(payload([overridden, discounted]), catalogue(75))

    expect(restored?.overridesRemoved).toBe(2)
    for (const item of restored?.items ?? []) {
      expect(item.price).toBe(75)
      expect(item.discount).toBeUndefined()
    }
  })

  it('drops a line with a bad quantity', () => {
    const restored = restoreCartDraft(payload([line({ quantity: 0 }), line({ quantity: 1.5 })]), catalogue())

    expect(restored?.items).toEqual([])
    expect(restored?.droppedLines).toBe(2)
  })

  it.each(['not json', '{}', JSON.stringify({ cartToken: '', items: [] }), JSON.stringify({ cartToken: 't' })])(
    'returns null for an unreadable draft (%s)',
    (bad) => {
      expect(restoreCartDraft(bad, catalogue())).toBeNull()
    }
  )
})

describe('restoreToastMessage', () => {
  const restored = (overrides = {}) => ({
    items: [line({ quantity: 2 }), line({ id: 'v2', quantity: 1 })],
    cartToken: 't',
    droppedLines: 0,
    overridesRemoved: 0,
    ...overrides
  })

  it('says how many items came back', () => {
    expect(restoreToastMessage(restored())).toBe('Restored the cart from before the restart. 3 items.')
    expect(restoreToastMessage(restored({ items: [line({ quantity: 1 })] }))).toBe(
      'Restored the cart from before the restart. 1 item.'
    )
  })

  it('says what was dropped and what lost its override', () => {
    const message = restoreToastMessage(restored({ droppedLines: 2, overridesRemoved: 1 }))

    expect(message).toContain('2 lines no longer in the catalogue were dropped.')
    expect(message).toContain('Price overrides and discounts were removed')
  })

  it('says nothing came back when every line was dropped', () => {
    expect(restoreToastMessage(restored({ items: [], droppedLines: 1 }))).toBe(
      'The cart from before the restart was not restored: 1 line no longer in the catalogue.'
    )
  })
})
