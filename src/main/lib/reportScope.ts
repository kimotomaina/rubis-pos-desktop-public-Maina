/**
 * What a Reports screen asks a report for (docs/phase-246, R2 and R3), in the one form the window API takes: a fixed
 * preset (a plain string, as before), one shift, or a custom range of two typed date-times. Pure, so the preload script
 * and the screens can both use it; the main process turns it into a range in `services/report-scope.ts`.
 */

import type { ReportRangePreset } from '../services/reports.js'
import type { ReportScopeRequest } from '../services/report-scope.js'

export type ReportScope = ReportRangePreset | { shiftId: number } | { from: string; to: string }

/**
 * @param {ReportScope} scope
 * @returns {ReportScopeRequest} the request fields: `{ preset }`, `{ shiftId }` or `{ from, to }`
 */
export function toScopeRequest(scope: ReportScope): ReportScopeRequest {
  return typeof scope === 'string' ? { preset: scope } : scope
}
