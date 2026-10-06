/**
 * Renderer-side twin of `main/lib/shiftWindows.ts` (docs/phase-199). Kept as
 * its own copy rather than a value import because every existing renderer
 * import from `main/` is `import type` only: main-process code is never
 * bundled into the renderer, the same reason `text.ts` and `vatLabel.ts` are
 * copies. It holds its own Nairobi offset for that reason too;
 * `tests/shiftWindows.test.ts` runs both files over the same inputs so the
 * two cannot drift.
 */

import type { ShiftType } from '../../../main/lib/shiftWindows.js'

export type { ShiftType }

export const SHIFT_TYPES: readonly ShiftType[] = ['day', 'night']

/** Africa/Nairobi is a fixed UTC+3 all year (no daylight saving), as in `main/services/reports.ts`. */
const NAIROBI_UTC_OFFSET_MINUTES = 3 * 60

const MINUTES_PER_DAY = 24 * 60

interface ShiftWindow {
  type: ShiftType
  startMinutes: number
  endMinutes: number
}

/** Both ends inclusive, in whole minutes after Nairobi midnight: 17:30:59 is day, 17:31:00 is night. */
/** Day 07:00 to 17:30 (docs/phase-237), the same numbers as the main copy. */
export const DAY_SHIFT: ShiftWindow = { type: 'day', startMinutes: 7 * 60, endMinutes: 17 * 60 + 30 }

export const NIGHT_SHIFT: ShiftWindow = {
  type: 'night',
  startMinutes: 17 * 60 + 31,
  endMinutes: 7 * 60 - 1
}

function toNairobiWallClock(iso: string): Date {
  return new Date(new Date(iso).getTime() + NAIROBI_UTC_OFFSET_MINUTES * 60 * 1000)
}

function formatClock(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0')
  const m = String(minutes % 60).padStart(2, '0')
  return `${h}:${m}`
}

function windowFor(type: ShiftType): ShiftWindow {
  return type === 'day' ? DAY_SHIFT : NIGHT_SHIFT
}

function nairobiMinuteOfDay(iso: string): number {
  const wall = toNairobiWallClock(iso)
  if (Number.isNaN(wall.getTime())) {
    throw new RangeError(`Not a valid time: ${iso}`)
  }
  return wall.getUTCHours() * 60 + wall.getUTCMinutes()
}

/**
 * Which shift an instant falls in: 07:00:00 to 17:30:59 Nairobi time is
 * `'day'`, everything else `'night'`.
 *
 * @param {string} iso
 * @returns {ShiftType}
 */
export function shiftTypeForTime(iso: string): ShiftType {
  const minute = nairobiMinuteOfDay(iso)
  return minute >= DAY_SHIFT.startMinutes && minute <= DAY_SHIFT.endMinutes ? 'day' : 'night'
}

/**
 * `Day shift (07:00 to 17:30)` or `Night shift (17:31 to 06:59)`.
 *
 * @param {ShiftType} type
 * @returns {string}
 */
export function shiftWindowLabel(type: ShiftType): string {
  const window = windowFor(type)
  return `${shiftName(type)} (${formatClock(window.startMinutes)} to ${formatClock(window.endMinutes)})`
}

/**
 * `Day shift` or `Night shift`, without the times.
 *
 * @param {ShiftType} type
 * @returns {string}
 */
export function shiftName(type: ShiftType): string {
  return type === 'day' ? 'Day shift' : 'Night shift'
}

/**
 * The last minute of a shift's window as `HH:MM`.
 *
 * @param {ShiftType} type
 * @returns {string}
 */
export function shiftEndClock(type: ShiftType): string {
  return formatClock(windowFor(type).endMinutes)
}

/**
 * Whether a shift opened at `openedAtIso` has run past the end of its window
 * by `nowIso`: the due moment is the next time the window's end comes round
 * after the shift was opened. A note for the screen only.
 *
 * @param {ShiftType} type
 * @param {string} openedAtIso
 * @param {string} nowIso
 * @returns {boolean}
 */
export function isPastShiftEnd(type: ShiftType, openedAtIso: string, nowIso: string): boolean {
  const dueMinute = (windowFor(type).endMinutes + 1) % MINUTES_PER_DAY
  const openedWall = toNairobiWallClock(openedAtIso)
  const openedMinute = nairobiMinuteOfDay(openedAtIso)
  const openedDayStart = Date.UTC(
    openedWall.getUTCFullYear(),
    openedWall.getUTCMonth(),
    openedWall.getUTCDate()
  )
  const daysUntilDue = openedMinute < dueMinute ? 0 : 1
  const dueWall = openedDayStart + (daysUntilDue * MINUTES_PER_DAY + dueMinute) * 60 * 1000
  return toNairobiWallClock(nowIso).getTime() >= dueWall
}
