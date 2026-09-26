/**
 * Shift Z-reports and daily sales summaries.
 *
 * Both aggregations read directly from the local `orders` ledger — no
 * network access — so they work identically online or offline, and
 * reflect cash actually collected regardless of a given order's
 * Shopify sync status.
 */

import type { RubisDatabase, PaymentMethod, OrderRow, MpesaPaymentRow, OrderStatus } from './database.js'

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
 * revenue, or the daily summary.
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

/**
 * Fixed UTC offset for Africa/Nairobi (EAT). Kenya has observed a single,
 * unchanging UTC+3 offset since 1960 — no daylight saving — so a plain
 * arithmetic shift is correct here and needs no timezone database. If
 * this store ever operates somewhere that *does* observe DST, this
 * constant is the wrong tool and `Intl.DateTimeFormat`'s timezone
 * support should replace it.
 */
const NAIROBI_UTC_OFFSET_MINUTES = 3 * 60

/**
 * Computes the UTC boundaries `[startIso, endIso)` of one Africa/Nairobi
 * calendar day — deliberately not {@link getUtcDayRange}, which answers a
 * different question (the UTC calendar day). The end-of-day report must
 * use *this* one: a sale at 00:30 Nairobi time is still "last night" to a
 * UTC clock for another three hours, and would otherwise land on the
 * wrong day's report.
 *
 * @param {string} localDay — `YYYY-MM-DD`, the date as read on a clock in
 *   Nairobi
 * @returns {{ startIso: string; endIso: string }}
 */
export function getLocalDayRange(localDay: string): { startIso: string; endIso: string } {
  const [year, month, day] = localDay.split('-').map(Number)
  const startUtcMs = Date.UTC(year, month - 1, day) - NAIROBI_UTC_OFFSET_MINUTES * 60 * 1000
  const start = new Date(startUtcMs)
  const end = new Date(startUtcMs + 24 * 60 * 60 * 1000)
  return { startIso: start.toISOString(), endIso: end.toISOString() }
}

/**
 * Which Africa/Nairobi calendar day an ISO-8601 instant falls on — the
 * inverse of {@link getLocalDayRange}. Used to label carry-over entries
 * with the day they actually happened on, and to compute "today" for the
 * end-of-day report's default.
 *
 * @param {string} iso
 * @returns {string} `YYYY-MM-DD`
 */
