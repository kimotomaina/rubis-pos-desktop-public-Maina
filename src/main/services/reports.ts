/**
 * Shift Z-reports and daily sales summaries.
 *
 * Both aggregations read directly from the local `orders` ledger — no
 * network access — so they work identically online or offline, and
 * reflect cash actually collected regardless of a given order's
 * Shopify sync status.
 */

import type {
  RubisDatabase,
  PaymentMethod,
  OrderRow,
  MpesaPaymentRow,
  OrderStatus,
  ShiftRow
} from './database.js'
import type { FiscalVatGroupAmounts } from './integrations/etims.js'
import type { Logger } from './logger.js'
import { resolveTraderSystemInvNum } from '../lib/traderSystemInvoiceNumber.js'
import { shiftWindowLabel, type ShiftType } from '../lib/shiftWindows.js'
import { withWindow } from '../lib/shiftLabel.js'
import {
  compareVatGroups,
  expectedGroupTotals,
  grossToVat,
  hasNonAClass,
  type VatClassLine
} from '../lib/vatClass.js'

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
  /**
   * The store's configured VAT rate used to compute {@link vatIncluded}
   * (docs/phase-158-1) — carried on the report so the printed slip and
   * the on-screen modal can both label it correctly (e.g. "calculated at
   * 16%") without hardcoding a rate that a config change would silently
   * make wrong. See {@link formatVatRateLabel}.
   */
  vatRate: number
  expectedCash: number
  endingCash: number | null
  discrepancy: number | null
  /** Which shift was opened, when it was recorded (docs/phase-199); absent on a shift opened before then. */
  shiftType?: ShiftType | null
  /** The nominal window of {@link shiftType}, e.g. `Day shift (07:00 to 17:30)`; absent with it. */
  shiftWindowLabel?: string | null
  /**
   * The M-Pesa till balances for the shift (docs/phase-222). Every one is `null` when it was not recorded,
   * which the report shows as "Not recorded", never as 0. Optional, so a report from before the phase has none.
   */
  mpesaOpeningBalance?: number | null
  /** Opening balance + this shift's M-Pesa sales: live while open, as stored at close once closed. */
  mpesaExpected?: number | null
  mpesaClosingBalance?: number | null
  /** Counted − expected: a prompt to check the M-Pesa statement, never a shortage. */
  mpesaDifference?: number | null
  /**
   * `'retrospective'` for a shift recorded after the fact (docs/phase-223); its creator, time and reason follow.
   * Absent or `'normal'` otherwise. The Z report says so on screen and on paper.
   */
  kind?: 'normal' | 'retrospective'
  createdAt?: string | null
  createdByName?: string | null
  reason?: string | null
  /**
   * Corrections of the figures typed in for this shift, oldest first (docs/phase-224). The figures above are
   * always the original ones; the last correction here is the current figures. Absent or empty when none.
   */
  corrections?: ZReportCorrection[]
  /**
   * `true` when nobody counted the drawer for this shift (docs/phase-227). The report then shows "Cash not counted"
   * and the cash sales, and none of starting, expected or counted cash or the difference: those fields are 0 or
   * `null` here and mean nothing. Absent or `false` for every other shift.
   */
  cashNotCounted?: boolean
  /**
   * The stored label when it differs from the window of `clock_in` (docs/phase-232, W4): `shiftType` is always the
   * window's. The report says "Labelled Day when opened". Absent when they agree, or there was no label.
   */
  labelledAs?: ShiftType | null
  /** `true` for a shift the till made itself for sales that had none (docs/phase-232). Absent otherwise. */
  createdAutomatically?: boolean
  /** Sales that joined or left this shift after it was opened or made, oldest first (docs/phase-232). Absent or empty when none. */
  adjustments?: ZReportAdjustment[]
  /**
   * What the shift held when it was closed, present only when later joins or moves mean the figures above now count
   * more or fewer sales (docs/phase-232).
   */
  salesAtClose?: { orderCount: number; totalRevenue: number; cash: number; mpesa: number; card: number }
}

