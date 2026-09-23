# Phase 119 — Stock Take Part B: physical count → Shopify inventory adjustment

**Date:** 2026-09-23 · **Branch:** `main` · **Previous:** [Phase 118](./phase-118.md) · **Spec:** [Phase 117](./phase-117.md)

The feature designed in the [phase-117](./phase-117.md) audit, built on the
precondition fix from [phase-118](./phase-118.md). **This is the first and only
code path in the app that writes inventory to Shopify.**

The rule everything below is judged against:

> **Shopify is the only source of truth for stock. There is never a second
> ledger.** A stock take captures physical counts, proposes a delta correction
> to Shopify, records what it did, and forgets.

```
npm run typecheck   → clean (node + web)
npm test            → 87 files, 1350 tests, all passing
```

---

## 1. The arithmetic, first, because everything else is scaffolding

```
S_T   snapshot — Shopify's figure when the count opened
C     counted  — what is physically on the shelf
S_T'  fresh    — Shopify's figure re-read at commit

delta              = C − S_T     ← what is pushed
changeFromQuantity = S_T'        ← compare-and-swap
Shopify afterwards = S_T' + (C − S_T)
```

`S_T' ≠ S_T` is **normal**: it means the till sold while the shelf was being
counted, and those sales survive the correction. Computing `delta = C − S_T'`
would land Shopify exactly on `C` — a blind set in disguise, resurrecting every
unit sold during the count.

The test that pins this down is
[`tests/stockTake.test.ts`](../tests/stockTake.test.ts), *"pushes counted −
snapshot, so sales made during the count survive"*: Shopify says 10, the shelf
holds 8, two units sell before the commit. The pushed delta is `-2` against a
`changeFromQuantity` of 8, leaving Shopify on **6** — the counted 8 minus the 2
sold. Not 8.

## 2. Schema — two append-only tables

[`database.ts`](../src/main/services/database.ts), `SCHEMA.stockTakeSessions` /
`SCHEMA.stockTakeItems`.

**`stock_take_sessions`** — `session_uuid` (UNIQUE), `location_id`, `status`
(`open|counting|awaiting_approval|committed|abandoned`), `opened_at`,
`committed_at`, `counted_by_staff_id`, `approved_by_staff_id`,
`second_approver_staff_id`, `opening_levels_json`, `shopify_response_json`
(verbatim, `userErrors` included), `committed_reference_uri` (UNIQUE).

**`stock_take_items`** — `session_id`, `variant_id`, `inventory_item_id`,
`variant_label`, `unit_price_at_count`, `system_snapshot_qty`,
`snapshot_taken_at`, `counted_qty` (**NOT NULL**), `variance`,
`fresh_qty_at_commit`, `delta_pushed`, `commit_status`
(`applied|rejected|skipped`), `commit_error`, `UNIQUE (session_id, variant_id)`.

Three design points worth stating:

- **`counted_qty NOT NULL` is the scope guarantee.** A row exists *because it
  was counted*. There is no "uncounted" state to confuse with a shelf counted as
  empty, so the catastrophic failure — pushing a negative delta for every item
  nobody walked past — is structurally impossible rather than merely handled.
- **`inventory_item_id` lives on the session's item row, not on `products`.**
  Adding it to the catalog cache would make this app keep a permanent local
  shadow of Shopify's inventory model. It belongs to the session about to
  commit and dies with it.
- **No column is named `quantity`.** They are `system_snapshot_qty`,
  `counted_qty`, `fresh_qty_at_commit`, `delta_pushed`. Nothing reads like a
  live quantity, so nothing gets used as one by autocomplete. There is a test
  asserting this.

### One addition the audit did not anticipate: `opening_levels_json`

Counting must work offline, and a counted row's `system_snapshot_qty` has to
come from the opening read — so the opening read has to survive a restart and
cannot live in memory. It is stored on the session row as
`opening_levels_json`: `{ variantId: { inventoryItemId, systemSnapshotQty } }`,
frozen at `opened_at`.

