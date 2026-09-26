/**
 * `computeReceiptTotals` tests (docs/phase-160 Part A, docs/phase-161
 * Commit 2) — the shared subtotal/discount/total/VAT figures for
 * `printer.ts`/`pdf-receipt.ts`. Pure function, no store/IPC involved.
 */

import { describe, it, expect, vi } from 'vitest'
import { computeReceiptTotals } from '../src/main/lib/receiptTotals.js'
import type { ReceiptTotalsOrder } from '../src/main/lib/receiptTotals.js'

function order(overrides: Partial<ReceiptTotalsOrder> = {}): ReceiptTotalsOrder {
  return {
    localId: 1,
    lineItems: [{ unitPrice: 25, quantity: 2 }],
    total: 50,
    ...overrides
  }
}

describe('computeReceiptTotals', () => {
  it('no discount: total equals the raw subtotal, VAT is extracted not added', () => {
    const totals = computeReceiptTotals(order(), 0.16)

    expect(totals.rawSubtotal).toBe(50)
    expect(totals.discountTotal).toBe(0)
    expect(totals.total).toBe(50)
    expect(totals.vatIncluded).toBe(6.9)
  })

  it('2 x 100.00 with a 10.00 line discount: total 190.00, VAT 26.21 at 16%', () => {
    const totals = computeReceiptTotals(
      order({
        lineItems: [{ unitPrice: 100, quantity: 2, discount: { type: 'fixed', value: 10 } }],
        total: 190
      }),
      0.16
    )

    expect(totals.rawSubtotal).toBe(200)
    expect(totals.discountTotal).toBe(10)
    expect(totals.total).toBe(190)
    expect(totals.vatIncluded).toBe(26.21)
  })

  it('1 x 100.00 with a 10% cart discount: total 90.00, VAT 12.41', () => {
    const totals = computeReceiptTotals(
      order({
        lineItems: [{ unitPrice: 100, quantity: 1 }],
        cartDiscount: { type: 'percent', value: 10 },
        total: 90
      }),
      0.16
    )

    expect(totals.rawSubtotal).toBe(100)
    expect(totals.discountTotal).toBe(10)
    expect(totals.total).toBe(90)
    expect(totals.vatIncluded).toBe(12.41)
  })

  it('a line discount and a cart discount together, cart discount applied on top of the line-discounted subtotal', () => {
    // 2 x 100 - 10.00 line discount = 190; then 10% of 190 = 19 cart discount -> 171.
    const totals = computeReceiptTotals(
      order({
        lineItems: [{ unitPrice: 100, quantity: 2, discount: { type: 'fixed', value: 10 } }],
        cartDiscount: { type: 'percent', value: 10 },
        total: 171
      }),
      0.16
    )

    expect(totals.rawSubtotal).toBe(200)
    expect(totals.discountTotal).toBe(29)
    expect(totals.total).toBe(171)
    expect(totals.vatIncluded).toBe(23.59)
  })

  it('1.00 at 16% extracts 0.14 VAT (the task’s own worked example)', () => {
    const totals = computeReceiptTotals(order({ lineItems: [{ unitPrice: 1, quantity: 1 }], total: 1 }), 0.16)
    expect(totals.vatIncluded).toBe(0.14)
  })

  it('total always equals the order’s own stored total, never a recomputed figure', () => {
    // A silent logger here — the point of this test is the `total`
    // passthrough, not the reconciliation warning (covered separately
    // below), and most of these stored totals deliberately don't
    // reconcile against the fixed 50.00 raw subtotal.
    const warn = vi.fn()
    for (const stored of [50, 190, 90, 171, 1]) {
      const totals = computeReceiptTotals(order({ total: stored }), 0.16, { warn })
      expect(totals.total).toBe(stored)
    }
  })

  it('reuses computeVatIncluded (reports.ts), not a re-implementation — same rounding at an awkward rate', () => {
    // 8% is not a round-tripping rate at 2dp — a drifted re-implementation
    // would very likely disagree with reports.ts's own function here.
    const totals = computeReceiptTotals(
      order({ lineItems: [{ unitPrice: 44.99, quantity: 1 }], total: 44.99 }),
      0.08
    )
    expect(totals.vatIncluded).toBe(3.33)
  })

  it('warns with the order id and still returns the stored total when the figures do not reconcile', () => {
    const warn = vi.fn()
    // rawSubtotal 50, no discount -> expected 50, but total claims 45.
    const totals = computeReceiptTotals(order({ localId: 99, total: 45 }), 0.16, { warn })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('Order 99')
    expect(totals.total).toBe(45)
  })

  it('does not warn when the figures reconcile exactly', () => {
    const warn = vi.fn()
    computeReceiptTotals(order(), 0.16, { warn })
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not warn for a mismatch of exactly one cent (within tolerance)', () => {
    const warn = vi.fn()
    computeReceiptTotals(order({ total: 50.01 }), 0.16, { warn })
    expect(warn).not.toHaveBeenCalled()
  })

  it('never lets a discount reduce a line below zero', () => {
    const totals = computeReceiptTotals(
      order({
        lineItems: [{ unitPrice: 10, quantity: 1, discount: { type: 'fixed', value: 100 } }],
        total: 0
      }),
      0.16
    )
    expect(totals.discountTotal).toBe(10)
    expect(totals.total).toBe(0)
  })
})