/** One adjustment as the Z report shows it (docs/phase-232). */
export interface ZReportAdjustment {
  id: number
  kind: 'opening' | 'auto' | 'reassign_in' | 'reassign_out'
  at: string
  /** The admin who moved the sale; `null` when the till did it itself. */
  byName: string | null
  reason: string
  peerShiftId: number | null
  salesCount: number
  salesTotal: number
  cashTotal: number
  mpesaTotal: number
  cardTotal: number
  firstSaleAt: string | null
  lastSaleAt: string | null
  openingDrawerCash: number | null
  startingCash: number | null
  endingCash: number | null
  expectedCash: number | null
  discrepancy: number | null
  mpesaOpeningBalance: number | null
  mpesaClosingBalance: number | null
  mpesaExpected: number | null
  mpesaDifference: number | null
}

/** One correction as the Z report shows it (docs/phase-224). */
export interface ZReportCorrection {
  id: number
  correctedAt: string
  correctedByName: string
  reason: string
  startingCash: number
  endingCash: number
  expectedCash: number
  discrepancy: number
  mpesaOpeningBalance: number | null
  mpesaClosingBalance: number | null
  mpesaExpected: number | null
  mpesaDifference: number | null
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
 * The sale's lines as the stored fiscal request recorded them — the only
 * place a sale's per-line VAT class is kept before and after filing.
 *
 * @param {Pick<OrderRow, 'fiscal_request_json'>} order
 * @returns {VatClassLine[] | null} `null` for an order with no stored request (older, or never sent), or an unreadable one
 */
function requestLines(order: Pick<OrderRow, 'fiscal_request_json'>): VatClassLine[] | null {
  if (!order.fiscal_request_json) return null
  try {
    const items = (JSON.parse(order.fiscal_request_json) as { items?: unknown }).items
    if (!Array.isArray(items)) return null
    return items.map((item: Partial<VatClassLine>) => ({
      unitPrice: Number(item.unitPrice),
      quantity: Number(item.quantity),
      vatClass: item.vatClass
    }))
  } catch {
    return null
  }
}

/**
 * The part of an order's total that carries VAT at the store's rate
 * (docs/phase-194): the whole total for an order with only class-A lines
 * or no stored request, and the class-A lines' amount alone for an order
 * that also sold zero-rated, exempt or other-rate items.
 *
 * @param {Pick<OrderRow, 'total' | 'fiscal_request_json'>} order
 * @returns {number}
 */
export function orderVatBase(order: Pick<OrderRow, 'total' | 'fiscal_request_json'>): number {
  const lines = requestLines(order)
  if (!lines || !hasNonAClass(lines)) return order.total
  return expectedGroupTotals(lines).A
}

/**
 * Sums {@link orderVatBase} over a set of orders, in order, so an
 * all-class-A set gives exactly the sum of the totals.
 *
 * @param {Array<Pick<OrderRow, 'total' | 'fiscal_request_json'>>} orders
 * @returns {number}
 */
function sumVatBase(orders: Array<Pick<OrderRow, 'total' | 'fiscal_request_json'>>): number {
  return orders.reduce((sum, order) => sum + orderVatBase(order), 0)
}

/**
 * Renders the VAT rate as the label shown next to {@link computeVatIncluded}'s
 * result (docs/phase-158-1, correcting a rate hardcoded as "16%" in three
 * places — `ZReportModal.tsx`, `renderZReport`, and the Sales Summary
 * view — which would have silently mislabelled the figure the moment the
 * store's configured rate ever changed, e.g. to 8%).
 *
 * @param {number} rate — fractional VAT rate (0.16 = 16%)
 * @returns {string}
 */
export function formatVatRateLabel(rate: number): string {
  return `VAT included (calculated at ${Math.round(rate * 100)}%)`
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
  const stored = db.getShiftById(shiftId)
  if (!stored) {
    throw new Error(`Shift ${shiftId} not found`)
  }
  const shift = stored
  const windowed = withWindow(stored)
  const shownType: ShiftType | null = windowed.window_type ?? shift.shift_type ?? null

  const orders = excludeVoided(db.getOrdersForShift(shiftId))
  const totalsByMethod = sumByPaymentMethod(orders)
  const totalRevenue = orders.reduce((sum, order) => sum + order.total, 0)
  const staffName = db.getStaffById(shift.staff_id)?.name ?? 'Unknown'
  const mpesaByMode = sumMpesaByMode(excludeVoided(db.getMpesaPaymentsForShift(shiftId)))

  const cashNotCounted = shift.cash_not_counted === 1
  const expectedCash = cashNotCounted
    ? 0
    : shift.status === 'closed' && shift.expected_cash !== null
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
    vatIncluded: computeVatIncluded(sumVatBase(orders), taxRate),
    vatRate: taxRate,
    expectedCash,
    endingCash: shift.ending_cash,
    discrepancy: shift.discrepancy,
    shiftType: shownType,
    shiftWindowLabel: shownType ? shiftWindowLabel(shownType) : null,
    ...(windowed.labelled_as ? { labelledAs: windowed.labelled_as } : {}),
    ...(shift.staff_id === 0 ? { createdAutomatically: true } : {}),
    ...adjustmentFields(db, shiftId, orders),
    ...mpesaBalanceFields(shift, totalsByMethod.mpesa),
    kind: shift.kind ?? 'normal',
    createdAt: shift.created_at ?? null,
    createdByName:
      shift.created_by_staff_id != null ? (db.getStaffById(shift.created_by_staff_id)?.name ?? 'Unknown') : null,
    reason: shift.reason ?? null,
    // Only when set, so the report of every other shift is exactly what it was before docs/phase-227.
    ...(cashNotCounted ? { cashNotCounted: true } : {}),
    corrections: db.listShiftCorrections(shiftId).map((row) => ({
      id: row.id,
      correctedAt: row.corrected_at,
      correctedByName: db.getStaffById(row.corrected_by_staff_id)?.name ?? 'Unknown',
      reason: row.reason,
      startingCash: row.starting_cash,
      endingCash: row.ending_cash,
      expectedCash: row.expected_cash,
      discrepancy: row.discrepancy,
      mpesaOpeningBalance: row.mpesa_opening_balance,
      mpesaClosingBalance: row.mpesa_closing_balance,
      mpesaExpected: row.mpesa_expected,
      mpesaDifference: row.mpesa_difference
    }))
  }
}

