# Phase 210 — the location on every Shopify order: audit (stopped before the build)

- **Date:** 2026-10-03
- **Requested:** audit first (four items), report and stop.
- **Outcome:** audit done, **nothing built**. Four findings change the plan as written; each is a decision in section 6. No code, test or config changed; no order, stock or tag touched.
- **Branch / base:** staging on `aa56d68`.

## 1. `buildOrderInput` and every test that pins the payload

[orders.ts:70-106](../src/main/services/orders.ts#L70-L106). `buildOrderInput(payload)` takes only the queued payload (no settings, no location). It returns `order` = `lineItems` (`variantId`, `quantity`), `financialStatus: 'PAID'`, `note`, `sourceIdentifier`, `customAttributes` (the client uuid), `metafields` (the client uuid); and `options` = `inventoryBehaviour: 'DECREMENT_OBEYING_POLICY'`, `sendReceipt: false`, `sendFulfillmentReceipt: false`. **No `fulfillment`, no `tags`, no location.** It is called from `pushOrderToShopify` ([orders.ts:139](../src/main/services/orders.ts#L139)), which is called from one place, the sync engine's `pushOrder` ([index.ts:993-1002](../src/main/index.ts#L993-L1002)).

Tests that pin it:
- `tests/orders.test.ts:44-55` maps to a PAID order with `DECREMENT_OBEYING_POLICY` and `sendReceipt: false`. Unaffected by an added field.
- `:57-72` customAttributes, metafields, note. Unaffected.
- `:74-79` sourceIdentifier. Unaffected.
- **`:81-96` pins the exact key set of `order`**: `['customAttributes','financialStatus','lineItems','metafields','note']` (plus `sourceIdentifier`). **It fails the moment `fulfillment` and `tags` are added**; it needs an old/new note.
- `:98-111` note text. Unaffected.
- `:114-132` `pushOrderToShopify` posts `ORDER_CREATE_MUTATION` with the built variables. Unaffected unless the signature changes.
- `tests/reportsExport.test.ts:172` calls `buildOrderInput(payload)` with **one argument**; it breaks if the location becomes a required second argument.
- Other grep hits for `orderCreate` (`database.test.ts`, `orderHistory.test.ts`, `reconciliation.test.ts`, `syncEngine.test.ts`) are the queue's `action` string, not the payload. `inventoryAdjust.test.ts` mentions it in a comment.

## 2. The 2026-07 reference, against the 2026-10 text you quoted

Fetched 2026-10-03 from `shopify.dev/docs/api/admin-graphql/2026-07/...` through the fetch tool, which summarises each page with a small model; **quotes are from its output, not the raw pages.** Every field you listed exists in 2026-07 with the same text:
- `OrderCreateFulfillmentInput.locationId`: `ID`, **required**, "The ID of the location to fulfill the order from." Also `notifyCustomer` (default false), `originAddress`, `shipmentStatus`, `trackingCompany`, `trackingNumber`. The page says nothing about inventory or stock.
- `OrderCreateOrderInput.fulfillment`: "The fulfillment to create for the order. This will apply to all line items." `fulfillmentStatus`: "The fulfillment status of the order. Will default to `unfulfilled` if not included." `tags`: type `[String!]`, "A comma separated list of tags that have been added to the draft order." (the description is copied from the draft-order input; the type is a list). `customAttributes`: "...Appears in the **Additional details** section of an order details page."
- `OrderCreateFulfillmentStatus`: `FULFILLED` ("Every line item in the order has been fulfilled."), `PARTIAL`, `RESTOCKED`. **The page does not say whether supplying `fulfillment` implies `FULFILLED`.** So the answer to your question is: **the reference does not say.** The plan below sends both and lets the one real order settle it.
- `OrderCreateInputsInventoryBehavior`: `BYPASS` ("Do not claim inventory."), `DECREMENT_IGNORING_POLICY`, `DECREMENT_OBEYING_POLICY` ("Follow the product's inventory policy and claim inventory, if possible."). Not stated: which location, or what happens at zero stock under deny.
- `orderCreate`: scope `write_orders`, "only accessible to apps authenticated using offline tokens"; five orders a minute on a trial or development store. The fetched summary lists `locationId` among the fulfillment details it accepts.
- **No difference from 2026-10 found.**

## 3. Zero stock at the fulfillment location, policy "deny": what the reference says

**The reference does not say.** Neither the enum page nor `OrderCreateFulfillmentInput` nor `orderCreate` addresses it. So whether the order is refused, created unfulfilled, or created and oversold is **Not verified**, and it decides what the retry queue must do (section 4, finding C).

What is measured, from phase 209-1: the variant "test" has policy **DENY**; today **every** location shows `available 0`; only Enjoy Haile Selassie ever held stock (`on_hand 3`), and the order for this till's sale was decremented there. **Rubis Kisumu holds none (`on_hand 0`).** A sale of "test" from this till, fulfilled at Rubis Kisumu, therefore **is the zero-stock case**.

## 4. Findings that change the plan

**A. The stock did go to the wrong shop.** Order #1087 (this till's sale, Rubis Kisumu) was decremented at Enjoy Haile Selassie (phase 209-1, section 3). This is the problem the phase exists to fix, now measured. Inference: Shopify picked the only location that held stock.

**B. The token cannot read or move fulfillment orders.** Its scopes have no fulfillment-order scope (`ACCESS_DENIED` on `fulfillmentOrders`). Consequences: (1) I cannot read an order's fulfillment location the way the plan's verification step expects, except through a `fulfillments { location }` read, which works only once a fulfillment exists, which is the case the new build creates. (2) The "move stock on existing orders" step would use `fulfillmentOrderMove`; that needs fulfillment-order write scopes the token does not have, so it cannot run without a scope change on the Shopify app. **Not verified:** whether `orderCreate` with `fulfillment` needs any scope beyond `write_orders`; the page lists only `write_orders`.

**C. "No location, no push; the order stays `pending_sync`; the Admin screen shows why" is not true of the current retry path.**
- A failed push goes to `db.recordQueueFailure` ([sync-engine.ts:179-187](../src/main/services/sync-engine.ts#L179-L187)). It counts an attempt each time; at `SYNC_MAX_ATTEMPTS = 10` (about 2.5 hours, [database.ts:522](../src/main/services/database.ts#L522), [:1212](../src/main/services/database.ts#L1212)) it sets the order `failed` and **deletes the queue row** ([database.ts:2639-2643](../src/main/services/database.ts#L2639-L2643)). The existing "Shopify credentials missing" refusal ([index.ts:995-999](../src/main/index.ts#L995-L999)) goes the same way.
- The failure reason is stored in `sync_queue.last_error`, and a search of `src/` finds **nothing that reads it for display**. So the Admin screen does not show why.
- So a till with no location would, after about 2.5 hours, mark its sales `failed` and stop trying. Meeting the instruction needs a second small change: a push result that means "deferred, count no attempt" (as the fiscal engine does for "device not reached", phase 186) and somewhere to show the reason.
- The same applies to a zero-stock refusal, if Shopify refuses it: today it would be retried ten times and then abandoned.

**D. The location can be empty or env-overridden.** The till's location is resolved in `index.ts` ([:660-690](../src/main/index.ts#L660-L690)): `VITE_SHOPIFY_LOCATION_ID` first (its display name is fetched in the background and can be undefined for a while), then the settings. `location:reset` sets both settings to `''` ([:2545-2552](../src/main/index.ts#L2545-L2552)). So "unset" must mean **undefined or empty**, for the id and for the name (no empty tag). Today's values: `location_id` `gid://shopify/Location/77557989479`, `location_name` `Rubis Kisumu`, `location_confirmed` `1`.

## 5. The build, as I would do it once decided

1. `buildOrderInput(payload, location)` where `location = { id, name }`; adds `fulfillment: { locationId, notifyCustomer: false }`, `fulfillmentStatus: 'FULFILLED'` (both, since the reference does not say one implies the other; the real order settles it) and `tags: ['location:<name>']`. It throws, or `pushOrderToShopify` returns a deferral, when the id or name is empty.
2. `index.ts:993` passes the resolved `locationId` and `locationName` bindings in.
3. Tests: the `:81-96` key-set test rewritten with an old/new note; `reportsExport.test.ts:172` updated for the signature; new tests pin `fulfillment.locationId`, `fulfillmentStatus`, the tag from the stored settings, an unset id and an unset name each refusing, and (if decision 2 is yes) that a deferral counts no attempt.
4. One real sale from this till, item "test", 1.00 KSh, **with your go**, then the three reads.

## 6. Decisions needed

1. **Where to take the location from.** (a) **At push time**, from the till's resolved settings (my recommendation: one call site, no change to the queued payload, nothing to migrate for orders already queued; a sale queued before an admin changes the till's location would carry the new one, which is rare); or (b) **at sale time**, stored in the payload (truest, but changes the payload type and its tests, and old queued payloads need a fallback).
2. **The deferral (finding C).** Build the "deferred, no attempt counted" result and a visible reason now, in this phase, or accept the 10-attempt behaviour for the missing-location case and record it in `docs/KNOWN_GAPS.md`.
3. **The test sale and zero stock (section 3).** "test" has no stock at Rubis Kisumu, so the verification sale is the zero-stock experiment, and under DENY it may be refused, which would not tell us where the decrement goes. Options: (a) **a written go to set "test" to a small available quantity at Rubis Kisumu** (a stock change, so only with your written go), then test the happy path; (b) test with a different item that already has stock at Rubis Kisumu; (c) run the zero-stock case as it stands and treat the result as the answer to section 3, and verify the decrement location later with stock in place. I recommend (b) if such an item exists, otherwise (a).
4. **Fulfillment-order scopes.** Whether to add them to the Shopify app (needed to read an order's fulfillment-order location and to move stock on existing orders), or to settle existing orders another way. Nothing in the existing-orders steps proceeds without this and the owner's split.

## 7. Not verified

- That `fulfillment.locationId` decides the decrement location (the one-order test exists to settle it).
- Whether `fulfillment` alone implies `FULFILLED`.
- Behaviour at zero stock under DENY.
- Whether `orderCreate` with `fulfillment` needs a scope beyond `write_orders`.
- The raw 2026-07 pages (read through a summarising tool).
- The other till's Shopify location, which the owner must name.

## 8. Rollback

Nothing to roll back: audit only.
