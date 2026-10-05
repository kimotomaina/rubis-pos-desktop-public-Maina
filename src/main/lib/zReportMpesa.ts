/**
 * The M-Pesa balance lines of a Z report (docs/phase-222), as label/value pairs, so the printed slip and the
 * on-screen modal say the same words. The renderer has its own twin in `renderer/src/lib/zReportMpesa.ts`
 * (main-process code is never bundled into the renderer); `tests/zReportMpesa.test.ts` runs both over the same
 * reports so they cannot drift.
 *
 * "Not recorded" is for a balance nobody entered, "Pending" for a figure an open shift has not reached yet.
 * A missing figure is never shown as 0, which would read as "the balance was nothing". The last line is worded
 * "Check against the M-Pesa statement", never "shortage": the till number's balance also moves for things the
 * till never sees (withdrawals, transfers, charges, reversals).
 */

import type { ZReport } from '../services/reports.js'

export interface ZReportMpesaLine {
  label: string
  value: string
}

type MpesaReportFields = Pick<
  ZReport,
  | 'status'
  | 'mpesaOpeningBalance'
  | 'mpesaExpected'
  | 'mpesaClosingBalance'
  | 'mpesaDifference'
>

/**
 * @param {MpesaReportFields} report
 * @param {(amount: number) => string} formatMoney
 * @returns {ZReportMpesaLine[]} opening, expected, counted, then the check line
 */
export function zReportMpesaLines(
  report: MpesaReportFields,
  formatMoney: (amount: number) => string
): ZReportMpesaLine[] {
  const opening = report.mpesaOpeningBalance ?? null
  const expected = report.mpesaExpected ?? null
  const closing = report.mpesaClosingBalance ?? null
  const difference = report.mpesaDifference ?? null
  const open = report.status === 'open'
  const show = (amount: number | null, missing: string): string =>
    amount !== null ? formatMoney(amount) : missing
  return [
    { label: 'M-Pesa opening', value: show(opening, 'Not recorded') },
    { label: 'M-Pesa expected', value: show(expected, 'Not recorded') },
    { label: 'M-Pesa counted', value: show(closing, open ? 'Pending' : 'Not recorded') },
    {
      label: 'Check against the M-Pesa statement',
      value: show(difference, open && opening !== null ? 'Pending' : 'Not recorded')
    }
  ]
}