/**
 * The adjustments of a Z report and, when later joins or moves changed what the shift counts, the sales it held at
 * close (docs/phase-232). A sale is "at close" if its first record on this shift is that it came with the shift
 * (`opening`) or was moved out of it, or it has no record at all and is attached now. A sale that joined later, or
 * was voided since, is not. Empty for a shift with no adjustments, so its report is exactly what it was.
 *
 * @param {RubisDatabase} db
 * @param {number} shiftId
 * @param {OrderRow[]} liveOrders — the shift's sales now, voided ones left out
 * @returns {Pick<ZReport, 'adjustments' | 'salesAtClose'>}
 */
function adjustmentFields(
  db: RubisDatabase,
  shiftId: number,
  liveOrders: OrderRow[]
): Pick<ZReport, 'adjustments' | 'salesAtClose'> {
  const rows = db.listShiftAdjustments(shiftId)
  if (rows.length === 0) return {}
  const adjustments: ZReportAdjustment[] = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    at: row.at,
    byName: row.by_staff_id === null ? null : (db.getStaffById(row.by_staff_id)?.name ?? 'Unknown'),
    reason: row.reason,
    peerShiftId: row.peer_shift_id,
    salesCount: row.sales_count,
    salesTotal: row.sales_total,
    cashTotal: row.cash_total,
    mpesaTotal: row.mpesa_total,
    cardTotal: row.card_total,
    firstSaleAt: row.first_sale_at,
    lastSaleAt: row.last_sale_at,
    openingDrawerCash: row.opening_drawer_cash,
    startingCash: row.starting_cash,
    endingCash: row.ending_cash,
    expectedCash: row.expected_cash,
    discrepancy: row.discrepancy,
    mpesaOpeningBalance: row.mpesa_opening_balance,
    mpesaClosingBalance: row.mpesa_closing_balance,
    mpesaExpected: row.mpesa_expected,
    mpesaDifference: row.mpesa_difference
  }))
  if (rows.every((row) => row.kind === 'opening')) return { adjustments }

  const sales = db.listAdjustmentSales(shiftId)
  const firstKind = new Map<number, string>()
  for (const sale of sales) if (!firstKind.has(sale.order_id)) firstKind.set(sale.order_id, sale.kind)
  const known = new Map<number, { total: number; method: string | null; voided: boolean }>()
  for (const order of liveOrders) known.set(order.local_id, { total: order.total, method: order.payment_method, voided: false })
  for (const sale of sales) {
    if (!known.has(sale.order_id)) {
      known.set(sale.order_id, { total: sale.total, method: sale.payment_method, voided: sale.status === 'voided' })
    }
  }
  const atClose = Array.from(known.entries()).filter(([id, sale]) => {
    const kind = firstKind.get(id)
    return !sale.voided && (kind === undefined || kind === 'opening' || kind === 'reassign_out')
  })
  const totalFor = (method: string): number =>
    atClose.filter(([, sale]) => sale.method === method).reduce((sum, [, sale]) => sum + sale.total, 0)
  return {
    adjustments,
    salesAtClose: {
      orderCount: atClose.length,
      totalRevenue: atClose.reduce((sum, [, sale]) => sum + sale.total, 0),
      cash: totalFor('cash'),
      mpesa: totalFor('mpesa'),
      card: totalFor('card')
    }
  }
}

