/**
 * Running automatic assignment from the main process (docs/phase-232): the one place that calls
 * {@link RubisDatabase.autoMergeSameWindowShifts} (docs/phase-242) and then {@link RubisDatabase.autoAssignUnattachedSales}, and writes their failure to `till.log`, so every trigger (start,
 * Open Shift, Close Shift, Shift History) behaves the same. A failure never reaches the screen as a stack, and
 * never stops what the person was doing: the sales simply stay without a shift until the next run.
 */

import type { AutoAssignResult, RubisDatabase } from './database.js'
import type { ServiceResult } from './shopify-types.js'

/** What {@link runAutoAssign} needs from the database. */
export type AutoAssignDb = Pick<RubisDatabase, 'autoAssignUnattachedSales' | 'autoMergeSameWindowShifts'>

/**
 * @param {AutoAssignDb} db
 * @param {(detail: string) => void} record — writes one `auto-assign-failed` line
 * @param {number} [nowMs] — the clock; the main process's own
 * @returns {ServiceResult<AutoAssignResult>}
 */
export function runAutoAssign(
  db: AutoAssignDb,
  record: (detail: string) => void,
  nowMs: number = Date.now()
): ServiceResult<AutoAssignResult> {
  // docs/phase-242: a window that holds more than one shift is merged into one first, so the sales that follow go to
  // the shift that holds the window. A failed merge is logged and does not stop the sales being given a shift.
  let merged: AutoAssignResult['merged'] = []
  try {
    merged = db.autoMergeSameWindowShifts(nowMs).merged
  } catch (err) {
    record(`merge: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
  try {
    return { success: true, data: { ...db.autoAssignUnattachedSales(nowMs), merged } }
  } catch (err) {
    record(err instanceof Error ? err.message : 'unknown error')
    return { success: false, error: 'Sales with no shift could not be given to a shift. Nothing was changed.' }
  }
}
