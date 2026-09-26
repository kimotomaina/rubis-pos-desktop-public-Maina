/**
 * `requestHasDiscount`/`shouldRefuseCheckoutForDiscount` tests
 * (docs/phase-161-1) — the pure functions behind the `orders:checkout`
 * server-side discount refusal, tested directly since this codebase has
 * no test that mounts an `index.ts` IPC handler (docs/phase-158-1).
 */

import { describe, it, expect } from 'vitest'
import { requestHasDiscount, shouldRefuseCheckoutForDiscount } from '../src/main/lib/requestHasDiscount.js'

describe('requestHasDiscount', () => {
  it('is false for a plain request with no discount anywhere', () => {
    expect(requestHasDiscount({ items: [{}, {}] })).toBe(false)
  })

  it('is true when any line item carries a discount', () => {
    expect(
      requestHasDiscount({ items: [{}, { discount: { type: 'percent', value: 5 } }] })
    ).toBe(true)
  })

  it('is true when a cart-level discount is set, even with no line discount', () => {
    expect(requestHasDiscount({ items: [{}], cartDiscount: { type: 'fixed', value: 10 } })).toBe(true)
  })

  it('is true when both a line discount and a cart discount are present', () => {
    expect(
      requestHasDiscount({
        items: [{ discount: { type: 'fixed', value: 1 } }],
        cartDiscount: { type: 'percent', value: 5 }
      })
    ).toBe(true)
  })

  it('is false for an empty items array with no cart discount', () => {
    expect(requestHasDiscount({ items: [] })).toBe(false)
  })
})

describe('shouldRefuseCheckoutForDiscount (docs/phase-161-1, item 3)', () => {
  it('refuses a real-provider checkout carrying a line discount', () => {
    expect(
      shouldRefuseCheckoutForDiscount(true, {
        items: [{ discount: { type: 'percent', value: 10 } }]
      })
    ).toBe(true)
  })

  it('refuses a real-provider checkout carrying a cart discount', () => {
    expect(
      shouldRefuseCheckoutForDiscount(true, { items: [{}], cartDiscount: { type: 'fixed', value: 5 } })
    ).toBe(true)
  })

  it('does not refuse a real-provider checkout with no discount at all', () => {
    expect(shouldRefuseCheckoutForDiscount(true, { items: [{}, {}] })).toBe(false)
  })

  it('does not refuse a mock-provider checkout even with a line and a cart discount', () => {
    expect(
      shouldRefuseCheckoutForDiscount(false, {
        items: [{ discount: { type: 'percent', value: 10 } }],
        cartDiscount: { type: 'fixed', value: 5 }
      })
    ).toBe(false)
  })
})
