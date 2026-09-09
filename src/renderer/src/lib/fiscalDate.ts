/**
 * Parses a `fiscal_fiscalized_at` timestamp into a `Date`, handling
 * BOTH formats an order row can carry (phase-96, Finding 2 of the
 * go-live readiness audit):
 *
 *  - The device's own datetime string, `dd-MM-yyyy HH:mm:ss` (day
 *    first), e.g. `"05-09-2026 14:30:00"` — what `ReadDateTime`
 *    returns. Confirmed against the vendor source, not guessed:
 *    `Date.TremolFpFormat = "dd-MM-yyyy HH:mm:ss"`
 *    (`ZFP_SDK_KE_2509041522_ControlUnit/Libs/JS/fp_core.js:600`),
 *    cross-checked with `tracker/SDK_RECON.md` §3.8. The device
 *    zero-pads every field (`fp_core.js`'s `toTremolFpString`), so this
 *    is always exactly two digits for day/month/hour/minute/second and
 *    four for the year — never a variable-width alternative to detect.
 *  - The local-fallback path's ISO-8601 string, e.g.
 *    `"2026-09-07T05:35:00.062Z"`, written when the device didn't
 *    return a timestamp (`real-etims-provider.ts`'s
 *    `fiscalizedAtSource: 'local-fallback'` path).
 *
 * `new Date(value)` alone gets the device format wrong: it reads
 * `dd-MM-yyyy` as the American `MM-dd-yyyy`, so 5 September silently
 * becomes 9 May. This detects the device's fixed shape explicitly
 * before ever handing anything to the platform's locale-sensitive
 * parser, so the two formats can never be confused with each other.
 *
 * Returns `null` — never an `Invalid Date`, never a throw — for
 * anything that isn't recognizably one of the two formats, so a caller
 * can show a plain placeholder instead of leaking a parsing artifact
 * onto a tax-relevant screen.
 *
 * @param {string | null | undefined} value
 * @returns {Date | null}
 */

const DEVICE_FORMAT = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/

export function parseFiscalTimestamp(value: string | null | undefined): Date | null {
  if (!value) return null

  const deviceMatch = DEVICE_FORMAT.exec(value)
  if (deviceMatch) {
    const [, dayStr, monthStr, yearStr, hourStr, minuteStr, secondStr] = deviceMatch
    const day = Number(dayStr)
    const month = Number(monthStr)
    const hour = Number(hourStr)
    const minute = Number(minuteStr)
    const second = Number(secondStr)
    // The `Date` constructor silently rolls over out-of-range fields
    // (e.g. month 13) into a "valid" but wrong date instead of failing
    // — exactly the silent-wrong-value failure mode this helper exists
    // to avoid, so reject those explicitly rather than trusting it.
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
      return null
    }
    const date = new Date(Number(yearStr), month - 1, day, hour, minute, second)
    return Number.isNaN(date.getTime()) ? null : date
  }

  const isoDate = new Date(value)
  return Number.isNaN(isoDate.getTime()) ? null : isoDate
}
