# Phase 159 - Fiscal read-back (G8) and Shopify invoice-number reporting audit (read-only)

- **Date:** 2026-09-26
- **Requested:** A read-only audit in two parts. B1: trace one sale's fiscal read-back path (`ReadCurrentReceiptInfo`'s per-VAT-group totals) to find exactly where the data is dropped, and confirm whether the additive `taxAmount` at `checkout.ts:290` reaches the device or the receipt. B2: map how a synced order gets its `shopify_order_id`, and design the smallest safe way to later attach the trader/CU invoice numbers to that Shopify order. B3: propose builds in order, each separately reviewable. No code changed, no device command sent (never `DailyReport`), no Shopify write call, no SQL against real data.
- **Outcome:** No change needed - audit only, as instructed.
- **Branch / base commit:** staging @ 50d4cb8 (Phase 158-1 - dynamic VAT label, Nairobi-day export filenames, client UUID on `orders.csv`).

**Method note:** every claim below carries a `file:line`. A conclusion drawn from more than one fact is labelled **Inference:**. Something I could not check from inside this repository - the fiscal protocol PDF's exact byte layout, live device behaviour, the till's actual granted Shopify scopes - is labelled **Not verified:**. Two `shopify.dev` documentation pages were fetched for Part B2 (`orderUpdate`'s required scope, `OrderInput.customAttributes`/`metafields` overwrite-vs-add wording) - reading public API documentation, not a call against the merchant's own store. No SQL was run against any database; every schema fact below comes from reading `database.ts`'s own `CREATE TABLE` strings. No command was sent to a fiscal device or ZFPLabServer. No device password appears anywhere below.

---

## PART B1 - Fiscal read-back (G8)

### B1.1 - Tracing one sale from checkout to `setOrderFiscalInfo`

1. `checkout.ts:307` `runCheckout` persists the order (`db.queueOrder`, `checkout.ts:508`), giving it a `localId`.
2. `checkout.ts:511-521` fires the Shopify sync tick (`void engineTick()`, not awaited) - see Part B2 for why this matters.
3. `checkout.ts:539` builds the fiscal request: `buildFiscalRequest(input, clientOrderUuid, localId, taxRate)` (`checkout.ts:266-296`).
4. `checkout.ts:542` stores that request, win or lose: `db.setOrderFiscalRequest(localId, fiscalRequest)` -> `database.ts:1481-1484`, `UPDATE orders SET fiscal_request_json = ?` (a plain `JSON.stringify(request)`, `database.ts:1484`).
5. `checkout.ts:544` calls `fiscalizationProvider.submitInvoice(fiscalRequest)` -> `RealFiscalizationProvider.submitInvoice` in `real-etims-provider.ts` (the seven-step sequence documented at `real-etims-provider.ts:22-32`).
6. Inside `submitInvoice`, **Step 5 of 7** is `ReadCurrentReceiptInfo` (`real-etims-provider.ts:946-956`):
   ```
   const receiptInfoResult = await this.sendCommand(this.endpoints.readCurrentReceiptInfo, 'ReadCurrentReceiptInfo', {})
   ...
   const receiptInfo = receiptInfoResult.data ?? {}
   const isReceiptOpened = receiptInfo.OptionIsReceiptOpened === '1'
   const subtotal = sumVatGroupSubtotals(receiptInfo)
   if (!isReceiptOpened || subtotal <= 0) { ... fail ... }
   ```
   `sumVatGroupSubtotals` (`real-etims-provider.ts:1554-1559`) sums the five fields named in `SUBTOTAL_FIELDS` (`real-etims-provider.ts:161-167`: `SubtotalAmountVATGA`...`SubtotalAmountVATGE`).
7. **This is where the values are dropped.** `subtotal` is a local `number` used for exactly one purpose - the `subtotal <= 0` sanity check at `real-etims-provider.ts:960` - then it, and the `receiptInfo` object it was computed from, both go out of scope. Neither the summed total nor any of the five individual `SubtotalAmountVATG*` fields is stored anywhere: not in the function's return value, not in a class field, not logged (outside `debugLogging`, and even then only as a raw dump on a different failure path, `real-etims-provider.ts:988-993`).
8. The success return (`real-etims-provider.ts:1016-1026`) carries only `invoiceNumber`, `qrCode`, `fiscalizedAt`, `fiscalizedAtSource`, `cuSerialNumber`, `defVerStatus` - no VAT figures at all.
9. Back in `checkout.ts:546-548`, only `invoice.data.invoiceNumber`/`invoice.data.qrCode` are kept (`fiscal = { invoiceNumber, qrCode }`) and passed to `db.setOrderFiscalInfo(localId, invoiceNumber, qrCode)`.
10. `setOrderFiscalInfo` (`database.ts:1419-1428`) writes exactly those two values plus a timestamp:
    ```sql
    UPDATE orders SET fiscal_invoice_number = ?, fiscal_qr_code = ?, fiscal_fiscalized_at = ?,
     fiscal_status = 'fiscalized', fiscal_error_reason = NULL, fiscal_error_kind = NULL, fiscal_data_issue = NULL
    WHERE local_id = ?
    ```
    No column for a VAT-group figure exists in the `orders` table at all (`database.ts:390-397` lists every `fiscal_*` column: `fiscal_invoice_number`, `fiscal_qr_code`, `fiscal_fiscalized_at`, `fiscal_status`, `fiscal_error_reason`, `fiscal_error_kind`, `fiscal_request_json`, `fiscal_data_issue`).

**Conclusion**: the device computes and reports back its own authoritative per-VAT-group totals at Step 5, this codebase reads them only to check `> 0`, and then throws them away. Nothing downstream - not the database, not a report, not the receipt - ever sees the number the device itself calculated. This is the direct root cause behind G8 (docs/phase-157 Part 3): there is no fiscal-vs-till reconciliation report because the fiscal figures needed for one are never captured past a single boolean check.

### B1.2 - Smallest way to persist the device's per-group totals

**Proposal** (not built - Part B3 sequences it): add one nullable `TEXT` column, `fiscal_vat_groups_json`, to the `orders` table via `CREATE TABLE ... ADD COLUMN` idiom this codebase already uses for additive schema changes (e.g. `database.ts:396`'s own `fiscal_request_json TEXT` was added the same way in an earlier phase). Store the five raw strings verbatim as returned (`{ "SubtotalAmountVATGA": "...", ..., "SubtotalAmountVATGE": "..." }`), not a parsed/summed number - the raw device strings are the authoritative fiscal record; deriving a total from them is a reporting-layer job (`computeVatIncluded`'s sibling would live in `reports.ts`, reading this column, once it exists), not something to bake into storage.

Reasoning for JSON-over-five-columns: the five fields are a fixed, device-defined group (A-E), read together, used together (only as a report row, never queried individually by VAT class in this codebase today) - the same shape/reasoning as `fiscal_request_json` already uses for a similarly fixed, opaque, "store what the device said" blob. Five separate `REAL` columns would let SQL aggregate a single VAT class across orders directly; nothing in the current report design (Part B3) needs that, so it would be speculative.

**Write-once**: populated in the same `real-etims-provider.ts:1016-1026` success block that already returns `invoiceNumber`/`qrCode` (add the raw `receiptInfo`'s five fields to `FiscalSubmitOutcome`'s success `data`), then written by `setOrderFiscalInfo` alongside the other write-once fiscal fields (`checkout.ts:548`) - never updated again, matching the "written once, never edited" instruction. A device response that fails the `subtotal <= 0` gate never reaches this write, which is correct: no filed invoice, nothing device-confirmed to store.

### B1.3 - Is `taxAmount` (the additive figure, `checkout.ts:290`) sent to the device?

**No. Confirmed by exhaustive search, not inference.** `grep -rn "taxAmount" src/` returns exactly two hits in the entire codebase: the field's definition (`etims.ts:52`, `/** Total tax portion of total. */ taxAmount: number`) and its one assignment (`checkout.ts:290`, `taxAmount: input.total * taxRate`). No third reference exists anywhere - not in `real-etims-provider.ts`, not in `mock-etims-provider.ts`, not in any renderer file, not in any test.

Tracing what the device actually receives, in the order it's sent:
- **Step 3**, `OpenInvoiceWithFreeCustomerData` - `buildOpenInvoiceArgs` (`real-etims-provider.ts:1393-1406`) sends exactly seven fields: `CompanyName`, `ClientPINnum`, `HeadQuarters`, `Address`, `PostalCodeAndCity`, `ExemptionNum`, `TraderSystemInvNum`. No total, no tax amount.
- **Step 4**, one `SellPLUfromExtDB`/`SellPLUfromExtDB_HS` command per line item - `buildSellPluArgs` (`real-etims-provider.ts:1492-1507`) sends `Price` (the line's own `item.unitPrice`, formatted by `formatPrice`) and `VATGrRate` (`(item.taxRate * 100).toFixed(2)`) **per line**; `buildSellPluHsArgs` (`real-etims-provider.ts:1519-1530`) sends `Price` and `HSCode` only, no VAT rate at all (the device derives it from its own programmed HS table, per the doc comment at `real-etims-provider.ts:1509-1514`).
- **Step 6**, `CloseReceipt` - no arguments (`real-etims-provider.ts:976`, `{}`).

The order's aggregate `total`/`taxAmount` never appear in a single command argument. The device computes its own totals from the per-line `Price`/`VATGrRate`/`HSCode` values sent at Step 4, then reports them back at Step 5 (`ReadCurrentReceiptInfo`) - the same figures B1.1 traced as read-then-discarded.

**This is not a live filing error.** `fiscal_request_json`'s stored `taxAmount` is write-only: it's persisted for the record (and for a manual resend to rebuild the *identical* request, `fiscal-retry.ts:172-182`, `database.ts:1469-1484`'s own doc comment) but never read back to drive a computation or a device call. **It is, however, a latent trap**: it is the exact same additive formula G2 (docs/phase-157) already found and phase-158 corrected on the *reports* side (`computeVatIncluded`). If anything is ever built to read `fiscal_request_json.taxAmount` for a report (a natural-looking shortcut, since the field already exists and looks authoritative), it would silently reintroduce the additive bug for VAT-inclusive shelf prices. Recommend a one-line doc comment on the `taxAmount` field in `etims.ts:52` warning against this, when this area is next touched (not done here - out of scope for an audit).

### B1.4 - Every place the added-on-top tax reaches the customer or KRA

**Not KRA** - confirmed above, the device never receives an aggregate tax figure at all; it computes and validates its own.

**The customer, in two separate places**, both using the identical wrong formula (`subtotal * rate` added on top, rather than `subtotal * rate / (1 + rate)` extracted - the same class of bug as G2, on the *printed* receipt rather than the *reports* side phase-158 already fixed):

1. **The primary thermal receipt** - `printer.ts:renderReceipt`:
   ```
   const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)  // printer.ts:211-214
   const tax = subtotal * settings.taxRate                                                 // printer.ts:215
   const total = subtotal + tax                                                            // printer.ts:216
   ...
   client.println(`Subtotal: ${formatCurrency(subtotal)}`)   // printer.ts:243
   client.println(`Tax: ${formatCurrency(tax)}`)              // printer.ts:244
   client.println(`Total: ${formatCurrency(total)}`)          // printer.ts:246
   ```
2. **The PDF fallback receipt** - used automatically whenever the thermal printer is offline or unreachable (`printer.ts`'s `printReceipt` falls back to it; doc comment at `pdf-receipt.ts:1-8`). It is a **second, independent copy of the same formula**, not shared code with `renderReceipt`:
   ```
   const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)  // pdf-receipt.ts:36
   const tax = subtotal * settings.taxRate                                                 // pdf-receipt.ts:37
   const total = subtotal + tax                                                            // pdf-receipt.ts:38
   ...
   doc.text(`Subtotal: ${formatCurrency(subtotal)}`)   // pdf-receipt.ts:66
   doc.text(`Tax: ${formatCurrency(tax)}`)              // pdf-receipt.ts:67
   doc.text(`Total: ${formatCurrency(total)}`)          // pdf-receipt.ts:68 (Helvetica-Bold)
   ```

Nowhere else: the on-screen post-checkout success toast (`saleCompleteToast.ts:26`) shows only "Sale complete - tax receipt issued." with no figure; `grep -rn "taxAmount" src/` (above) already rules out any renderer surface; the printed Z-report and every Admin Reports figure now use the corrected extraction (`computeVatIncluded`, phase-158/158-1).

**Not verified**: whether the printed "Total" on either receipt can ever exceed the amount actually tendered/charged at checkout (`input.total`) - that would require tracing `PosCheckoutPanel.tsx`'s own cart-total math against these two independently-recomputed figures, which is outside this audit's scope (fiscal read-back and Shopify reporting) and touches the checkout/receipt code the task's hard rules forbid changing regardless. Flagging it as the reason `docs/KNOWN_GAPS.md`'s "receipt tax fix is go-live plan Item 3" should, when it is eventually scheduled, explicitly list **both** `printer.ts` and `pdf-receipt.ts` as call sites - only one is named in that item's current framing.

### B1.5 - `STE1 = 0x3b` (59 decimal, "24 hours block, missing Z report"): waiting-forever or `needs_fixing`?

**`needs_fixing` - never auto-retried, in every case.** Traced through `checkDeviceResponse` (`real-etims-provider.ts:464-528`):

- `checkDeviceResponse` only special-cases one `STE1` value: `STE1_OPENED_FISCAL_RECEIPT = 52` (`real-etims-provider.ts:189, 497-504`). `STE1 = 59` (0x3b) is not that value, so the code falls through to line 505: `if (ste2 !== undefined) { const mapped = mapFiscalDeviceError(String(ste2), rawMessage) ... }`.
- Whatever `STE2` accompanies a real `STE1 = 0x3b` response is **Not verified** (already flagged as `VERIFY-ON-DEVICE` in `docs/KNOWN_GAPS.md`'s existing "Fiscal device daily closure" entry) - but it does not change the outcome:
  - `mapFiscalDeviceError` (`real-etims-provider.ts:383-406`) has no case that returns `retryable: true` - every named case (`52`, `57`, `58`, `59`, `60`, `61`, `62`, `63`, `64`) and its `default` all return `retryable: false`.
  - If `STE2` happens to also be `'59'` decimal, `mapFiscalDeviceError` maps it to `"Wrong client PIN"` - the coincidental byte overlap `docs/KNOWN_GAPS.md` already documents - and `classifyDeviceFailure` (`real-etims-provider.ts:559-573`) additionally tags `dataIssue: 'wrong-pin'` (line 571, keyed on `STE2_WRONG_CLIENT_PIN = '59'`, `real-etims-provider.ts:212`), which would put a **wrong, specific, actionable-looking** reason in front of the cashier ("wrong client PIN" - re-enter the PIN) for a condition that has nothing to do with the buyer's PIN.
  - If `STE2` is anything else not in the table, `mapFiscalDeviceError`'s `default` (`real-etims-provider.ts:403-404`) returns `` `Unknown fiscal device error (Code ${code})` ``, `retryable: false`.
  - If `STE2` is undefined for this response, `checkDeviceResponse`'s final fallback (`real-etims-provider.ts:514`) returns `` `Fiscal device error (Code 40): ${rawMessage}` ``, `retryable: false`.
- Every one of those three branches produces `retryable: false`. `routeFiscalOutcome` (`fiscal-routing.ts:52-63`) maps `retryable: false` directly to `{ status: 'needs_fixing', enqueue: false }` - never queued, so `fiscal-engine.ts`'s automated tick (`fiscal-engine.ts:1-33`, drains only `sync_queue` rows) never sees it again. The sale surfaces once, on the Needs Attention list, and stays there until a person manually resends it (`fiscal-retry.ts:65-93`'s `attemptFiscalRetry`, called only from a manual resend entry point, not from any timer).

**Conclusion**: a live `STE1 = 0x3b` will not loop forever - it becomes a one-time `needs_fixing` item - but the cashier-facing reason attached to it is very likely wrong (either a misleading "Wrong client PIN" or a generic "Unknown fiscal device error"/"Code 40" message), naming no connection to the real cause (a missing daily Z-report closure, a decision `docs/KNOWN_GAPS.md` already records as explicitly deferred pending VIL/TSL confirmation). Decoding `STE1 = 0x3b` explicitly (a small, targeted addition to `checkDeviceResponse`) would fix the message without requiring the daily-closure feature itself to be built - two independently reviewable pieces of work, not one.

---

## PART B2 - Invoice numbers on the Shopify order

### B2.1 - How an order gets its `shopify_order_id`; what runs after

**Sequence, confirmed from `checkout.ts`**:
- `checkout.ts:508` persists the order and gets `localId`.
- `checkout.ts:511-521`: `if (monitor.isOnline()) { void engineTick() ... }` - fired but **not awaited**. `engineTick` resolves to `() => engine.tick()` (`index.ts:1115`, `createSyncEngine` at `index.ts:848`).
- `checkout.ts:523`: `const order = db.getOrder(localId)` runs immediately after, **without waiting for the tick to finish** - so `order.status` here will almost always still read `'pending_sync'`, not `'synced'` (the tick is still in flight or hasn't started its HTTP call yet). **Inference**, from the `void`/no-`await` shape - not separately measured.
- `checkout.ts:538-548`: fiscalization runs and completes (or fails) entirely independently of whether the sync tick has finished.

**Inside the sync engine** (`sync-engine.ts:79-100`, `tick()`):
```
const pending = db.getPendingSyncQueue(now())
for (const item of pending) {
  const result = await pushOrder(item.payload)
  if (result.success && result.data) {
    db.markQueueItemSynced(item.id, result.data.shopifyOrderId)
  } else {
    db.recordQueueFailure(item.id, result.error ?? 'Unknown sync error')
  }
}
```
`pushOrder` -> `pushOrderToShopify` (`orders.ts:129-160ish`) -> `buildOrderInput` (`orders.ts:65-100`) -> the `orderCreate` mutation.

On success, `markQueueItemSynced` (`database.ts:1586-1601`) does exactly this, in one transaction:
```sql
UPDATE orders SET status = 'synced', shopify_order_id = ? WHERE local_id = ?;
DELETE FROM sync_queue WHERE id = ?;
```

**Nothing runs after this.** `markQueueItemSynced` is the terminal write for the Shopify side of an order - confirmed by reading every call site of `shopify_order_id` and every caller of `sync-engine.ts`'s `tick()`: no code anywhere re-reads a `synced` order to push a follow-up update. The order's Shopify record is created once and never touched again by this codebase, regardless of what happens to it afterward (fiscalization succeeding, failing, being manually resent hours later, or the order being voided).

### B2.2 - Could the trader invoice number be added to `orderCreate`'s `customAttributes`/`metafields` at creation?

**In principle, yes - the value is knowable before the Shopify push. In practice, not with the data `pushOrder` currently receives**, and this is a concrete, specific gap worth naming precisely:

- The trader invoice number's real, device-facing format comes from `RealFiscalizationProvider.buildTraderSystemInvNum` (`real-etims-provider.ts:1408-1421`, **private**): `` `INV-${String(localId).padStart(9, '0')}` ``, falling back to a dash-stripped, truncated `clientOrderUuid` only when `localId` is absent. Docs/phase-158 already extracted a deliberate, tested, byte-identical duplicate of this exact formula into `src/main/lib/traderSystemInvoiceNumber.ts` (`buildTraderSystemInvNum(localId, clientOrderUuid)`), specifically because the real method is private and its file is off-limits to routine changes - so the value is already computable from outside `real-etims-provider.ts` today, with no new logic needed.
- Both inputs (`localId`, `clientOrderUuid`) exist by the time an order is queued for checkout - `localId` from `db.queueOrder` (`checkout.ts:508`), `clientOrderUuid` from `idGen()` earlier in `runCheckout`.
- **But** `OfflineOrderPayload` (the object `pushOrder`/`buildOrderInput` actually receives) has **no `localId` field** - confirmed by its full definition (`shopify-types.ts:202-217`: `clientOrderUuid`, `total`, `lineItems`, `createdAt`, `staffId`, `staffName`, `paymentMethod`, `tenderedAmount`, `changeDue`, `referenceNumber?`, `customerPin?`, `cartDiscount?` - no `localId`). `queueOrder` (`database.ts:1193-1249`) builds this exact `payload` object *before* the `INSERT INTO orders` runs (`database.ts:1195-1216`, then `1224`), so `localId` isn't even known yet at the point the payload literal is constructed, and it is never added afterward - the identical `payload` object is serialized into both `orders.payload_json` (`database.ts:1228`) and `sync_queue.payload_json` (`database.ts:1241`).
- **The local order id is not lost, though** - it is already stored as a separate column on the queue row itself: `SyncQueueItem extends Omit<SyncQueueRow, 'payload_json'>` (`database.ts:144-146`) carries `entity_id` (the `local_id`, set at `database.ts:1239`), returned by `getPendingSyncQueue` (`database.ts:1260-1264`, `SELECT id, entity_type, entity_id, ...`). `sync-engine.ts:89` simply doesn't pass it through: `const result = await pushOrder(item.payload)` - only `item.payload`, not `item.entity_id`.

**Conclusion**: adding the trader invoice number to `orderCreate`'s initial `customAttributes`/`metafields` needs no read-back from the device and no new stored field - only threading `item.entity_id` (already sitting unused right next to `item.payload`) through `pushOrder`'s signature and into `buildOrderInput`. This is a small, precisely-scoped, separately reviewable change (Part B3, build 1) - and it is the one piece of this whole area that touches `orders.ts`, which is why it is called out by name here rather than left implicit, even though this Part B2 audit itself makes no such change.

**What else relies on `customAttributes`** (dedup/lookups): **nothing, in this codebase.** `grep -rn "customAttributes\|CLIENT_ORDER_UUID_KEY" src/main` shows `client_order_uuid` is attached at `orderCreate` time (`orders.ts:82-92`) purely as a forensic/audit trail for a human to search in the Shopify admin - `shopify.ts` has no order-search/query function of any kind (confirmed: no `ordersQuery`/`orders(query:...)` call exists anywhere in it), and nothing in this app ever reads a Shopify order's `customAttributes` back. Adding new keys carries no risk of breaking an existing programmatic dependency.

### B2.3 - Smallest safe update path for the CU invoice number (arrives later)

**Design, against the constraints given:**

1. **Mechanism: `metafields`, not `customAttributes`, as the primary and only mechanism for anything written after `orderCreate`.** Fetched directly from `shopify.dev` (2026-09-26):
   - `OrderInput.customAttributes`: *"A new list of custom attributes for the order. **Overwrites the existing custom attributes.**"*
   - `OrderInput.metafields`: *"A list of new metafields to add to the existing metafields for the order."*

   A `customAttributes` update on `orderUpdate` therefore requires the caller to already know and resend **every** existing attribute (including `client_order_uuid`) or silently delete it - meaning a read (a fresh GraphQL query for the order's current attributes) before every write, which is exactly the kind of extra round-trip, extra failure mode, and extra offline-survival problem the constraints ask to avoid. `metafields` upsert per `(namespace, key)` with no read-before-write needed - the standard, idempotent, retry-safe primitive, and the one this codebase already uses for `client_order_uuid` itself (`orders.ts:85-92`, namespace `rubis_pos`, `RUBIS_NAMESPACE` at `orders.ts:35`).
2. **Idempotent by construction**: writing the same `(namespace, key, value)` metafield twice is a no-op from Shopify's perspective - safe to retry an update an unknown number of times without a dedup key of its own.
3. **Never blocks the till, waits for `shopify_order_id`, survives offline**: this is a background, queued follow-up, not something added to `checkout.ts`'s fiscalization block. Confirmed necessary, not just cautious - B2.1 already shows `shopify_order_id` is essentially never known yet at the moment fiscalization completes (`checkout.ts:523` reads it before the sync tick has resolved). The natural home is a **third queue lane**, alongside the existing `entity_type = 'order'` (Shopify) and `entity_type = 'etims_invoice'` (fiscal retry) rows already in `sync_queue` - e.g. `entity_type = 'order_fiscal_update'`, enqueued only once an order is **both** `status = 'synced'` (has a `shopify_order_id`) **and** `fiscal_status = 'fiscalized'` (has a CU invoice number) - whichever of those two events happens second decides when to enqueue, since either order is possible (B2.1 shows sync usually finishes first, but nothing guarantees it). A third, independent engine (mirroring `sync-engine.ts`/`fiscal-engine.ts`'s own shape - same trigger set, same re-entrancy guard) drains it with ordinary exponential backoff, exactly like the other two.
4. **The Shopify copy is written once**: once this queue item succeeds, it is removed (like the other two queues) and never revisited - matching "the till and device remain the source of truth."
5. **Scope**: `orderUpdate` requires `write_orders` (one of `write_orders` / `write_marketplace_orders` / `write_quick_sale` - fetched from `shopify.dev`, 2026-09-26). This app's `orderCreate` call already requires and is presumably already granted `write_orders` (`pushOrderToShopify` works in production today), so **no new scope grant should be needed** - **Not verified**: the till's actual granted scope list was not checked (that would require a live Shopify Admin API call, forbidden by this task's hard rules); this is an inference from `orderCreate` already succeeding with the current token.

**Which fields to write, and where**: `trader_invoice_number`, `cu_invoice_number`, `fiscalised_at` - all as `metafields` in the existing `rubis_pos` namespace (`RUBIS_NAMESPACE`, `orders.ts:35`), each its own key (`trader_invoice_number`, `cu_invoice_number`, `fiscalised_at`), `type: 'single_line_text_field'` (matching `client_order_uuid`'s own metafield, `orders.ts:85-91`) - `fiscalised_at` as a plain ISO-8601 string, not Shopify's `date_time` metafield type, since nothing here needs Shopify-side date filtering and a plain string avoids a type-coercion failure mode.

**On also writing `customAttributes`** (the task's "recommend one or both, with the reason"): **recommend metafields only, for the initial build.** `docs/help.shopify.com`'s own documented distinction (attributes appear in Shopify's native order-export CSV; metafields do not) is a real trade-off for a merchant's back-office staff who only use Shopify's own export - but the overwrite-not-merge behaviour means a `customAttributes` write here would need to be built as a **separate, later, explicitly reviewable step** that first fetches the order's current attributes (an extra query, an extra failure mode, and a genuine risk of a lost-update race if this codebase or a Shopify staff member changes attributes between the fetch and the write) before resending the full list plus the three new fields. That extra complexity is exactly why Part B3 lists it as build 4, not folded into build 3.

**Values written**: `trader_invoice_number` can be attached at `orderCreate` time itself (B2.2, build 1 - no separate update needed for it at all, since it's knowable before the Shopify push). `cu_invoice_number`/`fiscalised_at` are the two values that genuinely need the follow-up queue lane in B2.3, since they don't exist until `submitInvoice` succeeds, which (B2.1) can be before or after the order even reaches Shopify.

---

## PART B3 - Proposed builds, in order

Each is separately reviewable and independently useful; none requires a later one to already exist. Builds 1-2 touch no fiscal command, no filed data, and no printed receipt. Build 3 touches `orders.ts`/what is sent to Shopify (flagged). Build 5 touches a fiscal command's *response parsing*, not what is sent or filed (flagged separately, lower risk). Nothing here proposes touching the printed customer receipt, `checkout.ts`'s fiscalization sequencing, or any `DailyReport`/daily-closure command - those stay exactly as `docs/KNOWN_GAPS.md` already records them (deferred pending a product/VIL decision).

1. **Thread `entity_id` (the local order id) into the Shopify push, and attach `trader_invoice_number` to `orderCreate`.**
   - Changes: `sync-engine.ts`'s `PushOrderFn` signature gains a second parameter (`localId: number`); `sync-engine.ts:89`'s call site passes `item.entity_id`; `index.ts:851`'s `pushOrder` wrapper forwards it; `orders.ts`'s `buildOrderInput` takes an extra `localId` (or a pre-built `traderInvoiceNumber` string, computed via the already-tested `traderSystemInvoiceNumber.ts` helper, keeping the format's only two implementations at exactly two, per phase-158-1's own decision) and adds one `customAttributes` entry and one `metafields` entry (namespace `rubis_pos`, key `trader_invoice_number`) alongside the existing `client_order_uuid` ones.
   - **Flag for explicit review**: this is the one build that changes `orders.ts`/what is sent to Shopify (the task's own hard rule for docs/phase-158-1 named this file as read-only "for step 10" - this build is exactly the follow-up that step's own question anticipated).
   - Tests: a new `sync-engine.test.ts` (or an addition to the existing one, if it exists) asserting `PushOrderFn` receives the queue item's `entity_id`; a `tests/orders.test.ts` addition asserting `buildOrderInput`'s `customAttributes`/`metafields` include the same `trader_invoice_number` value `buildTraderSystemInvNum` would independently compute for that `(localId, clientOrderUuid)` pair (same cross-check pattern phase-158-1's own CSV test already uses for `client_order_uuid`).
   - Tripwire tests touched: none of the fiscal suite, `mpesaPaymentGate`, keyboard, or Phase E layout tests reference `buildOrderInput`/`sync-engine.ts` - **Not verified**: a full-suite run was not performed as part of this audit (no code was written to run).

2. **Add `fiscal_vat_groups_json` and persist the device's per-VAT-group read-back (B1.2).**
   - Changes: one additive column (`database.ts`, `CREATE TABLE IF NOT EXISTS`/idempotent index-style migration matching this codebase's existing pattern); `FiscalSubmitOutcome`'s success `data` gains the five raw fields; `setOrderFiscalInfo` gains a fourth parameter and one more `UPDATE` column.
   - **Flag for explicit review**: this changes `real-etims-provider.ts` (adds a return value from an already-successful `ReadCurrentReceiptInfo` call - no new command, no new argument sent, purely capturing what Step 5 already reads) and `database.ts`'s `setOrderFiscalInfo` (the single writer for a successful fiscalization, shared by the immediate checkout path and a queued retry - `database.ts:1410-1413`'s own doc comment). No change to what is sent to the device or what gets filed with KRA; purely additive persistence of an existing, already-successful read.
   - Tests: a `reportsDatabase.test.ts`-style real in-memory SQLite test asserting the column round-trips; a `real-etims-provider.test.ts` addition asserting a successful `submitInvoice` call's returned `data` carries the five fields verbatim from a fake `ReadCurrentReceiptInfo` response.
   - Tripwire tests touched: the fiscal suite (`real-etims-provider.test.ts` and friends) would gain assertions, not have existing ones changed - any existing assertion on the exact shape of a successful `FiscalSubmitOutcome` would need updating to tolerate the new fields, which must be listed explicitly if it happens.

3. **A "Fiscal reconciliation" report reading the new column (build 2's consumer).**
   - Changes: a new `generateFiscalReconciliation(db, range)` in `reports.ts` (read-only, same shape as `generateFiscalStatusByDay`) comparing the till's own `computeVatIncluded(order.total, rate)` against the sum of that order's `fiscal_vat_groups_json`, flagging a mismatch beyond a small rounding tolerance; a new Reports sub-view or CSV column.
   - Depends on build 2 having data to read; otherwise every order shows "no device figure" rather than a false mismatch.
   - No fiscal command, filed data, or receipt touched - read-only reporting, same category as docs/phase-158/158-1.

4. **Queue and drain `cu_invoice_number`/`fiscalised_at` as Shopify `metafields` (B2.3), once an order is both synced and fiscalized.**
   - Changes: a third `sync_queue` `entity_type` (e.g. `'order_fiscal_update'`), enqueued from whichever of `markQueueItemSynced`/`setOrderFiscalInfo` runs second for a given order (both already know the order's `local_id`; a small check - "is the other half already true?" - decides whether to enqueue here); a new small engine mirroring `sync-engine.ts`/`fiscal-engine.ts`'s shape; a new `metafieldsSet`-style mutation (or `orderUpdate` with only `metafields` populated) in `shopify.ts`.
   - **Flag for explicit review**: this is a new Shopify **write** call this codebase has never made before (everything today is `orderCreate` only) - a `write_orders`-scoped `orderUpdate`/`metafieldsSet` mutation against a real order. Needs review specifically for the new mutation's shape and its idempotency under retry, even though the design in B2.3 argues it is safe.
   - Tests: an engine test mirroring `sync-engine.test.ts`'s existing shape (enqueue timing, retry/backoff, idempotent re-send); a `shopify.ts` unit test for the new mutation's request shape (mocked HTTP, no real Shopify call, matching every existing `shopify.ts` test's pattern).
   - Tripwire tests touched: none expected - this is new code, not a change to `checkout.ts`, `fiscal-retry.ts`, `mpesaPaymentGate`, or any existing schema column.

5. **(Optional, separate from 4) Also write `customAttributes`, fetching-then-resending the full list.**
   - Only worth doing if back-office staff actually rely on Shopify's native order-export CSV rather than this app's own CSV export (phase-158) - a product decision, not an engineering one.
   - **Flag for explicit review**: the read-before-write race B2.3 already names (a lost update if something else changes the order's attributes between the fetch and the write) needs an explicit, reviewed answer (e.g. "acceptable because nothing else ever writes to this order's attributes" - which is true today, per B2.2's finding that nothing else touches `customAttributes`, but that fact would need to keep being true).

6. **(Independent of 1-5) Decode `STE1 = 0x3b` explicitly in `checkDeviceResponse` (B1.5).**
   - Changes: one new named case in `checkDeviceResponse` (`real-etims-provider.ts:485-515`) for `ste1 === 59`, returning a cashier-facing reason that names "missing daily Z-report closure" rather than falling through to `STE2`'s unrelated table.
   - **Flag for explicit review, lower risk than builds 1/4/5**: this changes `real-etims-provider.ts`'s response-parsing logic (not a command sent, not filed data) - but it is the one build in this list that touches the fiscal suite's own tripwire tests directly (`checkDeviceResponse`'s existing Code-40/STE1/STE2 tests), so every changed assertion must be listed by name if this is ever built, per this project's own standing rule for fiscal-suite changes.
   - `docs/KNOWN_GAPS.md`'s own `VERIFY-ON-DEVICE` note already flags that the exact `STE2` accompanying a real `STE1 = 0x3b` has never been captured - this build should not guess at that; it can be written to fire on `STE1 = 59` alone, independent of whatever `STE2` happens to carry, which the current fallthrough already effectively ignores in favour of `STE2`'s value (B1.5).

**STOP. Do not implement.**
