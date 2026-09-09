# Phase 96 — fix Order History's fiscal date misparse (Finding 2)

Fixes the go-live readiness audit's Finding 2: `fiscal_fiscalized_at` is
stored in two formats, and Order History misread one of them —
`new Date("05-09-2026 14:30:00").toLocaleString()` silently produced
9 May instead of 5 September, a wrong-by-months date on a tax-relevant
screen. Display-layer fix only; no change to fiscalization, the write
paths, or the provider.

## Audit

**The two write paths**, confirmed by reading the call sites, not
assumed:

| Path | Where | Format written |
|---|---|---|
| Device-sourced | `real-etims-provider.ts:906` — `fiscalizedAt: deviceDateTime ?? new Date().toISOString()`, `deviceDateTime` from the `ReadDateTime` command's response (`:890-893`) | `dd-MM-yyyy HH:mm:ss`, e.g. `05-09-2026 14:30:00` |
| Local fallback (device gave no timestamp, or `resendFiscalization`/`attemptFiscalRetry` short-circuit an already-fiscalized order) | `real-etims-provider.ts:796`, `fiscal-retry.ts:69,150` | ISO-8601, e.g. `2026-09-07T05:35:00.062Z` |

**The device format, cross-checked against the vendor source** (not
guessed): `Date.TremolFpFormat = "dd-MM-yyyy HH:mm:ss"`
(`ZFP_SDK_KE_2509041522_ControlUnit/Libs/JS/fp_core.js:600`), matching
`tracker/SDK_RECON.md` §3.8's note that `analyzeResponse` parses
`DateTime` fields with `Date.TremolFpFormat`, not the inconsistent
per-field `Format`/`Desc` strings also present in the device's own XML
definition. `fp_core.js`'s `toTremolFpString` zero-pads every field
(day/month/hour/minute/second to 2 digits, year to 4) when the device
*writes* this format, which is why the parser below can match on a
fixed-width pattern rather than a variable-width one.

**Every read/render site**, confirmed by grepping the whole renderer for
`fiscalizedAt`/`fiscal_fiscalized_at`: exactly one —
`OrderHistory.tsx:282-283`. `reports.ts` (Z-report/daily summary) never
touches the field. `main/index.ts:617`'s use of it is not a display
site — it feeds `lookupInvoice`'s duplicate-recovery data back into an
internal `FiscalInvoiceResult`-shaped object for the provider's own
already-filed check, never formatted or shown to anyone. `printer.ts`
confirmed (again) not to use this field, matching the original audit
finding — the receipt uses the invoice number and QR only.

## Fix

**`src/renderer/src/lib/fiscalDate.ts`** (new) —
`parseFiscalTimestamp(value: string | null | undefined): Date | null`,
pure and framework-free:

- Matches the device's fixed-width `dd-MM-yyyy HH:mm:ss` shape with an
  explicit regex and constructs the date field-by-field (day-first),
  never handing that string to `new Date()`'s locale-guessing parser.
- Falls through to `new Date(value)` for anything else, covering the
  ISO-8601 local-fallback path exactly as it already parses today.
- Validates the device format's fields (month 1-12, day 1-31, hour
  ≤23, minute/second ≤59) before constructing the date. This was worth
  doing, not just theoretical: `new Date(year, month, day, ...)`
  silently *rolls over* an out-of-range field into a different,
  "valid"-looking date rather than failing — the same class of
  silently-wrong-output bug this whole fix exists to close. Caught by
  writing the test below with a deliberately garbage numeric value
  before assuming the implementation handled it.
- Returns `null` — never an `Invalid Date`, never a throw — for empty
  input or anything unrecognized, so the caller shows a plain
  placeholder instead of a parsing artifact.

**`OrderHistory.tsx:282-284`** — now reads
`parseFiscalTimestamp(order.fiscal_fiscalized_at)?.toLocaleString() ??
'unknown time'`, keeping the existing "unknown time" fallback copy
unchanged; only the parsing underneath it changed.

## Tests

`tests/fiscalDate.test.ts` (5 tests):

- The device string `"05-09-2026 14:30:00"` parses to **5 September
  2026** — `getMonth() === 8`, `getDate() === 5` — the exact case the
  audit found broken.
- A dedicated assertion that it does **not** read as 9 May
  (`getMonth() !== 4`) — the bug being fixed, asserted directly rather
  than only implied by the positive case above.
- **Anti-regression**: `"2026-09-07T05:35:00.062Z"` (ISO-8601, the path
  that already works today) still round-trips exactly via
  `toISOString()`.
- Empty (`''`, `null`, `undefined`) returns `null`, not `Invalid Date`.
- Garbage returns `null`: both non-date text (`"not a date"`) and,
  importantly, a string that matches the device format's *shape* but
  not its valid *range* (`"99-99-9999 99:99:99"`) — this is the case
  that caught the rollover behavior noted above.

```
$ npx vitest run tests/fiscalDate.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)

$ npm run typecheck
typecheck exit code: 0

$ npm test
 Test Files  76 passed (76)
      Tests  1111 passed (1111)
```

## The four rules

Unaffected — this is a read-only display fix. No write path,
fiscalization, resend, or routing logic changed.

## Recommended follow-up (flagged, not done here)

The cleaner long-term fix is to **normalize the device datetime to
ISO-8601 at write time**, in `real-etims-provider.ts`, so every
downstream reader — today's one site, and any future one — gets a
single consistent format and never has to detect or guess. That's a
write-path change to the provider, bigger than this contained display
fix, and out of scope for this task per the brief. This phase makes
display robust to both formats as they exist today; normalizing at the
source remains the recommended follow-up for a human to schedule.