Judged against the rule: it is a **timestamped observation of what Shopify said
at one instant**, written once and never updated. It is read for exactly one
purpose — stamping a newly counted row's snapshot — and never as current stock.
Deleting it after commit would leave the app functionally identical and the
audit trail poorer. That is the test the audit set for ledger-versus-history,
and it lands on the history side. It is called out here because it is the one
structure in the build that a reviewer should look at twice.

## 3. The write path

### 3.1 Reading the inventory item id

[`shopify.ts`](../src/main/services/shopify.ts): `INVENTORY_LEVELS_QUERY` now
selects `item { id }` alongside `item { variant { id } }`. The adjustment
mutation is keyed by `inventoryItemId` and will not take a variant id.

`fetchInventoryLevelDetails` is the new single paginator returning
`Map<variantId, { inventoryItemId, available }>`; the existing
`fetchInventoryLevels` is now a thin projection of it, so the catalog merge is
unchanged and there is one pagination loop rather than two.

### 3.2 The mutation

[`inventory-adjust.ts`](../src/main/services/inventory-adjust.ts) — a new module
deliberately shaped like `orders.ts`: mutation constant, injectable client, a
function that never throws.

```graphql
mutation StockTakeAdjust($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) { … }
}
```

| Field | Value |
| --- | --- |
| `name` | `"available"` — what a stock take counts, and the only bucket not needing a `ledgerDocumentUri` |
| `reason` | `"cycle_count_available"` — Shopify's own code for a count discrepancy |
| `referenceDocumentUri` | `gid://rubis-pos/StockTake/<session_uuid>` |
| `changes[].delta` | `counted − snapshot` |
| `changes[].changeFromQuantity` | the fresh re-read |
| `changes[].locationId` | the till's own, from the main-process binding |

**Delta, not set — a deliberate departure from Shopify's own guidance.**
Shopify's docs prefer `inventorySetQuantities` when the caller holds
authoritative values "like completed stocktakes". That assumes a warehouse whose
count freezes movement; a till does not freeze. The caveat is recorded in the
`buildInventoryAdjustInput` JSDoc so nobody later "fixes" this back to a set by
citing the doc.

### 3.3 `write_inventory` scope

The app has never needed this scope — every previous call either read, or let
Shopify do its own arithmetic. **A token issued before this feature will not
carry it**, and the failure is an HTTP 403. `translateAdjustError` names the
scope explicitly rather than leaving an operator with "Access denied":

> *Shopify rejected the stock take — the Admin API Token lacks the
> write_inventory scope. Nothing was changed.*

**This cannot be verified from here** — it depends on how each store's token was
issued. It needs checking against the live store before first use. Every
adjustment error message ends with "Nothing was changed", because the first
question an operator asks after a failure is whether it half-happened.

## 4. Session flow

[`stock-take.ts`](../src/main/services/stock-take.ts).

| Step | Network | Gate |
| --- | --- | --- |
| **Open** | online | authenticated staff |
| **Count** | offline OK | — |
| **Review** | offline OK | — |
| **Submit** | offline OK | — |
| **Preview** | online | none (reads, changes nothing — same class as `config:validate`) |
| **Commit** | online | manager PIN in main, + second approver over threshold, + explicit confirm |
| **Close** | — | immutable; corrections are a new session |

Open is online-only too: the snapshot is the reference every delta is computed
against, so it must be a real Shopify observation with a timestamp, never
something the app already had lying around.

One active session per till, enforced by `getActiveStockTakeSession` — two
concurrent counts would each snapshot the same shelf and each push a delta for
it, double-correcting the variance.

### Failure handling turns on whether anything was applied

This is the one place the brief's "session stays open for manual retry" needed
splitting, and the distinction is the whole double-apply argument:

