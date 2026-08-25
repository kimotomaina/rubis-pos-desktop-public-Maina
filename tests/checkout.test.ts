/**
 * Checkout math tests (Phase 6).
 *
 * `calculateChange`/`canCompleteSale` are pure functions, tested
 * directly without mounting `CheckoutModal`.
 */

import { describe, it, expect } from 'vitest'
import { calculateChange, canCompleteSale } from '../src/renderer/src/lib/checkoutMath.js'

describe('calculateChange', () => {
  it('computes change for a tender greater than the total', () => {
    expect(calculateChange(150, 200)).toBe(50)
  })

  it('returns 0 for an exact tender', () => {
    expect(calculateChange(150, 150)).toBe(0)
  })

  it('returns 0 (never negative) for an insufficient tender', () => {
    expect(calculateChange(150, 100)).toBe(0)
  })

  it('rounds to 2 decimal places, avoiding floating-point artifacts', () => {
    expect(calculateChange(19.99, 20)).toBe(0.01)
    expect(calculateChange(0.1, 0.3)).toBe(0.2)
  })
})

describe('canCompleteSale', () => {
  it('cash: disabled when the tendered amount is insufficient', () => {
    expect(canCompleteSale('cash', 150, 100)).toBe(false)
  })

  it('cash: enabled once the tendered amount covers the total', () => {
    expect(canCompleteSale('cash', 150, 150)).toBe(true)
    expect(canCompleteSale('cash', 150, 200)).toBe(true)
  })

  it('mpesa: disabled with a blank or whitespace-only reference number', () => {
    expect(canCompleteSale('mpesa', 150, 0)).toBe(false)
    expect(canCompleteSale('mpesa', 150, 0, '')).toBe(false)
    expect(canCompleteSale('mpesa', 150, 0, '   ')).toBe(false)
  })

  it('mpesa: enabled once a reference number is entered', () => {
    expect(canCompleteSale('mpesa', 150, 0, 'QGH7XJ2K1L')).toBe(true)
  })

  it('card: same reference-number gating as mpesa', () => {
    expect(canCompleteSale('card', 150, 0)).toBe(false)
    expect(canCompleteSale('card', 150, 0, 'TXN-9001')).toBe(true)
  })
})

describe('canCompleteSale — M-Pesa manual code flow (Phase 10)', () => {
  it('enables once PaymentModal hands back a verified 6-character transaction code', () => {
    expect(canCompleteSale('mpesa', 150, 150, 'QDF73H')).toBe(true)
  })

  it('stays disabled while no code has been verified yet', () => {
    expect(canCompleteSale('mpesa', 150, 150, undefined)).toBe(false)
  })
})
