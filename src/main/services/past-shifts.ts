/**
 * Recording a shift for sales that had none (docs/phase-223): the list of days with such sales, and the
 * preview of what a chosen period would take. Both are read-only; the write is
 * {@link RubisDatabase.createRetrospectiveShift}, which re-checks everything inside its own transaction.
 */

import type { PaymentMethod, RubisDatabase, UnattachedSaleRow } from './database.js'
import { localDayOf } from './reports.js'
import { findOverlappingShift, parsePastShiftPeriod } from '../lib/pastShift.js'
import { shiftTypeForTime, shiftWindowOf, type ShiftType } from '../lib/shiftWindows.js'

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

/**
 * One group of sales with no shift. From {@link listUnattachedDays} it is a Nairobi calendar day. From
 * {@link listUnattachedOffers} (docs/phase-229) it is one run inside one Day or Night window, and the optional
 * fields below are set.
 */
export interface UnattachedDay {
  /** The Nairobi day; for an offer, the date its window starts on. */
  localDay: string
  count: number
  total: number
  /** First and last sale of the group, as instants. */
  firstAt: string
  lastAt: string
  /** The window's type (offers only): the shift type the new shift takes, whatever the period is later edited to. */
  shiftType?: ShiftType
  /**
   * The period to record, as instants (offers only): the whole minutes the sales fall in, held back from any shift
   * next to it, so it never touches one. The form sends these exactly unless the manager edits the times.
   */
  periodStartIso?: string
  periodEndIso?: string
  /** Set when this sale already lies inside that shift's window (offers only): it is reported, never offered. */
  insideShiftId?: number
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
 * The periods the till offers a past shift for (docs/phase-229). A sale's bucket is the Day or Night window it was
 * made in ({@link shiftWindowOf}); a night that runs past midnight is one bucket, dated by the evening it starts.
 * Inside a window, consecutive sales are cut into runs so that no run, first sale to last, touches an existing
 * shift. Each offer carries the window's type and a period of whole minutes held back from the shifts either side
 * of it, which is what the form sends. Oldest first.
 *
 * A sale that already sits inside an existing shift's window should not exist; if one does it gets an offer of its
 * own with `insideShiftId` set and nothing to record, and it never joins a run.
 *
 * The offers are only where to start: the manager may still change a period, and the main process re-checks the
 * overlap rule when the shift is written.
 *
 * @param {RubisDatabase} db
 * @returns {UnattachedDay[]} one entry per offer
 */
export function listUnattachedOffers(
  db: Pick<RubisDatabase, 'listUnattachedSales' | 'listShiftWindows'>
): UnattachedDay[] {
  const shifts = db.listShiftWindows()
  const offers: UnattachedDay[] = []
  let current: UnattachedDay | null = null
  let currentKey = ''
  let previousMs = 0
  for (const sale of db.listUnattachedSales()) {
    const saleMs = Date.parse(sale.created_at)
    const containing = findOverlappingShift(shifts, saleMs, saleMs)
    if (containing) {
      offers.push({
        localDay: shiftWindowOf(sale.created_at).startDate,
        count: 1,
        total: sale.total,
        firstAt: sale.created_at,
        lastAt: sale.created_at,
        insideShiftId: containing.id
      })
      current = null
      continue
    }
    const window = shiftWindowOf(sale.created_at)
    const key = `${window.type}|${window.startDate}`
    if (current !== null && key === currentKey && findOverlappingShift(shifts, previousMs, saleMs) === undefined) {
      current.count += 1
      current.total += sale.total
      current.lastAt = sale.created_at
    } else {
      current = {
        localDay: window.startDate,
        count: 1,
        total: sale.total,
        firstAt: sale.created_at,
        lastAt: sale.created_at,
        shiftType: window.type
      }
      currentKey = key
      offers.push(current)
    }
    previousMs = saleMs
  }
  for (const offer of offers) {
    if (offer.insideShiftId === undefined) setOfferPeriod(offer, shifts)
  }
  return offers
}

const MINUTE_MS = 60_000

/**
 * Sets an offer's period: from the start of its first sale's minute to the end of its last sale's minute, held
 * back to 1 ms from the nearest shift before and after (docs/phase-229). Without this a sale seconds from a shift
 * would give a whole-minute period that touches it, and the form would be refused.
 *
 * @param {UnattachedDay} offer
 * @param {Array<{ clock_in: string; clock_out: string | null }>} shifts
 */
function setOfferPeriod(offer: UnattachedDay, shifts: Array<{ clock_in: string; clock_out: string | null }>): void {
  const firstMs = Date.parse(offer.firstAt)
  const lastMs = Date.parse(offer.lastAt)
  let start = Math.floor(firstMs / MINUTE_MS) * MINUTE_MS
  let end = Math.floor(lastMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS - 1
  for (const shift of shifts) {
    const shiftStart = Date.parse(shift.clock_in)
    const shiftEnd = shift.clock_out === null ? Number.NaN : Date.parse(shift.clock_out)
    if (!Number.isNaN(shiftEnd) && shiftEnd < firstMs) start = Math.max(start, shiftEnd + 1)
    if (shiftStart > lastMs) end = Math.min(end, shiftStart - 1)
  }
  offer.periodStartIso = new Date(start).toISOString()
  offer.periodEndIso = new Date(end).toISOString()
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
