# Phase 168 - Shopify safety check of this till's sales (audit only)

- **Date:** 2026-09-27
- **Requested:** A read-only audit, then a design (not built) for a check that loads this till's recent Shopify orders and compares them with the till's own sales: (a) a sale still waiting to sync that Shopify already has, which must be linked and never sent again; (b) a sale marked synced whose Shopify order cannot be found; (c) two or more Shopify orders for one sale; (d) orders from other tills, counted only. Login must never wait on the network, and no held sale may be pushed until the check has finished or timed out.
- **Outcome:** No change needed - audit only, as instructed. No code changed.
- **Branch / base commit:** staging @ e18149d (phase 167).

**Method note:** every claim carries a `file:line`. A conclusion drawn from several facts is labelled **Inference:**. Anything that could only be settled by calling the merchant's store is labelled **Not verified:**. No Shopify API call was made. Public `shopify.dev` documentation pages were read on **2026-09-27**; each is linked where it is used. No SQL was run against any database (schema facts come from the `CREATE TABLE` strings in `database.ts`). No command was sent to any device.

---

## 0. Summary, and the decisions this needs

Seven findings shape the design. Four of them differ from the brief's assumptions.

1. **The sync engine starts before anyone logs in.** `engine.start()` runs inside `app.whenReady()` (`index.ts:400`, `index.ts:907`), before the window is even created (`createWindow()` is at `index.ts:3405`). `start()` pushes immediately (`sync-engine.ts:103-107`). So "hold pushes until the check after login" would come too late: queued sales are already pushed at launch. The check has to run at **app start** (and on reconnect), with login untouched.
2. **`auth:login` is also the Manager PIN check.** `ManagerPinModal.tsx:62` calls `window.api.login` to verify a manager's PIN. Hooking the check onto the `auth:login` handler (`index.ts:2586-2602`) would fire it on every Manager PIN prompt. Another reason to trigger it from app start instead.
3. **There is a duplicate path that needs no lost response at all.** The Retry Sync button shows for `pending_sync` sales (`OrderHistory.tsx:201-213`). `retryOrderSync` only refuses `synced` sales (`database.ts:1951-1953`) and always inserts a **new** queue row (`database.ts:1961-1965`) without removing the one already there. The next tick reads both rows (`database.ts:1338`, filtered only by `entity_type` and due time) and pushes both (`sync-engine.ts:85-96`). Shopify gets two orders, and `markQueueItemSynced` overwrites `shopify_order_id` with the second one (`database.ts:1797-1801`). **Inference** from reading the code; no test covers it (`tests/orderHistory.test.ts:149-205` tests only the insert and the refusals).
4. **Automatic retries resend too, not only the button.** A timed-out `orderCreate` (client timeout 10 s, `shopify.ts:291`) is recorded as an ordinary failure (`orders.ts:109-111`, `sync-engine.ts:93-95`) and the same payload is pushed again after backoff. If Shopify did create the order, that is a duplicate. The pre-push guard in §2.4 covers both paths.
5. **"attempts > 0" misses two cases.** Retry Sync inserts its row with `attempts = 0` (`database.ts:1965`), and a crash or forced quit during the request leaves `attempts` at 0 because it is only increased after a reply (`database.ts:1825-1837`). §2.4 proposes a marker written **before** each push instead.
6. **Location cannot identify this till's orders.** `orderCreate` sends no location (`orders.ts:74-99`), and `OrderCreateOrderInput`'s only location field is `companyLocationId`, a B2B company location ([OrderCreateOrderInput](https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/OrderCreateOrderInput), read 2026-09-27). **Not verified:** what Shopify stores as the location on these orders. So a `location_id` filter is not reliable.
7. **A store-wide 7-day scan may not scale.** Rubis may have up to 106 locations (`docs/phase-140.md:4`), all on one store. Every till writes the same metafield (`orders.ts:85-91`), so nothing narrows a scan to one till. A 7-day `created_at` scan reads every order from every branch, and `shopify.ts:153-158` already records Shopify's 25,000-object pagination limit. Looking up **one sale at a time** by its `client_order_uuid` scales with this till's few problem sales, not with the store. But that lookup needs a one-off Shopify setting (§1.4).