- **Nothing landed** (offline, fresh read failed, first batch rejected) → the
  session stays `awaiting_approval` for a deliberate manual retry. Shopify's
  quantities are exactly as they were, so there is nothing to double-apply.
- **Something landed** (a later batch failed after an earlier one succeeded) →
  the session is **closed as committed** with per-item outcomes, and the result
  says "N applied, M rejected". Re-running a partly-applied session is precisely
  the double-apply hazard. Rejected items are re-counted in a **new** session.

Nothing is ever written to `sync_queue`. A queued delta is an arithmetic claim
about a Shopify quantity observed at a moment that has since passed; every hour
it waits, it gets more wrong. Tested both ways — no queue row on failure, none
on success either.

## 5. Guard rails

| # | Guard rail | Where |
| --- | --- | --- |
| 1 | **Location is never a parameter** | no `locationId` field exists on any stock-take schema — nothing to spoof. Commit additionally refuses when `session.location_id !== ` the current binding (the till was re-pointed mid-session) |
| 2 | **Manager PIN at commit**, re-verified in main | `requireAdminPin` in the `stocktake:commit` handler — the 13th call site, same `validate → requireAdminPin → act` shape |
| 3 | **Value threshold → second approver** | `evaluateApproval`; the second approver's PIN is verified by `requireAdminPin` too, and must be a different manager |
| 4 | **Preview + explicit confirmation** | `stocktake:preview` shows `fresh → fresh + delta` per line plus totals; the UI's confirm is a separate destructive-styled action behind an intermediate panel, never the button that opened the preview; `confirm: z.literal(true)` on the payload |
| 5 | **Delta against snapshot, CAS against fresh** | §1 |
| 6 | **Three-layer idempotency** | §6 |
| 7 | **Blocked offline, never queued** | `isOnline()` pre-check for a clean message; the fresh re-read is the real gate; no `sync_queue` write anywhere |
| 8 | **Never blocks selling** | new Admin tab beside Needs Attention; no locks on any variant; an open session changes nothing about the till |
| 9 | **Partial failure recorded, not retried** | per-item `commit_status` / `commit_error`; "N applied, M rejected"; rejected → new session |

**The approver is never named by the renderer.** The id recorded on the session
is the one whose PIN `requireAdminPin` just verified, so a compromised renderer
cannot attribute its own write to someone else.

**The unit price is never taken from the renderer either.** It is read
server-side from the catalog cache, so the figure the approval threshold is
judged against cannot be understated by the caller. (Price is not stock —
reading it implies nothing about the cached quantity, which the stock take never
touches.)

## 6. Three-layer idempotency

| Layer | Mechanism | Covers |
| --- | --- | --- |
| Shopify's | `@idempotent(key: "<session_uuid>:<batchIndex>")` | network blip, timeout, immediate retry — **24 hours only** |
| Compare-and-swap | `changeFromQuantity` = fresh read | a second application finds the quantity already moved and is rejected |
| **Ours** | `committed_reference_uri` **UNIQUE** + a status guard in the same transaction | for ever, regardless of elapsed time |

The key is suffixed per batch on purpose: reusing one key across batches would
make Shopify replay the first batch's cached response for the second and
silently drop it.

Layer three is the one this app owns, and it is tested past Shopify's horizon —
a second commit seven days later is refused and pushes nothing. The database
enforces it rather than a check some later caller might forget: a direct call to
`commitStockTakeSession` on an already-committed session throws.

## 7. History is never current stock

Three mechanisms, weakest to strongest:

1. **Naming** — no column named `quantity` (asserted by test).
2. **A file-header JSDoc** on `stock-take.ts` stating the rule, the arithmetic,
   and that any read of these tables as stock is a bug.
3. **`tests/stockTakeGuard.test.ts` — the actual guard.** It walks every `.ts`
   and `.tsx` file under `src/` and fails if any file outside `database.ts`
   (schema + statements), `stock-take.ts` (service) and `index.ts` (IPC
   handlers) so much as names `stock_take_items` or `stock_take_sessions`.

