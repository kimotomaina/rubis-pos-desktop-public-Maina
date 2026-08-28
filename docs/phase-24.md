# Phase 24 — eTIMS Fiscalization Integration & End-to-End Testing

**Date:** 2026-08-27 · **Branch:** `main` · **Previous:** [Phase 23](./phase-23.md)

## 1. Objective

Phase 23 built `fiscal-engine.ts` and its unit tests, each collaborator
(`RubisDatabase`, `createFiscalEngine`, `RealFiscalizationProvider`)
tested in isolation with fakes standing in for the others. This phase
adds integration coverage proving the real pieces work together —
`checkout → queueFiscalInvoice → fiscalEngine.tick → provider →
setOrderFiscalInfo` — plus resilience tests for idempotency,
re-entrancy, and abandonment. No source file changed; this phase is
test-only, as scoped.

## 2. `tests/fiscalIntegration.test.ts` — real DB, real engine, mocked provider

Runs against a **real** in-memory `better-sqlite3` connection
(`RubisDatabase({ dbPath: ':memory:' })`), the same pattern
`reconciliation.test.ts` already established, rather than the
recording fake `database.test.ts` uses. That fake ignores SQL text
entirely and just replays whatever rows a test pre-registers — it
cannot tell a `WHERE entity_type = 'order'` clause from no clause at
all, which is exactly the kind of regression this phase needs to
prove stays fixed (§4). `createFiscalEngine` is the real engine, not a
fake. Only `RealFiscalizationProvider` is mocked — per the brief's own
recommended default (Q2): its HTTP behavior is already covered by
`realEtimsProvider.test.ts`, and exercising the actual ZFPLabServer
protocol needs the physical device, which belongs in the manual
runbook (§5), not CI.

`attemptFiscalization()` in the test file is a **test-local** mirror
of `orders:checkout`'s fiscalization block (submit → save on success,
queue on any failure) — not exported production code. It exists so
the integration scenarios can drive the exact same sequence
deterministically without booting Electron or refactoring
`main/index.ts`'s inline `ipcMain.handle` closure, which isn't
structured for standalone invocation.

### Scenario A — happy path

`submitInvoice` resolves successfully on the first call.
`attemptFiscalization` is asserted to call it with the order's
`clientOrderUuid`, and `db.getOrder()` afterward — read back for real,
not a mock assertion — shows the saved `fiscal_invoice_number`/
`fiscal_qr_code`. The fiscal queue is confirmed empty.

### Scenario B — device offline at checkout

`submitInvoice` rejects once (simulating `ECONNREFUSED`), then
resolves on a second call. `attemptFiscalization` returns `undefined`
(no fiscal data), but critically the checkout itself was never at
risk — `queueOrder` already committed before fiscalization was even
attempted, matching `orders:checkout`'s real ordering. The order's
`fiscal_invoice_number` is confirmed `null` and exactly one row lands
in the fiscal queue. A real `fiscalEngine.tick()` is then run
explicitly (not via `onCheckoutMade()`'s fire-and-forget trigger —
see the note below) and is shown to resubmit, succeed, and leave the
order fiscalized with an empty queue.

**Why a manual `tick()` instead of `onCheckoutMade()`:** `onCheckoutMade()`
starts a background `tick()` without awaiting it
(`fiscal-engine.ts`'s own design, unit-tested in
`fiscalEngine.test.ts`). Calling it from a test and then immediately
calling `tick()` again to "wait for the retry" races the engine's own
re-entrancy guard: the first, backgrounded pass is often still
`running` when the second call arrives, so the second call is a
guaranteed no-op and the test would be asserting on a promise that
resolved before the real work finished. That race exists independent
of testing — this suite avoids it by testing the two concerns
separately: `onCheckoutMade()`'s wiring is already proven in
`fiscalEngine.test.ts`; this suite proves the queue → retry → success
data flow with an explicit, awaited `tick()`.

## 3. Resilience scenarios

- **Idempotent retry** — a `deviceLedger` map in the test simulates
  the fiscal device having actually processed the first (timed-out)
  request under its `clientOrderUuid`. The mocked retry looks up and
  returns that same `'KRA-ORIGINAL'` number rather than minting a new
  one. Asserts `submitInvoice` received the identical
  `clientOrderUuid` on both calls, the order ends up with the
  device's original number, and — the actual non-duplication proof —
  the fiscal queue has exactly one entry before the retry and zero
  after, never two.