**Decisions needed before a build:**

- **D1 - How to look sales up.** *Recommended:* look up by `metafields.rubis_pos.client_order_uuid`, one sale at a time. This needs a metafield definition for orders with admin filtering switched on, set up once by a person in Shopify admin. The app does not create it. The app only reads whether it is ready, and if it is not, it fails safe (§2.5). *Alternative:* a paginated `created_at` scan of the whole store. This needs no Shopify setup but its cost grows with every branch's sales.
- **D2 - What makes a sale "possibly already in Shopify".** *Recommended:* a new count on `orders`, written just before each push (§2.4). *Alternative:* the brief's `attempts > 0`, which misses finding 5's two cases.
- **D3 - When the check runs.** *Recommended:* at app start and on every offline to online change. Not on `auth:login` (findings 1 and 2).
- **D4 - Fix finding 3 on its own, first.** It is a small, deterministic bug and it does not depend on any of the rest (§2.7, build 0).

---

## 1. Audit

### 1.1 Sync engine: start, triggers, re-entrancy guard, every push path

**Creation and start.** Built at `index.ts:856-870`:

```ts
const engine = createSyncEngine({
  db,
  isOnline: () => net.isOnline(),
  pushOrder: async (payload) => {
    const env = shopifyEnv()
    if (!env) {
      return { success: false, error: 'Shopify credentials missing ... order sync deferred' }
    }
    return pushOrderToShopify(createShopifyClient(env.storeUrl, env.token), payload)
  },
  intervalMs: 30_000
})
```

(Error text shortened with `...`.) Started at `index.ts:906-908` (`monitor.start(); engine.start(); fiscalEngine.start()`), inside `app.whenReady().then(async () => {` (`index.ts:400`). The window is created later, at `index.ts:3405`. Stopped on `will-quit` (`index.ts:1002-1003`).

**Triggers** (documented at `sync-engine.ts:5-9`):

| Trigger | Where | Code |
| --- | --- | --- |
| Start: immediate tick, then every 30 s | `sync-engine.ts:103-107` | `timer = setInterval(() => void tick(), intervalMs)` then `void tick()` |
| After a checkout | `checkout.ts:520-521` | `if (monitor.isOnline()) { void engineTick() ...` (`engineTick` is `() => engine.tick()`, `index.ts:1160`) |
| Offline to online | `index.ts:896-900` | `if (online) { engine.notifyOnline(); ...` which calls `void tick()` (`sync-engine.ts:118-120`) |
| Retry Sync button | `index.ts:2301-2317` | `db.retryOrderSync(localId)` then `if (monitor.isOnline()) { await engine.tick() }` |

`onCheckoutMade()` (`sync-engine.ts:122-124`) exists but nothing in `src/main` calls it; checkout calls `engine.tick()` directly (`checkout.ts:521`).

**Re-entrancy guard** (`sync-engine.ts:79-100`):

```ts
async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    if (!isOnline()) return

    const pending = db.getPendingSyncQueue(now())
    for (const item of pending) {
      if (!isOnline()) break

      const result = await pushOrder(item.payload)

      if (result.success && result.data) {
        db.markQueueItemSynced(item.id, result.data.shopifyOrderId)
      } else {
        db.recordQueueFailure(item.id, result.error ?? 'Unknown sync error')
      }
    }
  } finally {
    running = false
  }
}
```

A call made while a pass is running returns at once. It does not wait for the running pass. So Retry Sync's `await engine.tick()` (`index.ts:2307`) can return before the retried row has been pushed.

**Every path that can push an order:** there is exactly one call to `pushOrderToShopify` (`index.ts:867`), reached only through `tick()` (`sync-engine.ts:89`). All four triggers above lead there. This is good news for the design: a guard placed inside `tick()` covers every path.

**Online signal.** The engine reads `net.isOnline()` directly (`index.ts:858`). Checkout and Retry Sync read the monitor's cached value (`checkout.ts:520`, `index.ts:2306`). The monitor starts optimistic (`network.ts:44`, `let online = true`) and takes a real reading in `start()` (`network.ts:64-68`).

### 1.2 What identifies this till's order in Shopify today

`buildOrderInput` (`orders.ts:82-92`):

