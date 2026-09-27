# Phase 169 - Four small commits from phases 167 and 168

- **Date:** 2026-09-27
- **Requested:** Four separate commits. 0: Retry Sync must not create a second queue row (docs/phase-168 finding 3). 1: a push marker on each sale, written just before it is sent to Shopify (docs/phase-168 section 2.4, marker only). 2: send the sale's `clientOrderUuid` as Shopify's `sourceIdentifier` (flagged for review). 3: remove check:fit's three old click-driven attempts (docs/phase-167). Then verify and stop for review.
- **Outcome:** Implemented. Four commits, stopped for review.
- **Branch / base commit:** staging @ 850555d (docs/phase-168)

| Commit | Sha | Summary |
| --- | --- | --- |
| 0 | `9527187` | Retry Sync never adds a second queue row |
| 1 | `3605ece` | Push marker written before each send |
| 2 | `47f1b83` | `sourceIdentifier` sent to Shopify (**flag for explicit review**) |
| 3 | `554fbb0` | check:fit: the three old click-driven attempts removed |

**Hard rules kept:** no fiscal file touched; no payment-gate file touched (`checkout.ts`, the M-Pesa files and every fiscal file are absent from all four diffs). No Shopify call in any test: every push is a `vi.fn()` stub, and `orders.test.ts` uses its existing injected mock client. No SQL against real data: new tests use `:memory:` or a throwaway file under the OS temp folder. **No existing assertion was changed** (section 6).

---

## Commit 0 - Retry Sync keeps one queue row per sale

**Problem** (docs/phase-168 finding 3): `retryOrderSync` always inserted a new `sync_queue` row, even for a `pending_sync` sale that still had its original row. The next tick pushed both rows, so Shopify got the sale twice.

**Change** (`src/main/services/database.ts:2009-2048`):
- After setting the sale back to `pending_sync`, it looks for an existing `'order'` row for that sale (`database.ts:2029-2031`).
- **Found:** that row's `next_attempt_at` is set to now (`database.ts:2032-2036`) and its id is returned. No insert.
- **Not found** (a `failed` sale, whose row was deleted when its attempts ran out): one row is inserted, exactly as before (`database.ts:2039-2045`).
- `synced` is still refused (`database.ts:2017-2019`). A missing sale is still refused.
- `attempts` on a reused row is left as it is (comment at `database.ts:2027-2028`). See section 7 for what that means.

The change is inside the existing transaction, so the status update and the row change happen together.

**Tests** (`tests/orderHistory.test.ts`, new describe block using the real `better-sqlite3` through `vi.importActual`, injected via the existing `DatabaseFactory` option, against `:memory:`):
- `pending_sync` with a row: still exactly one row, due now. The row is first pushed into the future by one recorded failure, so "due now" is proven by the retry and not by the row's initial `0`.
- `failed` (no row left): exactly one new row.
- `synced`: refused, and no row created.
- Two presses: one row.
- Two presses on a `failed` sale: one row (the second press finds the row the first press made).

**Sync engine test** (`tests/syncEngine.test.ts`, "SyncEngine after Retry Sync on a pending sale (real SQLite)"): queue a sale, press Retry Sync, run one tick. `pushOrder` (a stub) is called once, the sale is `synced` with the stub's id, and no queue row remains.

**Mutation test:** I changed `if (existing)` to `if (existing && false)` (the old unconditional insert) and ran both files. Four new tests failed:
- `pending_sync with a row` (expected 2 to be 1)
- `two presses: still one row` (length 3, expected 1)
- `two presses on a failed sale` (expected 1 row)
- the sync engine test (`pushOrder` "called 2 times")

The `failed` and `synced` tests still passed, which is correct: they do not depend on the bug. After restoring the fix, all 26 tests in the two files passed.

## Commit 1 - Push marker (marker only, no guard)

**Schema** (additive):
- `SCHEMA.orders` gains `shopify_push_count INTEGER NOT NULL DEFAULT 0` and `shopify_last_push_at TEXT` (`database.ts:492-493`) for a fresh database.
- `migrateOrdersPushColumns` (`database.ts:417-435`) adds both columns to an existing database, using the same idempotent `ALTER TABLE` pattern as `migrateOrdersReceiptColumns` and `migrateOrdersFiscalColumns`. It is called from `init()` right after the receipt migration (`database.ts:1178`).
- Existing rows read back as count 0 and no push time. This is also the true value for every sale sent before this phase: the marker cannot know about them.

**Database methods:**
- `recordPushStarted(localId)` (`database.ts:1822-1828`): one `UPDATE` sets `shopify_push_count = shopify_push_count + 1` and `shopify_last_push_at = <now>`. One statement is committed atomically by SQLite as its own transaction, so no explicit `transaction()` wrapper is needed. Both values change together or not at all.
- `getShopifyPushMarker(localId)` (`database.ts:1836-1841`): reads the pair. It is a separate reader on purpose: widening `getOrder`'s column list would change the row shape every existing caller and test reads.

