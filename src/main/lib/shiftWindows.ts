/**
 * The fixed shift windows (docs/phase-199): a day shift and a night shift,
 * on Africa/Nairobi wall-clock time.
 *
 * Operational labels only. Nothing here opens or closes a shift, and no
 * report reads these windows: a person still taps Open Shift and Close
 * Shift, and the windows only say which shift they are on and when it is
 * expected to end. The renderer keeps its own copy in
 * `src/renderer/src/lib/shiftWindows.ts` (the renderer never value-imports
 * from `main/`); `tests/shiftWindows.test.ts` runs both over the same inputs.
 */

import { NAIROBI_UTC_OFFSET_MINUTES, toNairobiWallClock } from '../services/reports.js'

/** The two shifts a till day is split into. */
export type ShiftType = 'day' | 'night'

/** Every valid {@link ShiftType}, for validators that need the list. */
export const SHIFT_TYPES: readonly ShiftType[] = ['day', 'night']

/**
 * One window, in whole minutes after Nairobi midnight. `startMinutes` and
 * `endMinutes` are both inclusive, because the client states the boundary
 * by whole minute: 17:30:59 is still the day shift and 17:31:00 is night.
 * A window whose end is before its start runs across midnight.
 */
export interface ShiftWindow {
  type: ShiftType
  startMinutes: number
  endMinutes: number
}

/** Day 07:00 to 17:30 (docs/phase-237; the 09:00 start of docs/phase-199 was an error). */
export const DAY_SHIFT: ShiftWindow = { type: 'day', startMinutes: 7 * 60, endMinutes: 17 * 60 + 30 }

export const NIGHT_SHIFT: ShiftWindow = {
  type: 'night',
  startMinutes: 17 * 60 + 31,
  endMinutes: 7 * 60 - 1
}

const MINUTES_PER_DAY = 24 * 60

/**
 * `HH:MM` for a minute of the day.
 *
 * @param {number} minutes
 * @returns {string}
 */
function formatClock(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0')
  const m = String(minutes % 60).padStart(2, '0')
  return `${h}:${m}`
}

/**
 * The window for a shift type.
 *
 * @param {ShiftType} type
 * @returns {ShiftWindow}
 */
function windowFor(type: ShiftType): ShiftWindow {
  return type === 'day' ? DAY_SHIFT : NIGHT_SHIFT
}

/**
 * Whole minutes after Nairobi midnight for an instant; the seconds are
 * dropped, which is what makes 17:30:59 count as 17:30.
 *
 * @param {string} iso
 * @returns {number}
 * @throws {RangeError} if `iso` is not a valid instant, since a guessed shift label would be worse than none
 */
function nairobiMinuteOfDay(iso: string): number {
  const wall = toNairobiWallClock(iso)
  if (Number.isNaN(wall.getTime())) {
    throw new RangeError(`Not a valid time: ${iso}`)
  }
  return wall.getUTCHours() * 60 + wall.getUTCMinutes()
}

/**
 * Which shift an instant falls in. 07:00:00 to 17:30:59 Nairobi time is
 * `'day'`, everything else is `'night'`, so 06:59:59 is night, 07:00:00 is
 * day, 17:30:59 is day and 17:31:00 is night.
 *
 * @param {string} iso — an ISO-8601 instant
 * @returns {ShiftType}
 */
export function shiftTypeForTime(iso: string): ShiftType {
  const minute = nairobiMinuteOfDay(iso)
  return minute >= DAY_SHIFT.startMinutes && minute <= DAY_SHIFT.endMinutes ? 'day' : 'night'
}

/** One occurrence of a window: its type and the Nairobi date it starts on (docs/phase-229). */
export interface ShiftWindowInstance {
  type: ShiftType
  /** `YYYY-MM-DD`. A night that runs past midnight is dated by the evening it starts. */
  startDate: string
}

/**
 * Which window instance an instant falls in (docs/phase-229): its type from {@link shiftTypeForTime}, and the date
 * that window started on. Day is 07:00:00 to 17:30:59 on its own date. Night is 17:31:00 to 06:59:59 the next
 * morning, so 00:00 to 06:59 belongs to the night that began the evening before.
 *
 * @param {string} iso — an ISO-8601 instant
 * @returns {ShiftWindowInstance}
 * @throws {RangeError} if `iso` is not a valid instant
 */
export function shiftWindowOf(iso: string): ShiftWindowInstance {
  const minute = nairobiMinuteOfDay(iso)
  const wall = toNairobiWallClock(iso)
  const type = shiftTypeForTime(iso)
  const dayBack = type === 'night' && minute < DAY_SHIFT.startMinutes ? 1 : 0
  const start = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() - dayBack))
  return { type, startDate: start.toISOString().slice(0, 10) }
}

/**
 * Whether two window instances are the same window (docs/phase-232): the same type on the same date.
 *
 * @param {ShiftWindowInstance} a
 * @param {ShiftWindowInstance} b
 * @returns {boolean}
 */
export function sameWindow(a: ShiftWindowInstance, b: ShiftWindowInstance): boolean {
  return a.type === b.type && a.startDate === b.startDate
}

/**
 * The first instant a shift may be closed (docs/phase-232): the start of its window's last minute, so a Day shift
 * can be closed from 17:30:00 and a Night shift from 06:59:00 the next morning. The window is the one the shift's
 * `clock_in` falls in; a shift left open past it can be closed at any time after.
 *
 * @param {string} clockInIso — the shift's `clock_in`
 * @returns {number} epoch milliseconds
 * @throws {RangeError} if `clockInIso` is not a valid instant
 */
export function windowClosableFrom(clockInIso: string): number {
  const { type, startDate } = shiftWindowOf(clockInIso)
  const nightEndsNextMorning = type === 'night' ? MINUTES_PER_DAY : 0
  const wallMinutes = nightEndsNextMorning + windowFor(type).endMinutes
  return Date.parse(`${startDate}T00:00:00.000Z`) + (wallMinutes - NAIROBI_UTC_OFFSET_MINUTES) * 60 * 1000
}

/**
 * The label shown beside a shift: `Day shift (07:00 to 17:30)` or
 * `Night shift (17:31 to 06:59)`.
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
 * The last minute of a shift's window as `HH:MM`, for the "due to close
 * at" note.
 *
 * @param {ShiftType} type
 * @returns {string}
 */
export function shiftEndClock(type: ShiftType): string {
  return formatClock(windowFor(type).endMinutes)
}

/**
 * Whether a shift opened at `openedAtIso` has run past the end of its
 * window by `nowIso`. The due moment is the next time the window's end
 * comes round after the shift was opened, so a night shift opened at 02:00
 * is due at 07:00 the same morning and one opened at 18:00 is due at 07:00
 * the next. A note for the screen only: nothing is blocked or closed by it.
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
