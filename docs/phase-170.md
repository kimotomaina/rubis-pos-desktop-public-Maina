# Phase 170 - The Shopify safety check (docs/phase-168, amended docs/phase-169)

- **Date:** 2026-09-27
- **Requested:** Three commits building the check docs/phase-168 designed. First, a report-only confirmation of a docs/phase-169-1 claim. Commit 1: read-only Shopify lookups. Commit 2: the periodic check and the per-item pre-push guard, inside the sync engine. Commit 3: where the results show. Hard rules: no fiscal or payment-gate changes; Shopify read-only (no mutation of any kind); no Shopify calls in tests (mocked HTTP only); no SQL on real data.
- **Outcome:** Implemented. Three commits, stopped for review.
- **Branch / base commit:** staging @ 1550e0b (docs/phase-169-1)

| Commit | Sha | Summary |
| --- | --- | --- |
| 1 | `5ad2f8e` | Read-only Shopify lookups (`shopify-reconcile.ts`) |
| 2 | `9ce1a73` | The check and the pre-push guard, inside the sync engine |
| 3 | `fff1db7` | Where the results show |

**Hard rules kept:** no file under `real-etims-provider.ts`, `checkout.ts`, `PaymentModal.tsx`, `PosCheckoutPanel.tsx`, or any M-Pesa provider was touched. Every Shopify call in `shopify-reconcile.ts` is a plain GraphQL query (`currentAppInstallation`, `orders`, `nodes`, `ordersCount`) - no mutation exists in the file, and `reconciliation.ts`'s only local write is `linkOrderToShopify`, which never calls Shopify itself. No Shopify call in any test: every HTTP call is an injected mock client (`orders.test.ts`'s own pattern) or a hand-rolled fake `ReconciliationDatabase`/`ReconciliationRunner`. No SQL against real data: every test uses `:memory:` or a throwaway temp-file database.

---

## FIRST - confirming a docs/phase-169-1 claim (report only)

**Claim to confirm:** in check:fit mode, the fiscal device address comes only from the copied database row, with no environment variable able to override or supply it.

**Confirmed, by reading the whole chain with no env var anywhere in it:**

1. `index.ts:806-812` reads the device config exactly once: `` const etimsConfig = db.getIntegrationConfig<{ baseUrl?: string; endpoints?...; deviceIp?: string; devicePort?: string }>('etims') `` - a plain read of the `integrations` table's `config_json` column for the `'etims'` row (`database.ts:2310-2317`'s `getIntegrationConfig`, itself one `SELECT config_json FROM integrations WHERE provider = ?`, `JSON.parse`d, no env var anywhere in that method).
2. `index.ts:817-822` passes `etimsConfig.baseUrl`/`etimsConfig.deviceIp`/`etimsConfig.devicePort` straight into `resolveFiscalizationProvider`'s `realOptions` - the values from step 1, unchanged.
3. Neither `real-etims-provider.ts` nor `fiscal-provider-factory.ts` reads `process.env` anywhere - confirmed by an exhaustive search of both files (`grep -n "process\.env"` returns no matches in either).
4. The only other reference to a default address is `DEFAULT_ETIMS_BASE_URL = 'http://localhost:4444/'` (`http-client.ts:45`), used in exactly two places: a debug log line (`index.ts:872`, `` etimsConfig.baseUrl || `(default) ${DEFAULT_ETIMS_BASE_URL}` ``) and the connectivity monitor's own reachability probe (`index.ts:1008`, `` db.getIntegrationConfig<{ baseUrl?: string }>('etims').baseUrl || DEFAULT_ETIMS_BASE_URL ``). Both only fall back to it when the configured value is itself empty - neither is an override of a value that is already set, and neither is an environment variable.
5. `applyEtimsConfigToProvider` (`index.ts:846-863`, the live-reconfigure path an Admin-screen save triggers) reads the identical way - `db.getIntegrationConfig<{...}>('etims')` - nothing else.

So `docs/phase-169-1`'s `sanitizeCopiedFiscalAddress` (rewriting the copied database's `etims` row to a closed loopback port, `check-fit.mjs:494-537`) is both necessary and sufficient on its own: there is no environment-variable path that could re-supply or override a real device address once that one row is rewritten.