**Engine** (`src/main/services/sync-engine.ts`):
- `SyncEngineDatabase` gains `recordPushStarted` (`sync-engine.ts:26`).
- In `tick()`, `db.recordPushStarted(item.entity_id)` runs immediately before `await pushOrder(item.payload)` (`sync-engine.ts:90-95`). `better-sqlite3` is synchronous, so the marker is committed before the request starts. If writing the marker throws, the push does not happen.
- The online checks are unchanged, so nothing is marked while offline.

**Retry Sync never resets it:** the marker lives on the `orders` row, and `retryOrderSync` does not touch those columns (tested).

**No behaviour change otherwise:** nothing reads the marker yet. Every existing sync engine test passes unchanged, including the lifecycle tests that expect `pushOrder` to be reached after a single `await Promise.resolve()`. That only still holds because the marker write is synchronous.

**Tests:**
- `tests/syncEngine.test.ts`, "SyncEngine push marker":
  - the marker is written for the queue row's own sale (`entity_id`), and before `pushOrder` (`invocationCallOrder`);
  - no marker is written while offline;
  - a fresh sale starts at `{ count: 0, lastPushAt: null }`;
  - **a push that throws still leaves count 1** (and a push time);
  - **two pushes give count 2** (the first fails, the clock moves past the 30 s backoff, the second succeeds);
  - **Retry Sync never resets it** (count stays 1).
- `tests/shopifyPushMarkerMigration.test.ts` (new): the upgrade test on a **file-backed** database. It builds the pre-phase-169 `orders` table by hand, inserts a row, closes it, reopens it through `RubisDatabase.init()`, and checks the old row is intact and reads as count 0 with no push time. It then checks that `recordPushStarted` works on the upgraded row, and that `init()` a second time does not throw.

**Extra mutation check** (not asked for): moving the marker write to after `pushOrder` made exactly two tests fail ("before calling pushOrder" and "a push that throws still leaves count 1"). Restored; all 19 tests in the file passed.

## Commit 2 - `sourceIdentifier` (FLAG FOR EXPLICIT REVIEW: changes what is sent to Shopify)

**Change:** `buildOrderInput` adds `sourceIdentifier: payload.clientOrderUuid` to the `orderCreate` order input (`src/main/services/orders.ts:87`). `customAttributes`, the `rubis_pos.client_order_uuid` metafield, the note, line items, `financialStatus` and the options are all unchanged. The doc comment (`orders.ts:57-65`) says why, with the sources.

**Sources** (shopify.dev, 2026-07 API docs, checked 2026-09-27):
- [OrderCreateOrderInput](https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/OrderCreateOrderInput), `sourceIdentifier`: "The ID of the order placed on the originating platform. This value doesn't correspond to the Shopify ID that's generated from a completed draft."
- [Order](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order), `sourceIdentifier`: "A unique POS or third party order identifier. For example, "1234-12-1000" or "111-98567-54". The receiptNumber field is derived from this value for POS orders."
- [orders query](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders), filter `source_identifier`: "Filter by the ID of the order placed on the originating platform, such as a unique POS or third-party identifier." Example: `source_identifier:1234-12-1000`.

**Why it helps:** docs/phase-168 found that searching by the metafield needs a metafield definition with admin filtering switched on in the store (a one-off setting someone has to own). `source_identifier` is a built-in search filter, so a later lookup can find this sale's order without that setting.

**Not verified** (no Shopify call allowed):
- Shopify does not document rejecting a duplicate `sourceIdentifier`, so this must not be read as a duplicate guard. It is an identifier to search by, nothing more.
- Whether `receiptNumber` changes for these orders. The docs say it is derived from this value "for POS orders", and these are API orders, not Shopify POS orders. The first real synced order should be checked in Shopify admin.
- Orders created before this commit do not have it. A lookup must still fall back to the metafield, or accept that older orders are not found this way.

**Tests** (`tests/orders.test.ts`):
- `sourceIdentifier` equals `clientOrderUuid`;
- the order input's other keys are exactly `customAttributes`, `financialStatus`, `lineItems`, `metafields`, `note` (nothing else added or removed), and `customAttributes`/`metafields` still hold the same values.

The existing test that the mutation is sent "with built variables" passes unchanged, because it compares against `buildOrderInput`'s own output.

## Commit 3 - check:fit clean-up

**Removed from `scripts/check-fit.mjs`:**
- `tryOpenVariantModal` (the catalogue search for a multi-variant product) and its call in `runCase`;
- the docked keyboard attempt through a real manual M-Pesa code field;
- the ZReportModal attempt through a real Shift History row (the Shift History sub-view itself is still measured).