**The guard was verified by breaking it**: a probe file added under
`src/renderer/src/lib/` referencing `stock_take_items` made the test fail
naming that exact file, and was then removed. A guard nobody has seen fail is a
guard nobody knows works.

It also asserts the allow-list still points at real files (a rename would
otherwise silently widen it to nothing), and that `getCachedProducts` — the POS
read path — contains no `stock_take` reference.

Two further tests attack the same rule from the behaviour side: the snapshot is
taken from Shopify even when the cache claims 9999 units, and the only thing
read from the cache is the price.

## 8. Tests

87 files, 1350 tests. New: `stockTake.test.ts` (39), `inventoryAdjust.test.ts`
(8), `stockTakeGuard.test.ts` (4), plus 9 schema cases appended to
`ipcValidator.test.ts`.

`stockTake.test.ts` runs against a **real in-memory SQLite database**, not a
recording fake — the `UNIQUE` constraints and transactions are part of the
safety argument, so they have to actually execute. Shopify is faked only at the
two injected seams, which is what lets a test drive the exact race the
arithmetic exists to survive.

| Property | Test |
| --- | --- |
| `delta = counted − snapshot`, sales during the count survive | *pushes counted − snapshot…* — Shopify ends on 6, not 8 |
| Snapshot, fresh read and pushed delta all recorded | *records the snapshot, the fresh read and the pushed delta separately* |
| Zero-variance item skipped, not pushed as a zero delta | *skips an item that already agrees* |
| `changeFromQuantity` is the fresh read | *sends the freshly re-read quantity…* |
| A rejected CAS surfaces and leaves the session open | *surfaces a rejected compare-and-swap…* |
| A de-stocked variant is rejected, not invented | *rejects a line Shopify no longer stocks* |
| Double commit refused past the 24h window | *refuses a second commit… long after Shopify would forget the key* |
| Reference uri written once, enforced by the DB | *writes the reference uri exactly once* |
| Offline: counts, refuses to push, queues nothing | *counts offline but refuses to push…* |
| No queue row on success either | *creates no sync_queue entry on a successful commit* |
| Counter ≠ approver, and the override relaxes it | five `evaluateApproval` cases + an end-to-end commit pair |
| Over-value needs a second, different approver | *requires a second approver…*, *rejects the same person as both* |
| Zero default threshold | *defaults to a zero threshold…* |
| Location mismatch refused; no `locationId` in any payload | three location cases + schema-shape assertions |
| Expiry refused; drift and age always reported | *refuses a count older than…*, *always reports snapshot age and observed drift* |
| Preview shows the resulting figure, not the counted one | *shows the resulting Shopify figure per line* |
| Mutation is delta, carries `@idempotent`, emits no absolute quantity | `inventoryAdjust.test.ts` + *never emits an absolute quantity field* |
| 403 names the missing scope | *names the missing write_inventory scope on a 403* |
| Part A regression | `voids.test.ts` unchanged and green |

**One pre-existing test needed updating**: `pagination.test.ts`'s
`inventoryLevelsResponse` fixture now supplies `item.id`, since a level without
one is skipped as unusable.

## 9. Flagged decisions — what the defaults do

Two values had to have a default, and both fail toward *more* control rather
than less. Both are editable in Admin > Stock Take behind a manager PIN.

- **`stock_take_variance_threshold` defaults to 0.** Until a manager sets a real
  figure, *every* count that moves any value needs a second approver. Inventing
  a number here would silently decide a store's control policy on its behalf,
  and would fail in the unsafe direction. Failing toward more approval is
  recoverable; failing toward less is not. The UI says so in as many words.
- **`stock_take_expiry_hours` defaults to 12**, standing in for "end of the
  trading day". A count that has outlived the shift that took it has outlived
  its shelf.
