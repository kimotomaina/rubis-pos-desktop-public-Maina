# Phase 88 — Step 4, Part 2: read path + resend wiring

Backend/logic only — no UI yet. Builds to the three decisions confirmed
after `docs/phase-87.md`'s audit: a 15-minute time-based stuck threshold
(named constant), a persisted `fiscal_data_issue` column (cleared on
fiscalization), and the needs-attention query joined to `staff` and
keyed on the sale's own `created_at`. STOP for review before Part 3 (the
UI) and Part 4 (the notice-timeout flip).

## Persisting `fiscal_data_issue`

New nullable `orders.fiscal_data_issue TEXT` column (`database.ts`),
added via `CREATE TABLE` for a fresh install and `migrateOrdersFiscalColumns`
for an upgrade — the same two-path pattern every earlier `fiscal_*`
column addition used.

- `setOrderFiscalFailure` gained a 5th, optional parameter:
  `dataIssue: 'wrong-pin' | null = null`. Every call site that already
  had a `FiscalSubmitOutcome`/`dataIssue` in scope now passes it through:
  `checkout.ts`'s first-attempt failure branch, `fiscal-engine.ts`'s
  retry-reclassification branch, and `fiscal-retry.ts`'s
  `resendFiscalization`. The thrown-exception fallback in `checkout.ts`
  has no classified outcome to tag, so it's left at the default `null`.
  This required widening the `setOrderFiscalFailure` signature on the
  three structural interfaces that describe it (`CheckoutDb`,
  `FiscalEngineDatabase`, `FiscalResendDb`) to match — a type-only
  change, no behavior differs for a caller that omits the new parameter.
- `setOrderFiscalInfo` now also clears `fiscal_data_issue = NULL` on
  success, alongside the existing `fiscal_error_reason`/`fiscal_error_kind`
  clear — a sale that fiscalizes (including via a same-visit PIN fix)
  doesn't keep a stale "wrong PIN" tag sitting on its row.
- `CheckoutReceipt.fiscalDataIssue`'s doc comment (which previously said
  "not persisted to the order row") is corrected — it's now also
  persisted, and that's the whole point of this change.

This closes the gap the audit flagged: `getFiscalNotice`'s wrong-PIN
detection was always sourced from a live attempt's in-memory outcome;
nothing could tell "is this stored `needs_fixing` row a wrong-PIN case"
by reading the database. Now it can, from a real column, not a
text-match against `fiscal_error_reason`.

## The stuck-waiting threshold

`STUCK_WAITING_THRESHOLD_MS = 15 * 60_000` (`database.ts`), with its
reasoning written directly on the constant: the retry queue's own
abandonment signal can take roughly 2.5 hours to reach given the backoff
curve, which is far too long a blind spot for a screen whose entire
purpose is "don't lose sight of an unfiled sale." Keyed off the sale's
own `orders.created_at`, not `sync_queue`'s bookkeeping, per your
direction — simpler, and correct since fiscalization is always attempted
synchronously at checkout time, so the two clocks would read the same
sale almost identically anyway.

## The two new queries

- **`getOrdersNeedingAttention(now, stuckWaitingThresholdMs)`** — every
  `needs_fixing` order, plus every `waiting` order whose `created_at` is
  older than the cutoff. `LEFT JOIN staff` for the cashier's name (not
  `sync_queue` — nothing in the result needs queue bookkeeping once the
  threshold is computed off the order's own timestamp). `fiscal_status`
  itself distinguishes the two categories in the result — a `'waiting'`
  row appearing here is, by construction of the query, already past the
  threshold. Ordered oldest-first (`created_at ASC, local_id ASC` — the
  `local_id` tiebreaker keeps the order deterministic when two rows share
  a millisecond timestamp, which a fast test run can genuinely produce).
  `now`/`stuckWaitingThresholdMs` are explicit parameters, matching
  `getPendingFiscalQueue`'s own convention, so tests can drive the
  threshold deterministically without mocking the clock.