The header comment and the synthetic-screens comment now say that the synthetic cases (`'mpesaManualKeyboard'`, `'zReport'`, `'variantModal'`, at all 9 sizes) are the only place those three screens are measured, and why the old attempts went. No test reads this script's source (searched `tests/`, `src/`, `scripts/`).

**One side effect worth knowing:** `tryOpenVariantModal` typed into the search bar and clicked single-variant results, which added them to the cart. Without it, the Cash and M-Pesa cases are measured with only the one item the existing cart step adds (unchanged), and with no search text left in the bar. This is a cleaner starting state, not a loss of coverage: the populated-cart case still exists.

## 5. Verify

```
$ npm run typecheck
(clean: typecheck:node and typecheck:web, no errors)

$ npx vitest run
Test Files  141 passed (141)
     Tests  2070 passed (2070)
(baseline before this phase: 140 files, 2054 tests; +1 file, +16 tests, 0 failures)

$ npm run build
built; "Confirmed: neither mock provider is in out/main."

$ npm run check:fit
...
✔ VariantModal (synthetic 6-variant product) - 2560x1440 @150%: page 1373x772 vs client 1373x772

Measured and fit: 274
Skipped (0):
Allow-listed scrollers (0):

✔ All 274 case(s) fit with no overflow.
```

(check:fit prints a long dash between the screen name and the size; it is shown here as a hyphen, otherwise verbatim.) "Measured and fit" is 274, the same as in docs/phase-167. The removed attempts had never measured anything in this environment; all 27 of their lines were skips. So removing them takes the skipped count from 27 to 0 without losing a single measured case. The three screens are still measured by their synthetic cases at all 9 sizes, all passing (the ZReportModal and VariantModal lines above are the tail of that output).

New tests by file: `orderHistory.test.ts` +5, `syncEngine.test.ts` +7, `shopifyPushMarkerMigration.test.ts` +2 (new file), `orders.test.ts` +2.

## 6. Changed existing assertions

**None.** No existing `expect(...)` was edited or removed in any commit.

One existing **test fixture** gained a field: `makeEngine`'s fake database in `tests/syncEngine.test.ts` now includes `recordPushStarted: vi.fn()`.
- **Old:** the fake had `getPendingSyncQueue`, `markQueueItemSynced`, `recordQueueFailure`.
- **New:** the same, plus `recordPushStarted`.
- **Why:** the engine now calls it before every push. Without it, every existing engine test that pushes would throw. It asserts nothing by itself.

## 7. Observed but not changed

- **Retry Sync accepts a voided sale.** `retryOrderSync` refuses only `synced` (`database.ts:2017-2019`). The button only appears for `failed`/`pending_sync` sales (`OrderHistory.tsx:201-213`), but the `orders:retrySync` IPC handler (`index.ts:2301-2317`) passes any id straight through. A call with a voided sale's id would set it back to `pending_sync` and queue it for Shopify. This was true before this phase; it needs a decision (refuse `voided` too), so it was left alone.
- **Retry on a pending sale keeps its attempt count.** Before, a retry added a fresh row with 0 attempts (and the duplicate). Now the existing row keeps its count, so a sale already at 9 of 10 attempts gets one more try before becoming `failed`. After that, Retry Sync gives it a new row with 0 attempts (the `failed` path). This follows the brief ("set that row's next_attempt_at to now"); resetting attempts on reuse would be a one-line change if wanted.
- **check:fit runs the real sync and fiscal engines.** It launches the built app against a copy of the real database and credential vault (`check-fit.mjs`, `copyAppState`). Nothing stops that copy's engines from sending any sale still queued in the copy to Shopify, or any queued fiscal retry to the device. The real app would then send the same sale again from the real database: a duplicate. This is not new in this phase. A small guard (for example, not starting either engine when `RUBIS_CHECK_FIT_SIZE` is set) is worth its own reviewed change.
- **A `pushOrder` that throws rejects `tick()`.** The `void tick()` callers (`sync-engine.ts:111-112`, `:125`, `:129`) then leave an unhandled rejection. `pushOrderToShopify` itself never throws, but its wrapper in `index.ts:859-868` can (`createShopifyClient` throws on an invalid store URL). This was true before this phase; commit 1 only makes sure the marker is written first.

## Rollback

Each commit reverts on its own with `git revert <sha>`, newest first if more than one:
- **Commit 3:** script only.
- **Commit 2:** new orders stop carrying `sourceIdentifier`; orders already created keep it (harmless, nothing reads it).
- **Commit 1:** the code revert stops writing the marker. The two columns stay in any database that already ran `init()`. They are additive, and no code reads them, so leaving them is harmless. SQLite would need a table rebuild to drop them, which is not worth doing.
- **Commit 0:** restores the duplicate bug.

**STOP for review.**
