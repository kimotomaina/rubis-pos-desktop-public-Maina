/**
 * The combined window report (docs/phase-232, S10): every shift whose `clock_in` falls in one Day or Night window,
 * each with its own Z report, and the sums that are safe to add up. Read-only, and it only calls
 * {@link generateZReport}: there is no second calculation.
 *
 * What is added: the sales (orders, revenue, VAT, by method) and each shift's own difference. What is not: starting,
 * expected or counted cash. A drawer that carries over from one shift to the next would be counted twice, so those
 * stay per shift. A shift whose cash was not counted has no difference and is counted apart.
 */

import { sameWindow, shiftWindowOf, type ShiftType } from '../lib/shiftWindows.js'
import { windowName } from '../lib/shiftRules.js'
import type { RubisDatabase } from './database.js'
import { generateZReport, type PaymentTotals, type ZReport } from './reports.js'

/** What {@link generateWindowReport} needs from the database. */
export type WindowReportDb = Pick<
  RubisDatabase,
  | 'listShiftWindows'
  | 'getShiftById'
  | 'getOrdersForShift'
  | 'getStaffById'
  | 'getMpesaPaymentsForShift'
  | 'listShiftCorrections'
  | 'listShiftAdjustments'
  | 'listAdjustmentSales'
  | 'getShiftMerge'
>

/** One shift of the window, with the difference it shows now. */
export interface WindowReportShift {
  report: ZReport
  /** The difference as it stands now (the newest record's); `null` when the cash was not counted. */
  difference: number | null
}

/** The combined report of one window. */
export interface WindowReport {
  window: { type: ShiftType; startDate: string; name: string }
  shifts: WindowReportShift[]
  totals: {
    orderCount: number
    totalRevenue: number
    vatIncluded: number
    byMethod: PaymentTotals
    /** The sum of the differences of the shifts that were counted. */
    differenceSum: number
    /** Shifts with no difference because nobody counted the drawer. */
    notCountedShifts: number
  }
}

/**
 * The difference a shift shows now: the newest of its own, its corrections' and its adjustments' (which keep the
 * counted cash and recalculate the rest).
 *
 * @param {ZReport} report
 * @returns {number | null}
 */
function currentDifference(report: ZReport): number | null {
  const candidates: Array<{ at: string; difference: number }> = [
    ...(report.corrections ?? []).map((c) => ({ at: c.correctedAt, difference: c.discrepancy })),
    ...(report.adjustments ?? [])
      .filter((a) => a.discrepancy !== null)
      .map((a) => ({ at: a.at, difference: a.discrepancy as number }))
  ]
  if (candidates.length > 0) return candidates.reduce((newest, next) => (next.at >= newest.at ? next : newest)).difference
  return report.cashNotCounted ? null : report.discrepancy
}

/**
 * @param {WindowReportDb} db
 * @param {number} taxRate
 * @param {ShiftType} type
 * @param {string} startDate — `YYYY-MM-DD`, the date the window starts on
 * @returns {WindowReport}
 */
export function generateWindowReport(
  db: WindowReportDb,
  taxRate: number,
  type: ShiftType,
  startDate: string
): WindowReport {
  const window = { type, startDate }
  const ids = db
    .listShiftWindows()
    .filter((shift) => {
      try {
        return sameWindow(shiftWindowOf(shift.clock_in), window)
      } catch {
        return false
      }
    })
    .sort((a, b) => a.clock_in.localeCompare(b.clock_in) || a.id - b.id)
    .map((shift) => shift.id)
  const shifts = ids.map((id) => {
    const report = generateZReport(db as RubisDatabase, id, taxRate)
    return { report, difference: currentDifference(report) }
  })
  const sum = (pick: (report: ZReport) => number): number => shifts.reduce((total, { report }) => total + pick(report), 0)
  const counted = shifts.filter((shift) => shift.difference !== null)
  return {
    window: { type, startDate, name: windowName(window) },
    shifts,
    totals: {
      orderCount: sum((r) => r.orderCount),
      totalRevenue: sum((r) => r.totalRevenue),
      vatIncluded: sum((r) => r.vatIncluded),
      byMethod: {
        cash: sum((r) => r.totalsByMethod.cash),
        mpesa: sum((r) => r.totalsByMethod.mpesa),
        card: sum((r) => r.totalsByMethod.card)
      },
      differenceSum: counted.reduce((total, shift) => total + (shift.difference as number), 0),
      notCountedShifts: shifts.length - counted.length
    }
  }
}
