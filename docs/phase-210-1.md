# Phase 210-1 — the location on every Shopify order: built, not yet verified against Shopify

- **Date:** 2026-10-03
- **Follows:** [phase-210.md](phase-210.md) (the audit), under the owner's rulings of 2026-10-03 as summarised in the instruction (the rulings file itself was not on disk; I worked from the instruction's summary).
- **Branch / base:** staging on `1f9e80c`.
- **Outcome:** **the build is done and tested; the real-order verification has not been run.** It needs OWNER GO 2 and 3, and a Shopify token in the shell. Until it runs, **it is not verified that `fulfillment.locationId` decides which location's stock is decremented.** Full suite 188 files, 3001 tests, all passing; typecheck clean; `npm run build` passes with the no-mock check.

## 1. What changed

- **`src/main/lib/locationSlug.ts`** (new): `locationSlug` (lowercase, spaces to hyphens, anything outside `[a-z0-9-]` removed, hyphen runs collapsed, at most 40 characters) and `locationTag` (`location:<slug>`, or `null` when no slug remains, so an empty tag is never sent).
- **`src/main/lib/checkoutLocation.ts`** (new): `resolveCheckoutLocation(id, name)` returns the location only when both are non-empty after trimming; `NO_LOCATION_MESSAGE`.
- **`orders.ts`:** `buildOrderInput(payload, fallback?)` adds `fulfillment: { locationId, notifyCustomer: false }`, `fulfillmentStatus: 'FULFILLED'` and `tags: ['location:<slug>']`. The location is the payload's own (captured at sale time); the fallback is this till's current location, used only for a payload with none. With neither it throws `MissingLocationError`, and `pushOrderToShopify` turns that into a failed result **before any request is sent**. `sourceIdentifier`, the note, `financialStatus`, the options, the pre-push guard and the queue are untouched.
- **Capture at sale time:** `OfflineOrderPayload`, `QueueOrderInput` and `CheckoutRequest` gain optional `locationId` / `locationName`; `queueOrder` stores them in the payload; `runCheckout` passes them through. `CheckoutIpcRequest` omits them, so a renderer cannot set them.
- **`index.ts`:** the `orders:checkout` handler resolves the till's location from its own settings (the env override first, as the existing bindings do), **refuses with `NO_LOCATION_MESSAGE` before anything is written, paid or filed**, and passes the location into `runCheckout`. The sync engine's `pushOrder` passes the till's current location as the fallback.
- **Both `fulfillment` and `fulfillmentStatus` are sent** because the 2026-07 reference does not say whether the first implies the second (phase 210 section 2).
- **`docs/KNOWN_GAPS.md`:** an entry for the retry exhaustion (a failed push counts attempts; after 10 the order is `failed` and the queue row deleted; `last_error` is not shown) and the unknown zero-stock behaviour. No deferral was built, as ruled.
- **Not done, as ruled:** no scope change, no deferral.

## 2. Tests

**Old/new notes in the files (existing tests changed):**
- `tests/orders.test.ts`: the sample payload now carries a location (OLD none; NEW `Rubis Kisumu`), because the builder now refuses without one. The key-set test "adds sourceIdentifier without changing any other order field" now lists `fulfillment`, `fulfillmentStatus` and `tags` in addition to the old keys (OLD `customAttributes, financialStatus, lineItems, metafields, note`).
- `tests/reportsExport.test.ts`: `buildOrderInput(payload)` became `buildOrderInput(payload, <Rubis Kisumu>)`; its assertions are unchanged.

**New:**
- `tests/orders.test.ts`, "the location": `fulfillment` is `{ locationId: gid://shopify/Location/77557989479, notifyCustomer: false }`; `fulfillmentStatus` is `FULFILLED`; the tag is exactly one, `location:rubis-kisumu` (and `location:enjoy-haile-selassie` for that name); the payload's location wins over a different current one; an old payload falls back to the current location; the builder throws for no id, no name, an empty id, an empty name and a name with no usable characters; a push with no location sends nothing (`post` not called) and fails with "no shop location"; the posted variables carry the location and the tag.
- `tests/locationSlug.test.ts`: the slug for `Rubis Kisumu` and `Enjoy Haile Selassie`, extra spaces, punctuation, hyphen runs, an all-symbol name (empty), the 40-character cap; `locationTag` null rather than an empty tag; `resolveCheckoutLocation` null for undefined, empty and blank values.
- `tests/checkoutLocation.test.ts`: `runCheckout` writes the location into the queued payload and the order row, and that stored payload builds the right order with no fallback; **a source pin** that the `orders:checkout` handler resolves the location, refuses with `NO_LOCATION_MESSAGE` and only then calls `runCheckout`, and takes the location from the till's settings. The handler needs Electron and cannot be run in a unit test; the pin fails if the refusal is removed or moved.

**Mutation checks (each run, file restored, hash compared):** tag not sent, 6 tests fail; `fulfillment` not sent, 6 tests fail; the handler's refusal removed, the source pin fails (1 test).

## 3. Not done: the verification, and why

| Step | Needs | State |
| --- | --- | --- |
| Stock for the verification item | OWNER GO 2, and `SHOPIFY_TOKEN` set in a shell I can use | **Not run.** The variable is not set in my shell. Nothing at Rubis Kisumu has been read for stock yet. |
| One real 1-unit sale from this till | OWNER GO 3 | **Not run.** Both app copies are still the old build (open since 22:36 and 22:40 on 2 October); the sale must be made from a build that contains this commit. |
| The three reads after it | the sale | Not run. |
| Existing orders, read-only listing | token | Not run. |
| Existing orders, tags | the owner's split and the other till's location name | Not run. |

**Pass condition, unchanged:** the order fulfilled from Rubis Kisumu, tag `location:rubis-kisumu`, decrement at Rubis Kisumu only. Anything else: stop, adjust nothing, report. If Shopify refuses the order at zero stock, that is the open `inventoryBehaviour` decision and nothing is changed.

## 4. Not verified

- That `fulfillment.locationId` decides the decrement location, and that `fulfillment` with `fulfillmentStatus` is accepted with this token's scopes.
- What Shopify does at zero stock under "deny" at the fulfillment location.
- That the checkout refusal behaves as pinned in the running app (the source pin proves the code is in place and ordered, not that the handler ran).

## 5. Rollback

`git revert` the commit. Orders already queued with a location in their payload still push after a revert (the extra payload fields are ignored).
