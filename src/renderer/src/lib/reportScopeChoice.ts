/**
 * What the Reports tab is looking at (docs/phase-246, R2): one shift, a fixed period, or a typed range. One value for
 * the whole page, so every section reads the same scope. Pure, so the picker, the sections and the tests share it.
 */

import type { ReportScope } from '../../../main/lib/reportScope.js'
import type { ReportRangePreset } from '../../../main/services/reports.js'

export type ScopeChoice =
  | { kind: 'preset'; preset: ReportRangePreset }
  | { kind: 'shift'; shiftId: number; label: string }
  | { kind: 'custom'; from: string; to: string }

/** The six fixed periods, in the order the picker lists them. */
export const PRESET_CHOICES: Array<{ key: ReportRangePreset; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'thisWeek', label: 'This week' },
  { key: 'lastWeek', label: 'Last week' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' }
]

/** The scope every report starts on. */
export const DEFAULT_SCOPE: Extract<ScopeChoice, { kind: 'preset' }> = { kind: 'preset', preset: 'today' }

/**
 * The shape the window API takes: a plain preset string as before, or the shift's id, or both ends of the range.
 *
 * @param {ScopeChoice} choice
 * @returns {ReportScope}
 */
export function toReportScope(choice: ScopeChoice): ReportScope {
  if (choice.kind === 'preset') return choice.preset
  if (choice.kind === 'shift') return { shiftId: choice.shiftId }
  return { from: choice.from, to: choice.to }
}

/**
 * @param {ScopeChoice} choice
 * @returns {string} what the scope is called on the page: "Today", "Shift #8, Day, 6 Oct 11:35 to now", "5 Oct 17:00 to 6 Oct 09:30"
 */
export function scopeTitle(choice: ScopeChoice): string {
  if (choice.kind === 'preset') return PRESET_CHOICES.find((preset) => preset.key === choice.preset)?.label ?? choice.preset
  if (choice.kind === 'shift') return choice.label
  return `${choice.from} to ${choice.to}`
}

/** The parts a shift's label is made of. */
export interface ShiftLabelInput {
  id: number
  windowType: 'day' | 'night' | null | undefined
  openedAt: string
  closedAt: string | null
}

const NAIROBI = 'Africa/Nairobi'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * @param {string} iso
 * @returns {{ day: string; month: string; time: string; key: string }} Nairobi wall-clock parts of an instant
 */
function nairobiParts(iso: string): { day: string; month: string; time: string; key: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: NAIROBI,
    day: 'numeric',
    month: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(iso))
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? ''
  const hour = get('hour') === '24' ? '00' : get('hour')
  // The month is named here, not by the locale: some give "Sept", and the till always says "Sep".
  const month = MONTHS[Number(get('month')) - 1] ?? ''
  const day = String(Number(get('day')))
  return { day, month, time: `${hour}:${get('minute')}`, key: `${day} ${month}` }
}

/**
 * A shift as the scope list names it (docs/phase-246, R2): its number, its window, when it began and when it ended, or
 * "now" while it is open. Times are Nairobi time whatever the machine's clock says. A shift that ends on another day
 * says which.
 *
 * @param {ShiftLabelInput} shift
 * @returns {string} `Shift #8, Day, 6 Oct 11:35 to now` or `Shift #3, Day, 5 Oct 09:14 to 17:30`
 */
export function shiftScopeLabel(shift: ShiftLabelInput): string {
  const kind = shift.windowType === 'day' ? 'Day' : shift.windowType === 'night' ? 'Night' : null
  const opened = nairobiParts(shift.openedAt)
  let end = 'now'
  if (shift.closedAt) {
    const closed = nairobiParts(shift.closedAt)
    end = closed.key === opened.key ? closed.time : `${closed.key} ${closed.time}`
  }
  return `Shift #${shift.id}, ${kind ? `${kind}, ` : ''}${opened.key} ${opened.time} to ${end}`
}
