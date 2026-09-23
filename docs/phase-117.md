# Phase 117 — AUDIT: Stock Take (physical count → Shopify inventory adjustment)

**Date:** 2026-09-23 · **Branch:** `main` · **Previous:** [Phase 116](./phase-116.md)

Read-only. **Nothing was changed** — no source, test, fixture or config, and no
request was sent to Shopify, the fiscal device or the printer. Everything below
is either a citation into the tree or a citation into shopify.dev (fetched
2026-09-23).

This is the first feature that would **write** inventory to Shopify. Every
proposal below is judged against one rule:

> **Shopify is the only source of truth for stock. There is never a second
> ledger.** A stock take captures physical counts, proposes a correction to
> Shopify, records what it did, and forgets.

## Verdict, up front

> **The read path and the location path are already clean enough to build on.**
> The app has **no inventory-write capability at all** today — confirmed
> exhaustively. Shopify's `inventoryAdjustQuantities` in our pinned API version
> (2026-07) gives us exactly the three properties the rule demands: **delta**
> adjustment, **compare-and-swap** (`changeFromQuantity`), and a **mandatory
> idempotency key** (`@idempotent`). The controls we need — manager PIN, staff
> identity, online detection, idempotent-ref patterns — all already exist and
> are reusable as-is.
>
> **Two pre-existing second-ledger footholds must be fixed or fenced before, not
> after, this feature ships:** the cached `inventory_quantity` gates
> `availableForSale` ([database.ts:744](../src/main/services/database.ts#L744)),
> and `voidOrder` **mutates the cached quantity locally**
> ([database.ts:1320-1333](../src/main/services/database.ts#L1320-L1333)) with
> no matching decrement anywhere — an unbalanced local write into the very
> column a stock take reports variance against.
>
> **One correction to the brief's wording**, and it is the crux of the whole
> design — see §4.3. "Re-read at commit and adjust by delta" is right about the
> re-read but must not be read as *delta = counted − fresh-read*. That is a
> blind set wearing a delta's clothes. The delta must be
> **counted − snapshot-taken-at-count-time**; the fresh read feeds
> `changeFromQuantity` and the preview, never the arithmetic.

---

# PART 1 — The inventory read + location path

## 1.1 How inventory is read from Shopify

Pinned API version, single constant, one place:

```ts
// src/main/services/shopify.ts:18
export const GRAPHQL_ENDPOINT_SUFFIX = '/admin/api/2026-07/graphql.json'
```

The per-variant quantity has exactly **one** source in the whole app:
`INVENTORY_LEVELS_QUERY` ([shopify.ts:74-96](../src/main/services/shopify.ts#L74-L96)),
which walks `location(id:).inventoryLevels` and reads the **`"available"`
bucket only**:

```graphql
nodes {
  quantities(names: ["available"]) { name quantity }
  item { variant { id } }
}
```

The existing comment there is load-bearing for us: there is no top-level
`inventoryLevels(locationId:)` on this version's QueryRoot, and `InventoryLevel`
has no bare `quantity` scalar — it is `quantities(names:)`, an array of named
buckets. A stock take counts what is on the shelf, so `"available"` remains the
correct and only bucket. **Note the gap this leaves for the write path:** the
query selects `item { variant { id } }` but *not* `item { id }`, and the write
mutation is keyed by `inventoryItemId`, not variant id. See §2.4.

`fetchInventoryLevels` ([shopify.ts:428-458](../src/main/services/shopify.ts#L428-L458))
paginates that query at 250/page into a `Map<variantId, quantity>` and returns
it. `fetchAllProducts` ([shopify.ts:472-551](../src/main/services/shopify.ts#L472-L551))
paginates the catalog, then merges the map in
([shopify.ts:516-539](../src/main/services/shopify.ts#L516-L539)):

- a variant with **no level record** at this location is **dropped**, not shown
  as zero — correct, and the stock take must inherit the same rule (a variant
  not stocked here is not "0 on the shelf", it is not this till's concern);
- the merge is skipped entirely when `inventoryMap.size === 0`, so a
  partial/failed inventory fetch can't wipe the catalog. Same instinct we need
  at commit time.

`mapVariant` hard-codes `inventoryQuantity: 0` with a comment refusing to query
Shopify's cross-location aggregate
([shopify.ts:151-155](../src/main/services/shopify.ts#L151-L155)). The only way
a non-zero quantity enters this app is the location-scoped merge above.

**Confirmed: the exact per-variant quantity source is
`location(id: <till's location>).inventoryLevels.nodes[].quantities(names:["available"]).quantity`,
keyed by `item.variant.id`.**

## 1.2 How LOCATION is resolved and stored

Resolution runs once at boot
([index.ts:436-466](../src/main/index.ts#L436-L466)):

| Priority | Source | Confirmed? |
| --- | --- | --- |
| 1 | `process.env.VITE_SHOPIFY_LOCATION_ID` | always `true` (explicit deployment-time choice) |
| 2 | `settings.location_id` | only if `settings.location_confirmed === '1'` |
| 3 | none | `locationId = undefined`, till is gated |

The doc comment there records that boot-time **auto-detect was deliberately
removed** — an earlier build let a till start selling against whichever location
Shopify returned first. Candidates are now only fetched on demand via
`location:list` for the renderer's confirmation gate.

There are exactly **three** writers of `location_id`:

- `config:save` — first-run wizard, no PIN (runs before any staff exists; see
  the `configSaveSchema` doc comment at
  [ipcValidator.ts:156-171](../src/main/lib/ipcValidator.ts#L156-L171)) —
  [index.ts:1891-1900](../src/main/index.ts#L1891-L1900);
- `location:set` — **manager PIN required**, and it calls `db.clearProductCache()`
  when the location actually changes —
  [index.ts:1808-1842](../src/main/index.ts#L1808-L1842);
- `config:clear` — **manager PIN required**, blanks everything —
  [index.ts:1918-1940](../src/main/index.ts#L1918-L1940).

`locationId` is a single main-process binding. `products:fetch` passes it and
nothing else ([index.ts:877-879](../src/main/index.ts#L877-L879)). The renderer
never supplies a location to any read.

**Confirmed: the till operates against ONE fixed location, resolved in main,
never chosen per-request.** A stock take obtains it the same way — read the
main-process `locationId` binding directly. It must **never** accept a
`locationId` from the renderer's IPC payload; that is how a stock take at branch
A ends up adjusting branch B. There is no code path today that would let it, and
the design below keeps it that way.

## 1.3 Does the local cache ever act as truth? — **Yes, in two places**

The cache is `products`
([database.ts:295-304](../src/main/services/database.ts#L295-L304)), one row per
variant, `inventory_quantity INTEGER NOT NULL`. It is written by
`cacheProducts` as a **full replace in one transaction**
([database.ts:670-693](../src/main/services/database.ts#L670-L693)) and cleared
by `clearProductCache` ([database.ts:701-703](../src/main/services/database.ts#L701-L703)).
It is fed only from a successful `fetchAllProducts`
([index.ts:885-891](../src/main/index.ts#L885-L891)).

That much is a display cache. But:

**🚩 Risk 1 — cached quantity gates sellability.**

```ts
// src/main/services/database.ts:744
availableForSale: row.inventory_quantity > 0,
```

`getCachedProducts` does not replay Shopify's `availableForSale`; it *derives*
it from the cached number. A stale cached zero makes a stocked item unsellable
offline, and a stale cached positive makes an out-of-stock item sellable. This
is the cached quantity being read as truth for a decision, not for display.

**🚩 Risk 2 — `voidOrder` writes to the cached quantity.**

```ts
// src/main/services/database.ts:1320-1321
const incrementInventory = this.conn.prepare(
  'UPDATE products SET inventory_quantity = inventory_quantity + ? WHERE variant_id = ?'
)
```

…run per line item inside the void transaction
([database.ts:1331-1339](../src/main/services/database.ts#L1331-L1339)). The
full set of writes to the `products` table is four statements — the two in
`cacheProducts`, the one in `clearProductCache`, and this one. **There is no
decrement anywhere.** A sale never touches the cached quantity (Shopify does the
math at `orderCreate` — §2.1), so this increment is unbalanced: every void
inflates the cached number above what Shopify says, until the next successful
`products:fetch` overwrites it.

The existing comment calls the reversal "best-effort" and notes the cache
"will self-correct on the next `products:fetch`" — true, and harmless while the
number is only a display hint. It stops being harmless the moment a stock take
reports variance, because an operator could open a count during the window
between a void and the next fetch and see a system figure that is neither
Shopify's nor the shelf's.

**Neither risk is caused by stock take, and neither needs to be fixed by it.**
But the stock take must (a) never read `products.inventory_quantity` for its
snapshot — it takes its own fresh location-scoped read from Shopify — and (b)
not be built on top of a column that a void silently mutates. Recommendation in
§4.6.

---

# PART 2 — The write path that does not exist yet

## 2.1 Confirmation: the app writes no inventory today

Searched the whole tree for inventory mutation names, `inventoryItemId`,
`inventoryAdjust*`, `inventorySet*`, and every write to the `products` table.
Findings:

- **The only Shopify mutation the app sends is `orderCreate`**
  ([orders.ts:16-29](../src/main/services/orders.ts#L16-L29)), with:

  ```ts
  // src/main/services/orders.ts:94-98
  options: {
    inventoryBehaviour: 'DECREMENT_OBEYING_POLICY',
    ...
  }
  ```

  That is **Shopify doing the arithmetic on its own ledger** in response to a
  sale. We state a behaviour; we never state a quantity. Correct, and exactly
  why sales have never been a source-of-truth hazard.

- Every other Shopify call is a read: `PRODUCT_LIST_QUERY`,
  `INVENTORY_LEVELS_QUERY`, `VALIDATE_STORE_QUERY`
  ([shopify.ts:26-117](../src/main/services/shopify.ts#L26-L117)).

- The four `products`-table writes are all local cache maintenance (§1.3).

**Plainly: the NEW capability is the ability to name a quantity to Shopify.**
Today the app can only say "a sale happened, apply your policy." A stock take
says "this number is wrong, change it by N." That is a categorically different
authority, and it needs the `write_inventory` scope the token may not currently
hold — **verify the installed token's scopes before building** (a missing scope
surfaces as HTTP 403, already translated by
[shopify.ts:295-296](../src/main/services/shopify.ts#L295-L296)).

## 2.2 The mutation: `inventoryAdjustQuantities` (delta) vs `inventorySetQuantities` (absolute)

Checked against shopify.dev for our pinned **2026-07**, fetched **2026-09-23**:

| | `inventoryAdjustQuantities` | `inventorySetQuantities` |
| --- | --- | --- |
| Semantics | applies a **delta** (±) | sets an **absolute** value |
| Exists in 2026-07 | yes | yes |
| Compare-and-swap | `changeFromQuantity` per change | `compareQuantity` |
| Idempotency | `@idempotent(key:)` **mandatory** since 2026-04 | same |
| Returns | `InventoryAdjustmentGroup` | `InventoryAdjustmentGroup` |

`InventoryAdjustQuantitiesInput` fields: `name` (required — `"available"` for
us), `reason` (required), `referenceDocumentUri` (optional), `changes`
(required array of `InventoryChangeInput`).

`InventoryChangeInput` (2026-07):

| Field | Type | Notes |
| --- | --- | --- |
| `delta` | `Int!` | the ± change |
| `inventoryItemId` | `ID!` | **not** the variant id — see §2.4 |
| `locationId` | `ID!` | the till's own, from main |
| `ledgerDocumentUri` | `String` | required for every bucket **except** `"available"` — so not needed by us |
| `changeFromQuantity` | `Int` | "the quantity currently expected at this location, before the delta is applied" — compare-and-swap. **Must be explicitly provided; omitting it returns an error.** Pass `null` only to skip the check. |

**Recommendation: `inventoryAdjustQuantities`, with `changeFromQuantity` set to
the freshly re-read quantity.**

**One honest caveat, because it cuts against the recommendation.** Shopify's own
guidance says to prefer **set** "when you possess authoritative quantity values
(like completed stocktakes)," and **adjust** for incremental changes. We are
deliberately departing from that, and the reason is specific to a POS that keeps
selling during the count:

> The count `C` is taken at time `T`, when Shopify says `S_T`. Commit happens at
> `T'`, by which time sales have taken Shopify to `S_T' = S_T − sold`.
>
> - **Set to `C`** → Shopify now reads `C`. But the shelf holds `C − sold`. The
>   set has silently **resurrected every unit sold during the count.**
> - **Adjust by `C − S_T`** → Shopify reads `S_T' + (C − S_T) = C − sold`.
>   Correct.

Shopify's advice assumes a warehouse whose count freezes movement. Our till does
not freeze. **A set would overwrite sales that happened during the count**, which
is precisely the "silently corrupt Shopify" failure the rule forbids. Delta-adjust
is the right call here, and the caveat is recorded so nobody later "fixes" it
back to a set by citing the doc.

## 2.3 Idempotency is enforced by Shopify, and it is not sufficient alone

Since **2026-04** the `@idempotent` directive is **mandatory** on
`inventoryAdjustQuantities` (and the rest of the inventory mutation family, plus
refunds):

```graphql
mutation StockTakeAdjust($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) { ... }
}
```

A retry with the same key returns the **cached original response** without
reprocessing. **But Shopify tracks keys for 24 hours only.** A retry beyond that
window would double-apply. So the idempotency story needs three layers, not one:

1. **Shopify's key** — covers the realistic case (network blip, timeout, immediate retry).
2. **`changeFromQuantity`** — a second application would find the quantity already
   moved and be rejected rather than applied.
3. **Local commit state** — the session row records `committed` and the mutation
   is refused for an already-committed session, regardless of elapsed time. This
   is the layer that survives the 24-hour horizon, and the one we own.

## 2.4 🚩 We do not currently fetch `inventoryItemId`

`INVENTORY_LEVELS_QUERY` selects `item { variant { id } }` and discards the
inventory item's own id ([shopify.ts:87-90](../src/main/services/shopify.ts#L87-L90)).
The mutation is keyed by `inventoryItemId`. This is a small, contained change —
add `id` alongside `variant { id }` in the existing selection set — but it must
be **carried in the session's own snapshot, not persisted into the `products`
cache.** Adding an `inventory_item_id` column to `products` would be the first
brick of a second ledger; the mapping belongs to the session that is about to
commit, and dies with it.

## 2.5 Shopify's own audit trail, and cross-referencing ours to it

Confirmed: Shopify records adjustments as `InventoryAdjustmentGroup`, returned
by the mutation and queryable, carrying `createdAt`, `reason`,
`referenceDocumentUri` and `changes { name delta }`. Merchant-visible inventory
history and analytics surface `referenceDocumentUri`.

Two fields let our record point at Shopify's:

- **`reason`** — 14 enumerated codes. The right one is **`cycle_count_available`**,
  documented as "an adjusted inventory count due to a discrepancy between actual
  and recorded quantities." That is the literal definition of a stock take.
  (`correction` is the generic fallback; `shrinkage`, `damaged`, `quality_control`
  exist if we ever want per-line reason codes — see the flagged decisions.)
- **`referenceDocumentUri`** — freeform, GID-shaped by convention. Shopify's own
  examples include `gid://3pl-system/CycleCount/CC-2024-0125`. Ours:

  ```
  gid://rubis-pos/StockTake/<session-uuid>
  ```

This is the **exact same reconciliation trick as sales**: `orderCreate` tags
every order with `client_order_uuid` as both a custom attribute and a
`rubis_pos`-namespaced metafield
([orders.ts:31-35](../src/main/services/orders.ts#L31-L35),
[orders.ts:82-92](../src/main/services/orders.ts#L82-L92)) so a retry can be
reconciled. A stock take does the same with one URI, and gets the merchant-facing
history entry for free.

---

# PART 3 — Controls we can reuse (all of these already exist)

## 3.1 Manager-PIN gate — reuse verbatim

`requireAdminPin(db, managerId, managerPin)`
([requireAdminPin.ts:43-57](../src/main/lib/requireAdminPin.ts#L43-L57)) re-runs
`authenticateStaff` **in the main process** and additionally requires
`role === 'admin'`, returning one generic message so it never leaks which part
failed. Its doc comment records exactly why it exists: `contextBridge` exposes
`window.api` globally, so a DevTools-driven renderer could call a privileged
channel and skip the `ManagerPinModal` entirely. **A renderer-side modal is not
a gate.**

The payload contract is shared:

```ts
// src/main/lib/ipcValidator.ts:92-95
const managerAuthzSchema = z.object({
  managerId: z.number().int().positive(),
  managerPin: z.string().min(1, 'Manager PIN is required')
})
```

There are 12 call sites today ([index.ts](../src/main/index.ts) — 1148, 1227,
1287, 1339, 1428, 1505, 1538, 1645, 1815, 1925, 2284, 2319). The stock-take
commit channel becomes the 13th, following the same three-line shape: `validate`
→ `requireAdminPin` → act.

## 3.2 Staff identity and segregation of duties

`staff` ([database.ts:345-351](../src/main/services/database.ts#L345-L351)) has
`id`, `name`, `pin_hash`, `role IN ('admin','cashier')`, `is_active`. Orders
carry `staff_id` ([database.ts:312](../src/main/services/database.ts#L312)), set
from the authenticated staff in `runCheckout`
([checkout.ts:244](../src/main/services/checkout.ts#L244),
[checkout.ts:300-301](../src/main/services/checkout.ts#L300-L301)) — the row is
looked up server-side by id, not trusted from the renderer.

Segregation of duties needs both roles recorded, and they are not the same
person:

- **counter** = `counted_by_staff_id`, the session's opener (any active staff,
  cashier included);
- **approver** = `approved_by_staff_id`, resolved **from the PIN actually
  verified at commit** — i.e. `requireAdminPin`'s `managerId`, not a
  renderer-supplied field.

There is already precedent for storing an approver next to the actor:
`mpesa_sms_messages` carries `approved_by_staff_id` / `approved_at`
([database.ts:413-414](../src/main/services/database.ts#L413-L414)).

**Enforcing counter ≠ approver is a policy decision, not a technical one** — see
the flagged decisions. Recording both is not; the schema below always does.

## 3.3 The offline model, and why COMMIT must not queue

Two independent notions of "online" exist:

- `createNetworkMonitor` ([network.ts](../src/main/services/network.ts)) polls
  `net.isOnline()` every 5s and exposes `isOnline()`. This is the one
  `runCheckout` and the sync engine consult.
- `createConnectivityMonitor`
  ([connectivityMonitor.ts:30-34](../src/main/services/connectivityMonitor.ts#L30-L34))
  probes M-Pesa, the fiscal device and the printer. **It does not probe
  Shopify.** There is no Shopify-reachability check in the app.

Sales queue offline by design: `queueOrder` writes a `pending_sync` order plus a
`sync_queue` row atomically
([database.ts:763-812](../src/main/services/database.ts#L763-L812)), and
`createSyncEngine`'s `tick` drains it when `isOnline()`
([sync-engine.ts](../src/main/services/sync-engine.ts)), with exponential
backoff via `computeBackoffMs`
([database.ts:257-260](../src/main/services/database.ts#L257-L260)).

**A stock-take commit must not use this machinery, and the reason is structural,
not stylistic.** A queued order is a *complete, self-contained fact*: "these line
items were sold." Shopify can apply it correctly whenever it arrives, because
Shopify does the arithmetic. A queued stock-take delta is **not** self-contained
— it is an arithmetic statement about a Shopify quantity observed at a moment
that has since passed. Every hour it sits in a queue, more sales land, and the
`changeFromQuantity` it was built against rots. On eventual flush it either
fails the compare-and-swap (best case, a confusing dead queue entry) or — if
someone "helpfully" relaxes the check to make the queue drain — silently
corrupts Shopify. **The queue is the overwrite risk, wearing a retry's
clothes.**

**Counting offline and committing online-only is achievable**, and cleanly:

- counting needs no network — it reads the session's own stored snapshot and
  writes counts to the local session rows;
- commit needs a live round trip *anyway*, for the fresh re-read. So the online
  gate is not an extra check bolted on: **a successful fresh re-read is itself
  the proof of connectivity.** `monitor.isOnline()` is the cheap pre-check that
  gives the operator a clear message instead of a timeout; the re-read is the
  real gate.
- a commit that fails mid-flight is **not queued**. It leaves the session open,
  surfaces the error, and the manager retries — with the same idempotency key,
  a fresh re-read and a fresh `changeFromQuantity`. Retry is a deliberate human
  act, never a background one.

## 3.4 Idempotency patterns already in the tree

| Pattern | Where | What it buys |
| --- | --- | --- |
| `client_order_uuid` on every synced order (attribute + metafield) | [orders.ts:31-35](../src/main/services/orders.ts#L31-L35), [orders.ts:82-92](../src/main/services/orders.ts#L82-L92) | a retried push is reconcilable against Shopify |
| `sync_queue` with `attempts` / `last_error` / `next_attempt_at` | [database.ts:327-338](../src/main/services/database.ts#L327-L338) | bounded retry with backoff |
| `transaction_code TEXT NOT NULL UNIQUE` | [database.ts:401-416](../src/main/services/database.ts#L401-L416) | **the best model here.** Its doc comment is explicit: dedup lives in the database, not in an in-memory set a restart would empty, because an emptied set would let an already-spent payment be approved twice. |
| conditional-write claim on an M-Pesa payment | [checkout.ts:87-96](../src/main/services/checkout.ts#L87-L96) | two rapid checkouts can't both spend one payment |

The stock-take commit reuses all four instincts: a **UNIQUE** committed-reference
column (not an in-memory guard), a persisted state transition, and a conditional
write — with `changeFromQuantity` playing the role the conditional claim plays
for M-Pesa.

---

# PART 4 — Proposed smallest safe design

**Proposal only. Nothing below is built.**

## 4.1 Session model

| Step | Network | Gate | What happens |
| --- | --- | --- | --- |
| **1. Open** | **online** | authenticated staff | Fresh `fetchInventoryLevels` at the till's own location. Snapshot `(inventoryItemId, variantId, systemQty)` per item into the session. Stamp `opened_at`, `counter`, `location_id`. |
| **2. Count** | offline OK | — | Operator enters counted quantities. Writes go to the session's own rows only. |
| **3. Review** | offline OK | — | `variance = counted − snapshot`. Show zero-variance lines collapsed; surface threshold breaches loudly. |
| **4. Approve** | — | **manager PIN** | Manager reviews the variance list. |
| **5. Commit** | **online only** | **manager PIN, re-verified in main** | Fresh re-read → preview → explicit confirm → one `inventoryAdjustQuantities` per batch, `@idempotent`, `changeFromQuantity` = fresh read, `delta` = **counted − snapshot** → record Shopify's response. |
| **6. Close** | — | — | Session becomes immutable. Corrections are a **new session**, never an edit. |

The **open** step is online-only too, and deliberately: the snapshot is the
reference the delta is computed against, so it must be a real Shopify
observation with a timestamp, never a cache read.

## 4.2 Why the snapshot is an audit reference and not truth

The snapshot answers exactly one question: *what did Shopify say when this count
started?* It is:

- **never** read by the POS as current stock;
- **never** merged into `products`;
- **never** consulted after the session commits — it is frozen history.

It exists so the variance is a meaningful number and so an auditor can later see
what the counter was contradicting. Deleting every snapshot row after commit
would leave the app functionally identical and the audit trail useless. That is
the test for whether something is a ledger: **a ledger is read back as truth; an
audit record is only ever read back as history.**

## 4.3 The delta arithmetic — the one thing that must not be gotten wrong

```
snapshot  S_T   = Shopify's quantity when the count opened
counted   C     = what is physically on the shelf
fresh     S_T'  = Shopify's quantity re-read at commit

delta              = C − S_T          ← the variance the counter actually found
changeFromQuantity = S_T'             ← compare-and-swap against live state
resulting quantity = S_T' + (C − S_T)
```

`S_T' ≠ S_T` is **normal and correct** — it means the till sold during the
count, and those sales survive the adjustment. It is not an error condition and
must not be treated as one.

**The trap:** computing `delta = C − S_T'` looks more "current" and is exactly
wrong — it lands Shopify on `C`, which is a blind set by another name, erasing
every sale made during the count. The brief's phrase "re-read at commit, adjust
by delta" is right about the re-read; this section pins down which subtraction
the delta is.

The fresh read earns its keep three ways: it populates `changeFromQuantity`, it
drives the confirmation preview (so the manager approves the *actual* resulting
number), and it makes a large `S_T' − S_T` drift visible — a signal the count
has gone stale, which feeds the expiry decision flagged in §4.7.

## 4.4 Audit-trail record shape (append-only, never edited)

Two tables, both **insert-only after close**.

**`stock_take_sessions`** — one row per count:

| Column | Notes |
| --- | --- |
| `id` | local autoincrement |
| `session_uuid` | **UNIQUE**; `randomUUID()`; becomes both the `referenceDocumentUri` and the `@idempotent` key |
| `location_id` | the till's own at open — recorded so a later reader can prove which shop |
| `status` | `open` \| `counting` \| `awaiting_approval` \| `committed` \| `abandoned` |
| `opened_at` / `committed_at` | ISO |
| `counted_by_staff_id` | the opener |
| `approved_by_staff_id` | from the PIN verified at commit, not from the payload |
| `second_approver_staff_id` | nullable; set only when the threshold rule demands it |
| `shopify_response_json` | verbatim, including `userErrors` |
| `committed_reference_uri` | **UNIQUE**; set only on success — the row-level double-commit guard |

**`stock_take_items`** — one row per counted variant:

| Column | Notes |
| --- | --- |
| `session_id` | FK |
| `variant_id`, `inventory_item_id` | the item-id lives here, **not** in `products` (§2.4) |
| `system_snapshot_qty` | Shopify at open — audit reference only |
| `snapshot_taken_at` | so staleness is measurable |
| `counted_qty` | nullable until entered (uncounted ≠ zero — see §4.7) |
| `variance` | `counted − snapshot` |
| `fresh_qty_at_commit` | what `changeFromQuantity` was set to |
| `delta_pushed` | what we actually sent |
| `commit_status` | `applied` \| `rejected` \| `skipped` |
| `commit_error` | per-item `userErrors` text |

Storing both `delta_pushed` and `fresh_qty_at_commit` alongside the snapshot is
what makes the record independently auditable: a reader can reconstruct the
arithmetic without trusting our code.

Mirroring `raw_text` on `mpesa_sms_messages`
([database.ts:395-399](../src/main/services/database.ts#L395-L399)) — *"the
parsed fields are an interpretation, and the original has to survive"* — the
verbatim Shopify response is kept, not just a parsed outcome.

## 4.5 Guard rails to implement

1. **Location is never a parameter.** Commit reads the main-process `locationId`
   binding. The IPC schema has no `locationId` field at all — not validated,
   *absent*, so there is nothing to spoof. Additionally: refuse commit if
   `session.location_id !== locationId` (the till was re-pointed mid-session).
2. **Manager PIN at commit**, via `requireAdminPin` in main (§3.1).
3. **Variance threshold** → second approver or forced recount. **Configured, not
   hard-coded** — see §4.7 for where.
4. **Preview + explicit confirmation.** The dialog shows, per item,
   `fresh → fresh + delta`, plus item count and total units moving. Confirmation
   is typed or a distinct destructive-styled action, not the same button that
   opened the preview.
5. **Delta against fresh read**, with `changeFromQuantity` (§4.3).
6. **Idempotent commit, three layers** (§2.3): `@idempotent(key: session_uuid)`,
   `changeFromQuantity`, and the `UNIQUE committed_reference_uri` refusal.
7. **Blocked offline.** `monitor.isOnline()` pre-check for a clean message; the
   fresh re-read is the real gate; **no `sync_queue` entry is ever created** for
   a stock take (§3.3).
8. **Never blocks selling.** Back-office only, reached from the Admin screen
   (`activeTab` at [AdminScreen.tsx:97](../src/renderer/src/components/AdminScreen.tsx#L97)
   is the natural home — a new tab beside `needsAttention`). An open session
   places no lock on any variant and changes nothing about the till.
9. **Partial failure is recorded, not retried silently.** Per-item
   `commit_status` from `userErrors`; the session reports "N applied, M
   rejected" and the manager decides. A rejected item is a **new session**, not
   an in-place retry.

## 4.6 The code guard: stock-take history is never current stock

Three mechanisms, because a comment alone will not survive six months:

- **Naming.** No column in either table is called `quantity`. They are
  `system_snapshot_qty`, `counted_qty`, `fresh_qty_at_commit`, `delta_pushed`.
  Nothing reads like a live quantity, so nothing gets used as one by autocomplete.
- **A single file-header comment** on the stock-take service, in the same voice
  as the `mpesa_sms_messages` and `location:set` comments already in the tree —
  stating that these tables are history, that Shopify is the only live quantity,
  and that any read of them outside the stock-take UI is a bug.
- **A test that is the actual guard.** Assert that no module outside
  `stock-take.ts` and its own IPC handlers references `stock_take_items` — the
  same shape as the existing schema-assertion tests the `SCHEMA` constants were
  kept named for ([database.ts:290-293](../src/main/services/database.ts#L290-L293)).
  A grep-based test fails loudly when someone wires the history into the POS
  read path; a comment does not.

**Also recommended, as a precondition rather than part of this feature** (§1.3):
drop `voidOrder`'s local `inventory_quantity` increment
([database.ts:1320-1333](../src/main/services/database.ts#L1320-L1333)). It is
unbalanced (no decrement exists anywhere), its stated benefit is self-correcting
within one fetch cycle, and it is the only local write that makes the cached
number diverge from Shopify by our own hand. Removing it costs a brief stale
display after a void — which is what the column already is — and removes the
one place the app pretends to keep its own count. Judged against the rule, it is
a vestigial second ledger with one writer and no readers that need it.

## 4.7 🚩 Flagged for the human — NOT decided here

**1. Variance threshold — value, and whether a second approver is required.**
Where it should live: the **`settings` table**
([database.ts:341-344](../src/main/services/database.ts#L341-L344)), key
`stock_take_variance_threshold`, edited from the Admin screen behind the manager
PIN like `store_name` / `store_kra_pin`. (`app_configurations`
([database.ts:418-425](../src/main/services/database.ts#L418-L425)) is the
alternative — it has `category` and `requires_restart` — but its category CHECK
constraint is `shopify|mpesa|etims|printer|general`, so a stock-take key would
land in `general` with no natural home. `settings` is the better fit.)
Undecided, and needing your call:
- Is the threshold **per-line** (one item off by N) or **session-total** (total
  units, or total retail value, moving)? Value-based is more meaningful for a
  fuel/retail store than unit-based, but needs price at count time.
- Over the threshold: **second approver**, **forced recount**, or **both**?
- Should **counter ≠ approver** be enforced in code, or recorded and left to
  policy? Enforcing it is one line; it also makes a single-manager shift unable
  to complete a count. That is a staffing decision, not an engineering one.

**2. Should an offline-completed count expire?** A count opened Monday and
committed Friday computes its delta against a five-day-old snapshot. The
arithmetic stays *formally* correct (§4.3), but it silently backdates five days
of drift, restocks and manual admin edits into one adjustment. Options: a hard
expiry (session auto-`abandoned` after N hours), a soft warning at commit
showing `snapshot_taken_at` and the observed `S_T' − S_T` drift, or no expiry
with the drift always displayed. **Recommendation if you want one:** soft warning
plus a configurable hard expiry defaulting to the end of the trading day — a
count that outlives its shift has outlived its shelf. Your call.

**3. Scope per session: subset or whole catalog?** This drives the schema's
`counted_qty` nullability and the entire UI. A whole-catalog count must
distinguish **uncounted** from **counted as zero** — conflating them would push
a negative delta for every item nobody walked past, which is the single most
destructive failure mode this feature has. A subset count (by barcode scan, or a
picked list) sidesteps it: only rows that exist were counted. **Recommendation if
you want one:** subset-per-session, scan-driven, with `counted_qty NOT NULL` on
every row that exists — it makes the dangerous case structurally impossible
rather than merely handled. But whole-catalog is what a year-end stocktake
actually needs, so this is genuinely your call.

---

## Summary table — rule compliance of the proposal

| Rule | How the design satisfies it |
| --- | --- |
| Shopify is the only source of truth; no second ledger | Snapshot is timestamped audit history, never read as stock; naming + header comment + a grep test enforce it; `inventory_item_id` lives in the session, not `products` |
| Never apply an adjustment twice | `@idempotent(key: session_uuid)` + `changeFromQuantity` + `UNIQUE committed_reference_uri` — three layers, because Shopify's key expires at 24h |
| Never let a stale local count masquerade as current stock | Append-only; corrections are new sessions; staleness surfaced at commit; expiry flagged for decision |
| Never silently corrupt Shopify | Fresh re-read at commit; `delta = counted − snapshot` (not − fresh); compare-and-swap; preview + explicit confirm |
| Never block the till's normal selling | Admin-screen back-office feature; no locks; no queue entries; counting is offline-tolerant |

## What was NOT changed

No source, test, fixture, config, schema or document other than this file. No
Shopify request was sent. **Stopping here for review** — specifically on the
three flagged decisions in §4.7, on the recommendation to remove `voidOrder`'s
local inventory increment (§4.6), and on the departure from Shopify's
"use set for stocktakes" guidance (§2.2).

---

## Sources

- [inventoryAdjustQuantities — GraphQL Admin (2026-07)](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/inventoryAdjustQuantities) — fetched 2026-09-23
- [InventoryChangeInput — GraphQL Admin (2026-07)](https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/InventoryChangeInput) — fetched 2026-09-23
- [Manage inventory quantities and states](https://shopify.dev/docs/apps/build/orders-fulfillment/inventory-management-apps/manage-quantities-states) — reason codes, `referenceDocumentUri`, `ledgerDocumentUri`, adjust-vs-set guidance — fetched 2026-09-23
- [inventorySetQuantities — GraphQL Admin](https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventorySetQuantities) — fetched 2026-09-23
- [InventoryAdjustmentGroup — GraphQL Admin](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryAdjustmentGroup) — fetched 2026-09-23
- [Making idempotency mandatory for inventory adjustments and refund mutations — changelog](https://shopify.dev/changelog/making-idempotency-mandatory-for-inventory-adjustments-and-refund-mutations) — fetched 2026-09-23
- [Idempotent requests](https://shopify.dev/docs/api/usage/idempotent-requests) / [Implementing idempotency](https://shopify.dev/docs/api/usage/implementing-idempotency) — 24-hour key retention — fetched 2026-09-23
