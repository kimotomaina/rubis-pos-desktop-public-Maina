/**
 * The period of a shift recorded after the fact, typed by the manager as Nairobi clock times (docs/phase-223).
 *
 * Minute precision on screen, exact to the millisecond underneath: a start of `10:05` is 10:05:00.000 and an end of
 * `18:30` is 18:30:59.999, so a sale at 18:30:42 is inside a period "to 18:30". Africa/Nairobi is a fixed UTC+3
 * all year, as in `main/services/reports.ts`. The main process re-checks every rule; this only builds the instants.
 */

const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000

/** `YYYY-MM-DD HH:MM`, the one format both fields take. */
const PERIOD_TEXT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/

/**
 * An instant as the Nairobi `YYYY-MM-DD HH:MM` the fields show, the minute it falls in.
 *
 * @param {string} iso
 * @returns {string}
 */
export function nairobiMinuteText(iso: string): string {
  const wall = new Date(new Date(iso).getTime() + NAIROBI_OFFSET_MS)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())} ${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`
}

/**
 * The instant for one field. `end` runs to the last millisecond of the minute typed.
 *
 * @param {string} text — `YYYY-MM-DD HH:MM`, Nairobi time
 * @param {'start' | 'end'} edge
 * @returns {string | null} an ISO instant, or `null` if the text is not a real date and time
 */
export function periodEdgeToIso(text: string, edge: 'start' | 'end'): string | null {
  const match = PERIOD_TEXT.exec(text.trim())
  if (!match) return null
  const [, y, mo, d, h, mi] = match.map(Number)
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const wallMs = Date.UTC(y, mo - 1, d, h, mi, edge === 'start' ? 0 : 59, edge === 'start' ? 0 : 999)
  const wall = new Date(wallMs)
  // Date.UTC rolls 31 February into March; a day that rolled is not the day the manager typed.
  if (wall.getUTCMonth() !== mo - 1 || wall.getUTCDate() !== d) return null
  return new Date(wallMs - NAIROBI_OFFSET_MS).toISOString()
}
