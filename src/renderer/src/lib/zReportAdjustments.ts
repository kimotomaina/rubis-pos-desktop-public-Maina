/**
 * The lines that show a shift's adjustments on a Z report (docs/phase-232): sales that joined it after it was opened
 * or made, and sales an admin moved in or out. The printed slip and the on-screen modal say the same words. The
 * renderer-side twin of `main/lib/zReportAdjustments.ts`, a copy because main-process code is never bundled into the
 * renderer; `tests/shiftWindowsZReport.test.ts` runs both over the same reports so they cannot drift.
 *
 * The original figures are left exactly as they were; each record is shown under them, oldest first, merged with
 * the corrections by time, so the newest record is the last one printed.
 */

import type { ShiftType } from '../../../main/lib/shiftWindows.js'
import type { ZReport, ZReportAdjustment } from '../../../main/services/reports.js'
import { zReportCorrectionBlocks, type CorrectionBlock } from './zReportCorrections.js'
import { zReportMpesaLines } from './zReportMpesa.js'

/**
 * @param {number} count
 * @returns {string} `1 sale` or `3 sales`
 */
function salesText(count: number): string {
  return count === 1 ? '1 sale' : `${count} sales`
}

/**
 * One adjustment as text: a heading, and what it holds and the figures it gives.
 *
 * @param {ZReportAdjustment} adjustment
 * @param {(amount: number) => string} formatMoney
 * @param {(iso: string) => string} formatDateTime
 * @returns {CorrectionBlock}
 */
function adjustmentBlock(
  adjustment: ZReportAdjustment,
  formatMoney: (amount: number) => string,
  formatDateTime: (iso: string) => string
): CorrectionBlock {
  const when = formatDateTime(adjustment.at)
  const by = adjustment.byName ?? 'the till'
  const what = `${salesText(adjustment.salesCount)} (${formatMoney(adjustment.salesTotal)})`
  const headings: Record<ZReportAdjustment['kind'], string> = {
    opening: `On ${when}, ${what} joined when the shift began: ${adjustment.reason}`,
    auto: `On ${when}, ${what} joined automatically: ${adjustment.reason}`,
    reassign_in: `On ${when}, ${by} moved ${what} in from shift #${adjustment.peerShiftId}: ${adjustment.reason}`,
    reassign_out: `On ${when}, ${by} moved ${what} out to shift #${adjustment.peerShiftId}: ${adjustment.reason}`
  }
  const details: string[] = []
  if (adjustment.firstSaleAt && adjustment.lastSaleAt) {
    details.push(`Sales from ${formatDateTime(adjustment.firstSaleAt)} to ${formatDateTime(adjustment.lastSaleAt)}`)
  }
  if (adjustment.openingDrawerCash !== null) {
    details.push(`Drawer counted at opening: ${formatMoney(adjustment.openingDrawerCash)}`)
  }
  if (adjustment.expectedCash !== null && adjustment.startingCash !== null && adjustment.endingCash !== null) {
    details.push(
      `Starting Cash: ${formatMoney(adjustment.startingCash)}`,
      `Expected Cash: ${formatMoney(adjustment.expectedCash)}`,
      `Counted Cash: ${formatMoney(adjustment.endingCash)}`,
      `Discrepancy: ${formatMoney(adjustment.discrepancy ?? 0)}`,
      ...zReportMpesaLines(
        {
          status: 'closed',
          mpesaOpeningBalance: adjustment.mpesaOpeningBalance,
          mpesaExpected: adjustment.mpesaExpected,
          mpesaClosingBalance: adjustment.mpesaClosingBalance,
          mpesaDifference: adjustment.mpesaDifference
        },
        formatMoney
      ).map((line) => `${line.label}: ${line.value}`)
    )
  }
  return { heading: headings[adjustment.kind], details }
}

/**
 * @param {ZReport} report
 * @param {(amount: number) => string} formatMoney
 * @param {(iso: string) => string} formatDateTime
 * @returns {CorrectionBlock[]} the adjustments, oldest first; empty when the shift has none
 */
export function zReportAdjustmentBlocks(
  report: Pick<ZReport, 'adjustments'>,
  formatMoney: (amount: number) => string,
  formatDateTime: (iso: string) => string
): CorrectionBlock[] {
  return (report.adjustments ?? []).map((adjustment) => adjustmentBlock(adjustment, formatMoney, formatDateTime))
}

/**
 * Corrections and adjustments together, oldest first: the order they happened in. For a shift with no adjustments
 * this is exactly {@link zReportCorrectionBlocks}.
 *
 * @param {ZReport} report
 * @param {(amount: number) => string} formatMoney
 * @param {(iso: string) => string} formatDateTime
 * @returns {CorrectionBlock[]}
 */
export function zReportChangeBlocks(
  report: Pick<ZReport, 'corrections' | 'adjustments'>,
  formatMoney: (amount: number) => string,
  formatDateTime: (iso: string) => string
): CorrectionBlock[] {
  const corrections = zReportCorrectionBlocks(report, formatMoney, formatDateTime)
  const entries = [
    ...(report.corrections ?? []).map((correction, index) => ({ at: correction.correctedAt, block: corrections[index] })),
    ...(report.adjustments ?? []).map((adjustment) => ({
      at: adjustment.at,
      block: adjustmentBlock(adjustment, formatMoney, formatDateTime)
    }))
  ]
  return entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((entry) => entry.block)
}

/**
 * The sales the shift held when it was closed, when later changes mean the figures above now count more or fewer.
 *
 * @param {ZReport} report
 * @param {(amount: number) => string} formatMoney
 * @returns {string | null} for example `Sales at close: 12 orders, Ksh 4,500.00`; `null` when nothing changed
 */
export function zReportSalesAtCloseLine(
  report: Pick<ZReport, 'salesAtClose'>,
  formatMoney: (amount: number) => string
): string | null {
  const atClose = report.salesAtClose
  if (!atClose) return null
  return `Sales at close: ${atClose.orderCount} ${atClose.orderCount === 1 ? 'order' : 'orders'}, ${formatMoney(atClose.totalRevenue)}`
}

/**
 * @param {ZReport} report
 * @returns {string | null} for example `Labelled Day when opened`; `null` when the stored label agrees or there was none
 */
export function zReportLabelledLine(report: Pick<ZReport, 'labelledAs'>): string | null {
  const label: ShiftType | null | undefined = report.labelledAs
  return label ? `Labelled ${label === 'day' ? 'Day' : 'Night'} when opened` : null
}

/**
 * @param {ZReport} report
 * @param {(iso: string) => string} formatDateTime
 * @returns {string | null} for example `Merged into shift #2 on 6 Oct by Manager Mo: opened twice`; `null` when not merged (docs/phase-239)
 */
export function zReportMergedLine(report: Pick<ZReport, 'mergedInto'>, formatDateTime: (iso: string) => string): string | null {
  const merge = report.mergedInto
  if (!merge) return null
  return `Merged into shift #${merge.shiftId} on ${formatDateTime(merge.at)} by ${merge.byName}: ${merge.reason}. Its sales are counted there now.`
}
