import type { SalesSummary, ShiftApprovalRow, ShiftEndOfDayReport, ZReport } from '../../../main/services/reports.js'
import type { ShiftRow } from '../../../main/services/database.js'
import { formatCurrency } from './currency.js'

/** What a card shows while its figure is still being read. */
export const HEADLINE_LOADING = '…'

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/**
 * The one figure on the cards of the Reports tab (docs/phase-246-1). Each takes what the main process already returned
 * for the section and words it; none reads anything else and none works a figure out. A count of rows is the most it does.
 */

/** @param {SalesSummary | null} summary @returns {string} the revenue of the scope */
export function takingsHeadline(summary: SalesSummary | null): string {
  return summary ? `Revenue ${formatCurrency(summary.totalRevenue)}` : HEADLINE_LOADING
}

/** @param {ZReport | null} report @returns {string} the cash difference of the shift, or why there is none */
export function zReportHeadline(report: ZReport | null): string {
  if (!report) return HEADLINE_LOADING
  if (report.cashNotCounted) return 'Cash not counted'
  if (report.discrepancy === null) return 'Shift open'
  return `Cash difference ${formatCurrency(report.discrepancy)}`
}

/** @param {ShiftEndOfDayReport | null} report @returns {string} where one shift's approval stands */
export function shiftEndOfDayHeadline(report: ShiftEndOfDayReport | null): string {
  if (!report) return HEADLINE_LOADING
  if (report.approval) return 'Approved'
  if (!report.canApprove) return 'Cannot approve yet'
  return report.pendingIds.length === 0 ? 'Nothing to approve' : `${plural(report.pendingIds.length, 'entry', 'entries')} to approve`
}

/** @param {ShiftApprovalRow[] | null} rows @returns {string} how many shifts of the range still await approval */
export function approvalRowsHeadline(rows: ShiftApprovalRow[] | null): string {
  if (!rows) return HEADLINE_LOADING
  const waiting = rows.filter((row) => row.state === 'not-approved').length
  return waiting === 0 ? 'Nothing to approve' : `${plural(waiting, 'shift', 'shifts')} to approve`
}

/** @param {SalesSummary | null} summary @returns {string} the number of sales the detail lists are about */
export function detailHeadline(summary: SalesSummary | null): string {
  return summary ? plural(summary.orderCount, 'sale', 'sales') : HEADLINE_LOADING
}

/** @param {ShiftRow[]} firstPage the newest shifts, as Shift History reads them @returns {string} the open shift, if there is one */
export function shiftsHeadline(firstPage: ShiftRow[]): string {
  const open = firstPage.find((shift) => shift.status === 'open')
  return open ? `Shift #${open.id} open` : 'No shift open'
}
