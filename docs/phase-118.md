# Phase 118 — Stock Take Part A: remove `voidOrder`'s unbalanced local inventory write

**Date:** 2026-09-23 · **Branch:** `main` · **Previous:** [Phase 117](./phase-117.md)

Precondition fix for the stock-take build, per the [Phase 117](./phase-117.md)
audit §1.3 (Risk 2) and §4.6. Small and deliberately separate from the feature
itself.

## 1. What was removed

`RubisDatabase.voidOrder` ran, once per line item, inside the void transaction:

```ts
const incrementInventory = this.conn.prepare(
  'UPDATE products SET inventory_quantity = inventory_quantity + ? WHERE variant_id = ?'
)
```

That statement, the loop that drove it, and the now-unused
`JSON.parse(order.payload_json)` that fed the loop are gone
([database.ts:1312-1341](../src/main/services/database.ts#L1312-L1341)).

## 2. Why it was a second-ledger write

The rule this whole feature is judged against: **Shopify is the only source of
truth for stock; there is never a second ledger.**

The increment broke it in two independent ways.

**It was unbalanced.** The full set of writes to the `products` table is now
three statements — the delete + insert in `cacheProducts`
([database.ts:670-693](../src/main/services/database.ts#L670-L693)) and the
delete in `clearProductCache`
([database.ts:701-703](../src/main/services/database.ts#L701-L703)). All three
are cache *replacement*. **A sale has never decremented the cached quantity**:
`orderCreate` carries `inventoryBehaviour: 'DECREMENT_OBEYING_POLICY'`
([orders.ts:95](../src/main/services/orders.ts#L95)), so Shopify does the
arithmetic on its own ledger and the local cache simply waits for the next
`products:fetch` to learn the result. The void's increment therefore had no
counterpart anywhere. Every void pushed the cached figure *above* Shopify's.

**It reversed something that had not happened.** `voidOrder` is restricted to
`pending_sync` orders — orders that by definition have **not** reached Shopify.
Shopify's quantity was never decremented for them, so there was nothing to
reverse. The increment was not correcting the cache toward Shopify; it was
moving the cache away from Shopify, by our own hand, on the basis of an event
Shopify never saw.

The old JSDoc called the reversal "best-effort" and noted the cache "will
self-correct on the next `products:fetch`" — both true, and harmless while the
number is only a display hint. It stops being harmless the moment a stock take
reports variance against that column: an operator opening a count in the window
between a void and the next fetch would see a system figure that is neither
Shopify's nor the shelf's, and the variance shown would be wrong by exactly the
voided quantity.

## 3. What was deliberately NOT changed

`getCachedProducts` still derives sellability from the cached number:

```ts
// src/main/services/database.ts:744
availableForSale: row.inventory_quantity > 0,
```

Phase 117 §1.3 flagged this as Risk 1, but it serves a real purpose — offline
sellability without a live Shopify call — and replacing it is a separate
decision with its own trade-offs. It is untouched here.

The stock take does not depend on it either way: **the stock take never reads
`products.inventory_quantity` for anything.** It takes its own fresh,
location-scoped snapshot straight from Shopify at session open (Part B, §B3
step 1). That is what makes Risk 1 irrelevant to this feature rather than
something Part A had to clear first.

## 4. Cost of the change

A void no longer nudges the on-screen stock figure. Since the column is a
display cache refreshed by `products:fetch`, the visible effect is a briefly
stale number after a void — which is what the column already is between any two
fetches. No behaviour that depends on a correct quantity changes, because
nothing derived a correct quantity from it.

## 5. Regression proof

`tests/voids.test.ts`:

- the existing `RubisDatabase.voidOrder` case is retained with the inventory
  assertions dropped, and still proves the order is marked `voided` and **both**
  `sync_queue` entries (`'order'` and `'etims_invoice'`) are cleared with the
  right parameters;
- a new case asserts the write is gone outright — no `UPDATE products` and no
  statement mentioning `inventory_quantity` is prepared or run during a void;
- the three throw cases (unknown order, already `synced`, already `voided`) are
  unchanged;
- the seven `voidLocalOrder` service cases are unchanged, covering the order
  state guard, the already-synced message and error propagation.

`tests/reconciliation.test.ts` exercises `db.voidOrder` at four call sites
against the same fake connection and asserts on order/queue state only — it
never asserted on inventory, and passes unchanged.

```
npm run typecheck   → clean (node + web)
npm test            → 84 files, 1291 tests, all passing
```

## 6. Compliance

| Rule | Before | After |
| --- | --- | --- |
| Shopify is the only source of truth; no second ledger | a local write moved the cached quantity away from Shopify on every void | the only writes to `products` are full-cache replacement from a Shopify read |
| Stock take never reads a competing local quantity | the column it would report against was mutated locally | the column has no local mutator; the stock take reads Shopify directly regardless |

## 7. Files changed

| File | Change |
| --- | --- |
| [src/main/services/database.ts](../src/main/services/database.ts) | removed the increment statement, its loop and the unused payload parse from `voidOrder`; JSDoc rewritten to record why the write must not come back |
| [tests/voids.test.ts](../tests/voids.test.ts) | inventory assertions dropped from the existing case; new case asserting no write to `products` occurs |

**STOP for review.** Part B (the stock-take feature) has not been started.
