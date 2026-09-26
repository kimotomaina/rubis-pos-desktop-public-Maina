/**
 * Generic CSV encoding (docs/phase-158) — used only by the Admin Reports
 * export. No report-specific knowledge lives here; it only knows how to
 * turn rows of cells into a safe CSV file.
 */

/**
 * A cell whose first character is one of these opens a formula in
 * Excel/Sheets/LibreOffice when the file is opened — "CSV formula
 * injection". Prefixing the cell with a literal `'` (as Excel's own
 * "paste as text" convention does) neutralises it while leaving the
 * value visibly unchanged for a human reading the file.
 */
const FORMULA_TRIGGER_CHARS = ['=', '+', '-', '@', '\t', '\r']

/**
 * Escapes one CSV cell: wraps it in double quotes and doubles any
 * embedded quote whenever the value contains a comma, quote, or
 * newline, and prefixes a formula-injection trigger character with a
 * literal `'` first.
 *
 * @param {string | number} value
 * @returns {string}
 */
export function csvCell(value: string | number): string {
  let text = String(value)
  if (FORMULA_TRIGGER_CHARS.some((char) => text.startsWith(char))) {
    text = `'${text}`
  }
  if (text.includes(',') || text.includes('"') || text.includes('\n') || text.includes('\r')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/**
 * Builds a complete CSV file's text from a header row and data rows,
 * every cell passed through {@link csvCell}, `\r\n` line endings (the
 * format's own convention, and what Excel expects), and a leading UTF-8
 * byte-order mark so Excel opens the file without mangling non-ASCII
 * text (e.g. a KRA PIN's letters are ASCII already, but this also
 * covers any Kenyan Shilling symbol or future non-ASCII field).
 *
 * @param {string[]} header
 * @param {Array<Array<string | number>>} rows
 * @returns {string}
 */
export function buildCsv(header: string[], rows: Array<Array<string | number>>): string {
  const BOM = '﻿'
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','))
  return BOM + lines.join('\r\n') + '\r\n'
}

/**
 * Formats a currency amount to exactly 2 decimal places for a CSV cell
 * — `toFixed` rather than `formatCurrency` (the renderer's display
 * helper, which adds a thousands separator a CSV column should not
 * have).
 *
 * @param {number} amount
 * @returns {string}
 */
export function csvMoney(amount: number): string {
  return amount.toFixed(2)
}
