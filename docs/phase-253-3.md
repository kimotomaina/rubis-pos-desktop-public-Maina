# Phase 253-3 — The discount against the real Shopify store, and one test order

- **Date:** 2026-10-07, about 01:20 Nairobi
- **Asked by the owner:** the 01:25 file. Read the real discount with the 253-1 sync, price the bread with it, then send exactly one test order.
- **Owner's change during the run:** the test order uses **Rubis Kisumu only**, never Enjoy Haile Selassie.
- **Status:** every check passed. One test order exists in Shopify, **#1333**, for the owner to cancel and restock. No code changed. Nothing released.
- **Standing rules kept:**
  - nothing was sent to the fiscal device, the ZFP Lab Server or Safaricom;
  - the app was not launched;
  - no `check:fit`;
  - the token was loaded into the process only, never printed or written, and every output was checked for it.
- **Shopify calls, all to `admin/api/2026-07`:**
  - read-only: the scopes, the discounts (the sync, and two side-by-side reads), the products and stock (the sync), and the order read back;
  - **exactly one `orderCreate`**.
- The scripts were session-only and are deleted. A marker file stopped any second send.

## Results

| Step | Check | Result |
| --- | --- | --- |
| 0 | State | Tree clean; `78b8d20` (253-2) and `5ba8bd2` (253-1) on top. 2.2.10 still built: Setup SHA-256 `d2e9b5d5…766324` unchanged. Still unpublished: the feed's latest is `v2.2.9`, and `v2.2.10` returns 404 |
| 1 | `read_discounts` | **Present.** The token file is dated 2026-10-03 and now carries the scope, so the **same token** gained it and did not change. Fingerprint `d77b21` (first 6 hex of its SHA-256) |
| 2 | The real sync, into a temp copy of the 1606 copy (Enjoy Haile Selassie) | 727 products refreshed. **One discount in scope**, as below. Skipped: `CODE_DISCOUNT_BLACKFRIDAY` and `FREESHIPPING2026` ("discount code: not applied by the till"). The old "Probakery Bread 2 @99/=" is `EXPIRED` (ended 2026-10-06T21:30:59Z), so it is left out. Query cost 31 points. The 1606 copy was unchanged by SHA-256 |
| 3 | Pricing with that copy, the real `runCheckout`, the device faked | 1 → 65 (1 × 65); 2 → 99 (1 × 65, 1 × 34); 3 → 164 (2 × 65, 1 × 34); 4 → 198 (2 × 65, 2 × 34). **All exactly as expected** |
| 4 | One `orderCreate`, 3 loaves at Rubis Kisumu | **Accepted as #1333.** Two lines of the same variant: 2 × 65.0 and 1 × 34.0. Subtotal and total **164.0 KES**. `PAID`, `FULFILLED`. Kisumu stock 66 → **63**; Haile Selassie 62 → 62; HQ 0 → 0 |

### The discount: Shopify against the till

| Field | Shopify (`discountNode`) | Till stored |
| --- | --- | --- |
| Kind, status | `DiscountAutomaticBxgy`, `ACTIVE`; summary "Buy 1 item, get 1 item at KES31.00 off each" | accepted |
| Title | "Pro-bakery Bread 2 @99/=" (with a hyphen) | the same |
| Buys | `DiscountQuantity` "1"; `DiscountProducts` PB WHITE BREAD 400G (`…/10235718041703`) | `buysQuantity` 1; `productIds` ["10235718041703"] |
| Gets | `DiscountOnQuantity` 1; `DiscountAmount` "31.0" KES, `appliesOnEachItem: true`; the same product | `getsQuantity` 1; `{ type: amount, amount: 31 }` |
| Limit per order | `usesPerOrderLimit: null` | `null` |
| Customers, purchase | `DiscountBuyerSelectionAll`; one-time purchase on both sides | accepted |
| Dates | starts 2026-10-06T21:31:23Z (00:31 Nairobi), no end | the same |

### The 3-loaf receipt (Step 3, from the stored sale)

At 48 columns:
```
PB WHITE BREAD 400G
2 x 65.00 130.00 A
PB WHITE BREAD 400G
1 x 34.00 34.00 A
Pro-bakery Bread 2 @99/= saved 31.00
TOTAL KSH         164.00
```
At 32 columns, the same, except that the title takes its own line and `saved 31.00` goes on the next. TOTAL EXCL. VAT is 141.38 and VAT is 22.62, both class A.

### The order sent (Step 4)

It went through the till's own `pushOrderToShopify` and `buildOrderInput`. A one-call wrapper added only the `TEST-253` tag and the note prefix.

- `lineItems`:
  - `{ variantId …/50363428241511, quantity 2, priceSet { shopMoney { amount "65.00", currencyCode KES } } }`
  - `{ variantId …/50363428241511, quantity 1, priceSet { shopMoney { amount "34.00", currencyCode KES } } }`
- `financialStatus` PAID, `fulfillmentStatus` FULFILLED, `fulfillment.locationId` `gid://shopify/Location/77557989479` (Rubis Kisumu).
- `tags` `["location:rubis-kisumu", "TEST-253"]`.
- `options`: `inventoryBehaviour DECREMENT_OBEYING_POLICY`, no receipts sent.
- **Note, as read back:** "TEST ORDER 253-3, not a sale. RUBIS POS offline sale — local UUID f67bc708-41aa-4914-8f27-291260337adb (taken 2026-10-06T22:20:23.606Z) — cashier Test 253-3 — payment: cash (tendered 200.00, change 36.00) — discounts: Pro-bakery Bread 2 @99/= -31.00".

**Stock:** every till order is sent with `inventoryBehaviour: DECREMENT_OBEYING_POLICY` and fulfilled from the sale's location, so this order took 3 loaves off Rubis Kisumu.

**D4 holds:** Shopify kept the two lines apart and kept both prices. `originalUnitPriceSet` and `discountedUnitPriceSet` are 65.0 and 34.0 on their lines. No automatic discount was applied on top.

## For the owner

- **Cancel #1333** in the Shopify admin and restock the 3 loaves at Rubis Kisumu. It is tagged `TEST-253`.
- The title in Shopify is "Pro-bakery Bread 2 @99/=", so that is what receipts will print.

## Observed

- The phase-170 "other tills" figure counts every order in the store over recent days, so it counts #1333 until it is cancelled. The figure is for information only; it raises no alarm.
- The store has two old code discounts (`CODE_DISCOUNT_BLACKFRIDAY` scheduled, `FREESHIPPING2026` active). The till lists them as skipped on every sync.

## Not verified

- The Kisumu till's own copy and its token: only the token in `.env.secrets.local` was fingerprinted.
- How Shopify's own reports show a line sold at 34.00. There is no separate discount figure, by design of option (b).
