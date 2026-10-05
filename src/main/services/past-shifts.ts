/**
 * Recording a shift for sales that had none (docs/phase-223): the list of days with such sales, and the
 * preview of what a chosen period would take. Both are read-only; the write is
 * {@link RubisDatabase.createRetrospectiveShift}, which re-checks everything inside its own transaction.
 */

import type { PaymentMethod, RubisDatabase, UnattachedSaleRow } from './database.js'
import { localDayOf } from './reports.js'
import { findOverlappingShift, parsePastShiftPeriod } from '../lib/pastShift.js'
import { shiftTypeForTime, type ShiftType } from '../lib/shiftWindows.js'

/** The `shifts:create-past` request as the renderer sends it (validated by `createPastShiftSchema`). */
export interface CreatePastShiftRequest {
  managerId: number
  managerPin: string
  startIso: string
  endIso: string
  orderIds: number[]
  /** Both cash figures, or `cashNotCounted: true` and neither (docs/phase-227). */
  startingCash?: number
  endingCash?: number
  cashNotCounted?: boolean
  mpesaOpeningBalance?: number | null
  mpesaClosingBalance?: number | null
  shiftType: ShiftType
  reason: string
}

/** One Nairobi day that has sales with no shift. */
export interface UnattachedDay {
  localDay: string
  count: number
  total: number
  /** First and last sale of that day with no shift, as instants. */
  firstAt: string
  lastAt: string
}

/** The sales a period would take, and whether the period may be recorded at all. */
export interface PastShiftPreview {
  startIso: string
  endIso: string
  sales: Array<{ id: number; createdAt: string; method: PaymentMethod | null; total: number }>
  count: number
  total: number
  totalsByMethod: { cash: number; mpesa: number; card: number }
  /** Day or night from the period's start: the label an ordinary shift gets, which the manager may change. */
  suggestedShiftType: ShiftType
  /** Why this period cannot be recorded (bad times, in the future, overlaps a shift, no sales), or `null`. */
  problem: string | null
}

/**
 * Groups the sales that have no shift by Nairobi day, the same day every other report uses, oldest first. A night
 * that crosses midnight shows as two days; the manager may widen the period to cover both.
 *
 * @param {RubisDatabase} db
 * @returns {UnattachedDay[]}
 */
export function listUnattachedDays(db: Pick<RubisDatabase, 'listUnattachedSales'>): UnattachedDay[] {
  const days = new Map<string, UnattachedDay>()
  for (const sale of db.listUnattachedSales()) {
    const localDay = localDayOf(sale.created_at)
    const day = days.get(localDay)
    if (day) {
      day.count += 1
      day.total += sale.total
      day.lastAt = sale.created_at
    } else {
      days.set(localDay, { localDay, count: 1, total: sale.total, firstAt: sale.created_at, lastAt: sale.created_at })
    }
  }
  return Array.from(days.values())
}

/**
 * The periods the till offers a past shift for (docs/phase-227): each Nairobi day's sales with no shift, cut into
 * runs so that no run's period, first sale to last sale, touches an existing shift. A day that has a shift in the
 * middle of it gives one offer before the shift and one after it, never one that spans it. Oldest first.
 *
 * The offers are only where to start: the manager may still change a period, and the main process re-checks the
 * overlap rule when the shift is written.
 *
 * @param {RubisDatabase} db
 * @returns {UnattachedDay[]} one entry per offer; `localDay` may repeat across entries
 */
export function listUnattachedOffers(
  db: Pick<RubisDatabase, 'listUnattachedSales' | 'listShiftWindows'>
): UnattachedDay[] {
  const shifts = db.listShiftWindows()
  const offers: UnattachedDay[] = []
  let current: UnattachedDay | null = null
  let previousMs = 0
  for (const sale of db.listUnattachedSales()) {
    const localDay = localDayOf(sale.created_at)
    const saleMs = Date.parse(sale.created_at)
    const continuesRun =
      current !== null &&
      current.localDay === localDay &&
      findOverlappingShift(shifts, previousMs, saleMs) === undefined
    if (current !== null && continuesRun) {
      current.count += 1
      current.total += sale.total
      current.lastAt = sale.created_at
    } else {
      current = { localDay, count: 1, total: sale.total, firstAt: sale.created_at, lastAt: sale.created_at }
      offers.push(current)
    }
    previousMs = saleMs
  }
  return offers
}

/**
 * What a past shift for `[startIso, endIso]` would take, with the reason if it cannot be recorded. Never throws on
 * a bad period: the screen shows `problem` instead.
 *
 * @param {RubisDatabase} db
 * @param {string} startIso
 * @param {string} endIso
 * @param {number} [nowMs]
 * @returns {PastShiftPreview}
 */
export function previewPastShift(
  db: Pick<RubisDatabase, 'listUnattachedSalesInPeriod' | 'listShiftWindows'>,
  startIso: string,
  endIso: string,
  nowMs: number = Date.now()
): PastShiftPreview {
  const empty = {
    sales: [],
    count: 0,
    total: 0,
    totalsByMethod: { cash: 0, mpesa: 0, card: 0 }
  }
  let period
  try {
    period = parsePastShiftPeriod(startIso, endIso, nowMs)
  } catch (err) {
    return {
      startIso,
      endIso,
      ...empty,
      suggestedShiftType: 'day',
      problem: err instanceof Error ? err.message : 'The period is not valid'
    }
  }

  const rows: UnattachedSaleRow[] = db.listUnattachedSalesInPeriod(period.startIso, period.endIso)
  const totalsByMethod = { cash: 0, mpesa: 0, card: 0 }
  for (const row of rows) {
    if (row.payment_method) totalsByMethod[row.payment_method] += row.total
  }
  const overlap = findOverlappingShift(db.listShiftWindows(), period.startMs, period.endMs)
  return {
    startIso: period.startIso,
    endIso: period.endIso,
    sales: rows.map((row) => ({
      id: row.local_id,
      createdAt: row.created_at,
      method: row.payment_method,
      total: row.total
    })),
    count: rows.length,
    total: rows.reduce((sum, row) => sum + row.total, 0),
    totalsByMethod,
    suggestedShiftType: shiftTypeForTime(period.startIso),
    problem: overlap
      ? `This period overlaps shift #${overlap.id}`
      : rows.length === 0
        ? 'There are no sales without a shift in this period'
        : null
  }
}
