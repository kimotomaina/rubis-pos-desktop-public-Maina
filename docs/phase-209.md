# Phase 209 — order 1: did it reach Shopify, can a void undo it, what is the smallest truthful correction (read-only audit)

- **Date:** 2026-10-03
- **Requested:** audit only, no change. (1) Did order 1 reach Shopify: sync row, `shopify_order_id`, stock at Rubis Kisumu? (2) Read `voidOrder` and `orders:void` end to end: does a void reverse the Shopify order or restore stock, and does it send anything to the device? (3) Propose the smallest correction that leaves order 1 truthful, as a decision.
- **Outcome:** (1) **Yes, it reached Shopify** as one order, on its second push attempt; **stock at Rubis Kisumu cannot be confirmed from here**, and the order carries no location, so Shopify chose where to decrement. (2) **A void cannot be done at all** (the channel always refuses, and order 1 is `synced`), and **it never reverses Shopify or restores stock, and sends nothing to the device.** (3) One decision, with a recommended one-row correction and a separate Shopify step.
- **Changes made:** none to code, config, fixtures or tests; no row was written. This document is the only file added.
- **Calls made to Shopify, the fiscal server or the device:** none. The database was read from the copy taken in phase 206 (re-read for the extra columns below), never the live file.
- **Branch / base commit:** staging @ `4c6561b`, tree clean (the phase 208 draft is in the stash, not in the tree).

## 1. Did order 1 reach Shopify?

**What the till recorded** (copy of `rubis-pos.db`):

| Field | Value |
| --- | --- |
| `status` | `synced` |
| `shopify_order_id` | `gid://shopify/Order/7801903054951` |
| `shopify_push_count` | **2** |
| `shopify_last_push_at` | 2026-10-02T21:39:28.396Z (the sale was created 21:37:08.330Z) |
| `sync_queue` | **no rows at all** |