export function localDayOf(iso: string): string {
  const shifted = new Date(new Date(iso).getTime() + NAIROBI_UTC_OFFSET_MINUTES * 60 * 1000)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Today's Africa/Nairobi calendar day, as `YYYY-MM-DD` — the default
 * range an end-of-day report is generated for when the caller doesn't
 * name one.
 *
 * @param {Date} [now] — defaults to the current instant
 * @returns {string}
 */
export function todayLocalDay(now: Date = new Date()): string {
  return localDayOf(now.toISOString())
}

/** One cashier's totals for an end-of-day report. */
export interface CashierDaySummary {
  staffId: number
  staffName: string
  orderCount: number
  totalsByMethod: PaymentTotals
  /** M-Pesa revenue this cashier took, split by how it was confirmed. */
  mpesaByMode: { manual: number; daraja: number }
}

/**
 * One manual M-Pesa entry as shown on an end-of-day report — the sale it
 * paid for, who took it, and whether a manager has approved it yet.
 */
export interface ManualMpesaEntrySummary {
  paymentId: number
  orderLocalId: number
  createdAt: string
  /** The Africa/Nairobi calendar day this entry falls on — carry-over rows predate the report's own day. */
  localDay: string
  staffId: number
  staffName: string
  reference: string
  amount: number
  approved: boolean
  reconciledAt: string | null
  reconciledByStaffId: number | null
  reconciledByStaffName: string | null
  /**
   * True only for an approved entry whose approver was the same person
   * who recorded it (docs/phase-153 decision 6) — display only, changes
   * no rule: self-approval stays allowed for the POC.
   */
  sameApproverAsRecorder: boolean
  /**
   * The most recent time a manager reviewed this entry and deliberately
   * left it pending instead of approving it (docs/phase-153), if ever —
   * carry-over shows this so the reason isn't lost between review cycles.
   */
  lastExclusion: { localDay: string; staffName: string; reason: string | null } | null
}

/**
 * The end-of-day report (docs/phase-150.md deferred approval to this;
 * docs/phase-151/152 design it): per-cashier totals for one Africa/Nairobi
 * calendar day, that day's manual M-Pesa entries, and any manual entry
 * from an earlier day still awaiting approval.
 */
export interface EndOfDayReport {
  localDay: string
  cashiers: CashierDaySummary[]
  totalsByMethod: PaymentTotals
  manualEntries: ManualMpesaEntrySummary[]
  carryOver: ManualMpesaEntrySummary[]
  /**
   * Every id from `manualEntries`/`carryOver` still unapproved at the
   * moment this report was generated — exactly, and only, what
   * `approveMpesaEntries` may act on for this report. An entry recorded
   * after this list was built is not in it, and so cannot be swept into
   * an approval of this report.
   */
  pendingIds: number[]
  pendingManualTotal: number
}

/**
 * Builds the end-of-day report for one Africa/Nairobi calendar day: each
 * cashier's totals by payment method (with M-Pesa further split by
 * manual vs. Daraja), every manual M-Pesa entry recorded that day, and
 * carry-over — manual entries from earlier days nobody has approved yet,
 * which keep appearing on every subsequent report until they are.
 *
 * Voided orders are excluded exactly as {@link generateDailySummary}
 * excludes them (`excludeVoided`), reused rather than re-derived here.
 *
 * @param {RubisDatabase} db
 * @param {string} localDay — `YYYY-MM-DD`, defaults to today in Nairobi
 * @returns {EndOfDayReport}
 */
export function generateEndOfDayReport(
  db: RubisDatabase,
  localDay: string = todayLocalDay()
): EndOfDayReport {
  const { startIso, endIso } = getLocalDayRange(localDay)

  const orders = excludeVoided(db.getOrdersForDateRange(startIso, endIso))
  const totalsByMethod = sumByPaymentMethod(orders)

  const staffNameCache = new Map<number, string>()
  const staffName = (staffId: number): string => {
    const cached = staffNameCache.get(staffId)
    if (cached) return cached
    const name = db.getStaffById(staffId)?.name ?? 'Unknown'
    staffNameCache.set(staffId, name)
    return name
  }

  const ordersByStaff = new Map<number, OrderRow[]>()
  for (const order of orders) {
    if (order.staff_id === null) continue
    const list = ordersByStaff.get(order.staff_id)
    if (list) list.push(order)
    else ordersByStaff.set(order.staff_id, [order])
  }

  const todaysPayments = excludeVoided(db.getMpesaPaymentsForDateRange(startIso, endIso))

  const mpesaByStaff = new Map<number, { manual: number; daraja: number }>()
  for (const payment of todaysPayments) {
    if (payment.mode !== 'manual' && payment.mode !== 'daraja') continue
    const bucket = mpesaByStaff.get(payment.entered_by_staff_id) ?? { manual: 0, daraja: 0 }
    bucket[payment.mode] += payment.amount
    mpesaByStaff.set(payment.entered_by_staff_id, bucket)
  }

  const cashiers: CashierDaySummary[] = Array.from(ordersByStaff.entries()).map(
    ([staffId, staffOrders]) => ({
      staffId,
      staffName: staffName(staffId),
      orderCount: staffOrders.length,
      totalsByMethod: sumByPaymentMethod(staffOrders),
      mpesaByMode: mpesaByStaff.get(staffId) ?? { manual: 0, daraja: 0 }
    })
  )

  const todaysManualPayments = todaysPayments.filter((payment) => payment.mode === 'manual')
  const carryOverPayments = excludeVoided(db.getUnapprovedManualPaymentsBefore(startIso))

  const allPaymentIds = [...todaysManualPayments, ...carryOverPayments].map((payment) => payment.id)
  const lastExclusionByPaymentId = new Map(
    db.getLatestExclusionsForPayments(allPaymentIds).map((exclusion) => [
      exclusion.payment_id,
      {
        localDay: exclusion.local_day,
        staffName: staffName(exclusion.approved_by_staff_id),
        reason: exclusion.reason
      }
    ])
  )

  const toSummary = (
    payment: MpesaPaymentRow & { status: OrderStatus }
  ): ManualMpesaEntrySummary => ({
    paymentId: payment.id,
    orderLocalId: payment.order_local_id,
    createdAt: payment.created_at,
    localDay: localDayOf(payment.created_at),
    staffId: payment.entered_by_staff_id,
    staffName: staffName(payment.entered_by_staff_id),
    reference: payment.reference,
    amount: payment.amount,
    approved: payment.reconciled_at !== null,
    reconciledAt: payment.reconciled_at,
    reconciledByStaffId: payment.reconciled_by_staff_id,
    reconciledByStaffName:
      payment.reconciled_by_staff_id !== null ? staffName(payment.reconciled_by_staff_id) : null,
    sameApproverAsRecorder:
      payment.reconciled_by_staff_id !== null &&
      payment.reconciled_by_staff_id === payment.entered_by_staff_id,
    lastExclusion: lastExclusionByPaymentId.get(payment.id) ?? null
  })

  const manualEntries = todaysManualPayments.map(toSummary)
  const carryOver = carryOverPayments.map(toSummary)

  const pending = [...manualEntries, ...carryOver].filter((entry) => !entry.approved)

  return {
    localDay,
    cashiers,
    totalsByMethod,
    manualEntries,
    carryOver,
    pendingIds: pending.map((entry) => entry.paymentId),
    pendingManualTotal: pending.reduce((sum, entry) => sum + entry.amount, 0)
  }
}