```ts
customAttributes: [
  { key: CLIENT_ORDER_UUID_KEY, value: payload.clientOrderUuid }
],
metafields: [
  {
    namespace: RUBIS_NAMESPACE,
    key: CLIENT_ORDER_UUID_KEY,
    type: 'single_line_text_field',
    value: payload.clientOrderUuid
  }
]
```

with `CLIENT_ORDER_UUID_KEY = 'client_order_uuid'` (`orders.ts:32`) and `RUBIS_NAMESPACE = 'rubis_pos'` (`orders.ts:35`). The uuid is also written into the order `note` (`orders.ts:81`).

- **No location id** is sent (`orders.ts:74-99` is the whole input), and none is read back: the mutation returns only `id` and `name` (`orders.ts:19-22`).
- **No till id** is sent. Every till writes the same namespace and key. The only way to tell "this till's order" from another till's is that the uuid exists in this till's own `orders` table.
- **Nothing reads the attribute or metafield back** today (confirmed in `docs/phase-159.md:155`, and still true: `shopify.ts` has no order query, see §1.3).

### 1.3 `shopify.ts`: version, client, errors, rate limiting

- **API version:** `2026-07` (`shopify.ts:17-19`, `GRAPHQL_ENDPOINT_SUFFIX = '/admin/api/2026-07/graphql.json'`). The mutation in `orders.ts:15` targets the same version.
- **Client shape:** `createShopifyClient(storeUrl, token)` (`shopify.ts:273-297`) returns a plain axios instance with `baseURL` set to the GraphQL endpoint, a **10 s timeout** (`shopify.ts:291`) and the `X-Shopify-Access-Token` header (`shopify.ts:293`). A new client is built for each push (`index.ts:867`).
- **Error handling:** every function returns a `ServiceResult` rather than throwing. GraphQL `errors[]` are joined into one message and **their `extensions` are dropped** (`shopify.ts:423-428`, `shopify.ts:493-501`, `shopify.ts:626-632`), even though the wire type has an `extensions` field (`shopify-types.ts:65`). HTTP failures go through `translateAxiosError` (`shopify.ts:311-344`): 401 and 403 get their own messages (`shopify.ts:333-336`, 403 names missing API scopes), and so does 429 (`shopify.ts:339-340`). The order push has its own, shorter translator (`orders.ts:108-120`).
- **Rate limiting and backoff:** none in `shopify.ts`. There is no retry, no reading of `extensions.cost`, and no handling of GraphQL throttling (a search of `src/` for `THROTTLED`, `throttleStatus` or `Retry-After` finds nothing). The only backoff is the sync queue's own (`database.ts:340-361`: 30 s doubling, capped at 30 minutes, 10 attempts).
- **Page size already used:** 250, with a cited source (`shopify.ts:149-150`), and a hard page cap that fails loudly rather than returning a partial list (`shopify.ts:152-158`, `shopify.ts:410-415`). That shape is worth copying.
- **No order query exists.** The only GraphQL documents in `shopify.ts` are `PRODUCT_LIST_QUERY` (`shopify.ts:27-61`), `INVENTORY_LEVELS_QUERY` (`shopify.ts:82-105`) and `VALIDATE_STORE_QUERY` (`shopify.ts:128-147`). The only order operation anywhere is `orderCreate` (`orders.ts:16-29`). This confirms `docs/phase-159.md:155`.

### 1.4 Shopify documentation (all read 2026-09-27)

