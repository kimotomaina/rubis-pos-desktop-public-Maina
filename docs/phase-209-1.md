# Phase 209-1 — order 1: the Shopify reads, the cancel proposal, and the database correction (not yet run)

- **Date:** 2026-10-03
- **Follows:** [phase-209.md](phase-209.md) (left as written).
- **Branch / base:** staging on `aa56d68` (phase 208-1).
- **Status:** **not committed.** Items 2, 3 and 4 are done. **Item 1 (the database correction) has not been run**, because both app copies are open and the ruling says "both app copies closed and confirmed closed". Nothing was sent to Shopify that changes anything. No device or fiscal-server call was made.

## 1. The database correction: blocked, and why

`Get-Process` at the time of writing shows both copies running against the same user-data folder `C:\Users\paulc\AppData\Roaming\rubis-pos-desktop`:

| Copy | Processes | Started |
| --- | --- | --- |
| Installed `RUBIS POS.exe` | 6076, 43700, 50348, 59468 | 2026-10-02 22:36 |
| Dev (`electron-vite dev`, node 7596; electron 17468, 18392, 35848, 37284) | | 2026-10-02 22:40 |

I did not stop them: they are yours, and a dev server in a terminal is not mine to kill. The WAL file was last written at 00:39 on 3 Oct. When both are closed I will: confirm with `Get-Process`; copy `rubis-pos.db`, `-wal`, `-shm` to dated backups beside the originals and record the path here; run the ruled statement (the phase 209 SQL, reason text `Test sale. The fiscal device refused it and it was never filed. Recorded as filed in error; corrected by hand on 2026-10-03. Do not resend.`); confirm `changes() = 1`; re-read the row and quote it.

## 2. Resend (ruling 2): recorded

Never resend. The reason text says so. Needs Attention will still offer the button on this dev PC; accepted.

## 3. The three Shopify reads

**Method.** The app's own `createShopifyClient` (`shopify.ts:304`) and its own `FIND_BY_SOURCE_IDENTIFIER_QUERY` (`shopify-reconcile.ts:93`), bundled by esbuild into a scratch script in the session scratchpad and run under Electron. The token was decrypted in memory with `safeStorage` from a **copy** of `secret-vault.json` and `Local State` (the live profile folder was not opened by the script) and never printed; the saved output was searched for token patterns and has none. Store: `https://rubisenergykenyaplc.myshopify.com/` (the app's `shopify_store_url` setting).

**Read 1: orders with `sourceIdentifier` `c2770b2d-e10d-4ca7-9900-8b4e304600b3`: exactly one.**
`gid://shopify/Order/7801903054951`, name **#1087**, `createdAt` 2026-10-02T21:39:28Z, `cancelledAt` null. So the second push attempt was the only one that created an order.

**Read 2: that order.** `displayFinancialStatus` PAID, `displayFulfillmentStatus` **UNFULFILLED**, `fulfillments` **[]**, `tags` **[]**, total 1.0 KES, `test` false, one line "test" quantity 1 on `gid://shopify/ProductVariant/50346858741863`.
- **Fulfillment location: none exists** (no fulfillment). The location a fulfillment *order* is assigned to could not be read: my first query asked for `fulfillmentOrders` and Shopify answered `ACCESS_DENIED: Access denied for fulfillmentOrders field.` The token's scopes (handles only, read from `currentAppInstallation`): `write_product_listings, read_product_listings, write_products, read_products, write_inventory, read_inventory, write_orders, read_orders, read_locations, read_all_orders`. **No fulfillment-order scope.** I re-ran the read without that field.

**Read 3: the variant's stock by location.** The Admin API offers **no list of inventory history**. Introspection of `InventoryItem`, `InventoryLevel` and the query root shows only `inventoryHistoryUrl` (a link to the admin page), not a history connection. What can be read is each location's current quantities with `updatedAt`:

| Location | available | committed | on_hand | quantities updated |
| --- | --- | --- | --- | --- |
| **Enjoy Haile Selassie** | 0 | **3** | 3 | available and committed **2026-10-02T21:39:29Z**; on_hand 2026-09-29T11:24:25Z |
| HQ, Hurlingham, Rubis Enjoy Karen, **Rubis Kisumu**, Rubis Kitengela, Westlands | 0 | 0 | 0 | available 2026-09-29T11:24:24Z; committed and on_hand never |

