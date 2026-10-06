/**
 * The card settlement lines of a Z report (docs/phase-246, R5), as label/value pairs, so the printed slip and the
 * on-screen modal say the same words. This is the renderer-side twin of `main/lib/zReportCard.ts`, a copy
 * because main-process code is never bundled into the renderer; `tests/shiftCardClose.test.ts` runs both over the same
 * reports so they cannot drift.
 *
 * "Not recorded" is for a settlement nobody entered, "Pending" for a figure an open shift has not reached yet. A
 * missing figure is never shown as 0, which would read as "the settlement was nothing". The last line is worded
 * "Check against the PDQ settlement", never "shortage": the settlement also moves for things the till never sees
 * (chargebacks, fees, a batch closed at another hour).
 */

import type { ZReport } from '../../../main/services/reports.js'

export interface ZReportCardLine {
  label: string
  value: string
}

type CardReportFields = Pick<ZReport, 'status' | 'cardClosingBalance' | 'cardExpected' | 'cardDifference'>

/**
 * @param {CardReportFields} report
 * @param {(amount: number) => string} formatMoney
 * @returns {ZReportCardLine[]} expected, counted, then the check line
 */
export function zReportCardLines(report: CardReportFields, formatMoney: (amount: number) => string): ZReportCardLine[] {
  const closing = report.cardClosingBalance ?? null
  const expected = report.cardExpected ?? null
  const difference = report.cardDifference ?? null
  const open = report.status === 'open'
  const show = (amount: number | null, missing: string): string => (amount !== null ? formatMoney(amount) : missing)
  return [
    { label: 'Card expected', value: show(expected, 'Not recorded') },
    { label: 'Card counted', value: show(closing, open ? 'Pending' : 'Not recorded') },
    { label: 'Check against the PDQ settlement', value: show(difference, 'Not recorded') }
  ]
}
