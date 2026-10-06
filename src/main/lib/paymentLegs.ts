import type { PaymentMethod } from '../services/database.js'

/**
 * One payment toward a sale (docs/phase-250). Every reader that turns sales into cash, M-Pesa or card figures reads them
 * through `RubisDatabase.paymentLegsFor`. Today a sale is paid one way, so it has one leg: its method and its total.
 */
export interface PaymentLeg {
  orderId: number
  method: PaymentMethod | null
  amount: number
  /** The sale was voided. Each reader keeps deciding, as before, whether a voided sale counts. */
  voided: boolean
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