/**
 * The M-Pesa balance figures of a Z report (docs/phase-222). A closed shift reports what was stored at
 * close, so a later change to this code cannot rewrite it; an open shift shows its expected figure live
 * when it has an opening balance. A shift without a balance reports `null`, never 0.
 *
 * @param {ShiftRow} shift
 * @param {number} mpesaSales — the shift's non-voided M-Pesa sales
 */
function mpesaBalanceFields(
  shift: ShiftRow,
  mpesaSales: number
): Pick<ZReport, 'mpesaOpeningBalance' | 'mpesaExpected' | 'mpesaClosingBalance' | 'mpesaDifference'> {
  const opening = shift.mpesa_opening_balance ?? null
  const live = shift.status === 'open' && opening !== null ? opening + mpesaSales : null
  return {
    mpesaOpeningBalance: opening,
    mpesaExpected: shift.status === 'closed' ? (shift.mpesa_expected ?? null) : live,
    mpesaClosingBalance: shift.mpesa_closing_balance ?? null,
    mpesaDifference: shift.mpesa_difference ?? null
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
    vatIncluded: computeVatIncluded(sumVatBase(orders), taxRate),
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
export const NAIROBI_UTC_OFFSET_MINUTES = 3 * 60

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
export function toNairobiWallClock(iso: string): Date {
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
  /** See {@link ZReport.vatRate} — same reasoning, this is the multi-day view. */
  vatRate: number
  totalsByMethod: PaymentTotals
  mpesaByMode: MpesaModeTotals
  /**
   * VAT derived from the fiscal device's own per-VAT-group amounts
   * (docs/phase-163, Commit 2) — a separate figure from {@link vatIncluded}
   * (which is calculated from `total` at the store's single configured
   * rate) shown alongside it, not in place of it. Only ever a best-effort
   * total across `'fiscalized'` orders that carry a stored device figure;
   * silently excludes orders with none (an older sale, an already-filed
   * recovery, or a non-numeric device value) and excludes VAT-group `'D'`
   * entirely (its rate is not known — see {@link deriveGroupVat}), rather
   * than guessing either. Voided orders are excluded, matching every
   * other figure on this report. See {@link vatFromDeviceGroupsCoverage}
   * for how much of the range this figure actually covers.
   */
  vatFromDeviceGroups: number
  /**
   * Coverage caption for {@link vatFromDeviceGroups} (docs/phase-163-1) —
   * e.g. "from 12 of 15 sales; group D not included" — so the figure is
   * never mistaken for covering every fiscalised sale in the range.
   */
  vatFromDeviceGroupsCoverage: VatFromDeviceGroupsCoverage
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
  const { total: vatFromDeviceGroups, ...vatFromDeviceGroupsCoverage } = sumVatFromDeviceGroups(orders)

  return {
    startIso: range.startIso,
    endIso: range.endIso,
    label: range.label,
    orderCount: orders.length,
    totalRevenue,
    vatIncluded: computeVatIncluded(sumVatBase(orders), taxRate),
    vatRate: taxRate,
    totalsByMethod,
    mpesaByMode: sumMpesaByMode(payments),
    vatFromDeviceGroups,
    vatFromDeviceGroupsCoverage
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

/** A per-VAT-group amount, keyed by the VAT class letter `FiscalInvoiceLine.vatClass` already uses. */
type VatGroupLetter = 'A' | 'B' | 'C' | 'D' | 'E'

const VAT_GROUP_LETTERS: readonly VatGroupLetter[] = ['A', 'B', 'C', 'D', 'E']

/**
 * The VAT captured within one VAT-group's amount, derived from the
 * confirmed VIL manual rate table (docs/phase-65: `'A'`=16%, `'B'`=8%,
 * `'C'`=0%, `'D'`="usually free for any other rates", `'E'`=Exempt).
 * `'A'`/`'B'` use the standard VAT-inclusive extraction
 * (`amount * rate / (1 + rate)`, the same shape {@link computeVatIncluded}
 * uses); `'C'`/`'E'` are always zero. `'D'` has no single rate the manual
 * commits to, so its VAT is reported as `'not-known'` rather than guessed
 * at any particular percentage.
 *
 * @param {VatGroupLetter} letter
 * @param {number} amount
 * @returns {number | 'not-known'}
 */
function deriveGroupVat(letter: VatGroupLetter, amount: number): number | 'not-known' {
  if (letter === 'A' || letter === 'B') return grossToVat(letter, amount)
  if (letter === 'C' || letter === 'E') return 0
  return 'not-known'
}

/**
 * How much of a {@link generateSalesSummary}'s `vatFromDeviceGroups`
 * figure is actually backed by a usable device reading (docs/phase-163-1)
 * — the "from 12 of 15 sales" caption shown next to it, so the figure is
 * never read as covering every fiscalised sale in the range when it may
 * not.
 */
export interface VatFromDeviceGroupsCoverage {
  /** Fiscalised orders in range whose stored device figure could be fully parsed and summed. */
  ordersWithFigure: number
  /** Fiscalised orders in range, the coverage's denominator. */
  ordersFiscalized: number
}

/**
 * Best-effort total VAT across a set of orders' stored device figures,
 * plus how many of them actually contributed to it — the Sales Summary's
 * "VAT from device groups" (docs/phase-163, Commit 2) and its coverage
 * caption (docs/phase-163-1). An order counts as "with figure" only when
 * `fiscal_vat_groups_json` is present, parses, and every group it
 * contains is numeric — the same all-or-nothing rule
 * {@link buildReconciliationRow} applies, so the two reports' coverage
 * language means the same thing; a `'not-known'`-VAT group (`'D'`) still
 * counts as "with figure" if its own amount was numeric, since the
 * device DID answer, this file just cannot derive its VAT (rather than
 * this being treated the same as the device answering nothing at all).
 * This is a rough aggregate shown alongside the existing calculated VAT
 * figure, not a compliance check, so a bad or missing figure is skipped
 * silently here rather than logged — the fiscal reconciliation report is
 * where that gets surfaced and logged per order.
 *
 * @param {OrderRow[]} orders
 * @returns {{ total: number } & VatFromDeviceGroupsCoverage}
 */
function sumVatFromDeviceGroups(
  orders: OrderRow[]
): { total: number } & VatFromDeviceGroupsCoverage {
  let total = 0
  let ordersWithFigure = 0
  let ordersFiscalized = 0
  for (const order of orders) {
    if (order.fiscal_status !== 'fiscalized') continue
    ordersFiscalized += 1
    if (!order.fiscal_vat_groups_json) continue
    let rawGroups: FiscalVatGroupAmounts
    try {
      rawGroups = JSON.parse(order.fiscal_vat_groups_json) as FiscalVatGroupAmounts
    } catch {
      continue
    }
    let sawNumericGroup = false
    let sawNonNumericGroup = false
    let orderVat = 0
    for (const letter of VAT_GROUP_LETTERS) {
      const raw = rawGroups[letter]
      if (raw === undefined) continue
      const amount = Number(raw)
      if (!Number.isFinite(amount)) {
        sawNonNumericGroup = true
        break
      }
      sawNumericGroup = true
      const vat = deriveGroupVat(letter, amount)
      if (vat !== 'not-known') orderVat += vat
    }
    if (sawNonNumericGroup || !sawNumericGroup) continue
    ordersWithFigure += 1
    total += orderVat
  }
  return { total: Math.round(total * 100) / 100, ordersWithFigure, ordersFiscalized }
}

/** One VAT-group's amount and derived VAT, for one reconciliation row. */
export interface FiscalReconciliationGroupVat {
  amount: number
  vat: number | 'not-known'
}

/**
 * How one fiscalised order's charged amount compares to the fiscal
 * device's own validated total (docs/phase-159 B1.1/B1.2, VIL checklist
 * item 13):
 *
 *   - `'matched'`         — the two amounts agree within 1 cent.
 *   - `'mismatch'`        — they genuinely differ (e.g. the docs/phase-160
 *     discount case: the device was never told about a discount, so it
 *     validated the undiscounted line amount while the till charged less).
 *   - `'no-device-figure'` — `fiscal_vat_groups_json` is `NULL` (an older
 *     sale filed before this column existed, or an already-filed recovery
 *     that never re-ran Step 5) or carries a non-numeric value. Never
 *     reported as a `'mismatch'` — there is nothing to compare against,
 *     not a confirmed disagreement.
 */
export type FiscalReconciliationStatus = 'matched' | 'mismatch' | 'no-device-figure'

/** One fiscalised order's reconciliation figures. */
export interface FiscalReconciliationRow {
  localId: number
  createdAt: string
  traderInvoiceNumber: string
  /** The KRA/eTIMS invoice number `CloseReceipt` returned — `null` should not occur for a `'fiscalized'` order, but the column itself is nullable. */
  cuInvoiceNumber: string | null
  /** What the till charged the customer (`order.total`). */
  charged: number
  /** Sum of the present VAT-group amounts, or `null` for `'no-device-figure'`. */
  deviceTotal: number | null
  /** `deviceTotal - charged`, or `null` for `'no-device-figure'`. */
  difference: number | null
  status: FiscalReconciliationStatus
  /** Present groups only — a group absent from the device's response is absent here too. */
  vatByGroup: Partial<Record<VatGroupLetter, FiscalReconciliationGroupVat>>
  /**
   * What the sale's own lines put in each group, from the stored fiscal
   * request (docs/phase-194); `null` when no request is stored.
   */
  expectedByGroup: Record<VatGroupLetter, number> | null
  /**
   * Which non-A groups disagree with the sale's own lines, or `null` when
   * they agree or the sale has no non-A line. Any disagreement makes the
   * row a `'mismatch'` even when the totals agree.
   */
  groupMismatch: string | null
}

/** Aggregate counts and sums across every row in a {@link FiscalReconciliationReport}. */
export interface FiscalReconciliationTotals {
  matched: number
  mismatch: number
  noDeviceFigure: number
  sumCharged: number
  sumDevice: number
  sumDifference: number
}

/** The fiscal reconciliation report for a date range (docs/phase-163, Commit 2). */
export interface FiscalReconciliationReport {
  startIso: string
  endIso: string
  label: string
  /** Mismatches first, then no-device-figure, then matched — each group otherwise in the order the orders were created. */
  rows: FiscalReconciliationRow[]
  totals: FiscalReconciliationTotals
}

/** Sort weight for {@link FiscalReconciliationStatus} — lower sorts first. */
function reconciliationSortWeight(status: FiscalReconciliationStatus): number {
  if (status === 'mismatch') return 0
  if (status === 'no-device-figure') return 1
  return 2
}

/**
 * Builds one order's reconciliation row. A non-numeric VAT-group amount
 * makes the WHOLE row `'no-device-figure'` (not just that one group) —
 * a device response this build cannot parse tells us nothing usable
 * about the sale's true device-validated total, logged once so a
 * genuinely malformed response doesn't pass silently.
 *
 * Exported so `reportsExport.ts`'s `orders.csv` can reuse the identical
 * figures rather than re-deriving them, so the report screen and the CSV
 * export can never drift apart on what "matched"/"mismatch" means.
 *
 * @param {OrderRow} order a `fiscal_status === 'fiscalized'` order
 * @param {Logger} logger
 * @returns {FiscalReconciliationRow}
 */
export function buildReconciliationRow(order: OrderRow, logger: Logger): FiscalReconciliationRow {
  const payload = JSON.parse(order.payload_json || '{}') as { clientOrderUuid?: string }
  const traderInvoiceNumber = resolveTraderSystemInvNum(
    order.fiscal_trader_inv_num,
    order.local_id,
    payload.clientOrderUuid ?? ''
  )
  const charged = order.total
  const base = {
    localId: order.local_id,
    createdAt: order.created_at,
    traderInvoiceNumber,
    cuInvoiceNumber: order.fiscal_invoice_number,
    charged
  }

  if (!order.fiscal_vat_groups_json) {
    return {
      ...base,
      deviceTotal: null,
      difference: null,
      status: 'no-device-figure',
      vatByGroup: {},
      expectedByGroup: null,
      groupMismatch: null
    }
  }

  const rawGroups = JSON.parse(order.fiscal_vat_groups_json) as FiscalVatGroupAmounts
  const parsedAmounts: Partial<Record<VatGroupLetter, number>> = {}
  for (const letter of VAT_GROUP_LETTERS) {
    const raw = rawGroups[letter]
    if (raw === undefined) continue
    const value = Number(raw)
    if (!Number.isFinite(value)) {
      logger.warn(
        `[rubis-pos] Fiscal reconciliation: order ${order.local_id} has a non-numeric VAT-group ${letter} ` +
          `amount ("${raw}") — reported as no device figure, not a mismatch`
      )
      return {
        ...base,
        deviceTotal: null,
        difference: null,
        status: 'no-device-figure',
        vatByGroup: {},
        expectedByGroup: null,
        groupMismatch: null
      }
    }
    parsedAmounts[letter] = value
  }

  const deviceTotal =
    Math.round(Object.values(parsedAmounts).reduce((sum: number, value) => sum + (value ?? 0), 0) * 100) / 100
  const difference = Math.round((deviceTotal - charged) * 100) / 100
  const lines = requestLines(order)
  const expected = lines ? expectedGroupTotals(lines) : null
  const groupMismatch = lines && expected && hasNonAClass(lines) ? compareVatGroups(expected, rawGroups) : null
  const status: FiscalReconciliationStatus =
    Math.abs(difference) <= 0.01 && groupMismatch === null ? 'matched' : 'mismatch'
  const vatByGroup: Partial<Record<VatGroupLetter, FiscalReconciliationGroupVat>> = {}
  for (const letter of Object.keys(parsedAmounts) as VatGroupLetter[]) {
    const amount = parsedAmounts[letter] as number
    vatByGroup[letter] = { amount, vat: deriveGroupVat(letter, amount) }
  }

  return { ...base, deviceTotal, difference, status, vatByGroup, expectedByGroup: expected, groupMismatch }
}

/**
 * Fiscal reconciliation report (docs/phase-159 B1.1/B1.2, builds 2-3;
 * VIL checklist item 13 — "system invoice amount versus the validated
 * amount"): for every `'fiscalized'` order in `range`, compares what the
 * till charged against the fiscal device's own per-VAT-group amounts
 * (stored verbatim by docs/phase-163's Commit 1), read-only — no device
 * command is sent here.
 *
 * Deliberately **not** run through {@link excludeVoided}, exactly like
 * {@link generateFiscalStatusByDay}: a fiscalised sale stays filed with
 * KRA even if it is later voided, so this view must keep showing it
 * rather than hide a real filing.
 *
 * @param {RubisDatabase} db
 * @param {ReportRange} range
 * @param {Logger} [logger] defaults to `console`
 * @returns {FiscalReconciliationReport}
 */
export function generateFiscalReconciliation(
  db: RubisDatabase,
  range: ReportRange,
  logger: Logger = console
): FiscalReconciliationReport {
  const fiscalisedOrders = db
    .getOrdersForDateRange(range.startIso, range.endIso)
    .filter((order) => order.fiscal_status === 'fiscalized')

  const rows = fiscalisedOrders.map((order) => buildReconciliationRow(order, logger))
  rows.sort((a, b) => reconciliationSortWeight(a.status) - reconciliationSortWeight(b.status))

  const totals = rows.reduce<FiscalReconciliationTotals>(
    (acc, row) => {
      if (row.status === 'matched') acc.matched += 1
      else if (row.status === 'mismatch') acc.mismatch += 1
      else acc.noDeviceFigure += 1
      acc.sumCharged = Math.round((acc.sumCharged + row.charged) * 100) / 100
      if (row.deviceTotal !== null) acc.sumDevice = Math.round((acc.sumDevice + row.deviceTotal) * 100) / 100
      if (row.difference !== null) {
        acc.sumDifference = Math.round((acc.sumDifference + row.difference) * 100) / 100
      }
      return acc
    },
    { matched: 0, mismatch: 0, noDeviceFigure: 0, sumCharged: 0, sumDevice: 0, sumDifference: 0 }
  )

  return { startIso: range.startIso, endIso: range.endIso, label: range.label, rows, totals }
}
