/**
 * Discount math tests (Phase 10).
 *
 * Pure functions in `checkoutMath.ts`, tested directly — no store or
 * IPC involved. Covers line-level discounts, cart-level discounts
 * stacked on top of them, the "never below zero" floor, and the
 * Manager PIN threshold used to gate discounts over 10%.
 */

import { describe, it, expect } from 'vitest'
import {
  applyDiscount,
  calculateLineTotal,
  calculateSubtotal,
  calculateCartTotal,
  discountPercentOf,
  requiresManagerPinForDiscount,
  MANAGER_PIN_DISCOUNT_THRESHOLD_PERCENT
} from '../src/renderer/src/lib/checkoutMath.js'
import type { CartItem, Discount } from '../src/renderer/src/types/shopify.js'

const item = (overrides: Partial<CartItem> = {}): CartItem => ({
  id: 'variant-1',
  productId: 'product-1',
  title: 'RUBIS Mug',
  variantTitle: 'Small',
  price: 100,
  quantity: 2,
  image: null,
  ...overrides
})

describe('applyDiscount', () => {
  it('applies a percentage discount', () => {
    expect(applyDiscount(200, { type: 'percent', value: 10 })).toBe(180)
  })

  it('applies a fixed discount', () => {
    expect(applyDiscount(200, { type: 'fixed', value: 50 })).toBe(150)
  })

  it('never goes below zero for a fixed discount larger than the amount', () => {
    expect(applyDiscount(30, { type: 'fixed', value: 100 })).toBe(0)
  })

  it('never goes below zero for a percentage over 100%', () => {
    expect(applyDiscount(30, { type: 'percent', value: 150 })).toBe(0)
  })

  it('returns the rounded amount unchanged when there is no discount', () => {
    expect(applyDiscount(19.999)).toBe(20)
  })

  it('ignores a zero or negative discount value', () => {
    expect(applyDiscount(100, { type: 'fixed', value: 0 })).toBe(100)
    expect(applyDiscount(100, { type: 'percent', value: -5 })).toBe(100)
  })
})

describe('calculateLineTotal / calculateSubtotal', () => {
  it('applies a line-level discount to price × quantity', () => {
    const line = item({ price: 100, quantity: 2, discount: { type: 'percent', value: 10 } })
    expect(calculateLineTotal(line)).toBe(180)
  })

  it('sums undiscounted and discounted lines together', () => {
    const items = [
      item({ id: 'a', price: 100, quantity: 1 }),
      item({ id: 'b', price: 50, quantity: 2, discount: { type: 'fixed', value: 20 } })
    ]
    expect(calculateSubtotal(items)).toBe(100 + (100 - 20))
  })
})

describe('calculateCartTotal', () => {
  it('applies the cart-level discount on top of already-discounted line totals', () => {
    const items = [item({ price: 100, quantity: 2, discount: { type: 'percent', value: 10 } })]
    const cartDiscount: Discount = { type: 'fixed', value: 30 }

    expect(calculateCartTotal(items, cartDiscount)).toBe(180 - 30)
  })

  it('never goes below zero even when line + cart discounts overshoot', () => {
    const items = [item({ price: 10, quantity: 1, discount: { type: 'fixed', value: 5 } })]
    const cartDiscount: Discount = { type: 'fixed', value: 100 }

    expect(calculateCartTotal(items, cartDiscount)).toBe(0)
  })

  it('equals the plain sum when no discount is applied anywhere', () => {
    const items = [item({ price: 12.5, quantity: 1 })]
    expect(calculateCartTotal(items)).toBe(12.5)
  })
})

describe('discountPercentOf / requiresManagerPinForDiscount', () => {
  it('converts a fixed discount into an equivalent percentage of the base amount', () => {
    expect(discountPercentOf({ type: 'fixed', value: 25 }, 200)).toBe(12.5)
  })

  it('returns 0 for a non-positive base amount', () => {
    expect(discountPercentOf({ type: 'percent', value: 10 }, 0)).toBe(0)
  })

  it(`does not require Manager PIN at or below ${MANAGER_PIN_DISCOUNT_THRESHOLD_PERCENT}%`, () => {
    expect(requiresManagerPinForDiscount({ type: 'percent', value: 10 }, 200)).toBe(false)
    expect(requiresManagerPinForDiscount({ type: 'fixed', value: 20 }, 200)).toBe(false)
  })

  it(`requires Manager PIN above ${MANAGER_PIN_DISCOUNT_THRESHOLD_PERCENT}%`, () => {
    expect(requiresManagerPinForDiscount({ type: 'percent', value: 11 }, 200)).toBe(true)
    expect(requiresManagerPinForDiscount({ type: 'fixed', value: 21 }, 200)).toBe(true)
  })
})
