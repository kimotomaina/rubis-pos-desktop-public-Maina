/**
 * The period rules for a shift recorded after the fact (docs/phase-223).
 *
 * Pure functions, so the same rule runs in the preview and, again, inside the transaction that creates the
 * shift: the preview is a courtesy, the transaction is the guard.
 */

/** The part of a shift row the overlap rule reads. */
export interface ShiftWindowRow {
  id: number
  clock_in: string
  /** `NULL` while the shift is open. */
  clock_out: string | null
}

/** A validated period, normalised to the `.000Z` form `clock_in` already uses, so it sorts as text. */
export interface PastShiftPeriod {
  startIso: string
  endIso: string
  startMs: number
  endMs: number
}

/**
 * Validates and normalises a period given as two instants.
 *
 * Refuses an unreadable time, an end before the start, and an end in the future (`end > now`). An end equal to
 * the start is allowed: a one-sale period is a real period.
 *
 * @param {string} startIso
 * @param {string} endIso
 * @param {number} nowMs — the main process's own clock, never the renderer's
 * @returns {PastShiftPeriod}
 * @throws {Error} with a message fit to show the manager
 */
export function parsePastShiftPeriod(startIso: string, endIso: string, nowMs: number): PastShiftPeriod {
  const startMs = Date.parse(startIso)
  const endMs = Date.parse(endIso)
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new Error('The start or end time is not a valid time')
  }
  if (endMs < startMs) {
    throw new Error('The end of the period is before its start')
  }
  if (endMs > nowMs) {
    throw new Error('The period ends in the future')
  }
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    startMs,
    endMs
  }
}

/**
 * The first existing shift whose window overlaps `[startMs, endMs]`, or `undefined`.
 *
 * A window is the closed interval `[clock_in, clock_out]`; an open shift (`clock_out` NULL) is
 * `[clock_in, +infinity)`. Two windows overlap when `newStart <= existingEnd` and `newEnd >= existingStart`,
 * so touching counts: sales are stamped to the millisecond, and one on a boundary instant could not be said to
 * belong to either side. A shift whose times cannot be read is treated as open-ended, which refuses more, never less.
 *
 * @param {ShiftWindowRow[]} shifts
 * @param {number} startMs
 * @param {number} endMs
 * @returns {ShiftWindowRow | undefined}
 */
export function findOverlappingShift(
  shifts: ShiftWindowRow[],
  startMs: number,
  endMs: number
): ShiftWindowRow | undefined {
  return shifts.find((shift) => {
    const existingStart = Date.parse(shift.clock_in)
    const parsedEnd = shift.clock_out === null ? Number.POSITIVE_INFINITY : Date.parse(shift.clock_out)
    const existingEnd = Number.isNaN(parsedEnd) ? Number.POSITIVE_INFINITY : parsedEnd
    if (Number.isNaN(existingStart)) return true
    return startMs <= existingEnd && endMs >= existingStart
  })
}
