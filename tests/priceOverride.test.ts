/**
 * Manual price override sanity-check tests (Phase 11, Task 2).
 *
 * `validatePriceOverride` is pure and tested directly; `cartStore`'s
 * `setItemPrice` is tested against the store to confirm it actually
 * enforces the same rule rather than trusting the UI alone.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  validatePriceOverride,
  PRICE_OVERRIDE_MAX_MARKUP_PERCENT
} from '../src/renderer/src/lib/checkoutMath.js'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

describe('validatePriceOverride', () => {
  it('rejects a price of exactly zero (Q1 default — use a 100% discount instead)', () => {
    const result = validatePriceOverride(0, 100)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/greater than zero/i)
  })

  it('rejects a negative price', () => {
    const result = validatePriceOverride(-5, 100)
    expect(result.valid).toBe(false)
  })

  it('rejects a non-finite price', () => {
    expect(validatePriceOverride(NaN, 100).valid).toBe(false)
  })

  it(`allows a price up to exactly the ${PRICE_OVERRIDE_MAX_MARKUP_PERCENT}% ceiling`, () => {
    expect(validatePriceOverride(150, 100).valid).toBe(true)
  })

  it(`rejects a price over the ${PRICE_OVERRIDE_MAX_MARKUP_PERCENT}% ceiling`, () => {
    const result = validatePriceOverride(150.01, 100)
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('Price exceeds maximum allowed override. Contact Admin.')
  })

  it('catches the classic typo case (10000 instead of 1000)', () => {
    const result = validatePriceOverride(10000, 1000)
    expect(result.valid).toBe(false)
  })

  it('allows a markdown below the base price with no ceiling concern', () => {
    expect(validatePriceOverride(50, 100).valid).toBe(true)
  })

  it('skips the ceiling check when basePrice is not positive (defensive default)', () => {
    expect(validatePriceOverride(999, 0).valid).toBe(true)
  })
})

const catalogItem = (overrides: Partial<CartItem> = {}): Omit<CartItem, 'quantity'> => ({
  id: 'variant-1',
  productId: 'product-1',
  title: 'RUBIS Mug',
  variantTitle: 'Small',
  price: 100,
  image: null,
  ...overrides
})

describe('cartStore.setItemPrice enforces the override ceiling', () => {
  beforeEach(() => {
    useCartStore.setState({ items: [], cartDiscount: null })
  })

  it('captures basePrice from the catalog price when an item is added', () => {
    useCartStore.getState().addItem(catalogItem())
    expect(useCartStore.getState().items[0].basePrice).toBe(100)
  })

  it('applies a valid override within the ceiling', () => {
    useCartStore.getState().addItem(catalogItem())
    useCartStore.getState().setItemPrice('variant-1', 140)
    expect(useCartStore.getState().items[0].price).toBe(140)
  })

  it('silently rejects an override above the ceiling, leaving the price unchanged', () => {
    useCartStore.getState().addItem(catalogItem())
    useCartStore.getState().setItemPrice('variant-1', 1000)
    expect(useCartStore.getState().items[0].price).toBe(100)
  })

  it('silently rejects a zero override', () => {
    useCartStore.getState().addItem(catalogItem())
    useCartStore.getState().setItemPrice('variant-1', 0)
    expect(useCartStore.getState().items[0].price).toBe(100)
  })

  it('checks a second override against the original basePrice, not a previously overridden price', () => {
    useCartStore.getState().addItem(catalogItem())
    useCartStore.getState().setItemPrice('variant-1', 145)
    expect(useCartStore.getState().items[0].price).toBe(145)

    // 150% of the ORIGINAL 100 is 150 — a jump to 149 from the current
    // 145 is a small step, but must still be judged against the Ksh 100
    // catalog price, not compounded on top of the first override.
    useCartStore.getState().setItemPrice('variant-1', 149)
    expect(useCartStore.getState().items[0].price).toBe(149)

    useCartStore.getState().setItemPrice('variant-1', 151)
    expect(useCartStore.getState().items[0].price).toBe(149)
  })
})
