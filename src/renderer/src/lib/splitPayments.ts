/**
 * The till screen's side of split payments (docs/phase-252): what is still due, whether another payment can be added,
 * and whether the sale can be completed. The main process checks the same rules again (`checkSplitPayments` in
 * `checkout.ts`), and its check is the control; these only keep the screen's buttons honest. Every comparison is in
 * whole cents.
 */

import type { CheckoutIpcPaymentLeg } from '../../../main/services/database.js'

/** The most payments one sale may be split into, mirrored from `checkout.ts`. */
export const MAX_SPLIT_PAYMENTS = 4

/** Shown under the cart while a split holds a recorded payment and the cart is locked (docs/phase-252-1). */
export const CART_LOCKED_BY_SPLIT_MESSAGE = 'Remove the recorded payments to change the cart.'

/** @returns {number} the amount in whole cents */
function cents(amount: number): number {
  return Math.round(amount * 100)
}

/**
 * @param {number} total the sale's total
 * @param {readonly CheckoutIpcPaymentLeg[]} legs the payments recorded so far
 * @returns {number} what is still due, never below 0
 */
export function amountDue(total: number, legs: readonly CheckoutIpcPaymentLeg[]): number {
  const paid = legs.reduce((sum, leg) => sum + cents(leg.amount), 0)
  return Math.max(0, cents(total) - paid) / 100
}

/**
 * Another payment can be added while fewer than {@link MAX_SPLIT_PAYMENTS} are recorded, something is still due and no
 * cash has been taken: cash is always the last payment.
 *
 * @param {number} total
 * @param {readonly CheckoutIpcPaymentLeg[]} legs
 * @returns {boolean}
 */
export function canAddPayment(total: number, legs: readonly CheckoutIpcPaymentLeg[]): boolean {
  return legs.length < MAX_SPLIT_PAYMENTS && amountDue(total, legs) > 0 && !legs.some((leg) => leg.method === 'cash')
}

/**
 * The most an M-Pesa or card payment may be: what is still due, and for the first payment one cent less, since a sale
 * paid whole one way is not a split.
 *
 * @param {number} total
 * @param {readonly CheckoutIpcPaymentLeg[]} legs
 * @returns {number}
 */
export function maxNonCashPayment(total: number, legs: readonly CheckoutIpcPaymentLeg[]): number {
  const due = cents(amountDue(total, legs))
  return (legs.length === 0 ? due - 1 : due) / 100
}

/**
 * Complete sale is active only when two or more payments are recorded and they add up to the total exactly.
 *
 * @param {number} total
 * @param {readonly CheckoutIpcPaymentLeg[]} legs
 * @returns {boolean}
 */
export function canCompleteSplit(total: number, legs: readonly CheckoutIpcPaymentLeg[]): boolean {
  return legs.length >= 2 && cents(total) > 0 && legs.reduce((sum, leg) => sum + cents(leg.amount), 0) === cents(total)
}

/**
 * The change the cash payment gives: what was handed over less the cash due.
 *
 * @param {readonly CheckoutIpcPaymentLeg[]} legs
 * @returns {number}
 */
export function splitChange(legs: readonly CheckoutIpcPaymentLeg[]): number {
  const cash = legs.find((leg) => leg.method === 'cash')
  return cash ? Math.max(0, cents(cash.tendered ?? 0) - cents(cash.amount)) / 100 : 0
}
