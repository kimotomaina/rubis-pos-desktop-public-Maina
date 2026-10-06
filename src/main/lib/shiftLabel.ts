/**
 * A shift is shown by its window (docs/phase-232, W4): the type comes from the clock at `clock_in`, never from what
 * was stored. An older shift whose stored label disagrees (shift #1, opened 17:43, labelled Day) is shown as the
 * window says, with a note that it was labelled otherwise when opened. The stored row is not edited.
 */

import type { ShiftRow } from '../services/database.js'
import { shiftWindowOf } from './shiftWindows.js'

/**
 * How many shifts hold each window, keyed `type|startDate`.
 *
 * @param {Array<{ clock_in: string }>} shifts
 * @returns {Map<string, number>}
 */
export function countShiftsByWindow(shifts: Array<{ clock_in: string }>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const shift of shifts) {
    try {
      const window = shiftWindowOf(shift.clock_in)
      const key = `${window.type}|${window.startDate}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    } catch {
      // A shift whose time cannot be read belongs to no window.
    }
  }
  return counts
}

/**
 * @param {ShiftRow} shift
 * @param {Map<string, number>} [counts] — from {@link countShiftsByWindow}; adds `window_shift_count`
 * @returns {ShiftRow} the same row, with the window; unchanged if `clock_in` cannot be read
 */
export function withWindow(shift: ShiftRow, counts?: Map<string, number>): ShiftRow {
  try {
    const window = shiftWindowOf(shift.clock_in)
    const stored = shift.shift_type ?? null
    return {
      ...shift,
      window_type: window.type,
      window_date: window.startDate,
      ...(counts ? { window_shift_count: counts.get(`${window.type}|${window.startDate}`) ?? 1 } : {}),
      ...(stored !== null && stored !== window.type ? { labelled_as: stored } : {})
    }
  } catch {
    return shift
  }
}
