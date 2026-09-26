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

/** M-Pesa revenue split by how it was confirmed. */
export interface MpesaModeTotals {
  manual: number
  daraja: number
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
  /** M-Pesa revenue for this shift, split by how it was confirmed (docs/phase-158). */
  mpesaByMode: MpesaModeTotals
  orderCount: number
  totalRevenue: number
  /**
   * VAT extracted from `totalRevenue` (docs/phase-158, replacing the old
   * `totalTax` field, which wrongly added tax on top of an already
   * VAT-inclusive shelf price — see {@link computeVatIncluded}).
   */
  vatIncluded: number
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
  /** See {@link ZReport.vatIncluded} — same extraction, same reasoning. */
  vatIncluded: number
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
 * Sums a set of M-Pesa payments into a manual/Daraja split, ignoring any
 * other `mode` (e.g. `sms`, which never confirms a sale on its own —
 * see `mpesaSms.ts`) since only these two ever settle one. Shared by
 * {@link generateZReport} and {@link generateEndOfDayReport} (docs/
 * phase-158) — a shift's split and a cashier's split are the same
 * arithmetic over a different slice of payments, extracted here instead
 * of copied so the two never drift apart.
 *
 * @param {Array<Pick<MpesaPaymentRow, 'mode' | 'amount'>>} payments
 * @returns {MpesaModeTotals}
 */
function sumMpesaByMode(
  payments: Array<Pick<MpesaPaymentRow, 'mode' | 'amount'>>
): MpesaModeTotals {
  const totals: MpesaModeTotals = { manual: 0, daraja: 0 }
  for (const payment of payments) {
    if (payment.mode !== 'manual' && payment.mode !== 'daraja') continue
    totals[payment.mode] += payment.amount
  }
  return totals
}

/**
 * Extracts the VAT already included in a VAT-inclusive shelf price,
 * rather than adding tax on top of it (docs/phase-158, correcting the
 * old `totalRevenue * taxRate` formula — docs/phase-157 Part 3, G2 —
 * which double-counted: a 1.00 sale would report 1.16 as though 16%
 * had been added, when the customer paid exactly 1.00 and that 1.00
 * already contains VAT at the configured rate).
 *
 * `vatIncluded = total * rate / (1 + rate)` — the standard inverse of
 * `priceInclVat = priceExclVat * (1 + rate)`. Rounded to 2 decimal
 * places, matching every other currency figure this file produces.
 *
 * @param {number} total — revenue, as charged (VAT-inclusive)
 * @param {number} rate — fractional VAT rate (0.16 = 16%)
 * @returns {number}
 */
export function computeVatIncluded(total: number, rate: number): number {
  return Math.round(((total * rate) / (1 + rate)) * 100) / 100
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
 * payment method (M-Pesa further split by manual/Daraja, docs/
 * phase-158), the VAT included in that revenue at the store's
 * configured rate (see {@link computeVatIncluded} — orders don't store
 * VAT individually), and the cash reconciliation (expected vs.
 * counted, with discrepancy) already persisted on the shift row when
 * closed.
 *
 * @param {RubisDatabase} db
 * @param {number} shiftId
 * @param {number} taxRate — fractional store tax rate (0.16 = 16%)
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
  const mpesaByMode = sumMpesaByMode(excludeVoided(db.getMpesaPaymentsForShift(shiftId)))

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
    mpesaByMode,
    orderCount: orders.length,
    totalRevenue,
    vatIncluded: computeVatIncluded(totalRevenue, taxRate),
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
    vatIncluded: computeVatIncluded(totalRevenue, taxRate),
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
 * Shifts an ISO instant by the fixed Nairobi offset, so its UTC-named
 * fields (`getUTCFullYear` etc.) read as Nairobi wall-clock values.
 * Shared by {@link localDayOf} and {@link formatNairobiDateTime} so
 * both start from the identical shifted instant.
 *
 * @param {string} iso
 * @returns {Date}
 */
function toNairobiWallClock(iso: string): Date {
  return new Date(new Date(iso).getTime() + NAIROBI_UTC_OFFSET_MINUTES * 60 * 1000)
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
  const shifted = toNairobiWallClock(iso)
  const y = shifted.getUTCFullYear()
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Formats an ISO-8601 instant as a Nairobi-local `YYYY-MM-DD HH:mm:ss`
 * string — the CSV export's "date and time (Nairobi)" column
 * (docs/phase-158).
 *
 * @param {string} iso
 * @returns {string}
 */
export function formatNairobiDateTime(iso: string): string {
  const shifted = toNairobiWallClock(iso)
  const y = shifted.getUTCFullYear()
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const d = String(shifted.getUTCDate()).padStart(2, '0')
  const h = String(shifted.getUTCHours()).padStart(2, '0')
  const mi = String(shifted.getUTCMinutes()).padStart(2, '0')
  const s = String(shifted.getUTCSeconds()).padStart(2, '0')
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`
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
  mpesaByMode: MpesaModeTotals
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

  const paymentsByStaff = new Map<number, Array<MpesaPaymentRow & { status: OrderStatus }>>()
  for (const payment of todaysPayments) {
    const list = paymentsByStaff.get(payment.entered_by_staff_id)
    if (list) list.push(payment)
    else paymentsByStaff.set(payment.entered_by_staff_id, [payment])
  }

  const cashiers: CashierDaySummary[] = Array.from(ordersByStaff.entries()).map(
    ([staffId, staffOrders]) => ({
      staffId,
      staffName: staffName(staffId),
      orderCount: staffOrders.length,
      totalsByMethod: sumByPaymentMethod(staffOrders),
      mpesaByMode: sumMpesaByMode(paymentsByStaff.get(staffId) ?? [])
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

/**
 * A fixed set of Nairobi-local date ranges a report screen can offer as
 * buttons (docs/phase-158) — a manager picks one, never types a date, so
 * there is no free-text date input to validate at the IPC boundary.
 */
export const REPORT_RANGE_PRESETS = [
  'today',
  'yesterday',
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth'
] as const

export type ReportRangePreset = (typeof REPORT_RANGE_PRESETS)[number]

/** A resolved Nairobi-local date range, ready for the `getOrdersForDateRange`-style queries. */
export interface ReportRange {
  startIso: string
  endIso: string
  /** Human-readable, e.g. "This week (2026-09-21 to 2026-09-27)". */
  label: string
}

/**
 * Adds (or subtracts) `deltaDays` calendar days to a `YYYY-MM-DD`
 * string, in UTC so this is pure label arithmetic — the actual
 * Nairobi-offset conversion happens once, at the end, in
 * {@link getLocalDayRange}. Mirrors the identical helper in
 * `EndOfDayPage.tsx` (the renderer's day-picker), duplicated rather
 * than imported since the main process must not depend on renderer code.
 *
 * @param {string} localDay
 * @param {number} deltaDays
 * @returns {string}
 */
function shiftLocalDay(localDay: string, deltaDays: number): string {
  const [year, month, day] = localDay.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + deltaDays)).toISOString().slice(0, 10)
}

/** 0 (Monday) .. 6 (Sunday) for a `YYYY-MM-DD` string — used to find a week's Monday start. */
function isoWeekday(localDay: string): number {
  const [year, month, day] = localDay.split('-').map(Number)
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay() // 0 (Sun) .. 6 (Sat)
  return (jsDay + 6) % 7
}

/** The Monday on or before `localDay`. */
function mostRecentMonday(localDay: string): string {
  return shiftLocalDay(localDay, -isoWeekday(localDay))
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

/** `YYYY-MM-01` and the last day of that same month, as `YYYY-MM-DD` strings. */
function monthBounds(year: number, month1Indexed: number): { first: string; last: string } {
  const mm = String(month1Indexed).padStart(2, '0')
  const first = `${year}-${mm}-01`
  // Date.UTC's day-0 rolls back to the last day of the previous 0-indexed
  // month — passing the 1-indexed target month as the 0-indexed "next"
  // month is the standard trick, not an off-by-one.
  const lastDayNum = new Date(Date.UTC(year, month1Indexed, 0)).getUTCDate()
  const last = `${year}-${mm}-${String(lastDayNum).padStart(2, '0')}`
  return { first, last }
}

/**
 * Resolves a fixed preset into a concrete Nairobi-local date range.
 * Built entirely on {@link getLocalDayRange}/{@link localDayOf} — no
 * fresh UTC-offset arithmetic here — so it inherits their no-DST
 * reasoning (Kenya has kept a fixed UTC+3 offset since 1960, see the
 * comment above {@link getLocalDayRange}) rather than repeating it.
 *
 * @param {ReportRangePreset} preset
 * @param {Date} [now] — defaults to the current instant
 * @returns {ReportRange}
 */
export function getReportRange(preset: ReportRangePreset, now: Date = new Date()): ReportRange {
  const today = todayLocalDay(now)

  const dayRange = (day: string, label: string): ReportRange => ({
    ...getLocalDayRange(day),
    label: `${label} (${day})`
  })

  const spanRange = (start: string, end: string, label: string): ReportRange => ({
    startIso: getLocalDayRange(start).startIso,
    endIso: getLocalDayRange(end).endIso,
    label: `${label} (${start} to ${end})`
  })

  switch (preset) {
    case 'today':
      return dayRange(today, 'Today')
    case 'yesterday':
      return dayRange(shiftLocalDay(today, -1), 'Yesterday')
    case 'thisWeek': {
      const monday = mostRecentMonday(today)
      return spanRange(monday, shiftLocalDay(monday, 6), 'This week')
    }
    case 'lastWeek': {
      const lastMonday = shiftLocalDay(mostRecentMonday(today), -7)
      return spanRange(lastMonday, shiftLocalDay(lastMonday, 6), 'Last week')
    }
    case 'thisMonth': {
      const [year, month] = today.split('-').map(Number)
      const { first, last } = monthBounds(year, month)
      return {
        startIso: getLocalDayRange(first).startIso,
        endIso: getLocalDayRange(last).endIso,
        label: `This month (${MONTH_NAMES[month - 1]} ${year})`
      }
    }
    case 'lastMonth': {
      const [year, month] = today.split('-').map(Number)
      const prevYear = month === 1 ? year - 1 : year
      const prevMonth = month === 1 ? 12 : month - 1
      const { first, last } = monthBounds(prevYear, prevMonth)
      return {
        startIso: getLocalDayRange(first).startIso,
        endIso: getLocalDayRange(last).endIso,
        label: `Last month (${MONTH_NAMES[prevMonth - 1]} ${prevYear})`
      }
    }
  }
}

/** A date-range sales summary (docs/phase-158) — the multi-day generalisation of {@link DailySummary}. */
export interface SalesSummary {
  startIso: string
  endIso: string
  label: string
  orderCount: number
  totalRevenue: number
  vatIncluded: number
  totalsByMethod: PaymentTotals
  mpesaByMode: MpesaModeTotals
}

/**
 * Aggregates every order (and its M-Pesa payments) within a resolved
 * {@link ReportRange} — the same shape {@link generateDailySummary}
 * returns, plus the M-Pesa manual/Daraja split, over any of the fixed
 * presets rather than only "today".
 *
 * @param {RubisDatabase} db
 * @param {number} taxRate
 * @param {ReportRange} range
 * @returns {SalesSummary}
 */
export function generateSalesSummary(
  db: RubisDatabase,
  taxRate: number,
  range: ReportRange
): SalesSummary {
  const orders = excludeVoided(db.getOrdersForDateRange(range.startIso, range.endIso))
  const totalsByMethod = sumByPaymentMethod(orders)
  const totalRevenue = orders.reduce((sum, order) => sum + order.total, 0)
  const payments = excludeVoided(db.getMpesaPaymentsForDateRange(range.startIso, range.endIso))

  return {
    startIso: range.startIso,
    endIso: range.endIso,
    label: range.label,
    orderCount: orders.length,
    totalRevenue,
    vatIncluded: computeVatIncluded(totalRevenue, taxRate),
    totalsByMethod,
    mpesaByMode: sumMpesaByMode(payments)
  }
}

/** One Nairobi calendar day's fiscal-status counts. */
export interface FiscalStatusDayCount {
  localDay: string
  fiscalized: number
  waiting: number
  needsFixing: number
}

/**
 * Counts orders by fiscal status, one row per Nairobi calendar day
 * within `range` — grouped in JS via {@link localDayOf}, not a SQL
 * `GROUP BY`, since "which Nairobi day" is not something SQLite's date
 * functions can compute without duplicating that offset logic in SQL.
 *
 * Deliberately **not** run through {@link excludeVoided}: a fiscalised
 * sale stays filed with KRA even if it is later voided (voiding cannot
 * un-file it — docs/phase-157 Part 3, G13), so a fiscal-compliance view
 * should keep counting it rather than hide a real filing.
 *
 * @param {RubisDatabase} db
 * @param {ReportRange} range
 * @returns {FiscalStatusDayCount[]} sorted oldest day first
 */
export function generateFiscalStatusByDay(db: RubisDatabase, range: ReportRange): FiscalStatusDayCount[] {
  const orders = db.getOrdersForDateRange(range.startIso, range.endIso)
  const byDay = new Map<string, FiscalStatusDayCount>()

  for (const order of orders) {
    const day = localDayOf(order.created_at)
    const bucket = byDay.get(day) ?? { localDay: day, fiscalized: 0, waiting: 0, needsFixing: 0 }
    if (order.fiscal_status === 'fiscalized') bucket.fiscalized += 1
    else if (order.fiscal_status === 'waiting') bucket.waiting += 1
    else if (order.fiscal_status === 'needs_fixing') bucket.needsFixing += 1
    byDay.set(day, bucket)
  }

  return Array.from(byDay.values()).sort((a, b) => a.localDay.localeCompare(b.localDay))
}
