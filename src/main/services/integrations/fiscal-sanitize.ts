/**
 * Text sanitization for fields sent to the Tremol/VIL G03 fiscal
 * device. Per the G03 Integration Programming Manual, symbols outside
 * a conservative allow-list can block a request from reaching TIMS
 * (KRA's tax invoice management system) entirely, with no useful error
 * surfaced back to the till — so every free-text fiscal field is
 * scrubbed before it reaches the device rather than only escaped for
 * XML.
 *
 * Note: the allow-list excludes `'` and `&`, so a company name like
 * "Mama Njeri's Grocers & Sons" reaches the device as
 * "Mama Njeris Grocers Sons". That is deliberate belt-and-braces — the
 * XML layer already escapes both characters safely — and must not be
 * loosened until a live device confirms it accepts them, since the
 * failure mode being guarded against is silent (TIMS drops the invoice
 * with no error back to the till).
 */

/**
 * Characters permitted in a sanitized fiscal text field.
 *
 * // VERIFY-ON-DEVICE: the manual warns generically that "symbols" can
 * block a request from reaching TIMS, without enumerating exactly which
 * ones are safe. This set (letters, digits, space, `.`, `,`, `-`) is a
 * reasonable default — item/company names commonly need the punctuation,
 * and it's already applied to `HSCode`/`MeasureUnit` too (§ `docs/KNOWN_GAPS.md`,
 * "the fiscal-text allow-list ... are VERIFY-ON-DEVICE") — but it is
 * unproven against a real Control Unit. Confirm with a live sale carrying
 * each allowed punctuation mark before treating this as settled.
 */
const ALLOWED_FISCAL_CHARS_PATTERN = /[^A-Za-z0-9 .,-]/g

/**
 * Strips every character outside `[A-Za-z0-9 .,-]`, collapses runs of
 * whitespace left behind by that removal, trims the result, and
 * truncates to `maxLen`.
 *
 * @param {string | undefined | null} value
 * @param {number} maxLen
 * @returns {string}
 */
export function sanitizeFiscalText(value: string | undefined | null, maxLen: number): string {
  const stripped = (value ?? '').replace(ALLOWED_FISCAL_CHARS_PATTERN, '')
  const collapsed = stripped.replace(/\s+/g, ' ').trim()
  return collapsed.slice(0, maxLen)
}