**Finding: the decrement for this order went to Enjoy Haile Selassie, not to Rubis Kisumu.** Haile Selassie's committed and available were touched at 21:39:29Z, one second after the order was created at 21:39:28Z. Rubis Kisumu has not changed since 2026-09-29. The variant's `inventoryPolicy` is **DENY**.
- **Inference:** Shopify chose the one location that held on-hand stock of this variant (Haile Selassie held 3, every other location 0).
- **Not verified:** which two other orders account for the other two committed units there (the owner says the 16:00 orders are the other till's).
- **Not shown by this read:** a time-ordered history. The admin page is `https://rubisenergykenyaplc.myshopify.com/admin/products/inventory/52465584013415/inventory_history`; opening it in the admin gives the per-location history since 21:00Z. I also probed `Product.events` since 21:00Z and got an empty list, but Shopify's reply shows it mis-parsed my time filter (`Invalid search field for this query`, field `00`), so **that empty list is not evidence**.

**Reads beyond the three, all read-only, disclosed:** the first, denied attempt at read 2; the introspection; the product-events probe; the variant's policy and history link; the token's scope handles.

## 4. `orderCancel` for 2026-07, and the proposed call (not sent)

Source: shopify.dev, `mutations/orderCancel` and its input types, version 2026-07, read 2026-10-03 **through the fetch tool, which summarises each page with a small model; the quotes below are from that output and I did not read the raw page.** Required scope: `write_orders` (the token has it).

Arguments: `orderId: ID!` ("The ID of the order to be canceled."), `reason: OrderCancelReason!` (values `CUSTOMER, DECLINED, FRAUD, INVENTORY, OTHER, STAFF`), `restock: Boolean!` ("Whether to restock the inventory committed to the order."), optional `notifyCustomer` (default false), `refundMethod: OrderCancelRefundMethodInput` ("Indicates how to refund the amount paid by the customer."; fields `originalPaymentMethodsRefund: Boolean`, `storeCreditRefund`), optional `staffNote` (max 255), `refund` (deprecated). Payload: `job { id done }`, `orderCancelUserErrors`. "Cancellation occurs asynchronously via a job." "Order cancellation is irreversible." The page does **not** say what `originalPaymentMethodsRefund` does for a cash or manual payment, nor what happens if `refundMethod` is omitted.

**Proposed call:**

```graphql
mutation {
  orderCancel(
    orderId: "gid://shopify/Order/7801903054951"
    reason: OTHER
    restock: true
    notifyCustomer: false
    refundMethod: { originalPaymentMethodsRefund: true }
    staffNote: "Test sale, 1.00 KSh cash, never filed on the fiscal device. Cancelled 2026-10-03."
  ) {
    job { id done }
    orderCancelUserErrors { field message code }
  }
}
```

Expected effect (**Inference**): the order is cancelled, and the 1 committed unit at Enjoy Haile Selassie is released, giving that location `committed 2`, `available 1`. **Not verified:** whether the refund part works for an order created `PAID` with no transaction (the app sends none); if Shopify refuses it, the mutation is expected to return a user error and cancel nothing, and the fallback is the same call without `refundMethod`, which cancels and restocks but records no refund. After it, I would read back the order (`cancelledAt`, `displayFinancialStatus`) and the variant's levels at Haile Selassie.

**This changes a stock figure and cannot be undone. It is not sent. It needs your written go.**

## 5. `voidLocalOrder` (ruling 4)

One line added to `docs/KNOWN_GAPS.md`: `voidLocalOrder` has no caller since phase 131; remove in a later cleanup.

## 6. Files in this phase

`docs/phase-209-1.md`, `docs/KNOWN_GAPS.md`. No source or test change. Scratch scripts and the copies of the vault and database stay in the session scratchpad.

## 7. Decisions needed

1. Close both app copies (or tell me to stop the processes), so the correction can run.
2. A written go, or not, for the `orderCancel` above, and whether to keep `refundMethod`.