- **`stock_take_allow_self_approval` defaults to off.** Counter ≠ approver is
  enforced in code; the override exists so a single-manager shift is not
  hard-blocked.

The staleness notice is always shown — snapshot age plus observed drift — and
worded so drift reads as normal rather than as an error, because it is.

## 10. Deferred: whole-catalog stock take

Out of scope, deliberately, and it is not a small addition. A whole-catalog
count must distinguish **uncounted** from **counted as zero**; conflating them
pushes a negative delta for every item nobody walked past, which is the most
destructive thing this feature could do. This build makes that impossible by
construction (`counted_qty NOT NULL`, a row exists only because it was counted).
A whole-catalog phase would have to reintroduce an uncounted state and defend it
explicitly — a design decision, not an extra screen.

## 11. Compliance

| Rule | How this build satisfies it |
| --- | --- |
| Shopify is the only source of truth; no second ledger | Snapshot is a frozen timestamped observation, never read as stock; `inventory_item_id` lives on the session, not `products`; no column named `quantity`; a grep test enforces it and has been seen to fail |
| Never apply an adjustment twice | `@idempotent` per batch + `changeFromQuantity` + `UNIQUE committed_reference_uri` enforced in the same transaction as the status change; tested past the 24h horizon |
| Never let a stale local count masquerade as current stock | Append-only; corrections are new sessions; configurable hard expiry; age and drift always shown at commit |
| Never silently corrupt Shopify | Fresh re-read; `delta = counted − snapshot`; compare-and-swap; preview + separate explicit confirm; partial failure recorded rather than retried |
| Never block the till's normal selling | Back-office Admin tab; no locks; no queue entries; counting is offline-tolerant and the till keeps selling throughout |

## 12. Files changed

| File | Change |
| --- | --- |
| [src/main/services/stock-take.ts](../src/main/services/stock-take.ts) | **new** — session lifecycle, variance, approval rules, preview, commit |
| [src/main/services/inventory-adjust.ts](../src/main/services/inventory-adjust.ts) | **new** — the app's only inventory write |
| [src/main/services/database.ts](../src/main/services/database.ts) | two tables + index, row types, eleven stock-take methods, `getCachedVariantPrice` |
| [src/main/services/shopify.ts](../src/main/services/shopify.ts) | `item { id }` in the levels query; `fetchInventoryLevelDetails` as the single paginator |
| [src/main/services/shopify-types.ts](../src/main/services/shopify-types.ts) | `ShopifyInventoryLevel.item.id` |
| [src/main/lib/ipcValidator.ts](../src/main/lib/ipcValidator.ts) | seven stock-take schemas, none with a `locationId` |
| [src/main/index.ts](../src/main/index.ts) | eleven IPC handlers, the live-levels reader, the dependency factory |
| [src/preload/index.ts](../src/preload/index.ts), [window.d.ts](../src/preload/window.d.ts) | eleven bridge methods |
| [src/renderer/src/pages/StockTakePage.tsx](../src/renderer/src/pages/StockTakePage.tsx) | **new** — count, review, preview, confirm, policy, history |
| [src/renderer/src/lib/stockTake.ts](../src/renderer/src/lib/stockTake.ts) | **new** — display helpers |
| [src/renderer/src/components/AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) | Stock Take tab |
| [tests/stockTake.test.ts](../tests/stockTake.test.ts), [tests/inventoryAdjust.test.ts](../tests/inventoryAdjust.test.ts), [tests/stockTakeGuard.test.ts](../tests/stockTakeGuard.test.ts) | **new** |
| [tests/ipcValidator.test.ts](../tests/ipcValidator.test.ts) | stock-take schema cases |
| [tests/pagination.test.ts](../tests/pagination.test.ts) | fixture supplies `item.id` |

**STOP for review.** Nothing has been run against a live Shopify store — in
particular the `write_inventory` scope (§3.3) is unverified and should be
checked before the first real count.
