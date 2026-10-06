/**
 * The scope the Reports tab gives every report (docs/phase-246, R2 and R3): one shift, a preset, or a custom range of
 * two date-times. Every report keeps calling the function it called before, with the same kind of range; only how the
 * range is made is new. A shift scope is the span of the shift's own sales (see {@link shiftScopeRange}), so a shift
 * that holds sales its clock times do not cover, as a merged shift does, is still read whole.
 */

import type { RubisDatabase } from './database.js'
import { formatNairobiDateTime, getReportRange, type ReportRange, type ReportRangePreset } from './reports.js'

/** What a report request carries to say what it is for: exactly one of the three. */
export interface ReportScopeRequest {
  preset?: ReportRangePreset
  shiftId?: number
  /** `YYYY-MM-DD HH:MM`, Nairobi time. */
  from?: string
  to?: string
}

/** The longest custom range, so a typed range cannot ask for years of sales at once. */
export const MAX_CUSTOM_RANGE_DAYS = 62

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * @param {string} iso
 * @returns {string} `6 Oct 11:35`, Nairobi time
 */
function shortNairobi(iso: string): string {
  const [date, time] = formatNairobiDateTime(iso).split(' ')
  const [, month, day] = date.split('-').map(Number)
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${day} ${names[month - 1]} ${time.slice(0, 5)}`
}

/**
 * The range that holds one shift's sales: from the earlier of its `clock_in` and its first sale to the later of its
 * `clock_out` (now, while open) and the instant after its last sale. A shift's own times alone are not enough: shift #1
 * of 5 Oct closed after 14 seconds and holds the 59 sales merged into it, which is why the range is also read from the
 * sales. Only the scope passed to the reports is made here; nothing is added up.
 *
 * @param {RubisDatabase} db
 * @param {number} shiftId
 * @param {Date} [now]
 * @returns {ReportRange}
 * @throws {Error} when the shift does not exist
 */
export function shiftScopeRange(db: RubisDatabase, shiftId: number, now: Date = new Date()): ReportRange {
  const shift = db.getShiftById(shiftId)
  if (!shift) throw new Error(`Shift ${shiftId} not found`)
  const times = db
    .getOrdersForShift(shiftId)
    .filter((order) => order.status !== 'voided')
    .map((order) => Date.parse(order.created_at))
  const startMs = Math.min(Date.parse(shift.clock_in), ...times)
  const endMs = Math.max(shift.clock_out ? Date.parse(shift.clock_out) : now.getTime(), ...times.map((ms) => ms + 1))
  const startIso = new Date(startMs).toISOString()
  const endIso = new Date(endMs).toISOString()
  return {
    startIso,
    endIso,
    label: `Shift #${shiftId} (${shortNairobi(startIso)} to ${shift.clock_out ? shortNairobi(endIso) : 'now'})`
  }
}

/**
 * Parses one typed `YYYY-MM-DD HH:MM` (Nairobi time) into an instant.
 *
 * @param {string} text
 * @returns {number} milliseconds since the epoch
 * @throws {Error} for a text that is not a real date and time
 */
function parseNairobi(text: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text.trim())
  if (!match) throw new Error('Enter the date and time as YYYY-MM-DD HH:MM')
  const [year, month, day, hour, minute] = match.slice(1).map(Number)
  const utc = Date.UTC(year, month - 1, day, hour, minute)
  const back = new Date(utc)
  // A day or hour that does not exist (31 Feb, 25:00) rolls over in Date.UTC; refuse it rather than read another time.
  if (back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day || back.getUTCHours() !== hour) {
    throw new Error('Enter the date and time as YYYY-MM-DD HH:MM')
  }
  return utc - 3 * 60 * 60 * 1000
}

/**
 * The range of two typed date-times, checked at the boundary: real dates, the end after the start, and at most
 * {@link MAX_CUSTOM_RANGE_DAYS} days.
 *
 * @param {string} from
 * @param {string} to
 * @returns {ReportRange}
 * @throws {Error} with a message fit to show
 */
export function customRange(from: string, to: string): ReportRange {
  const startMs = parseNairobi(from)
  const endMs = parseNairobi(to)
  if (endMs <= startMs) throw new Error('The end must be after the start')
  if (endMs - startMs > MAX_CUSTOM_RANGE_DAYS * DAY_MS) throw new Error(`A range is at most ${MAX_CUSTOM_RANGE_DAYS} days`)
  const startIso = new Date(startMs).toISOString()
  const endIso = new Date(endMs).toISOString()
  return { startIso, endIso, label: `${shortNairobi(startIso)} to ${shortNairobi(endIso)}` }
}

/**
 * Turns a report request's scope into the range the report's own function takes.
 *
 * @param {RubisDatabase} db
 * @param {ReportScopeRequest} scope — exactly one of preset, shiftId, or from and to (the schema checks this)
 * @param {Date} [now]
 * @returns {ReportRange}
 * @throws {Error} when the scope names nothing usable
 */
export function resolveReportRange(db: RubisDatabase, scope: ReportScopeRequest, now: Date = new Date()): ReportRange {
  if (scope.preset !== undefined) return getReportRange(scope.preset, now)
  if (scope.shiftId !== undefined) return shiftScopeRange(db, scope.shiftId, now)
  if (scope.from !== undefined && scope.to !== undefined) return customRange(scope.from, scope.to)
  throw new Error('Choose a shift, a preset or a range')
}
