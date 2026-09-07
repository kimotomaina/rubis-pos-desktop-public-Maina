# Phase 87 — Step 4, Part 1: back-office list, Audit

Read-only. No code changed. STOP for review before Part 2.

## How a flagged/unfiled sale is actually findable today

Confirmed exactly as assumed, by tracing every write path:

- **`needs_fixing`** — a row in `orders` with `fiscal_status = 'needs_fixing'`
  and **never** a `sync_queue` row. `checkout.ts`'s non-retryable branch
  never calls `queueFiscalInvoice`; `fiscal-engine.ts`'s reclassification
  branch (a later retry revealing a data/system problem) calls
  `removeFiscalQueueItem` in the same breath as `setOrderFiscalFailure`.
  So a `needs_fixing` order is never in the retry queue, by construction,
  from every code path that can produce one.
- **`waiting`** — `fiscal_status = 'waiting'` **and** a `sync_queue` row
  with `entity_type = 'etims_invoice'`, `entity_id = <local_id>`.
- **`fiscalized`** — `fiscal_status = 'fiscalized'`, `fiscal_invoice_number`
  set, no queue row.

## No query lists orders by `fiscal_status` today

`database.ts` has `getOrder` (single row by id, full fiscal columns),
`getOrderByFiscalInvoiceNumber` (single row, by invoice number),
`getOrdersForShift`/`getOrdersForDateRange` (lists, but **no fiscal
columns at all** in their `SELECT`), and `getOrders(limit, offset)` —
the only general list with fiscal columns, but no `WHERE` clause and no
`staff_id`/`payment_method`/`tendered_amount`/`change_due` in its
`SELECT` either. **Nothing today can list "just the needs_fixing and
stuck-waiting ones" — a new query is needed**, and `getOrders` isn't
the thing to extend in place (its no-filter, paginated shape serves a
different caller); this wants its own purpose-built method.

`getPendingFiscalQueue(now)` lists `sync_queue`, not `orders`, scoped to
items still eligible for automatic retry — it excludes both
`needs_fixing` orders (never queued) and abandoned `waiting` orders
(pushed to `next_attempt_at = MAX_SAFE_INTEGER`, so `next_attempt_at <=
now` never matches again). It's the right table to join against for
"why is this waiting sale stuck," not a substitute for an orders-list
query.

## `resendFiscalization`/`correctPinAndResend` — one is wired, one isn't

- **`correctPinAndResend`** — wired to `fiscal:correct-pin-and-resend`
  (`main/index.ts`), used by the till's wrong-PIN fix-and-resend
  (phase-79). Returns `ServiceResult<FiscalResendResult>` via
  `buildFiscalResendResult`.
- **`resendFiscalization`** — exported from `fiscal-retry.ts`, called
  internally by `correctPinAndResend` (`return
  resendFiscalization(deps, localId)`), but **has no IPC handler, no
  preload entry, nothing in the renderer can call it today.** This is
  exactly the gap Part 2 needs to close for a plain "Resend" button (no
  PIN change) on a `needs_fixing`/`system` row or a stuck-`waiting` row.

Both functions go through the same guarded `attemptFiscalRetry` (the
already-fiscalized short-circuit + `isRetry: true` tagging) — reusing
either from a new IPC handler holds Rule 1 automatically; nothing new
needs to be built, only wired.

## "Stuck waiting" — what the schema actually offers, and a decision point

`sync_queue`'s `attempts`/`next_attempt_at`/`last_error` (no separate
boolean state column) is the only signal. `RubisDatabase.maxAttempts`
defaults to `SYNC_MAX_ATTEMPTS = 10`; `recordFiscalQueueFailure` marks a
row abandoned (`next_attempt_at = Number.MAX_SAFE_INTEGER`, `last_error`
prefixed `'ABANDONED after N attempts: ...'`) once `attempts >= 10`.
That's the one unambiguous, already-computed "stuck" signal — no new
threshold to invent.

**But it can take a long time to reach.** `computeBackoffMs` doubles
from 30s, capped at 30 minutes: attempts 1-10 sum to roughly **2.5
hours** of accumulated backoff before the 10th (final) attempt even
fires. A sale stuck since the device password went wrong could sit
"waiting," un-surfaced, for hours before hitting true abandonment —
directly in tension with Rule 3 ("never silently lose an unfiled sale")
and the reason this feature exists in the first place (the standing
context notes the device password is currently wrong, so this isn't a
hypothetical).

Two reasonable definitions of "stuck," not decided here:

1. **True abandonment only** (`next_attempt_at = MAX_SAFE_INTEGER` /
   `attempts >= 10`) — simplest, zero new threshold, but a sale can be
   invisible for hours first.
2. **A lower bar** — e.g. `attempts >= 3` (a few minutes in) or a
   time-based check off `orders.created_at`/`sync_queue.created_at`
   ("waiting longer than N minutes regardless of attempt count") — surfaces
   trouble sooner, at the cost of a manager occasionally seeing a sale
   that's still auto-retrying normally and would resolve on its own.

