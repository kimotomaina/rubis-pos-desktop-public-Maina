/**
 * Checkout math tests.
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

  /**
   * This asserted the opposite until phase-102: a typed reference used
   * to enable "Complete Sale" for M-Pesa. A string somebody typed is not
   * evidence that anyone paid, so it never enables the button now. An
   * M-Pesa sale completes only through a confirmed payment, which
   * arrives by way of `PaymentModal`'s `onPaid`.
   */
  it('mpesa: never enabled by a typed reference number, however well-formed', () => {
    expect(canCompleteSale('mpesa', 150, 0, 'QGH7XJ2K1L')).toBe(false)
    expect(canCompleteSale('mpesa', 150, 0, 'X')).toBe(false)
    // Not even a tendered amount can stand in for a confirmation.
    expect(canCompleteSale('mpesa', 150, 150, 'QGH7XJ2K1L')).toBe(false)
  })

  it('card: still gated on a reference number, unchanged', () => {
    // Card is the cashier's record of a payment the terminal already
    // took, so there is nothing for this till to confirm.
    expect(canCompleteSale('card', 150, 0)).toBe(false)
    expect(canCompleteSale('card', 150, 0, '   ')).toBe(false)
    expect(canCompleteSale('card', 150, 0, 'TXN-9001')).toBe(true)
  })

  it('cash is untouched by the M-Pesa gate', () => {
    expect(canCompleteSale('cash', 150, 150)).toBe(true)
    expect(canCompleteSale('cash', 150, 149.99)).toBe(false)
  })
})

describe('canCompleteSale — M-Pesa manual code flow', () => {
  /**
   * `PaymentModal` does not complete an M-Pesa sale through this button.
   * It calls `onPaid`, and the surface checks out directly — which is
   * why this returns `false` even for a code the modal verified, and why
   * that is correct rather than a regression. The confirmation is
   * re-checked in the main process by `runCheckout`, which is the only
   * place that can decide it, since a renderer's word is not evidence.
   */
  it('is not the route a confirmed M-Pesa payment completes through', () => {
    expect(canCompleteSale('mpesa', 150, 150, 'QDF73H')).toBe(false)
  })

  it('stays disabled while no code has been verified yet', () => {
    expect(canCompleteSale('mpesa', 150, 150, undefined)).toBe(false)
  })
})
