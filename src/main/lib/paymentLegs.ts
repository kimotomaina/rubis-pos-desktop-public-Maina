import type { MpesaPaymentMode, PaymentMethod } from '../services/database.js'

/**
 * One payment toward a sale (docs/phase-250). Every reader that turns sales into cash, M-Pesa or card figures reads them
 * through `RubisDatabase.paymentLegsFor`. A sale's legs are its `order_payments` rows (docs/phase-252); a sale made
 * before that table has one leg, its method and its total.
 */
export interface PaymentLeg {
  orderId: number
  method: PaymentMethod | null
  amount: number
  /** The sale was voided. Each reader keeps deciding, as before, whether a voided sale counts. */
  voided: boolean
}

/**
 * One recorded payment of a sale (docs/phase-252), as written to `order_payments` and, for a split sale, to the order's
 * payload, where the receipt, the reprint and the Shopify note read it.
 */
export interface SalePayment {
  method: PaymentMethod
  /** The part of the sale's total this payment covers. For cash, the cash taken toward the sale, not what was handed over. */
  amount: number
  /** The M-Pesa code or the PDQ slip reference. */
  reference?: string
  /** Cash only: what the customer handed over. */
  tendered?: number
  /** Cash only: the change given. Only cash gives change. */
  changeDue?: number
  /** M-Pesa only: how the payment was taken, from the gate branch that accepted it, never from the screen. */
  mpesaMode?: MpesaPaymentMode
}

/**
 * The amount paid by `method` on the sales `orderIds`, added in the order the sales are given (docs/phase-250). The
 * order matters: the readers moved onto legs add the same amounts in the same order as before, so every figure is the
 * same to the last digit.
 *
 * @param {ReadonlyMap<number, readonly PaymentLeg[]>} legs from `RubisDatabase.paymentLegsFor`
 * @param {readonly number[]} orderIds
 * @param {PaymentMethod} method
 * @returns {number}
 */
export function methodTotalOf(legs: ReadonlyMap<number, readonly PaymentLeg[]>, orderIds: readonly number[], method: PaymentMethod): number {
  return orderIds
    .flatMap((id) => legs.get(id) ?? [])
    .filter((leg) => leg.method === method)
    .reduce((sum, leg) => sum + leg.amount, 0)
}

/**
 * How a sale was paid, in words (docs/phase-252): the method alone for a sale paid one way, exactly as the displays
 * showed it before, and `split: mpesa 500.00 + cash 1000.00` for a split sale.
 *
 * @param {ReadonlyArray<{ method: PaymentMethod | null; amount: number }>} legs one sale's legs
 * @returns {string} empty when the sale has no legs or no method
 */
export function describePayment(legs: ReadonlyArray<{ method: PaymentMethod | null; amount: number }>): string {
  if (legs.length <= 1) return legs[0]?.method ?? ''
  return `split: ${legs.map((leg) => `${leg.method ?? ''} ${leg.amount.toFixed(2)}`).join(' + ')}`
}
