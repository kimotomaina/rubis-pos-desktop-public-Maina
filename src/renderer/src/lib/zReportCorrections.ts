/**
 * The lines that show a shift's corrections on a Z report (docs/phase-224), so the printed slip and the on-screen
 * modal say the same words. This is the renderer-side twin of `main/lib/zReportCorrections.ts`, a
 * copy because main-process code is never bundled into the renderer; `tests/shiftCorrections.test.ts` runs both over
 * the same reports so they cannot drift.
 *
 * The original figures are left exactly as they were; a correction is shown under them, never in place of them.
 * Its M-Pesa lines are the same four as everywhere else, so "Not recorded" and the "Check against the M-Pesa
 * statement" wording come from one place.
 */

import type { ZReport, ZReportCorrection } from '../../../main/services/reports.js'
import { zReportMpesaLines } from './zReportMpesa.js'

/** One correction as text: a heading, and the figures it now gives. */
export interface CorrectionBlock {
  heading: string
  details: string[]
}

/**
 * @param {ZReport} report
 * @param {(amount: number) => string} formatMoney
 * @param {(iso: string) => string} formatDateTime
 * @returns {CorrectionBlock[]} oldest first; empty when the shift was never corrected
 */
export function zReportCorrectionBlocks(
  report: Pick<ZReport, 'corrections'>,
  formatMoney: (amount: number) => string,
  formatDateTime: (iso: string) => string
): CorrectionBlock[] {
  return (report.corrections ?? []).map((correction: ZReportCorrection) => ({
    heading: `Corrected on ${formatDateTime(correction.correctedAt)} by ${correction.correctedByName}: ${correction.reason}`,
    details: [
      `Starting Cash: ${formatMoney(correction.startingCash)}`,
      `Expected Cash: ${formatMoney(correction.expectedCash)}`,
      `Counted Cash: ${formatMoney(correction.endingCash)}`,
      `Discrepancy: ${formatMoney(correction.discrepancy)}`,
      ...zReportMpesaLines(
        {
          status: 'closed',
          mpesaOpeningBalance: correction.mpesaOpeningBalance,
          mpesaExpected: correction.mpesaExpected,
          mpesaClosingBalance: correction.mpesaClosingBalance,
          mpesaDifference: correction.mpesaDifference
        },
        formatMoney
      ).map((line) => `${line.label}: ${line.value}`)
    ]
  }))
}