My inclination is **option 2 with a modest, named threshold** (e.g. 15
minutes since `sync_queue.created_at`, or `attempts >= 3` — whichever
you'd rather key it on), since a multi-hour blind spot undercuts the
whole point of this step, but I'm flagging it for your call rather than
picking silently, per Part 1's brief.

## `fiscal_data_issue` (wrong-PIN) is not persisted — a real decision point

Confirmed by reading every producer: `dataIssue` lives only on the
in-memory `FiscalSubmitOutcome` of one live `submitInvoice` call, never
written to the `orders` table. `getFiscalNotice` (the till's own notice)
only ever reads it off a fresh `CheckoutReceipt`/`FiscalResendResult` —
i.e. immediately after a live attempt, never off a stored row read back
later. There is **no existing precedent anywhere in this codebase for
re-deriving wrong-PIN-ness from stored data** — phase-77's own
reasoning was explicit that this should come from the code the device
already computed, not from text-matching a reason string.

For a back-office list reading `orders` rows written potentially hours
or days ago, that in-memory value is long gone. Two options:

1. **Persist a new `fiscal_data_issue` column** (mirrors exactly how
   `fiscal_request_json`/the `fiscal_status` columns were added in
   earlier phases — a small, precedented migration), written by
   `setOrderFiscalFailure` (or a sibling call) whenever the outcome
   carries `dataIssue`. Robust to any future wording change in
   `mapFiscalDeviceError`; the list reads a real column, same as the
   till's notice conceptually does.
2. **Match `fiscal_error_reason === 'Wrong client PIN'`** (the exact,
   fixed string `mapFiscalDeviceError`'s `'59'` case produces) in the
   list query/renderer. No migration, smaller footprint — but brittle:
   if that message's wording ever changes, wrong-PIN rows silently stop
   being recognized as fixable, with no test forcing the two to move
   together.

**I'd recommend option 1** — it's a small, precedented schema addition,
avoids inventing this codebase's first text-matching classification
where a structured one already exists everywhere else, and directly
serves the brief's own requirement ("whether it's the wrong-PIN case" as
a field the UI needs). Flagging for your confirmation before Part 2
touches the schema.

## `AdminScreen.tsx` — the shape a new section would take

Single large component with one `activeTab` union (`'overview' |
'integrations' | 'peripherals' | 'mpesaLogs' | 'system'`) and a manual
tab-button row; most tabs are inline JSX in the same file, but
**`mpesaLogs` is already fully delegated**: `{activeTab === 'mpesaLogs'
&& <MpesaLogsPage />}`, with `MpesaLogsPage.tsx` (`src/renderer/src/pages/`)
owning its own state, data fetch, and a `STATUS_BADGE_CLASSES`/label
lookup table for its status pills. This is the exact precedent to
follow: a new `'needsAttention'` tab value, one new button, one new
`{activeTab === 'needsAttention' && <NeedsAttentionPage />}` line, and a
new self-contained `src/renderer/src/pages/NeedsAttentionPage.tsx`.

**No numeric-count badge exists anywhere in the app today** — every
existing badge (`ConnectivityBadges.tsx`, the online/offline pill, the
shift-open pill) is a binary/enum status pill, not a count. The
"prominent unfiled-sales count" requirement (Part 3) is new UI territory
for this app, not a reuse — small, but worth knowing going in rather
than assuming a component already exists for it.

## `KNOWN_GAPS.md`

No entry exists for "flagged sale only visible as a toast" — nothing to
delete there. `docs/phase-79.md` and `FiscalNotice.tsx`'s own doc
comment already name this exact gap and call it "Step 4," so Part 4's
close-out is documenting a gap that was already acknowledged in code
comments, not discovering a new one.

## Smallest approach, given all of the above

- **Part 2**: one new `getOrdersNeedingAttention()`-style query joining
  `orders` to `sync_queue` (LEFT JOIN, since `needs_fixing` rows have no
  queue row) to compute the stuck-waiting signal in one pass; one new
  `getUnfiledCount()` query (`waiting` + `needs_fixing`, trivial `COUNT`);
  one new IPC handler wiring `resendFiscalization` (mirroring
  `fiscal:correct-pin-and-resend`'s existing shape exactly); reuse
  `correctPinAndResend`'s existing handler/schema as-is for the wrong-PIN
  case, no changes needed there. If option 1 above is confirmed, the
  `fiscal_data_issue` column migration lands in this part too, following
  the exact pattern `migrateOrdersFiscalColumns` already uses.
- **Part 3**: `NeedsAttentionPage.tsx` following `MpesaLogsPage.tsx`'s
  shape, plus the count badge on `AdminScreen`'s tab button (new
  pattern, small).
- **Part 4**: flip `FISCAL_NOTICE_TIMEOUT_MS`, one constant + one
  comment update.

## Open questions for your review before Part 2

1. **Stuck-waiting threshold**: true abandonment only, or a lower bar
   (and if so, attempts-based or time-based, and what number)?
2. **`fiscal_data_issue` persistence**: add the column (recommended), or
   match the fixed reason string?

Holding here for those two calls before Part 2 touches the database or
adds any IPC.
