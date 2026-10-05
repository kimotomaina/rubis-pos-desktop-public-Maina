/**
 * The lines that mark a Z report as a shift recorded after the fact (docs/phase-223), so the printed slip and the
 * on-screen modal say the same words. The renderer has its own twin in `renderer/src/lib/zReportRetro.ts`
 * (main-process code is never bundled into the renderer); `tests/pastShiftZReport.test.ts` runs both over the same
 * reports so they cannot drift.
 *
 * A normal shift gets no line at all. A retrospective shift's cashier is not known (the manager recorded it), so the
 * slip says who recorded it and why instead of naming a cashier.
 */

import type { ZReport } from '../services/reports.js'

type RetroFields = Pick<ZReport, 'kind' | 'createdAt' | 'createdByName' | 'reason' | 'createdAutomatically'>

/**
 * @param {RetroFields} report
 * @param {(iso: string) => string} formatDateTime
 * @returns {string[]} empty for a normal shift
 */
export function zReportRetroLines(report: RetroFields, formatDateTime: (iso: string) => string): string[] {
  if (report.kind !== 'retrospective') return []
  const when = report.createdAt ? ` ${formatDateTime(report.createdAt)}` : ''
  // docs/phase-231: the till made this shift itself, for sales that had none.
  if (report.createdAutomatically) {
    return [`CREATED AUTOMATICALLY${when}`, `Reason: ${report.reason ?? ''}`]
  }
  return [
    `RETROSPECTIVE SHIFT, created${when} by ${report.createdByName ?? 'Unknown'}`,
    `Reason: ${report.reason ?? ''}`
  ]
}
