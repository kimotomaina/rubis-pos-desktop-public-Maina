# Phase 94 — the fiscal back-office screen (Finding 1)

Closes the go-live readiness audit's headline finding
(`docs/GO_LIVE_READINESS.md`, Finding 1): the IPC to list unfiled sales,
count them, and resend them existed and was tested, but nothing in the
renderer called it. A stuck sale was invisible to staff and the go-live
plan's own success test — "watch the unfiled count drain to zero" —
could not be performed. This phase is UI wiring only: no change to
fiscalization, resend, or routing logic.

## What was built

**`src/renderer/src/pages/NeedsAttentionPage.tsx`** — a new self-contained
Admin tab, following `MpesaLogsPage.tsx`'s established pattern (own
`useState`/`useEffect` fetch-on-mount, no props). Fetches via
`window.api.getSalesNeedingAttention()` and renders one card per sale:
order number, a status pill distinguishing `needs_fixing` ("Needs
fixing") from a stuck `waiting` sale ("Stuck — retrying automatically"),
when/cashier/amount, and the stored `fiscal_error_reason` verbatim —
never a code.

- **Resend** — `window.api.resendFiscalization(localId)`, the same
  guarded path `fiscal-engine.ts`'s own queue drain and `FiscalNotice`'s
  toast retry use (Rule 1 holds identically here). Disabled while in
  flight; on a fiscalized outcome the row leaves the list, on continued
  failure it stays with the refreshed status/reason.
- **Correct PIN & Resend** — shown only when `fiscal_data_issue ===
  'wrong-pin'`. Reuses the exact mechanism `FiscalNotice.tsx` uses for
  the same fix at the point of sale: `useKeyboardStore.getState().open()`
  opens the shared on-screen keyboard (no separate `<VirtualKeyboard>`
  embedded), gated on `isValidKraPinFormat` from `lib/kraPin.ts`, and
  calls `window.api.correctPinAndResend(localId, pin)` — never a new
  submit path.
- Empty state: "No sales need attention."

**`src/renderer/src/lib/needsAttention.ts`** — pure, framework-free
helpers, matching how `fiscalNotice.ts` is tested independently of
`FiscalNotice.tsx`:
- `describeNeedsAttentionStatus(status)` — the plain-language status label.
- `resendClearsRow(result)` — true once `fiscalStatus === 'fiscalized'`.
- `applyResendResult(rows, result)` — drops a row that fiscalized;
  otherwise merges in the fresh `fiscal_status`/`fiscal_error_reason`/
  `fiscal_error_kind`/`fiscal_data_issue` so a `waiting` row that comes
  back rejected as a data problem reclassifies to `needs_fixing`
  immediately, not only on the next full refetch.

**`AdminScreen.tsx`** — one new tab, `'needsAttention'`, added to the
existing tab union, nav bar, and mount list, identically to how
`mpesaLogs` is wired.

## Backend confirmed unchanged and already correct (Part 1 audit)

All four channels existed and were tested before this phase; only their
renderer callers were missing.

| Channel | Handler | Return shape |
|---|---|---|
| `fiscal:needs-attention` | `main/index.ts:1952-1965` → `db.getOrdersNeedingAttention` | `NeedsAttentionRow[]` |
| `fiscal:unfiled-count` | `main/index.ts:1972-1980` → `db.getUnfiledOrderCount` | `number` |
| `fiscal:resend` | `main/index.ts:1927-1945` → `resendFiscalization` | `FiscalResendResult` |
| `fiscal:correct-pin-and-resend` | `main/index.ts:1896-1918` | `FiscalResendResult` |

No changes were made to `fiscal-retry.ts`, `database.ts`, the IPC
handlers, or preload — confirmed by re-reading them in Part 1 rather
than assumed.

## Tests

- `tests/needsAttention.test.ts` (7 tests) — pure helper tests: status
  labels, `resendClearsRow`, and `applyResendResult`'s drop/merge/
  reclassify/leave-others-alone behavior.
- `tests/NeedsAttentionPage.test.ts` (5 tests) — mounted with
  `react-dom/client` and driven with real DOM `.click()`, matching
  `VirtualKeyboard.test.ts`'s stated exception to this repo's
  "test pure logic, don't mount" convention, since this page's
  interactive surface is exactly what needed covering: empty state;
  reason renders verbatim and the two statuses are visually distinct;
  Resend success removes the row; Resend failure keeps it with the
  updated reason; a wrong-PIN row's correction affordance is gated on
  `isValidKraPinFormat` (rejects `bad`, accepts `p051234567z` uppercased
  to `P051234567Z`) and calls `correctPinAndResend` with the corrected PIN.

```
$ npx vitest run tests/needsAttention.test.ts tests/NeedsAttentionPage.test.ts
 Test Files  2 passed (2)
      Tests  12 passed (12)

$ npm run typecheck
typecheck exit code: 0

$ npm test
 Test Files  72 passed (72)
      Tests  1092 passed (1092)
```

## Real-screen verification (not simulated)

Rather than trust the mounted tests alone, this was driven against the
**actual dev Electron app** (`npm run dev --remote-debugging-port=9222`,
driven over Chrome DevTools Protocol) and the **real on-disk database**,
not `:memory:` or a mock. Two of the three existing dev orders were
temporarily flipped to `waiting`/`needs_fixing` (one force-aged past the
15-minute stuck threshold) to populate the list, and the Admin PIN and
`etims` device config were temporarily set to known test values so the
setup gate and login could be passed. Every value changed for this check
was captured beforehand and restored exactly afterward — orders back to
`fiscalized`/`null`, the `etims` integrations row back to `{}`, the
staff PIN hash and the secret vault file restored byte-for-byte from a
backup taken before any change, and the app process fully quit. Verified
by reading all of it back after restore.

What this proved, with real IPC round-trips (no mocks):

- The Admin nav shows a **Needs Attention** tab; opening it lists both
  seeded sales with their real, stored reasons verbatim, correct status
  pills (amber "Stuck — retrying automatically" vs. rose "Needs fixing"),
  and the right actions per row (Resend on both; Correct PIN & Resend
  only on the wrong-PIN one).
- Clicking **Correct PIN & Resend** opens the exact same shared keyboard
  modal `FiscalNotice` uses, titled "Corrected Customer KRA PIN"; typing
  an invalid PIN (`bad`) keeps **Save & Resend** disabled, typing a valid
  one (`p051234567z`, uppercased) enables it.
- Clicking **Save & Resend** made a real HTTP call through the real
  `RealFiscalizationProvider` against the (unreachable, dummy) device —
  it failed honestly with **"Fiscal device timed out on ReadStatus"**,
  and the row updated in place with that new reason, still `needs_fixing`,
  no crash, no stuck spinner.
- Clicking plain **Resend** on the stuck-`waiting` row made the same kind
  of real call, timed out the same way, and the row **reclassified live**
  from "Stuck — retrying automatically" to "Needs fixing" with the fresh
  reason — exactly what `applyResendResult`'s unit test asserts, now
  seen end-to-end through the real IPC/provider/DB stack.
- The sale was never lost, never double-filed, and the till was never
  blocked at any point in this sequence — the four rules held.

One thing worth naming honestly: my first attempt at typing the PIN
through the on-screen keyboard via direct DOM `.click()` calls batched
too many keystrokes into a single React tick and produced a garbled
value — a harness artifact of driving React synchronously from outside
the browser's real event loop, not a bug in `VirtualKeyboard` (its
`append`/`backspace` logic is a plain, correct closure over its `value`
prop). Fixed by sending one key per round-trip, which let React flush
between each, then re-verified. Noted here rather than glossed over,
per this project's "twice had green tests over broken behavior" history.

## Part 3 (the count badge + Finding 4) — not yet done

This phase covers Part 2 only. The prominent unfiled-count badge in the
header and the Finding-4 relabel of the "✓ Fiscal" connectivity badge
(currently an HTTP-reachability probe of the server, not proof sales are
filing) are the next phase.

## The four rules

- **Never file twice** — Resend and Correct PIN & Resend both go through
  `resendFiscalization`/`attemptFiscalRetry`, the same single resubmit
  path the background queue uses; nothing here adds a second one.
- **Never print a valid-looking receipt for an unfiled sale** — untouched;
  this phase adds no printer code.
- **Never silently lose an unfiled sale** — this is the fix: the data was
  already safe, it is now visible and actionable.
- **Never block the till** — this page lives entirely in Admin; the
  checkout flow is untouched.

## Visual-check list (for the real touch screen)

Deferred to the Part 4 report, which will cover this page together with
the Part 3 count badge in one pass, per the plan.
