/**
 * The till's event log (docs/phase-228): one line for each print that failed or fell back to a PDF, and for the
 * cart's shift state that could not be read. `till.log` sits next to `error.log`, which stays for crashes only.
 *
 * Failures only, never a success. A line holds a time, a fixed event name and a short detail: the document, the
 * printer and the message already shown to the cashier. Never a PIN, a token, an order's contents, a raw error
 * object or a stack. The file is not rotated: it grows by about 150 bytes for each failure.
 */

/** Every event the log knows. `print-failed`, `print-fallback` and `update-failed` are written by the main process only. */
export const TILL_LOG_EVENTS = ['print-failed', 'print-fallback', 'shift-state-unreadable', 'update-failed', 'auto-assign-failed'] as const

export type TillLogEvent = (typeof TILL_LOG_EVENTS)[number]

/** The events the screen may ask the main process to write, and no others. */
export const RENDERER_TILL_EVENTS = ['shift-state-unreadable'] as const

/** The longest detail a line carries; anything longer is cut and marked. */
export const TILL_LOG_DETAIL_MAX = 200

/** Every control character, and the Unicode line and paragraph separators. */
const LINE_BREAKS_AND_CONTROLS = new RegExp('[\u0000-\u001f\u007f\u2028\u2029]+', 'g')

/**
 * Makes a detail safe for one log line: line breaks and other control characters become a space, runs of spaces
 * collapse, and the length is capped.
 *
 * @param {string} detail
 * @returns {string}
 */
export function sanitizeTillDetail(detail: string): string {
  const flat = detail.replace(LINE_BREAKS_AND_CONTROLS, ' ').replace(/ {2,}/g, ' ').trim()
  return flat.length > TILL_LOG_DETAIL_MAX ? `${flat.slice(0, TILL_LOG_DETAIL_MAX - 1)}…` : flat
}

/**
 * One log line: `[2026-10-05T16:20:11.000Z] [print-failed] z-report shift #1: Printer "Receipt" (tcp://…) is offline…`.
 *
 * @param {TillLogEvent} event
 * @param {string} detail
 * @param {Date} [now]
 * @returns {string}
 */
export function formatTillLogLine(event: TillLogEvent, detail: string, now: Date = new Date()): string {
  return `[${now.toISOString()}] [${event}] ${sanitizeTillDetail(detail)}`
}

/** What a print's result says, as far as the log needs it. */
interface LoggablePrintResult {
  success: boolean
  error?: string
  data?: { mode?: string }
}

/**
 * The log entry for one print result, or `null` when there is nothing to log: a success is never logged
 * (docs/phase-228). A failure carries the message already shown to the cashier; a receipt saved as a PDF because
 * its printer was unreachable carries the printer. Only strings go in, never the result or an error object.
 *
 * @param {string} document — for example `Z report for shift #1`
 * @param {LoggablePrintResult | null} result — `null` when that slip was not asked for
 * @param {() => string} printer — says which printer was tried, asked only when it is needed
 * @returns {{ event: TillLogEvent; detail: string } | null}
 */
export function printOutcomeEntry(
  document: string,
  result: LoggablePrintResult | null,
  printer: () => string
): { event: TillLogEvent; detail: string } | null {
  if (!result) return null
  if (!result.success) return { event: 'print-failed', detail: `${document}: ${result.error ?? 'no reason given'}` }
  if (result.data?.mode === 'pdf') {
    return { event: 'print-fallback', detail: `${document}: ${printer()} was unreachable, saved as a PDF` }
  }
  return null
}

/** Writes lines to the till log. Logging never throws: a log that cannot be written must not stop a sale or a print. */
export interface TillLog {
  record(event: TillLogEvent, detail: string): void
}

/**
 * Builds a {@link TillLog} that appends to `filePath`.
 *
 * @param {string} filePath — absolute path to `till.log`
 * @param {{ appendFileSync: (path: string, data: string) => void }} fs — injected so tests never touch the disk
 * @returns {TillLog}
 */
export function createTillLog(
  filePath: string,
  fs: { appendFileSync: (path: string, data: string) => void }
): TillLog {
  return {
    record(event, detail) {
      try {
        fs.appendFileSync(filePath, formatTillLogLine(event, detail) + '\n')
      } catch {
        // Nowhere left to report it to.
      }
    }
  }
}