- **`getUnfiledOrderCount()`** — `waiting` + `needs_fixing`, no threshold
  gate at all. The Rule-3 safety-net number: every completed sale not
  yet filed, full stop, regardless of how long.

## IPC — three new handlers, one existing one reused

- **`fiscal:resend`** (new) — the plain "Resend" action Part 1's audit
  found had no handler at all. Validates `{ localId }`
  (`resendFiscalizationSchema`), calls `resendFiscalization` (the same
  guarded function `correctPinAndResend` already delegates to — no new
  submit path, Rule 1 holds exactly as everywhere else), returns
  `ServiceResult<FiscalResendResult>` via `buildFiscalResendResult`. Same
  shape as `fiscal:correct-pin-and-resend`'s handler, deliberately.
- **`fiscal:needs-attention`** (new) — read-only, calls
  `getOrdersNeedingAttention(Date.now(), STUCK_WAITING_THRESHOLD_MS)`.
- **`fiscal:unfiled-count`** (new) — read-only, calls
  `getUnfiledOrderCount()`.
- **`fiscal:correct-pin-and-resend`** — unchanged; already the right
  shape for the wrong-PIN case, reused as-is by Part 3's UI.

Preload (`src/preload/index.ts` + `window.d.ts`) gained matching entries:
`resendFiscalization(localId)`, `getSalesNeedingAttention()`,
`getUnfiledSalesCount()`.

## Tests

- **`tests/database.test.ts`** — the three existing `setOrderFiscalFailure`
  tests updated for the new 5th parameter (`null` default) rather than
  loosened; one new test asserting the `wrong-pin` tag is actually
  persisted when passed; `setOrderFiscalInfo`'s existing test extended to
  assert `fiscal_data_issue = NULL` is in the clearing SQL.
- **`tests/fiscalEngine.test.ts`** — the reclassification test's
  assertion updated for the new parameter; one new test proving a retry
  that reveals a wrong-PIN rejection persists the tag through the
  reclassification path specifically (not just the first-attempt path).
- **`tests/needsAttention.test.ts`** (new, 9 tests, against a REAL
  in-memory `RubisDatabase` — this query's JOIN/WHERE/ordering logic
  needed proving, not just "what SQL string got built"): a needs_fixing/
  wrong-PIN row is included with the staff name and tag; a needs_fixing/
  system row is included with no tag; a fiscalized order is excluded; a
  waiting order **within** the threshold is excluded (proven with `now`
  set 5 seconds after creation); a waiting order **past** the threshold
  is included (proven with `now` set threshold+60s after creation) — both
  directions of the stuck check, as asked; ordering is oldest-first and
  stable when two rows share a timestamp; an empty result when nothing
  qualifies; the count includes a not-yet-stuck waiting order (unlike the
  list) and excludes a fiscalized one; the count is zero when nothing's
  unfiled.
- **`tests/ipcValidator.test.ts`** — new `resendFiscalizationSchema`
  block (4 tests): accepts a positive `localId`; rejects non-integer/
  non-positive/missing/malformed.
- Three pre-existing `OrderRow` test fixtures (`reports.test.ts`,
  `shifts.test.ts`, `voids.test.ts`) needed `fiscal_data_issue: null`
  added — the same category of fallout every earlier `OrderRow` column
  addition in this project has caused, not a new kind of problem.

Not re-tested here, and didn't need to be: `resendFiscalization` and
`correctPinAndResend`'s own resend/guard behavior — already exhaustively
covered by `fiscalResend.test.ts` from phases 76/78, unchanged by this
part. This part only adds an IPC entry point calling the same, already-
proven function.

## Verification

- `npx vitest run`: **67 files / 1004 tests** (991 going in + 13 new), 0
  failures.
- `npm run typecheck` (node + web): clean.
- No new submit path anywhere — grepped every new/changed line touching
  `submitInvoice`/`attemptFiscalRetry`: none exist outside the two
  already-guarded functions this part only wires up, never re-implements.

Holding here for review before Part 3 (the screen) and Part 4 (flipping
the fiscal notice's timeout now that this back-office home exists).