---

## Commit 1 - read-only Shopify lookups

New file `src/main/services/shopify-reconcile.ts`. Every function resolves a `ServiceResult`, never throws, and takes an injected `AxiosInstance` - the same shape as `shopify.ts`/`orders.ts`.

- `checkScopes` (`shopify-reconcile.ts:360-375`) - `currentAppInstallation { accessScopes { handle } }` (`ACCESS_SCOPES_QUERY`, `:71-79`). Ready when `read_orders` or `read_all_orders` is present.
- `findBySourceIdentifier` (`:407-428`) - `orders(first: 5, query: "source_identifier:\"<uuid>\"")` (`FIND_BY_SOURCE_IDENTIFIER_QUERY`, `:93-105`), then keeps only nodes whose `sourceIdentifier` equals the uuid exactly (`:426`, `nodes.filter((node) => node.sourceIdentifier === uuid)`) - Shopify's search is a text match, not an equality test, so a near-match (a longer uuid merely containing this one) is discarded rather than trusted.
- `classifyOrderMatches` (`:388-392`) - a plain, dependency-free `none | one | many` classifier, kept separate from the fetch so it is its own tested unit.
- `existsByIds` (`:442-475`) - `nodes(ids:)` (`NODES_BY_ID_QUERY`, `:113-125`), batched at `MAX_NODES_PER_BATCH = 250` (`:142`, cited from shopify.dev's own "maximum size of 250 for input array arguments"). A `null` node means not found.
- `countRecent` (`:492-519`) - `ordersCount(query:, limit:)` (`ORDERS_COUNT_QUERY`, `:128-135`), `limit` capped at `ORDERS_COUNT_LIMIT = 10_000` (`:145`, shopify.dev's own documented cap). The date filter uses the documented `created_at:>='<ISO 8601>'` syntax.
- `ThrottleBudget` (`:170-207`) - tracks `extensions.cost.throttleStatus` from each real reply and waits, respecting an `AbortSignal`, before a request whose estimated cost exceeds what is currently available. This is the proactive mechanism shopify.dev documents; no reactive check for a "throttled" error code exists, because **no such code is documented on the pages this audit could reach** - see "Not verified" below.
- Every call shares one time-limited `postGraphQL` helper (`:294-346`) that keeps GraphQL `errors[].extensions` (unlike `shopify.ts`'s own translators, which drop them) and logs a scope denial's raw code before turning it into `SCOPE_MISSING_MESSAGE` (`:148-149`, `isScopeDeniedError`, `:247-251`).

### shopify.dev pages cited (API version 2026-07, all read 2026-09-27)

| Fact | Page |
| --- | --- |
| `orders(query:)` filters, including `source_identifier` | [orders query](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders) |
| `nodes(ids:)` returns the requested nodes, `null` for one not found | [nodes query](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/nodes) |
| `ordersCount(query:, limit:)`, needs `read_orders`/`read_marketplace_orders`, `limit` default/cap 10,000 | [ordersCount query](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/ordersCount) |
| `currentAppInstallation { accessScopes { handle } }` | [currentAppInstallation query](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/currentAppInstallation), [AccessScope object](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/AccessScope) |
| `extensions.cost` shape (`requestedQueryCost`/`actualQueryCost`/`throttleStatus`), 100/200/1000/2000 points-per-second by plan, 250-item input array cap | [GraphQL Admin API rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits) |
| `created_at:>='...'` date range syntax | [Search syntax](https://shopify.dev/docs/api/usage/search-syntax) |

**Not verified:** the exact `extensions.code` string (if any) Shopify uses for a cost-based throttle or for a scope-denial GraphQL error - neither the rate-limits page nor the general errors/access-scopes pages this audit fetched documented one (one attempted fetch of a general errors-reference page returned HTTP 404). `isScopeDeniedError` (`:247-251`) matches on wording as a result, the same fallback `shopify.ts`'s own HTTP-403 handling already uses; `checkScopes` (run first, before any order lookup) is the primary, verified mechanism for catching a missing scope, so this wording match is a defence-in-depth fallback, not the only safeguard.

### Tests (`tests/shopifyReconcile.test.ts`, 22 tests, mocked HTTP)

Exact match filters a near-match; none/one/many classification; `cancelledAt` passed through unmodified; batching at 250 (confirmed two calls, of 250 and 50); a scope-denial reply and a plain HTTP 403 both resolve `SCOPE_MISSING_MESSAGE`, with the raw code logged; `ThrottleBudget` waits when under budget, does not wait when there is enough, and rejects mid-wait when aborted; an already-aborted signal never calls the client; an axios cancellation resolves `TIME_LIMIT_MESSAGE`.

---

## Commit 2 - the check and the pre-push guard

### Database additions (`database.ts`)

- `ReconciliationCandidateRow` (`:925-933`) and `getReconciliationCandidates(sinceIso)` (`:2069-2108`): every sale in the window that is either `pending_sync`/`failed` with `shopify_push_count > 0` (the lost-response case), or `synced` (to confirm its Shopify order still exists). `client_order_uuid` is parsed out of `payload_json` once here, and a row whose payload cannot be parsed is skipped rather than aborting the whole check.
- `linkOrderToShopify(localId, shopifyOrderId)` (`:1907-1922`, doc comment `:1885-1906`): one transaction, `` UPDATE orders SET status = 'synced', shopify_order_id = ? WHERE local_id = ? AND status IN ('pending_sync', 'failed') ``, then (only if that update actually changed a row) `` DELETE FROM sync_queue WHERE entity_type = 'order' AND entity_id = ? ``. The `WHERE status IN (...)` clause is the whole safety property: a `voided` or already-`synced` sale can never be relinked, and only the `'order'` queue row is ever touched - a fiscal retry queued under `'etims_invoice'` for the same sale is untouched.

### `reconciliation.ts` (new)

Orchestrates `shopify-reconcile.ts` against `getReconciliationCandidates`, and is the only caller of `linkOrderToShopify`. `createReconciliationRunner` (`:125-...`) returns three methods:

- `beginTick()` - clears the per-tick lookup cache (`cache`, a `Map<uuid, ServiceResult<...>>`) shared between the periodic check and the guard, so a sale the check already looked up this tick is never looked up twice for the same push loop (docs/phase-168 section 2.4's own "reuse this run's result").
- `runCheck(signal)` - checks scopes first (fails safe, no candidate read at all, if not ready); reads candidates in the 7-day window; for each `pending_sync`/`failed` candidate, looks it up and classifies it (`none` - leave for the normal push; `one`, not cancelled - link; `one`, cancelled, or `many` - report only, never link); batches every `synced` candidate's existence check in one `existsByIds` call; counts the wider store's 7-day total and subtracts this till's own synced count for the "other tills" number. Every outcome (`ok` true or false) is handed to `onResult`.
- `guardPush(item)` - the pre-push guard: a fresh sale (`push_count` 0) always pushes; a sale pushed under 2 minutes ago (`RECENT_PUSH_SKIP_MS`, `:43`) is held without a Shopify call, on the theory that Shopify's own search may not have caught up yet; otherwise it looks the sale up (reusing the tick's cache if the periodic check already did) and pushes only if there is no match - anything else (one cancelled match, more than one match, or the lookup being unavailable for any reason) holds rather than pushing blind.
- `getClient()` is called fresh on every `runCheck`/`guardPush`, never cached across calls (`:82-92`'s own doc comment) - a token saved via the Admin screen mid-run takes effect on the very next check, not the next launch, matching how `main/index.ts`'s own `pushOrder` already rebuilds its Shopify client on every call.

### `sync-engine.ts` wiring

- `SyncEngineOptions` gains an optional `reconciliation?: ReconciliationRunner` (`:54`), `checkTimeLimitMs` (default 45 s, `:56`, `:85`) and `checkRetryIntervalMs` (default 10 minutes, `:58`, `:86`) - all optional, so every existing caller/test that omits them keeps exactly today's behaviour.
- `start()` (`:195-200`) and `notifyOnline()` (`:211-214`) set `checkDue = true`.
- `tick()` (`:141-192`): after the online test and `reconciliation?.beginTick()`, if `checkDue` or the 10-minute retry timer has elapsed, `runCheckWithTimeLimit()` (`:115-130`) runs the check inside its own `AbortController`, timed out at `checkTimeLimitMs`. Only then does the push loop run; every due item first goes through `reconciliation.guardPush(item)` (`:157-160`) - a `'linked'` or `'hold'` decision is never a recorded failure and never reaches `pushOrder` at all.
- Login and checkout never wait for any of this: `checkout.ts`'s own trigger (`void engineTick()...`, unchanged) was already fire-and-forget before this phase, and remains so - the check runs inside the engine's own background tick, never on the request path a cashier or a login waits on.
- **check:fit mode**: the check never runs, because `reconciliation` is never even constructed there (`main/index.ts:906`, `shouldStartBackgroundSenders(checkFitSendingDisabled) ? createReconciliationRunner(...) : undefined`) - the same structural guard docs/phase-169-1 already established for the engine's own `.start()`. Proven the same way that phase's own tests proved it (index.ts cannot be unit tested - it imports Electron at module load): `tests/syncEngine.test.ts`'s "check:fit mode (engine never started/notified): the check never runs, even if tick() is somehow called" asserts `reconciliation.runCheck` is never invoked when `checkDue` was never set to `true`, which is exactly the mechanism `start()`/`notifyOnline()` being skipped relies on.

### Tests

`tests/reconciliation.test.ts` (14 tests, mocked HTTP + a fake `ReconciliationDatabase`): the lost-response sale is linked, not resent; two matches are reported, never linked; the only match being cancelled is held and reported; a synced sale whose order is gone is reported as missing; scope missing fails safe with no candidate ever read; credentials missing (`getClient()` returns `null`) fails safe with no Shopify call at all, checked for both `runCheck` and `guardPush`; the guard allows a fresh sale through with no Shopify call; a push under 2 minutes ago is held with no Shopify call; a push over 2 minutes ago with no match pushes, with exactly one match links, and with the lookup unavailable holds; the guard reuses the same-tick lookup the check already made; `beginTick()` clears that cache for the next tick.

`tests/syncEngine.test.ts` (+7 tests, a fake `ReconciliationRunner`): check:fit mode never runs the check; `start()` runs it, offline skips it entirely, `notifyOnline()` runs it again on reconnect; the push loop waits for the check to finish before pushing anything; a timed-out check still lets a fresh item push while a held item stays held; a held item never reaches `recordPushStarted`/`pushOrder`/`recordQueueFailure`; a linked item is dequeued by the guard itself, never pushed, never a recorded failure; after a failed/timed-out check, the 10-minute retry timer (not every tick) governs the next attempt.

`tests/orderHistory.test.ts` (+5 tests, real SQLite, same pattern as the existing `retryOrderSync` describe block): `linkOrderToShopify` links a `pending_sync` sale (status synced, id set, queue row removed) and a `failed` sale (even with no queue row left); refuses a `voided` sale (no write at all) and an already-`synced` sale (does not overwrite its existing id); removes only the `'order'` queue row, leaving an `'etims_invoice'` row for the same sale untouched.

**Mutation (as instructed):** made the guard return `{ action: 'push' }` whenever the lookup was unavailable, instead of holding. Ran `tests/reconciliation.test.ts`: exactly one test failed - "the lookup being unavailable (an error result) holds, never pushes blind." Restored; all 14 tests passed again.

---

## Commit 3 - where the results show

### Admin > Needs Attention: the "Shopify check" card

`ShopifyCheckCard.tsx` (new) renders `describeReconciliationCard`'s output (`src/renderer/src/lib/shopifyReconciliation.ts:71-94`): a headline with the last run time, then one plain line per finding (wording per docs/phase-168 section 2.6, using the Shopify order **name** - e.g. `#1043` - when known, falling back to the raw id only if Shopify never returned one), followed by the "other tills" line last. Mounted at the top of `NeedsAttentionPage.tsx` (`:142`), above the existing fiscal list - the same screen, since both are "don't let a sale go unnoticed."

Held (`held-cancelled`, `duplicate`) and missing (`missing`) findings add to the Needs Attention badge (`AdminScreen.tsx:103-105`, `countActionableFindings` - everything except an automatic `linked` finding, which needed no one's attention). `NavStatusButton`'s own separate badge is intentionally left untouched this phase (see "Observed but not changed").

### Cashier notice

`ShopifyCheckNotice.tsx` (new), mounted alongside `FiscalNotice` in `App.tsx:772`: shows the exact line `` "Some sales need a manager to check them in Shopify. See Admin > Needs Attention." `` (`CASHIER_NOTICE_MESSAGE`, `shopifyReconciliation.ts:97-98`) only when `countActionableFindings` is above zero, and nothing at all for an automatic link. Uses the shared toast stack (`useToastStore`), `pinned: true` so it is never pushed out by routine toasts - the same flag `FiscalNotice` already uses, whose two doc comments (`toastStore.ts:29-36`, `toastVisibility.ts:9`) are updated to name both producers now that a second one exists.

### Delivery

One IPC read, `shopify:get-reconciliation-status` (`index.ts:948-951`), plus the existing `broadcast` helper for live updates (`shopify-reconciliation:status`, wired inside the runner's `onResult`, `index.ts:906-917`) - `useShopifyReconciliationStore` (new, `src/renderer/src/stores/shopifyReconciliationStore.ts`) reads once on `init()` and then only updates from the broadcast, unlike the fiscal count's own polling store (there is no polling here, since every update already has a push channel). `init()` is called once, globally, from `App.tsx`, matching `useUnfiledCountStore`'s own convention - `ShopifyCheckCard`/`ShopifyCheckNotice` only ever read.

Kept in main-process memory only (`lastReconciliationResult`, `index.ts:896`) - never persisted, so a restart simply waits for the next check rather than showing a stale one.

**Scope note:** the plain IPC read (`shopify:get-reconciliation-status`) had to land in commit 2, not commit 3 as the brief's own split implies - `main/index.ts` would not otherwise compile (`lastReconciliationResult` assigned but never read is a build error under this project's `noUnusedLocals`). Commit 3 adds the broadcast, the store, the card, the notice, and the badge - everything a person actually sees.

### check:fit

A fourth synthetic screen, `'shopifyCheckCard'` (`check-fit.mjs:993`), covering every finding kind at once (`App.tsx`'s `CHECK_FIT_SYNTHETIC_RECONCILIATION_RESULT`, one `linked`, one `duplicate`, one `held-cancelled`, one `missing`, plus an `otherTillsCount`) - run at all 9 sizes, same as the other three synthetic screens, via `ShopifyCheckCard`'s `resultOverride` prop (never the IPC-backed store) and `NeedsAttentionPage`'s new `shopifyCheckOverride` prop, so no database write and no Shopify call happen even against the throwaway copy.

A first attempt wrapped the overlay in a scrolling container (`overflow-auto`), which is exactly what Phase E's no-scroll rule forbids for `App.tsx` (`tests/noUnexpectedScroll.test.ts`'s own `ZERO_SCROLL_FILES`) - caught immediately by that existing test, and fixed by dropping the scroll class: `NeedsAttentionPage` already keeps its own content within the viewport via pagination, exactly as the pre-existing `Admin > Needs Attention` case already proved.

### Tests

`tests/shopifyReconciliationLib.test.ts` (14 tests, pure functions, no component mounted): every finding kind's exact wording, including the name-vs-raw-id fallback; `isActionableFinding`/`countActionableFindings` (a `linked` finding does not count; the other three do; `null` counts as zero); `describeReconciliationCard`'s three states (never run, failed, ok - with and without findings); the cashier notice's exact wording.

### A small correction to commit 2, made while writing this report

`reconciliation.ts`'s own doc comment on `RECONCILIATION_MAX_AGE_DAYS` (`:36`) already claimed the check's window is "never older than this" - but nothing in `runCheck` actually enforced it; the constant was declared and never read. `:189` now reads `` isoDaysAgo(now, Math.min(RECONCILIATION_WINDOW_DAYS, RECONCILIATION_MAX_AGE_DAYS)) `` - a no-op today (7 is already less than 60) but a genuine cap if the window were ever widened. Included in this commit rather than amending commit 2 (this project's own convention of a new commit over an amend). All 14 `reconciliation.test.ts` tests, which exercise `runCheck` directly, still passed unchanged, since the effective value did not change.

---

## 6. Changed existing assertions

None. No existing `expect(...)` in any test file was edited or removed by any of the three commits.

One existing non-assertion doc comment was corrected because it became inaccurate: `toastStore.ts`'s and `toastVisibility.ts`'s notes that `pinned` is "set only by FiscalNotice" now name `ShopifyCheckNotice` too (see commit 3 above) - a wording fix, not a behaviour or assertion change.

## 7. Verify

```
$ npm run typecheck
(clean: typecheck:node and typecheck:web, no errors)

$ npx vitest run
Test Files  143 passed (143)
     Tests  2144 passed (2144)

$ npm run build
built; "Confirmed: neither mock provider is in out/main."

$ npm run check:fit
...
✔ Shopify check card (synthetic findings, docs/phase-170) - 2560x1440 @150%: page 1373x772 vs client 1373x772

Measured and fit: 283
Skipped (0):
Allow-listed scrollers (0):

All 283 case(s) fit with no overflow.
```

(base before this phase, end of docs/phase-169-1: 141 files, 2087 tests, 274 fit cases. Every new/changed test file's own count was verified independently by running that file alone: `shopifyReconcile.test.ts` 22 tests (new file), `reconciliation.test.ts` 14 tests (new file), `syncEngine.test.ts` 29 tests (+7), `orderHistory.test.ts` 21 tests (+5), `shopifyReconciliationLib.test.ts` 14 tests (new file). check:fit's own count rose by exactly 9 - the new synthetic screen's own 9 sizes - with 0 skipped and 0 allow-listed throughout, both before and after.)

## 8. Rollback

Each commit reverts independently with `git revert <sha>`, newest first if more than one:
- **Commit 3:** the card, the notice and the badge disappear; the IPC channel and broadcast stay wired from commit 2 but nothing reads them.
- **Commit 2:** the check and the guard stop running; `linkOrderToShopify`/`getReconciliationCandidates` stay in `database.ts` but nothing calls them.
- **Commit 1:** `shopify-reconcile.ts` is unused by anything once commit 2 is also reverted.

No schema change beyond docs/phase-169's own additive columns (unchanged by this phase); no data migration; nothing here can be "rolled back" in the sense of undoing a write, since the only write this phase makes (`linkOrderToShopify`) only ever sets a sale that was already, verifiably, synced in Shopify to read `synced` locally too.

## 9. Observed but not changed

- **`NavStatusButton`'s own status-popover count** still reflects only the fiscal unfiled count, not Shopify findings - the brief named only the Needs Attention card's badge, and widening the header popover too would touch `App.tsx`'s existing prop wiring for a concern this phase did not ask about. Worth a dedicated follow-up if the two badges showing different numbers proves confusing in practice.
- **`integrations:mpesa-stk-push`/`mpesa:query-status`/the updater/the two "Test Connection" buttons** remain unguarded from docs/phase-169-1, unaffected by this phase.
- **The card's findings are not yet interactive** - resolving a held/duplicate sale (deciding which Shopify order is the right one) is a follow-up decision docs/phase-168 itself deferred; this phase only reports.
- **`ReconciliationRunner`'s guard and periodic check each build their own `AbortController`/timeout** rather than sharing a single overall budget across a whole tick - the periodic check has the 45 s limit the brief specifies; the guard's own per-item lookup uses a fixed, smaller 15 s timeout (`reconciliation.ts`), chosen so one slow lookup cannot stall the whole push loop, but this value was not specified by the brief and is worth a second look if guard lookups prove too slow or too eager to give up in practice.

**STOP for review.**