| Fact | Source |
| --- | --- |
| `orders(query:)` accepts the filter keys `created_at`, `location_id`, `metafields.{namespace}.{key}`, `id`, `name`, `tag` and others. Default sort is `PROCESSED_AT`; Shopify suggests sorting on the field you filter by. | [orders query](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/orders) |
| The `Order` object needs `read_orders` (or `read_marketplace_orders` or `read_quick_sale`). "Only the last 60 days' worth of orders from a store are accessible from the Order object by default." Older orders need `read_all_orders`. | [Order object](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Order) |
| `Order.retailLocation`: "The physical location where a retail order is created or completed". `Order.cancelledAt` is null unless cancelled. | same page |
| Filtering by a metafield value needs a **metafield definition** with the **`adminFilterable` capability enabled**. "Not all metafield types or resources support filtering." Syntax: `metafields.{namespace}.{key}:{value}`. | [Query by metafield value](https://shopify.dev/docs/apps/build/custom-data/metafields/query-by-metafield-value) |
| The definition's filter status is one of `FILTERABLE`, `IN_PROGRESS` ("currently being processed for admin filtering"), `FAILED`, `NOT_FILTERABLE`, and the capability carries an `eligible` flag. | [MetafieldDefinitionAdminFilterStatus](https://shopify.dev/docs/api/admin-graphql/2026-07/enums/MetafieldDefinitionAdminFilterStatus), [MetafieldCapabilityAdminFilterable](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/MetafieldCapabilityAdminFilterable) |
| `metafieldDefinitions(ownerType:, namespace:, key:)` lists definitions. | [metafieldDefinitions](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/metafieldDefinitions) |
| Date ranges: `created_at:>='2020-10-21T23:39:20Z'`. AND is implied between terms. Special characters must be quoted or escaped. | [Search syntax](https://shopify.dev/docs/api/usage/search-syntax) |
| `ordersCount(query:, limit:)` returns `count` and `precision`. `limit` defaults to and is capped at 10,000. Needs `read_orders`. | [ordersCount](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/ordersCount) |
| `nodes(ids:)` returns objects by id. Input arrays are capped at 250 items. | [nodes](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/nodes), [GraphQL rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits) |
| Cost limits: 100 points/second (standard), 200 (Advanced), 1,000 (Plus), 2,000 (enterprise). "A single query may not exceed a cost of 1,000 points." Connection cost is sized by `first`/`last`. Status is in `extensions.cost.throttleStatus` (`maximumAvailable`, `currentlyAvailable`, `restoreRate`). | [GraphQL rate limits](https://shopify.dev/docs/apps/build/apis/graphql-admin/rate-limits) |
| `currentAppInstallation { accessScopes { handle } }` returns "the access scopes granted to the application". | [currentAppInstallation](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/currentAppInstallation) |
| Maximum page size 250. | Already cited in this repo at `shopify.ts:149` (checked 2026-09-25) |

**Does the till's token have `read_orders`?** **Not verified.** Nothing in the repo records the token's scopes (a search of the repo for `read_orders` finds nothing). `orderCreate` works today, which suggests `write_orders`. **Not verified:** whether that grant includes read access; do not assume it does.

**How the build detects a missing scope and fails safe:** the check's first call is `currentAppInstallation { accessScopes { handle } }`. If neither `read_orders` nor `read_all_orders` is listed, the check stops, changes nothing, holds nothing new, and reports one plain message (§2.6). As a second line of defence, an HTTP 403 (already recognised at `shopify.ts:335-336`) or a GraphQL error whose `extensions.code` says access was denied is treated the same way. **Not verified:** the exact `extensions.code` string Shopify uses for a missing scope; the build should log the raw code and test against a recorded fixture.

**Not verified, and it matters:** whether `ORDER` metafield definitions of type `single_line_text_field` are `eligible` for admin filtering on this store, and how quickly a newly created order becomes findable by search. The first is read-only to check (`metafieldDefinitions` → `capabilities.adminFilterable.eligible/status`). The second is handled by a waiting margin (§2.4).

### 1.5 Local data

**`orders`** (`database.ts:447-472`):
- `local_id INTEGER PRIMARY KEY AUTOINCREMENT` (`:448`)
- `shopify_order_id TEXT` (`:449`), null until synced
- `status TEXT ... CHECK (status IN ('pending_sync', 'synced', 'failed', 'voided'))` (`:451`); the type is at `database.ts:23`
- `created_at TEXT` (`:452`), ISO string from the till's clock
- `payload_json TEXT` (`:453`)

**`client_order_uuid` has no column of its own.** It lives only inside `payload_json` as `clientOrderUuid` (`database.ts:1270-1271`, written at `:1303`), and inside `sync_queue.payload_json` (`:1316`). Finding a local sale by uuid today would mean parsing JSON for every row. **Inference:** the check should instead start from local rows (a handful of candidates) and parse each one's payload, which needs no new index.

**`sync_queue`** (`database.ts:473-483`): `id`, `entity_type` (`'order'` for Shopify, `'etims_invoice'` for fiscal retries, `database.ts:7-10`), `entity_id` (the `local_id`), `action` (`'orderCreate'`), `payload_json`, `attempts INTEGER NOT NULL DEFAULT 0`, `last_error`, `created_at`, `next_attempt_at`.

**Status changes:**

| Method | What it does |
| --- | --- |
| `queueOrder` (`database.ts:1268-1324`) | Inserts the order `pending_sync` and a queue row with `attempts = 0`, in one transaction. Both get the same `createdAt` (`:1269`, `:1302`, `:1318`). |
| `markQueueItemSynced` (`database.ts:1790-1805`) | One transaction: `status = 'synced'`, `shopify_order_id = ?`, then deletes that queue row. |
| `recordQueueFailure` (`database.ts:1817-1842`) | `attempts + 1`. At `SYNC_MAX_ATTEMPTS = 10` (`database.ts:347`) the order becomes `failed` and the queue row is **deleted** (`:1827-1831`); otherwise it reschedules with backoff (`:1833-1837`). |
| `retryOrderSync` (`database.ts:1943-1970`) | Refuses `synced` only; sets `pending_sync` and inserts a fresh row with `attempts = 0` (`:1965`). |
| `voidOrder` (`database.ts:1996-...`) | Only for `pending_sync`; marks `voided` and deletes the order's queue rows (doc comment `database.ts:1972-1976`). |

A `failed` order has **no** queue row, so it is never pushed again unless someone presses Retry Sync.

---

## 2. Proposal (smallest design, not built)

### 2.1 Where the check runs, and how it holds the engine

Make the check a **step inside the engine's own `tick()`**, under the existing `running` guard (`sync-engine.ts:80-81`), rather than a second engine. Because every push already goes through `tick()` (§1.1), "no push until the check has finished or timed out" then needs no new lock:

- `start()` and `notifyOnline()` set a flag, `checkDue = true`.
- In `tick()`, after the online test (`sync-engine.ts:83`) and before `getPendingSyncQueue`, if `checkDue`: run the check with a **total time limit** (proposed: 45 s, via an `AbortController` on the axios calls).
  - Finished: `checkDue = false`, keep the result.
  - Timed out or failed: record why, and try again at the next `notifyOnline()` or after 10 minutes, rather than every 30 s.
  - Offline: the tick already returns before this point (`sync-engine.ts:83`), so the check is skipped and runs when the connection returns (`index.ts:896-900`).
- Then the normal push loop runs, with the per-sale guard from §2.4.

**Login never waits.** `auth:login` (`index.ts:2586-2602`) is untouched. The check runs in the main process at app start. A cashier can log in and sell while it runs, because checkout does not wait for the tick (`checkout.ts:520-529`, `void engineTick()`). The only effect is that a new sale's push may wait until the check finishes or times out.

### 2.2 The Shopify reads (all read-only)

Proposed documents, for review, not built:

```graphql
# 1. Scope check (once per run)
query { currentAppInstallation { accessScopes { handle } } }

# 2. Is the uuid metafield searchable? (once per run)
query {
  metafieldDefinitions(first: 1, ownerType: ORDER, namespace: "rubis_pos", key: "client_order_uuid") {
    nodes { capabilities { adminFilterable { eligible enabled status } } }
  }
}

# 3. Look up one sale by uuid
query FindByUuid($q: String!) {
  orders(first: 5, query: $q) {
    nodes {
      id name createdAt cancelledAt
      metafield(namespace: "rubis_pos", key: "client_order_uuid") { value }
    }
  }
}
# $q = metafields.rubis_pos.client_order_uuid:"<uuid>"

# 4. Do this till's synced orders still exist? (up to 250 ids per call)
query Exists($ids: [ID!]!) { nodes(ids: $ids) { id ... on Order { name cancelledAt } } }

# 5. Other tills, count only
query { ordersCount(query: "created_at:>='<now minus 7 days>'", limit: 10000) { count precision } }
```

Rules:
- **Never trust search matching alone.** After query 3, keep only nodes whose `metafield.value` equals the uuid exactly. Search can match loosely; the exact comparison is the safety check.
- `first: 5` on query 3 is enough to tell 0, 1 and "more than one" apart.
- Every reply's `extensions.cost.throttleStatus` is read. If `currentlyAvailable` is below the next query's requested cost, wait `(cost - available) / restoreRate` seconds, all inside the 45 s limit.
- Only sales from the last 60 days can be looked up at all (§1.4). An older candidate is reported as "too old to check" and never pushed automatically.

**Why not the brief's 7-day scan with a location filter:** no location is written on these orders (finding 6), so the scan would read every branch's orders (finding 7). Query 5 gives the "other tills" number without reading them.

### 2.3 Which sales are checked, and what happens

Candidates, all taken from this till's own `orders` table, with `created_at` in the last 7 days (and never older than 60):

| Case | Which local sales | Shopify read | Action |
| --- | --- | --- | --- |
| **(a)** already in Shopify, not linked | `pending_sync` or `failed` with the push marker set (§2.4) | query 3 | **Exactly one** match, not cancelled: link it (below). **None:** leave it to the normal push, subject to §2.4. **More than one, or the only match is cancelled:** hold it and report. |
| **(b)** synced but missing | `synced` | query 4, in batches of 250 | A `null` node: report only. |
| **(c)** duplicates | Any (a) lookup with 2 or more matches, plus `synced` sales pushed more than once (§2.4 count > 1) | query 3 | Report only. Never cancel, edit or delete in Shopify. |
| **(d)** other tills | none | query 5 | Count only: Shopify's 7-day total minus this till's synced sales in the same window, shown as "about N". |
| **(e)** extra, not in the brief | `voided` with the push marker set | query 3 | Report only: "this sale was voided on the till but is in Shopify." Possible because a void is allowed for any `pending_sync` sale (`database.ts:2001`), including one whose push reply was lost. |

**The link action** is the only local write. One new method, one transaction, keyed on the sale:

```sql
UPDATE orders SET status = 'synced', shopify_order_id = ?
  WHERE local_id = ? AND status IN ('pending_sync', 'failed');
DELETE FROM sync_queue WHERE entity_type = 'order' AND entity_id = ?;
```

- The `status IN (...)` condition means a voided or already-synced sale can never be changed by it.
- Deleting by `entity_id` rather than by queue id also removes the extra rows from finding 3.
- It mirrors `markQueueItemSynced` (`database.ts:1790-1805`) but also works for a `failed` sale that has no queue row (§1.5).

**"Hold" means:** the queue row stays; the tick skips it without calling `recordQueueFailure`, so it neither burns attempts nor gets marked `failed`. It stays held until a person resolves it. How a person resolves a held sale (for example a "Link to order #1050" button) is a follow-up decision, not in this design.

### 2.4 The pre-push guard

**Marker.** Add two columns to `orders`, following the existing additive column pattern (`database.ts:363-365`):
- `shopify_push_count INTEGER NOT NULL DEFAULT 0`
- `shopify_last_push_at TEXT`

Both are written in their own small transaction **immediately before** the HTTP call. A crash mid-request therefore still leaves them set. `retryOrderSync` does not reset them, because they live on the order and not on the queue row. This closes both gaps in finding 5.

**Guard, for every due queue item, inside `tick()`:**

1. `shopify_push_count = 0`: this sale has never been sent. Push as today.
2. Otherwise, it may already be in Shopify:
   - If `shopify_last_push_at` is less than **2 minutes** ago, skip it this tick. This allows for Shopify's search catching up. **Not verified:** how long that takes; 2 minutes is a starting value to tune.
   - Look it up (query 3). This reuses this run's result if the check already looked it up.
   - 0 matches: push.
   - 1 match, not cancelled: link, do not push.
   - 2 or more matches, or the only match is cancelled: hold and report.
   - The lookup could not run (offline, timeout, scope missing, uuid search not `FILTERABLE`): **hold, do not push.** This is the fail-safe. A sale that may already exist is never sent blind.

**Trade-off to accept:** if the uuid search is not set up, any sale that has had a failed push waits (held, visible, not lost) instead of being retried blind, as it is today. New sales (count 0) are unaffected.

### 2.5 Failing safe

| Condition | Behaviour |
| --- | --- |
| Offline at start | Check skipped; runs on reconnect. New sales push as normal once online; "possibly sent" sales are held until a lookup succeeds. |
| `read_orders` missing | Check stops after query 1. Nothing linked, nothing changed. "Possibly sent" sales are held. One message (§2.6). |
| uuid metafield not `FILTERABLE` (or `IN_PROGRESS`, `FAILED`, missing) | (a) and (c) cannot run: "possibly sent" sales are held. (b) and (d) still run, because they do not need uuid search. Message names the missing Shopify setting. |
| Throttled, timed out, or any other error | Stop, keep what was learned, hold nothing new beyond what §2.4 already holds, retry later. |
| Shopify credentials missing (`index.ts:861-866`) | Same as today; the check is skipped. |

### 2.6 Where results show, and wording

- **Admin > Needs Attention:** a "Shopify check" card above the fiscal list (`NeedsAttentionPage.tsx:131-150`), showing the last run time and one line per finding. Proposed wording:
  - "Sale #12 was already in Shopify as order #1043. It has been linked and will not be sent again."
  - "Sale #15 is in Shopify more than once (#1050, #1051). Nothing was changed. It will not be sent again until a manager checks it."
  - "Sale #20 is marked as sent, but Shopify has no order #1060. Nothing was changed."
  - "Sale #22 was voided on the till but is in Shopify as order #1070. Nothing was changed."
  - "Could not check Shopify: this till is not allowed to read orders. Ask whoever manages the Shopify app to add the read_orders permission."
  - "Could not check Shopify: order search is not set up. Ask whoever manages Shopify to turn on filtering for the client_order_uuid order field."
  - "Other tills and channels: about 340 orders in the last 7 days (not checked)."
- **Needs Attention badge:** the card's action count is added to the existing badge (`AdminScreen.tsx:102-107`).
- **Cashier notice:** one line, only when a person must act (held, (b), (c), (e), or the check cannot run at all): "Some sales need a manager to check them in Shopify. See Admin > Needs Attention." An automatic link is not shown to the cashier.
- Results are kept in main-process memory and recomputed at every run; nothing new is persisted except the two §2.4 columns. Delivered with the existing `broadcast` helper (`index.ts:887-891`) plus one IPC read.

### 2.7 Builds, in order, each separately reviewable

0. **Stop Retry Sync from adding a second queue row** (finding 3). `retryOrderSync` refuses, or reuses the row, when a `sync_queue` row with `entity_type = 'order'` already exists for that `local_id`. This is independent and small, and it removes a duplicate path that exists today.
1. **Push marker** (§2.4 columns and the pre-push write). No behaviour change on its own.
2. **Read-only Shopify functions** (§2.2 queries 1 to 5) in a new file, with throttle handling. No local writes.
3. **The check and guard in `tick()`** (§2.1, §2.3, §2.4), including the one link write.
4. **Admin card and cashier notice** (§2.6).

---

## 3. Tests needed

All with mocked HTTP, as every existing `shopify.ts` test does. No real Shopify call.

**Engine (`tests/syncEngine.test.ts`, which already covers triggers and re-entrancy at `:85-290`):**
- Lost-response sale is linked, not resent: push count 1, lookup returns one match → link called with that id, `pushOrder` never called.
- Two matches are not auto-linked: lookup returns two → no link, no push, no `recordQueueFailure`, reported as (c).
- Only match is cancelled → held, not linked.
- Offline skip: `isOnline` false → no Shopify call at all; `checkDue` still true; `notifyOnline()` then runs the check.
- Sync waits for the check, then proceeds: with the check's promise unresolved, no push happens; resolve it and the fresh sale is pushed in the same tick.
- Check timeout: fresh sale (count 0) is pushed after the time limit; a "possibly sent" sale is held.
- Scope missing fails safe: `accessScopes` without `read_orders` → no link, no push of "possibly sent" sales, the right message, fresh sales still pushed.
- uuid search not `FILTERABLE` → same fail-safe; (b) still runs.
- Push count set before the HTTP call: a `pushOrder` that throws still leaves the count at 1.
- Recent push inside 2 minutes → skipped this tick, not looked up.

**Database:**
- Link write: changes `pending_sync` and `failed` sales, refuses `voided` and `synced`, and removes every `'order'` queue row for that sale in the same transaction (and not its `'etims_invoice'` rows).
- `retryOrderSync` with an existing row → no second row (build 0). Added to `tests/orderHistory.test.ts:149-205`.
- New columns are added to an old database without losing rows.

**Shopify reads:**
- Exact uuid comparison: a search reply containing a near-match uuid is ignored.
- `nodes` batching at 250; a `null` node is reported as (b).
- Throttle status: waits when `currentlyAvailable` is too low, and gives up inside the time limit.
- 403 and access-denied GraphQL errors map to the scope message.

---

## 4. Files that would change

| File | Change |
| --- | --- |
| `src/main/services/database.ts` | Two additive columns; push-marker write; link method; candidate reads; `retryOrderSync` fix (build 0) |
| `src/main/services/sync-engine.ts` | `checkDue` flag, check step with time limit, per-item guard; new injected functions in `SyncEngineOptions` (`sync-engine.ts:36-44`) and `SyncEngineDatabase` (`:24-28`) |
| `src/main/services/shopify-reconcile.ts` (new) | The five read-only queries, exact uuid match, throttle waits, classification |
| `src/main/index.ts` | Wiring at `:856-870`; one IPC read; broadcast |
| `src/preload/index.ts` | Expose the IPC read |
| `src/renderer/src/pages/NeedsAttentionPage.tsx` | Shopify check card |
| `src/renderer/src/components/AdminScreen.tsx` | Badge count |
| a cashier notice component (to be chosen at build time, matching existing notices) | One-line notice |
| `tests/syncEngine.test.ts`, `tests/orderHistory.test.ts`, new `tests/shopifyReconcile.test.ts` | §3 |

`orders.ts` (what is sent to Shopify) does **not** change.

## 5. What needs explicit review

- **Anything that changes local sync status:** the link write (§2.3) is the only new path that sets `synced`. Review its `WHERE` condition, and that it can only be reached with exactly one exact-uuid, not-cancelled match.
- **The hold state:** a queue row the engine skips without counting a failure. Confirm it cannot keep a sale from Shopify silently: it must always appear on Needs Attention.
- **Build 0** changes the Retry Sync button's behaviour.
- **The two new columns** (a schema change, additive only).
- **The one-off Shopify setting** (a filterable metafield definition) is a change to the merchant's store made by a person, not by the app. Someone has to own it.

## 6. Not verified, and residual risk

- The till token's scopes (§1.4).
- Whether the uuid order metafield is `eligible` for admin filtering, and how long a new order takes to become searchable.
- The exact `extensions.code` for a missing scope.
- What location Shopify records on these API-created orders.
- Query costs: only readable from live replies' `extensions.cost`.
- **Residual:** if search takes longer than the 2-minute margin, one duplicate can still be created. The next run's (c) check reports it, because that sale's push count will be above 1.
- **Residual:** sales pushed before the push marker exists have count 0. Their duplicates are only found through (a) lookups. This gap ages out after 7 days.
- Till clock drift: windows use the till's own `created_at`. A 7-day window is loose enough that small drift does not matter.

## 7. Observed but not changed

- **Finding 3** (Retry Sync on `pending_sync` creates a second queue row and a second Shopify order). This is a real bug today; proposed as build 0.
- `onCheckoutMade()` (`sync-engine.ts:122-124`) is never called; checkout calls `engine.tick()` directly (`checkout.ts:521`). Harmless, but the doc comment at `sync-engine.ts:56-57` suggests otherwise.
- `await engine.tick()` in Retry Sync (`index.ts:2307`) can return before the retry is pushed, because a busy tick returns at once (`sync-engine.ts:80`). The button's success reply means "queued", not "sent".
- GraphQL `extensions` are thrown away in every `shopify.ts` error path (`shopify.ts:423-428`, `:493-501`, `:626-632`), so throttling and access errors cannot be told apart from other errors today.
- `fetchInventoryLevelDetails` (`shopify.ts:550-570`) does not check GraphQL `errors` and has no page cap, unlike `validateAndFetchLocations` (`shopify.ts:409-415`).
- `.env.example:13-14` says the location is "Auto-detected and cached on first run if left blank"; `index.ts:565-577` says boot no longer auto-detects it.

**STOP. Do not implement.**