- **Re-entrancy guard** — `vi.useFakeTimers()` plus
  `vi.advanceTimersByTimeAsync()` (Q1's recommended approach) drive a
  `submitInvoice` that "takes" 5 simulated seconds. A second `tick()`
  fired 1 simulated second in is proven to be a no-op — the provider
  is called exactly once — with zero real wall-clock delay and zero
  timing flakiness.
- **Abandonment** — fake timers again, advancing the clock by 31
  simulated minutes after each failed attempt (comfortably past
  `SYNC_BACKOFF_CAP_MS`'s 30-minute cap, regardless of the exact
  backoff at that attempt count) so ten failures run back-to-back with
  no real waiting. Confirms the provider is called exactly 10 times,
  never an 11th, and reads the abandoned row back through the public
  API by passing `Number.MAX_SAFE_INTEGER` as `getPendingFiscalQueue`'s
  `now` (the only value guaranteed `>=` the abandoned row's own
  `next_attempt_at`) — no new inspection method was added to
  `RubisDatabase` for this, keeping the phase test-only. Confirms
  `last_error` starts with `ABANDONED` and `next_attempt_at` is
  exactly `Number.MAX_SAFE_INTEGER`.

## 4. Phase 23 regression: `getPendingSyncQueue` excludes `etims_invoice`

A `queueOrder()` call's `'order'` queue row is removed via
`markQueueItemSynced()`, then `queueFiscalInvoice()` inserts the only
remaining row as `'etims_invoice'`. `getPendingSyncQueue()` — the
Shopify sync engine's query — is asserted to return `[]`. This is the
regression Phase 23 fixed, now proven against a real SQL `WHERE`
clause rather than the fake connection's replay behavior, which
cannot fail this way even if the filter were silently removed from
the source.

## 5. Manual testing runbook (on-site PoC)

Unit and integration tests are hermetic by design (Q2) — none of them
talk to a real ZFPLabServer. Before relying on this in a live PoC,
verify the physical path by hand:

**Verify the happy path**
1. Confirm ZFPLabServer is running and reachable at the configured
   `baseUrl` (Admin → Integrations → eTIMS → Server URL).
2. Ring up a sale. The receipt should print a `Fiscal Inv:` line
   (see `printer.ts`'s fiscal footer) and Order History should show
   the "Fiscalized" badge/QR thumbnail immediately.

**Verify the store-and-forward queue**
1. With the till otherwise idle, physically unplug the ZFPLabServer
   machine's network cable (or stop the ZFPLabServer process/service
   if it runs locally).
2. Ring up a sale. It must complete normally — total, receipt, and
   change all print — with no fiscal invoice number yet.
3. Open the SQLite database (`%APPDATA%\rubis-pos-desktop\rubis-pos.db`,
   `sync_queue` table) with any SQLite browser and confirm a new row
   exists with `entity_type = 'etims_invoice'` and `entity_id` matching
   the order's `local_id`.
4. Reconnect the ZFPLabServer. Within 30 seconds (the engine's poll
   interval) the row should disappear from `sync_queue`, and the
   order's `fiscal_invoice_number`/`fiscal_qr_code` columns in the
   `orders` table should be populated. Order History's badge should
   appear without restarting the app.

**Verify abandonment (optional, destructive to the test row)**
1. Repeat the offline steps above, but leave ZFPLabServer disconnected
   for the full retry window (10 attempts, backoff capping at 30
   minutes — roughly several hours if left untouched; not a quick
   manual check, so this is best verified by inspecting a queue row
   directly and trusting the automated coverage in §3, rather than
   waiting it out).
2. To force it quickly instead: with the app closed, edit the row's
   `attempts` to `9` and `next_attempt_at` to `0` directly in SQLite,
   then start the app. Within seconds the engine should run one more
   failed attempt, after which the row's `last_error` should read
   `ABANDONED after 10 attempts: ...` and `next_attempt_at` should be
   an enormous number (`9007199254740991`). The row stays in
   `sync_queue` — it is not deleted — for IT to find and resolve
   manually (issue the fiscal document a different way, or hand-enter
   the resulting invoice number once available and clear the row).

## 6. Verification

- `npm run typecheck` — clean (both `node` and `web` projects).
- `npm test` — 489/489 passing (483 prior + 6 new
  `fiscalIntegration.test.ts` cases). Re-ran the new file three times
  in isolation to confirm no timing flakiness before including it in
  the full suite.
