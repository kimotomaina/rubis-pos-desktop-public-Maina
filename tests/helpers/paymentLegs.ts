/**
 * The payment legs a hand-made fake database serves (docs/phase-250): the readers of cash, M-Pesa and card figures read
 * how a sale was paid through `paymentLegsFor`, so a fake that serves order rows serves their legs too, built the way the
 * real reader builds them: one leg per order, its method and its total, voided flagged.
 */

import type { PaymentLeg } from '../../src/main/lib/paymentLegs.js'
import type { PaymentMethod } from '../../src/main/services/database.js'

type OrderLike = { local_id: number; payment_method: PaymentMethod | null; total: number; status?: string }

/**
 * @param {...ReadonlyArray<OrderLike>} lists every order row the fake serves
 * @returns {(orderIds: readonly number[]) => Map<number, PaymentLeg[]>} a `paymentLegsFor` over those rows
 */
export function legsOf(...lists: Array<ReadonlyArray<OrderLike>>): (orderIds: readonly number[]) => Map<number, PaymentLeg[]> {
  const byId = new Map<number, OrderLike>()
  for (const list of lists) for (const row of list) if (!byId.has(row.local_id)) byId.set(row.local_id, row)
  return (orderIds) => {
    const legs = new Map<number, PaymentLeg[]>()
    for (const id of orderIds) {
      const row = byId.get(id)
      if (row) legs.set(id, [{ orderId: id, method: row.payment_method, amount: row.total, voided: row.status === 'voided' }])
    }
    return legs
  }
}