- **The sync row:** none exists, and that is the expected end state. A success deletes the `order` row (`markQueueItemSynced`, [database.ts:2543-2558](../src/main/services/database.ts#L2543-L2558); the reconciliation link does the same), and `status = 'synced'` with a stored Shopify id is what remains. There is nothing left to look at in the queue.
- **Two pushes, one order (Inference).** `recordPushStarted` adds one *before* each push ([sync-engine.ts:166](../src/main/services/sync-engine.ts#L166)), so a count of 2 is two attempts, and the stored id is from the one that succeeded. The pre-push guard explains the 2m20s gap: for a sale already pushed once it **holds for 2 minutes** (`RECENT_PUSH_SKIP_MS`), then looks Shopify up by the sale's `sourceIdentifier` and pushes only if nothing is found; if one order is found it links instead of pushing ([reconciliation.ts:278-326](../src/main/services/reconciliation.ts#L278-L326)). The second push at 21:39:28, a little over two minutes after the first, fits "the first attempt failed or its reply was lost, the guard waited, found nothing, pushed". That points to **one** Shopify order. Two caveats, both **Not verified**: I did not look in Shopify, and the guard trusts Shopify's search, which the code itself says can lag.
- **What was sent** ([orders.ts:73-107](../src/main/services/orders.ts#L73-L107)): `orderCreate` with the one line (`variantId gid://shopify/ProductVariant/50346858741863`, quantity 1, product "test"), `financialStatus: PAID`, `sourceIdentifier` = the sale's UUID `c2770b2d-e10d-4ca7-9900-8b4e304600b3`, a note beginning "RUBIS POS offline sale — local UUID …", and `inventoryBehaviour: 'DECREMENT_OBEYING_POLICY'`.
- **Stock at Rubis Kisumu: Not verified, and the file evidence says do not assume it.** The order input carries **no location** ([phase 168](phase-168.md) finding 6: "`orderCreate` sends no location", and `OrderCreateOrderInput` has no location field apart from a B2B company location). With `DECREMENT_OBEYING_POLICY` Shopify decides which location's level to decrement; whether that was Rubis Kisumu is not stated anywhere in the project. The till's own copy of the product says `inventory_quantity = 0` for that variant, but the till never updates that cache after a sale (the code says so on purpose, [database.ts:2922-2930](../src/main/services/database.ts#L2922-L2930)), so it is the level from the last product refresh, not after the sale.
- **How to check, without me touching Shopify:** in Shopify admin, search Orders for `c2770b2d-e10d-4ca7-9900-8b4e304600b3` (or open order id 7801903054951) and confirm there is exactly one; then open the variant "test / Default Title" and read its inventory history per location. In the till, the Stock Take page reads the live level at the till's location. I did not use either: both need the Shopify token, which lives in the encrypted vault, and I do not read that.

## 2. `voidOrder` and `orders:void`, end to end

- **The channel always refuses.** `orders:void` is registered only so a stale renderer gets a plain answer: `{ success: false, error: 'Sales cannot be voided on this till. A filed sale needs a credit note.' }` ([index.ts:2571-2574](../src/main/index.ts#L2571-L2574), the message at [voids.ts:17-19](../src/main/services/voids.ts#L17-L19)), since phase 131. It does not call anything. The preload and the renderer have no void API at all (`grep` for `voidOrder` / `orders:void` finds nothing in `src/preload` or `src/renderer`).
- **The service behind it is dead code.** `voidLocalOrder` ([voids.ts:45-74](../src/main/services/voids.ts#L45-L74)) has **no caller in `src/`**. If it were called, it refuses a `synced` order outright ("already synced to Shopify and cannot be voided here — refunds for synced orders are not currently supported", [:49-55](../src/main/services/voids.ts#L49-L55)), so **order 1 could not be voided even then.**
- **What `db.voidOrder` does** ([database.ts:2940-2969](../src/main/services/database.ts#L2940-L2969)), for a `pending_sync` order only: set `status = 'voided'`; delete the sale's `order` and `etims_invoice` queue rows. In one transaction. Nothing else.
- **Does a void reverse the Shopify order or restore stock? No.** It never contacts Shopify; no cancel or refund mutation exists anywhere in `src/main`. And it deliberately does not touch `products.inventory_quantity` (the doc comment at [database.ts:2922-2930](../src/main/services/database.ts#L2922-L2930) explains why: for a `pending_sync` order Shopify was never decremented, so there is nothing to restore; for a `synced` one it is refused). A sale that has reached Shopify, like order 1, can only be undone in Shopify.
- **Does a void send anything to the device? No.** `voids.ts` and `voidOrder` make no network or device call, and the only credit-note capability, `cancelInvoice` ([real-etims-provider.ts:1317](../src/main/services/integrations/real-etims-provider.ts#L1317), built on `OpenCreditNoteWithFreeCustomerData`), **has no caller anywhere in `src/`** (`grep cancelInvoice`: definitions only). That confirms your phase 207 reading. The one place a void touches the fiscal side is by omission: `attemptFiscalRetry` refuses a `voided` sale ([fiscal-retry.ts:99-101](../src/main/services/fiscal-retry.ts#L99-L101)).

## 3. The smallest correction that leaves order 1 truthful (a decision)

**What is untrue today.** `fiscal_status = 'fiscalized'`, `fiscal_invoice_number = 0110605040000000000` (a zero counter, not a fiscal reference), an empty QR, `fiscal_fiscalized_at` 21:37:09 with source `local-fallback` (a till time, not the device's), and `fiscal_slip_unprinted_at` set (a "fiscal slip did not print" flag for a slip that should never exist). Reports count it as filed, the ETR-copy button treats it as filed, and the app can never correct it: the columns are write-once and a `fiscalized` sale is never retried ([phase 207](phase-207.md) §3). **What is true and stays:** `fiscal_cu_serial` (read from the device), `fiscal_trader_inv_num = INV-000000001` (it was sent to the device and refused), `fiscal_request_json`, and the `fiscal_duplicate_prints` row (history of a refused press).

**Recommended: one guarded row update on this till's database, done by hand with both app copies closed and the database backed up first** (the app cannot do it; a manual SQL write bypasses the write-once rule). I have not run it:

```sql
UPDATE orders SET
  fiscal_status = 'needs_fixing',
  fiscal_error_kind = 'system',
  fiscal_error_reason = 'The fiscal device refused this sale and it was never filed. It was recorded as filed in error and corrected by hand on 2026-10-03.',
  fiscal_invoice_number = NULL,
  fiscal_qr_code = NULL,
  fiscal_fiscalized_at = NULL,
  fiscal_fiscalized_at_source = NULL,
  fiscal_slip_unprinted_at = NULL
WHERE local_id = 1
  AND fiscal_invoice_number = '0110605040000000000';
```

The `AND` makes it a no-op if anything has changed. **After it:** the sale appears in Needs Attention as a system error, reports count it as not filed, and the ETR-copy button stops treating it as filed. **Consequence to accept:** a manual Resend from Needs Attention would send the sale to the device again; the device currently refuses `OpenInvoice` ([phase 206](phase-206.md)), but if that is ever fixed, the 1 KSh test sale would be filed for real. The app has no way to say "never file this one" (void is disabled), so the sale would sit in Needs Attention until someone decides.

**Alternatives:**
- **Do nothing in the database,** only record the truth in this document. Cheapest, but every report keeps counting it as filed and the stored number stays a zero string.
- **Build an admin "mark as not filed" path** in the app. A new feature with its own audit trail; larger than this problem warrants today.

**Separately, the Shopify side is not touched by any of the above.** The order is in Shopify (section 1) and decremented some location's stock. The app cannot cancel or refund it. If that matters for a 1 KSh test, cancel it and restock in Shopify admin by hand, after the check in section 1 tells you where the stock went. If it does not matter, leave it.

## 4. Verification

- Files read: `orders.ts`, `sync-engine.ts`, `reconciliation.ts` (`guardPush`), `voids.ts`, `database.ts` (`voidOrder`, `markQueueItemSynced`, the order schema), `index.ts` (`orders:void`, `orders:retrySync`), `fiscal-retry.ts`, `real-etims-provider.ts` (`cancelInvoice`), phases 131 (via code comments), 168, 206, 207.
- Database: the copy from phase 206, read with `sqlite3`: the order's Shopify columns, the empty `sync_queue`, the order payload, the cached product row. Nothing was written.
- `grep` over `src/` for `voidOrder`, `voidLocalOrder`, `orders:void`, `cancelInvoice`, `creditNote`, `UPDATE products`.
- **Not run:** any Shopify call, the Stock Take page, the vault, any device or fiscal-server call, the SQL above.
- **Not verified:** how many Shopify orders exist for the sale's UUID; which location's stock the order decremented; whether the first push attempt reached Shopify.

## 5. Decisions needed

1. **Correct order 1 in the database?** The recommended update above, or leave it and only document it. If yes: who runs it and when (both app copies closed, backup first), and the reason text.
2. **Order 1 and the device.** After the correction, should a manual Resend stay possible (it would file a 1 KSh test sale for real if the device ever accepts it), or should it be left in Needs Attention and never resent?
3. **The Shopify order.** Check it first (section 1), then cancel and restock by hand, or leave it as a test?
4. **Void.** Phase 131 disabled it and `voidLocalOrder` has no caller. Leave the dead service as it is, or remove it later so nobody assumes a void exists?

## 6. Rollback

Nothing to roll back: no code, config, fixture, test or row changed, and nothing was sent to Shopify, the fiscal server or the device.
