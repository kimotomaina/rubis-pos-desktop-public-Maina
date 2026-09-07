# Phase 78 — Cashier notice, Part B: the till notice

Part B of Step 3. Builds on `docs/phase-77.md`'s plumbing
(`CheckoutReceipt.fiscalStatus`/`fiscalErrorReason`/`fiscalErrorKind`/
`fiscalDataIssue`). Part C (fix-and-resend for a wrong PIN) is not
started yet — this report is Part B alone, held for review before Part
C builds on top of it.

## What was built

**`src/renderer/src/lib/fiscalNotice.ts`** — pure mapping function,
`getFiscalNotice(receipt) → FiscalNotice | null`. No React, no store
access, directly testable — same pattern `checkoutMath.ts` already
uses for `CheckoutModal`/`PosCheckoutPanel`.

**`src/renderer/src/components/FiscalNotice.tsx`** — the small
dismissible banner, mounted once at the app root (`App.tsx`, alongside
`ConnectivityToast`/`UpdateToast`) rather than inside
`PosCheckoutPanel`. Reads `lastReceipt` from the cart store (not
`checkoutStatus`, which resets to idle moments after checkout so the
panel is ready for the next sale) and tracks dismissal per `localId`
locally, so a new checkout's notice always starts un-dismissed.

## The three messages

| `fiscalStatus` / `fiscalErrorKind` | Message shown |
|---|---|
| `fiscalized` (or fiscalization never attempted) | *(nothing — no notice)* |
| `waiting` | "Tax device unavailable. This sale will be sent automatically when it's back." |
| `needs_fixing` / `data` | "Sale complete, but the tax device rejected it: **{reason}**. It's been flagged for correction." |
| `needs_fixing` / `system` | "Sale complete, but it couldn't be sent to the tax device due to a system error. It's been flagged. Please tell support." |

Notes on the wording, since that's what you're checking first:

- Every sentence a cashier reads says or implies the sale is fine —
  "Tax device unavailable" (not "sale failed"), "Sale complete, but…"
  leading every `needs_fixing` message. Nothing suggests the customer's
  purchase itself is in doubt.
- The `system` message never tells the cashier to do anything about
  the *data* — it says what happened ("a system error"), states the
  outcome ("it's been flagged"), and names the one action available
  ("tell support"). It deliberately does not reuse the `data` message's
  "flagged for correction" phrasing, since there's nothing for a
  cashier to correct.
- The `data` message includes the actual stored reason (e.g. "Wrong
  client PIN") because that's specific, true, and short — not a code,
  not jargon, just what the device said in the plain-language form
  already stored in `fiscal_error_reason`. Falls back to a generic
  clause ("the tax device rejected it") only in the edge case where no
  reason was stored.
- No device codes, no STE numbers, no internal terms ("STE2", "kind",
  "retryable") anywhere in the strings — verified by a test that scans
  every message for that pattern.
- No em dashes anywhere in these strings (checked by the same test) —
  every sentence break is a period.
- Nothing is over-explained. Each notice is one or two short sentences,
  no sub-bullets, no "learn more," no restating what a cashier already
  knows (the sale happened — they were just standing at the till).

## Rule 4 — never blocks, verified two ways

1. **Structural**: `FiscalNotice` is a `fixed`, non-modal overlay
   mounted at the app root, entirely outside `PosCheckoutPanel`'s
   layout and React tree. Nothing in `PosCheckoutPanel.tsx` reads the
   fiscal outcome or the notice's state — the "Complete Sale" button,
   the numpad, and the M-Pesa flow are unmodified and have no new
   disabled/gated condition tied to fiscalization. There is no code
   path by which a fiscal outcome can affect whether the next sale can
   start.
2. **Behavioral** (`tests/cartCheckout.test.ts`, new test): a checkout
   whose receipt carries `fiscalStatus: 'needs_fixing'` still clears
   the cart and resolves `checkoutStatus` to a normal terminal state
   (`'queued-offline'`, not stuck on "submitting" or some new blocked
   state) — then a second `checkout()` call immediately after succeeds
   with no gate on the first sale's fiscal outcome.

## Tests

- **`tests/fiscalNotice.test.ts`** (new, 11 tests): every
  status/kind combination maps to the right message or `null`; the
  `data` fallback when no reason is stored; the `system` message never
  matches `/fix|correct/i`; an `it.each` scanning every non-null
  message for STE references, the word "code" followed by a digit, and
  em dashes.
- **`tests/cartCheckout.test.ts`**: one new test for Rule 4 (above).

## Verification

- `npx vitest run`: **61 files / 915 tests** (903 going into this part
  + 12 new), 0 failures.
- `npm run typecheck` (node + web): clean.
- **Not verified**: an actual browser/Electron render of the notice.
  This environment is headless — I could not start the dev server and
  visually confirm placement, colors, or that the toast doesn't overlap
  anything at real screen sizes. Typecheck and the pure-mapping tests
  are what's actually been checked; the visual result is
  `VERIFY-ON-DEVICE` in the literal sense (needs a real screen), not
  the fiscal-device sense this project usually uses that tag for. Flag
  this if you'd like it checked before Part C adds buttons to the same
  banner.

## Not done yet (Part C)

No wrong-PIN buttons, no PIN correction, no `resendFiscalization` call
from the UI. The `data`-kind message above is generic — it's shown for
*every* data rejection, wrong PIN included; Part C will add
[Correct PIN] / [Remove PIN and resend] / [Send to office] actions on
top of this same notice specifically when
`fiscalDataIssue === 'wrong-pin'`, not replace it.

---

Holding here per your request. Let me know if the wording needs
changes, or if you'd like screenshots/a dev-server check before Part C.
