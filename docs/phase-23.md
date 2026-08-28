# Phase 23 — eTIMS Fiscalization Store-and-Forward Queue

**Date:** 2026-08-27 · **Branch:** `main` · **Previous:** [Phase 22](./phase-22.md)

## 1. Objective

`RealFiscalizationProvider.submitInvoice()` was called once, inline,
during checkout. If the local ZFPLabServer was unreachable or
rejected the request, the failure was logged and the sale completed
un-fiscalized with no recovery path — the invoice simply never got a
KRA number unless a human noticed and intervened. This phase adds a
background retry queue for fiscalization, mirroring the existing
Shopify `sync-engine.ts` pattern, so a failed fiscalization is queued
and retried automatically instead of silently dropped.

## 2. `sync_queue` reused, not a new table

`entity_type` on `sync_queue` has no `CHECK` constraint in this
schema (unlike `orders.status`, which does) — there was nothing to
"update" to allow `'etims_invoice'`, it's a free-form `TEXT` column
already. Reusing the table (per the brief's own recommended default)
was still the right call: identical shape needed
(`entity_type`, `entity_id`, `payload_json`, `attempts`,
`next_attempt_at`), and a second table would just be Phase 18's
rejected-duplicate-persistence mistake again.

## 3. A latent bug this phase had to close first

`RubisDatabase.getPendingSyncQueue()` — the query `sync-engine.ts`
polls — selected **every** `sync_queue` row with `next_attempt_at <=
now`, with no `entity_type` filter, because until this phase the
table only ever held `'order'` rows. The instant `'etims_invoice'`
rows share the table, that query would hand the Shopify sync engine a
row whose `payload_json` is a `FiscalInvoiceRequest`, which it would
`JSON.parse` as an `OfflineOrderPayload` and attempt to push to
Shopify — corrupt data sent to Shopify, not just a crash. Fixed by
scoping the query to `WHERE entity_type = 'order'`; the new
`getPendingFiscalQueue()` is the `'etims_invoice'` counterpart.
`RubisDatabase.voidOrder()`'s queue cleanup got the same scoping
treatment in reverse — it now also removes any pending
`'etims_invoice'` row for a voided order, so a void doesn't leave a
fiscalization retry chasing a sale that no longer exists.

## 4. `fiscal-engine.ts`

A new, separate engine (`sync-engine.ts` untouched, per the brief) —
same `start`/`stop`/`tick`/`notifyOnline`/`onCheckoutMade` shape, same
re-entrancy guard. One deliberate deviation: it has **no `isOnline`
gate**. `sync-engine.ts` gates every tick on `net.isOnline()` because
Shopify is a cloud API; the eTIMS device sits on the till's LAN and
its reachability is unrelated to internet connectivity. Gating
fiscalization retries on internet connectivity would incorrectly
freeze them during an internet outage even when the local device is
perfectly reachable. The offline→online transition is still wired as
a trigger (`monitor`'s `emit` callback calls both engines'
`notifyOnline()`) since it's a reasonable "connectivity just changed,
worth checking everything" signal and costs nothing extra.

An exhausted item (`attempts >= maxAttempts`, default 10, the same
`RubisDatabase` constructor option `recordQueueFailure` already uses)
is **never deleted** — `recordFiscalQueueFailure` instead prefixes
`last_error` with `ABANDONED after N attempts:` and pushes
`next_attempt_at` to `Number.MAX_SAFE_INTEGER`. This differs
deliberately from the Shopify queue's exhaustion behavior (which
deletes the row and marks the order `failed`): a missed Shopify sync
is recoverable via "Retry Sync" in Order History, but an
un-fiscalized invoice is a compliance gap, not a UX inconvenience — it
stays in `sync_queue` for IT to find and handle by hand rather than
vanishing.

## 5. Checkout integration (`main/index.ts`)

`orders:checkout`'s fiscalization block is now wrapped in `try/catch`
(`submitInvoice` itself shouldn't throw — `RealFiscalizationProvider`
catches its own HTTP errors — but the brief asked for defense against
an unexpected throw, and it costs nothing). On any failure path
(`success: false` or a thrown error), the same request object queued
to Shopify parlance would use is instead persisted via
`db.queueFiscalInvoice(localId, fiscalRequest)` and `fiscalEngine
.onCheckoutMade()` fires an immediate retry attempt — matching how a
failed Shopify push already falls back to `sync_queue` rather than
failing checkout. The sale itself is never blocked or reverted by a
fiscalization failure, queued or not.

`fiscalEngine.start()`/`stop()` are wired alongside the Shopify
`engine`'s in the app lifecycle (`will-quit` stops both), giving the
"or when the app starts" trigger — `start()` runs an immediate tick,
same as `sync-engine.ts`.

## 6. Idempotency (`real-etims-provider.ts`)

`FiscalInvoiceRequest.clientOrderUuid` was already validated as
required but was never actually sent to the device — none of the
`OpenInvoice`/`SellPLU`/`CloseReceipt` payloads included it. Since a
queued retry resubmits the *same* `FiscalInvoiceRequest` object
verbatim (`queueFiscalInvoice` stores it once; `fiscalEngine` reads it
back unchanged), the device has no way to recognize a retry as a
duplicate of a request that may have already succeeded without
acknowledging. Fixed by adding `clientOrderUuid` to the `OpenInvoice`
payload — the natural point to identify the invoice being opened.

## 7. Testing

- `tests/fiscalEngine.test.ts` (new, 12 tests) — happy path (batch
  resubmit + mark-synced), idempotent-uuid resend, failure recording,
  generic-error fallback, continuing past an exhausted item,
  no-connectivity-gate sanity check, re-entrancy coalescing, and the
  full start/stop/notifyOnline/onCheckoutMade lifecycle — mirroring
  `syncEngine.test.ts`'s suite shape line for line.
- `tests/database.test.ts` — five new `describe` blocks:
  `queueFiscalInvoice`, `getPendingFiscalQueue`,
  `markFiscalQueueItemSynced`, and `recordFiscalQueueFailure`
  (backoff-and-keep, abandon-after-max-attempts-without-deleting, and
  missing-row-is-exhausted).
- `tests/database.test.ts`'s existing `getPendingSyncQueue` test —
  updated its SQL-substring match for the new `entity_type = 'order'`
  clause (no behavior assertion changed).
- `tests/voids.test.ts` — updated to expect *two* `DELETE FROM
  sync_queue` statements (`'order'` and `'etims_invoice'`, each
  asserted by clause and by `entity_id` param) instead of one.
- `tests/realEtimsProvider.test.ts` — new test asserting
  `clientOrderUuid` reaches the `OpenInvoice` payload.

## 8. Verification

- `npm run typecheck` — clean (both `node` and `web` projects).
- `npm test` — 483/483 passing (463 prior + 12 new
  `fiscalEngine.test.ts` cases + 7 new `database.test.ts` cases across
  the four new methods + 1 new `realEtimsProvider.test.ts` idempotency
  case).
