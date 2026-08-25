/**
 * Shift Z-reports and daily sales summaries (Phase 7 — Shift
 * Management, Z-Reports & Admin Polish).
 *
 * Both aggregations read directly from the local `orders` ledger — no
 * network access — so they work identically online or offline, and
 * reflect cash actually collected regardless of a given order's
 * Shopify sync status.
 */

import type { RubisDatabase, PaymentMethod } from './database.js'

/** Revenue total per payment method. */
export interface PaymentTotals {
  cash: number
  mpesa: number
  card: number
}

/** Financial summary of one till shift, mirroring the printed Z-report. */
export interface ZReport {
  shiftId: number
  staffName: string
  openedAt: string
  closedAt: string | null
  status: 'open' | 'closed'
  startingCash: number
  totalsByMethod: PaymentTotals
  orderCount: number
  totalRevenue: number
  totalTax: number
  expectedCash: number
  endingCash: number | null
  discrepancy: number | null
}

/** Aggregate sales for a calendar day, independent of shift boundaries. */
export interface DailySummary {
  startIso: string
  endIso: string
  orderCount: number
  totalRevenue: number
  totalTax: number
  totalsByMethod: PaymentTotals
}

/**
 * Excludes voided orders from a revenue aggregation — a void reverses
 * the sale, so it must never count toward cash reconciliation, Z-report
 * revenue, or the daily summary (Phase 11 fix; see `database.ts`'s
 * `closeShift` for the matching cash-reconciliation fix).
 *
 * @param {Array<{ status: string }>} orders
 * @returns filtered orders
 */
function excludeVoided<T extends { status: string }>(orders: T[]): T[] {
  return orders.filter((order) => order.status !== 'voided')
}

/**
 * Sums order totals into a {@link PaymentTotals} bucket by payment method.
 *
 * @param {Array<{ payment_method: PaymentMethod | null; total: number }>} orders
 * @returns {PaymentTotals}
 */
function sumByPaymentMethod(
  orders: Array<{ payment_method: PaymentMethod | null; total: number }>
): PaymentTotals {
  const totals: PaymentTotals = { cash: 0, mpesa: 0, card: 0 }
  for (const order of orders) {
    if (order.payment_method === 'cash') totals.cash += order.total
    else if (order.payment_method === 'mpesa') totals.mpesa += order.total
    else if (order.payment_method === 'card') totals.card += order.total
  }
  return totals
}

/**
 * Computes the UTC calendar-day boundaries containing `date`.
 *
 * @param {Date} [date] — defaults to now
 * @returns {{ startIso: string; endIso: string }} `[startIso, endIso)`
 */
export function getUtcDayRange(date: Date = new Date()): {
  startIso: string
  endIso: string
} {
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  )
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { startIso: start.toISOString(), endIso: end.toISOString() }
}

/**
 * Generates the Z-report for a till shift: revenue broken down by
 * payment method, total tax (computed from the store's configured
 * tax rate — orders don't store tax individually), and the cash
 * reconciliation (expected vs. counted, with discrepancy) already
 * persisted on the shift row when closed.
 *
 * @param {RubisDatabase} db
 * @param {number} shiftId
 * @param {number} taxRate — fractional store tax rate (0.08 = 8%)
 * @returns {ZReport}
 * @throws if the shift does not exist
 */
export function generateZReport(
  db: RubisDatabase,
  shiftId: number,
  taxRate: number
): ZReport {
  const shift = db.getShiftById(shiftId)
  if (!shift) {
    throw new Error(`Shift ${shiftId} not found`)
  }

  const orders = excludeVoided(db.getOrdersForShift(shiftId))
  const totalsByMethod = sumByPaymentMethod(orders)
  const totalRevenue = orders.reduce((sum, order) => sum + order.total, 0)
  const staffName = db.getStaffById(shift.staff_id)?.name ?? 'Unknown'

  const expectedCash =
    shift.status === 'closed' && shift.expected_cash !== null
      ? shift.expected_cash
      : shift.starting_cash + totalsByMethod.cash

  return {
    shiftId: shift.id,
    staffName,
    openedAt: shift.clock_in,
    closedAt: shift.clock_out,
    status: shift.status,
    startingCash: shift.starting_cash,
    totalsByMethod,
    orderCount: orders.length,
    totalRevenue,
    totalTax: totalRevenue * taxRate,
    expectedCash,
    endingCash: shift.ending_cash,
    discrepancy: shift.discrepancy
  }
}

/**
 * Aggregates every order created within a date range (default: the
 * current UTC calendar day) — used for the Admin screen's "Today's
 * Sales" view, independent of till-shift boundaries.
 *
 * @param {RubisDatabase} db
 * @param {number} taxRate
 * @param {{ startIso: string; endIso: string }} [range]
 * @returns {DailySummary}
 */
export function generateDailySummary(
  db: RubisDatabase,
  taxRate: number,
  range: { startIso: string; endIso: string } = getUtcDayRange()
): DailySummary {
  const orders = excludeVoided(db.getOrdersForDateRange(range.startIso, range.endIso))
  const totalsByMethod = sumByPaymentMethod(orders)
  const totalRevenue = orders.reduce((sum, order) => sum + order.total, 0)

  return {
    startIso: range.startIso,
    endIso: range.endIso,
    orderCount: orders.length,
    totalRevenue,
    totalTax: totalRevenue * taxRate,
    totalsByMethod
  }
}
