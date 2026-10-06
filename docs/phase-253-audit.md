# Phase 253 — Shopify automatic discounts on the till, and a Sync button (read-only audit)

- **Date:** 2026-10-06, after the 23:45 file
- **Asked by the owner:**
  - discounts made in Shopify apply on the till by themselves, the first being "Probakery Bread 2 @99/=";
  - a Sync button in the top bar;
  - a sync at every start and every login.
  - Audit first, then stop.
- **Status:** audit only. No code changed.
  - Nothing was sent to the device, the ZFP Lab Server or Safaricom.
  - The app was not started, and nothing was done on a till.
  - Shopify: only the read-only queries quoted in §1.5. There were no mutations and no orders, and the token was never printed.
  - Product facts come from Shopify and from a temporary copy of the 1606 database copy. The scratchpad copy checked unchanged by SHA-256 afterwards.
- **Base:** `main` at `fd08431`.

## Part 1. How things work today

### 1.1 The catalogue sync

**What is pulled.** `products:fetch` → `fetchAllProducts` ([shopify.ts:633-712](../src/main/services/shopify.ts#L633-L712)), API **2026-07** ([shopify.ts:19](../src/main/services/shopify.ts#L19)):
- active products: title, handle, image, the `rubis` metafields `vat_class`, `hs_code` and `hs_name`;
- each product's variants (up to 250): id, title, `availableForSale`, barcode, image and `price` (`PRODUCT_LIST_QUERY`, [shopify.ts:27-70](../src/main/services/shopify.ts#L27-L70));
- the stock: the "available" quantity at this till's location (`INVENTORY_LEVELS_QUERY`, [shopify.ts:91-114](../src/main/services/shopify.ts#L91-L114)). A variant not stocked at the location is dropped ([shopify.ts:677-699](../src/main/services/shopify.ts#L677-L699)).

**Not pulled:** collections, compare-at prices and discounts. Staff are not pulled either: they are local, and `auth.ts` only imports a Shopify type ([auth.ts:12](../src/main/services/auth.ts#L12)).

**When it runs.** There is no timer, and nothing runs at login.
- Once when the app opens ([App.tsx:534-536](../src/renderer/src/App.tsx#L534-L536)). That hook sits above the login screen's early return ([App.tsx:656-663](../src/renderer/src/App.tsx#L656-L663)), so it runs before anyone logs in, and `App` is not mounted again at a later login.
- From "Try again", shown only when the catalogue failed and there is no cache ([App.tsx:833-848](../src/renderer/src/App.tsx#L833-L848)).
- After a location is saved ([AdminScreen.tsx:609](../src/renderer/src/components/AdminScreen.tsx#L609), [LocationConfirmScreen.tsx:97](../src/renderer/src/components/LocationConfirmScreen.tsx#L97)).
- From the stock take, when the catalogue is empty ([StockTakePage.tsx:122](../src/renderer/src/pages/StockTakePage.tsx#L122)).
- The 30-second timer ([index.ts:1082](../src/main/index.ts#L1082), [sync-engine.ts:1-14](../src/main/services/sync-engine.ts#L1-L14)) only **pushes** orders. It never reads the catalogue.

**Where it is stored.**
- The `products` table ([database.ts:1225-1237](../src/main/services/database.ts#L1225-L1237)), one row per variant.
- `cacheProducts` deletes all rows and inserts the new ones in **one transaction** ([database.ts:2341-2367](../src/main/services/database.ts#L2341-L2367)).
- It runs only when the fetch succeeded with at least one product ([index.ts:1360-1366](../src/main/index.ts#L1360-L1366)).

**Offline or on an error.**
- Each request has a 10-second timeout ([shopify.ts:320-327](../src/main/services/shopify.ts#L320-L327)), and the error is logged ([index.ts:1356-1358](../src/main/index.ts#L1356-L1358)).
- The screen then falls back to the SQLite copy with the badge "Cached catalog (offline)" ([productStore.ts:53-63](../src/renderer/src/stores/productStore.ts#L53-L63), [App.tsx:850-854](../src/renderer/src/App.tsx#L850-L854)).
- With no copy, it shows the error and "Try again".
- No time of the last good sync is kept anywhere.

**Phase 197, restoring a cart:**
- `restoreCartDraft` rebuilds each saved line from the **current** catalogue at today's price ([cartDraft.ts:113-154](../src/renderer/src/lib/cartDraft.ts#L113-L154));
- it drops lines no longer in the catalogue and removes any price override or discount ("approved against the old price");
- it runs once the catalogue is ready and someone is signed in ([App.tsx:388-418](../src/renderer/src/App.tsx#L388-L418)).
- A **held** sale is never repriced: `resumeHeldSale` puts it back exactly as held ([cartStore.ts:325-334](../src/renderer/src/stores/cartStore.ts#L325-L334)).

### 1.2 The till's own discounts

**In the store** ([cartStore.ts:284-307](../src/renderer/src/stores/cartStore.ts#L284-L307)):
- `setItemPrice`, a price override checked against `basePrice` ([checkoutMath.ts:211-228](../src/renderer/src/lib/checkoutMath.ts#L211-L228));
- `setItemDiscount`, a line discount;
- `setCartDiscount`, a cart discount.

Totals: line discounts first, then the cart discount, never below 0 ([checkoutMath.ts:102-141](../src/renderer/src/lib/checkoutMath.ts#L102-L141)).

**On screen, only the cart discount has a control:**
- the "+ Discount" button ([PosCheckoutPanel.tsx:338-348](../src/renderer/src/components/PosCheckoutPanel.tsx#L338-L348));
- the line discount and price override lost their screen when `CartLineItem.tsx` was deleted (`28dfe67`, phase 197-1).

**Hidden on a live till (phase 161).**
- The control shows only when the fiscal mode is neither live nor unknown ([PosCheckoutPanel.tsx:96-98](../src/renderer/src/components/PosCheckoutPanel.tsx#L96-L98)). This fails closed, per phase 161-1.
- A cart that already carries a discount or override cannot be paid ([PosCheckoutPanel.tsx:194-198](../src/renderer/src/components/PosCheckoutPanel.tsx#L194-L198)).

**Refused by the main process (phase 161-1):** `orders:checkout` refuses any line or cart discount when the provider is the real one, before anything is written or paid. The message is "Discounts cannot be filed with KRA yet. Remove the discount and try again." ([index.ts:1424-1434](../src/main/index.ts#L1424-L1434)).

**The recorded reason:**
- [requestHasDiscount.ts:4-7](../src/main/lib/requestHasDiscount.ts#L4-L7): "docs/phase-160 found the fiscal device is never told about a discount at all (it only ever receives `item.price × quantity`), so filing one today would file the wrong amount with KRA."
- Phase 161 records the notice shown: "This sale has a discount or price override that cannot yet be filed correctly with KRA. Remove it from the cart before completing this sale." ([phase-161.md:76-78](phase-161.md)).
- Phase 248 lists the same refusal as rule 7 ([phase-248-audit.md:154](phase-248-audit.md)).

### 1.3 How a discounted line reaches the fiscal device

**From the code:**
- `buildFiscalRequest` sends each line as `unitPrice: item.price` (the cart price) with `quantity` ([checkout.ts:756-776](../src/main/services/checkout.ts#L756-L776)). It never reads `item.discount` or `cartDiscount`, and never sets `discAddP`.
- The provider sends `Price = formatPrice(unitPrice)` and `Quantity`, and there is no amount argument ([real-etims-provider.ts:1781-1819](../src/main/services/integrations/real-etims-provider.ts#L1781-L1819)).
- `DiscAddP` would be passed through if a line carried it ([real-etims-provider.ts:1964-1967](../src/main/services/integrations/real-etims-provider.ts#L1964-L1967), [etims.ts:40](../src/main/services/integrations/etims.ts#L40)), but nothing sets it.
- Before closing, the device's VAT-group subtotal is read. A receipt whose subtotal is **≤ 0 is cancelled** ([real-etims-provider.ts:1163-1178](../src/main/services/integrations/real-etims-provider.ts#L1163-L1178)).

**From the Tremol protocol PDF** (`Rubis Etims API Files/ZFP_SDK_KE_2509041522_ControlUnit/protocol_description_KE_CU_2509041522.pdf`, text extracted with pypdf on 2026-10-06):
- **31h, "Sell of article" and "Sell of article with defined HS code" (p. 26).** The input ends `{<'*'> <Quantity[1..10]>} {<','> <DiscAddP[1..7]>}`, with "DiscAddP (Discount/Addition %.) 1 to 7 for percentage of discount/addition". That is a **percentage only**, with no value argument. Unlike 33h, the text gives no sign rule for telling a discount from an addition.
- **2Ch, open-sell-close receipt and invoice (pp. 26-28).** The same `DiscAddP`, percentage only.
- **33h, "Subtotal" (p. 29).** It takes `DiscAddV` ("Up to 13 symbols for the value of the discount/addition. Use minus sign '-' for discount") and `DiscAddP` (a percentage). Its notes say: "When the discount/addition is a percentage the amount is distributed proportionally over the turnover items and is automatically transferred to the turnovers of the corresponding VAT groups." and "A value discount/addition may be specified only if all sales are of articles (items) belonging to one and the same VAT group."
  - Phase 160 could not find this second sentence ([phase-160.md:133](phase-160.md)). It is now **verified** on p. 29.

**Phase 183's line, "No payment or discount command exists" ([phase-183.md:90](phase-183.md)), is confirmed as a statement about what the app sends.** The provider sends no discount argument and never sends `Subtotal`. The **protocol** does have discount arguments (31h and 2Ch `DiscAddP`, 33h `DiscAddV`/`DiscAddP`), and the provider already carries `DiscAddP` through unused.

### 1.4 How a discount reaches Shopify

**What `orderCreate` sends today:**
- `buildOrderInput` sends each line as `{ variantId, quantity }` only, with **no price** ([orders.ts:134-137](../src/main/services/orders.ts#L134-L137)).
- Shopify prices each line at the variant's own price, so a discount or price override on the till never reaches Shopify (phase 160).

**What shopify.dev says, API 2026-07, checked 2026-10-06.** Every field text below was also read from the dev store's own schema (introspection, §1.5), which carries the same descriptions.
- [OrderCreateLineItemInput](https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/OrderCreateLineItemInput) `priceSet`: "The price of the item before discounts have been applied in the shop currency." **Confirmed.**
  - The input has **no per-line discount field**. Its fields are: `fulfillmentService`, `giftCard`, `priceSet`, `productId`, `properties`, `quantity`, `requiresShipping`, `sku`, `taxLines`, `taxable`, `title`, `variantId`, `variantTitle`, `vendor`, `weight`.
- `OrderCreateDiscountCodeInput`: "The input fields for a discount code to apply to an order. Only one type of discount can be applied to an order." **Confirmed.**
  - Its fields are `itemPercentageDiscountCode`, `itemFixedDiscountCode` ("A fixed amount discount code applied to the line items on the order") and `freeShippingDiscountCode`.
  - The fixed one takes `code` and `amountSet` ("The amount that's deducted from the order total").
- **Automatic discounts on `orderCreate`: documented.** This corrects the owner's "not documented". The [orderCreate page](https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/orderCreate) says:
  - "Automatic discounts won't be applied unless you replicate the logic of those discounts in your custom implementation."
  - "You can apply a discount code, but only one discount code can be set for each order."
  - "The `orderCreate` mutation doesn't support applying multiple discounts, such as discounts on line items."
  - The same page: "If you're using the `orderCreate` mutation with a trial or development store, then you can create a maximum of five new orders per minute."

### 1.5 Reading discounts from Shopify: the read-only queries

Seven calls were made: Q1, Q2, Q4, and four introspection calls under Q3. All were POSTs to `https://rubisenergykenyaplc.myshopify.com/admin/api/2026-07/graphql.json`, with the token loaded into the process only and never printed. The helper refuses any body containing the word "mutation". Ids are shortened.

**Q1, the token's scopes.**
- Query: `query Scopes { currentAppInstallation { accessScopes { handle } } }`
- Result: `write_product_listings`, `read_product_listings`, `write_products`, `read_products`, `write_inventory`, `read_inventory`, `write_orders`, `read_orders`, `read_locations`, `read_all_orders`.
- **`read_discounts` is not there.**

**Q2, reading the discounts.**
- Query: `discountNodes(first: 10, query: "status:active") { nodes { id discount { __typename ... on DiscountAutomaticBasic { title status startsAt endsAt summary discountClasses combinesWith {…} context {…} minimumRequirement {…} customerGets {…} } } } }`
- Result: `"Access denied for discountNodes field. Required access: Apps must have `read_discounts` access scope."` (`ACCESS_DENIED`), with `data: null`.
- **The bread discount's real values could not be read.**

**Q3, introspection of the types** (`__type`, `__schema`; reading the schema needs no scope). Only names seen in these replies are used below.

| Need | Field, as named in the 2026-07 schema |
| --- | --- |
| The query | `discountNodes(first, after, last, before, reverse, sortKey, query, savedSearchId)`; also `discountNode(id)`. **`automaticDiscountNodes` is not on `QueryRoot` at all in 2026-07** (removed, not only deprecated) |
| Discount kinds (`Discount` union) | `DiscountAutomaticBasic` (amount off), `DiscountAutomaticBxgy`, `DiscountAutomaticFreeShipping`, `DiscountAutomaticApp`, and the four `DiscountCode*` |
| Common fields of `DiscountAutomaticBasic` | `title`, `status` (`ACTIVE`, `EXPIRED`, `SCHEDULED`), `startsAt`, `endsAt` (null when there is no end), `discountClasses` (`PRODUCT`, `ORDER`, `SHIPPING`), `combinesWith` (`productDiscounts`, `orderDiscounts`, `shippingDiscounts`, `productDiscountsWithTagsOnSameCartLine`), `tags`, `summary`, `shortSummary`, `createdAt`, `updatedAt`, `asyncUsageCount`, `recurringCycleLimit` |
| Value | `customerGets.value` is `DiscountAmount` (`amount { amount currencyCode }`, `appliesOnEachItem`), `DiscountPercentage` (`percentage`), or `DiscountOnQuantity` |
| Each item, or once per order | `DiscountAmount.appliesOnEachItem`: "If true, then the discount is applied to each of the entitled items. If false, then the amount is split across all of the entitled items." |
| Products and collections | `customerGets.items` is `DiscountProducts` (`products`, `productVariants`), `DiscountCollections` (`collections`) or `AllDiscountItems` |
| Minimum | `minimumRequirement` is `DiscountMinimumQuantity` (`greaterThanOrEqualToQuantity`; "This threshold applies to qualifying items in the customer's cart") or `DiscountMinimumSubtotal` (`greaterThanOrEqualToSubtotal`) |
| Customers | `context` is `DiscountBuyerSelectionAll` (`all`), `DiscountCustomers`, `DiscountCustomerSegments` or `DiscountMarkets` |
| One-time purchase | `customerGets.appliesOnOneTimePurchase`, `appliesOnSubscription` |
| **POS or channel** | **None.** No field named for POS, channel, sales channel or publication exists on any of the 3,552 types' discount fields, nor on `DiscountAutomaticBasicInput`. The only matches were `allocationMethod`, a false hit on "location". The "Apply on POS Pro locations" box is **not in the Admin API** |

Other descriptions from the same reply:
- `productDiscountsWithTagsOnSameCartLine`: "By default, only one product discount applies per line."
- `DiscountAutomaticBasic`: "API versions prior to `2025-10` only return automatic discounts with `context` set to `all`."

**Q4, the bread product.**
- Query: `productVariants(first: 5, query: "barcode:6161300140187") { nodes { id title price barcode product { id title status vatClass: metafield(namespace: "rubis", key: "vat_class") { value } hsCode: metafield(namespace: "rubis", key: "hs_code") { value } } } }`
- Result: variant `…/50363428241511`, price **"65.00"**, product `…/10235718041703` "PB WHITE BREAD 400G", `ACTIVE`, with `vatClass` null and `hsCode` null.

### 1.6 Every reader of a line's price

| Reader | What it reads | File |
| --- | --- | --- |
| The cart total | `item.price`, then line and cart discounts | [checkoutMath.ts:102-141](../src/renderer/src/lib/checkoutMath.ts#L102-L141) |
| The stored sale | `payload_json.lineItems[]`: `unitPrice = item.price`, `discount`, plus `cartDiscount` and `total` (no line table) | [database.ts:2446-2470](../src/main/services/database.ts#L2446-L2470) |
| The fiscal request (stored as `fiscal_request_json`) | `unitPrice = item.price`, `quantity` | [checkout.ts:745-784](../src/main/services/checkout.ts#L745-L784) |
| Standard receipt | the line's `unitPrice × quantity`, then "Discount: -x" under a discounted line; totals from the stored `total` | [receiptLayout.ts:334-339](../src/main/lib/receiptLayout.ts#L334-L339), [receiptLayout.ts:476-494](../src/main/lib/receiptLayout.ts#L476-L494), [receiptTotals.ts:93-136](../src/main/lib/receiptTotals.ts#L93-L136); the print handler [index.ts:3217-3229](../src/main/index.ts#L3217-L3229); `printer.ts:419`, `989`; `pdf-receipt.ts:99` |
| Enjoy slip | net per line; a cart reduction worked out as the lines less `total` | [enjoySlip.ts:122-133](../src/main/lib/enjoySlip.ts#L122-L133) |
| Z report and Sales Summary | `orders.total`; VAT by class from the **fiscal request's** lines | [reports.ts:286-312](../src/main/services/reports.ts#L286-L312), `388`, `604`, `1331` |
| Fiscal reconciliation | device total against `orders.total`: **"mismatch" beyond 0.01** | [reports.ts:1587-1640](../src/main/services/reports.ts#L1587-L1640) |
| VAT reconcile | the stored lines and discounts | [vat-reconcile.ts:62-68](../src/main/services/vat-reconcile.ts#L62-L68) |
| CSV export | `unitPrice`, plus a "Line discount" column | [reportsExport.ts:173-189](../src/main/services/reportsExport.ts#L173-L189) |
| Shopify order | none: variant and quantity only | [orders.ts:134-137](../src/main/services/orders.ts#L134-L137) |
| Shift figures | order totals and payments, not lines | `shiftFigures.ts` |
| Held sales | the cart's lines, discounts and total, exactly as held | [held-sales.ts:97-107](../src/main/services/held-sales.ts#L97-L107) |
| Cart draft (197) | lines; repriced on restore | [cartDraft.ts:124-154](../src/renderer/src/lib/cartDraft.ts#L124-L154) |
| Split payments (252) | the request's `total`; the payments must add up to it | `checkout.ts` `decideSplit` |
| Stock take | the cached variant price at count time | [stock-take.ts:454](../src/main/services/stock-take.ts#L454) |
| The 249 key | a repeat compares `total` to the cent | [checkout.ts:292-297](../src/main/services/checkout.ts#L292-L297) |

The main process takes the renderer's `total` and prices as given; nothing recomputes them (phase 160, [phase-160.md:34](phase-160.md)).

### 1.7 PB WHITE BREAD 400G

- **Shopify (Q4):** Ksh 65.00, active, with no `rubis` VAT or HS metafield.
- **The till (temporary copy of the 1606 copy, `products` table):** the same variant, price 65, 66 in stock, barcode 6161300140187, and `vat_class`, `hs_code` and `hs_name` all null. So **it sells as class A at 16%** today.
- **Yes, its class depends on the open audit.** Phase 233 row 555 proposes **C (zero-rated)**, "the supply of ordinary bread", with high confidence, and that row is still waiting for the owner's or accountant's sign-off ([phase-233.md:65](phase-233.md)). If it is signed as C, the bread goes through `SellPLUfromExtDB_HS`, which sends a price and has the same `DiscAddP`; R5's choice is the same either way. Under 33h a mixed A and C basket could not take a *value* discount at all.

**The discount's title does not match its stated setting.**

| | Setting as described: 31 off **each** | 31 split once per order (`appliesOnEachItem: false`) |
| --- | --- | --- |
| 1 loaf | 65 (below the minimum) | 65 |
| 2 loaves | 2 × 34 = **68** | 130 − 31 = **99** |
| 3 loaves | 3 × 34 = 102 | 195 − 31 = 164 |
| 4 loaves | 4 × 34 = 136 | 260 − 31 = 229 |

The title, "2 @99/=", only comes out from the split setting, and only for exactly 2 loaves. Neither setting gives "every pair for 99". The real value could not be read (Q2).

## Part 2. The proposed design, checked against the code

| # | Verdict | From the code |
| --- | --- | --- |
| R1 | **Confirmed, with additions.** Skip `context` other than `DiscountBuyerSelectionAll`: Customers, Segments and **Markets**, a context R1 does not name. Skip `discountClasses` without `PRODUCT`. Skip `DiscountOnQuantity`. Skip `appliesOnOneTimePurchase: false`. Skip `DiscountAutomaticBxgy`, `…FreeShipping`, `…App` and every `DiscountCode*`. Decision D1 | §1.5 |
| R2 | Confirmed. Store it like `products`: a separate table, replaced whole | [database.ts:2341-2367](../src/main/services/database.ts#L2341-L2367) |
| R3 | **Confirmed.** Shopify's own rule is the same: "By default, only one product discount applies per line." Ties go to the earliest `startsAt`, then the id, so the result is always the same | §1.5 |
| R4 | **Corrected: there is no line table.** Lines live in `orders.payload_json`. Add optional fields to each line (`autoDiscount: { id, title, perUnit, lineAmount }`), so old sales read exactly as before. **Also:** the main process must work the discount out itself from its own copy at checkout. If it trusts the renderer's prices and total, as it does today (§1.6), a renderer bug files a wrong figure | §1.6 |
| R5 | **Net unit price recommended.** Decision D3 | §1.3 |
| R6 | Options and a recommendation in D4 | §1.4 |
| R7 | **Possible.** "Probakery Bread 2 @99/=  -62.00" is 30 characters and fits 32. The title wraps when it is longer. Today's "Discount: -x" line ([receiptLayout.ts:482-487](../src/main/lib/receiptLayout.ts#L482-L487)) takes the title in its place. The Enjoy slip shows the net per line ([enjoySlip.ts:122-127](../src/main/lib/enjoySlip.ts#L122-L127)); add the title line there too | §1.6 |
| R8 | **Needs a guard in the main process as well.** Today nothing stops two fetches running together: start plus a location confirm. The main process cannot see the cart, but it can see the saved cart draft (`cart_drafts`), so it can refuse a sync while one exists | [productStore.ts:37-70](../src/renderer/src/stores/productStore.ts#L37-L70) |
| R9 | **New:** nothing syncs at login today. A sync at start already exists. At login the sync is started after the login succeeds and is not awaited, so login never waits | §1.1 |
| R10 | **Products already work this way.** Use one transaction for products, discounts and the sync time together; a read that fails on any page writes nothing | §1.1 |
| R11 | Confirmed. The copy keeps the stock figure the same way `products` already does, and pushes nothing | [shopify.ts:84-89](../src/main/services/shopify.ts#L84-L89) |
| R12 | **Confirmed, with one design rule.** Automatic discounts must **not** travel as `item.discount` or `cartDiscount`, or the phase-161-1 refusal ([index.ts:1424-1434](../src/main/index.ts#L1424-L1434)) would refuse every bread sale on a live till. They are a separate thing the main process works out itself; the manual ones stay refused. Split payments work from the discounted total with no change, because `decideSplit` checks against the request's total | §1.2 |

## Part 3. Edge cases

| # | Verdict and handling |
| --- | --- |
| 1 | **Example given:** 1 loaf 65. 2 loaves 68 or 99, and 3 loaves 102 or 164, per D0 (§1.7). Tests pin all three |
| 2 | Recomputed on every cart change, so taking a loaf off removes the discount at once. Nothing is stored on the cart line |
| 3 | **A scheduled end applies on time,** because the till checks `startsAt` and `endsAt` itself, not the `status` from the last sync. **A change made in Shopify** (a deactivation, a new value) reaches the till only at the next start, login or Sync press. There is no time limit: a till left logged in all day keeps the old copy. The top bar shows "Last synced <Nairobi time>" |
| 4 | Compare instants in UTC. `startsAt` and `endsAt` are DateTime values, so 13:12 EAT is 10:12Z. Rule: start ≤ now < end. Whether Shopify treats the end as inclusive is **not verified**. The price that counts is the one at **payment**, worked out by the main process. A cart started at 13:11 and paid at 13:12 gets the discount; if the screen's figure differs, the sale is refused with "Prices changed, check the cart" |
| 5 | Two product discounts on one line: the larger saving wins (R3). Order discounts (`discountClasses` without `PRODUCT`) are skipped and listed by title on the sync result |
| 6 | A collection discount needs to know which products are in the collection. Read it per discount collection (`collections`, then each collection's products, paged) and store it with the copy, so membership and discounts always come from the same sync |
| 7 | **Recommend recomputing at payment, from the current copy, every time.** Held sales keep their held prices (phase 217) but the discount is worked out again when the sale is resumed. A restored draft is repriced anyway (phase 197). A repeat submit under 249 returns the first sale, unchanged, because nothing is written. Keeping "the discount as at the time of hold" would mean storing the renderer's discount and trusting it, which R4's rule forbids. Decision D5 |
| 8 | **The missing scope is the case today (Q1):** the sync result says "Discounts not read: the Shopify token has no read_discounts access" and keeps the last good discount copy, which is empty today. Products and discounts are each replaced only when their own read completed, so a discount failure does not stop the price and stock refresh. Offline or slow: the 10-second timeout per request, then the last good copy and "Last synced …"; login goes on (R9) |
| 9 | **The device cancels a receipt whose subtotal is ≤ 0** ([real-etims-provider.ts:1166](../src/main/services/integrations/real-etims-provider.ts#L1166)). Whether a single 0-priced line is accepted is **not verified**. Recommend: do not apply a discount that would bring a unit to 0 or below; the line sells at the normal price and the cart says why. Shopify itself would give the item free |
| 10 | Split payment: the payments add up to the discounted total. `decideSplit` and the 252-1 lock are unchanged. A sync cannot change a cart mid-split, because it is refused while the cart has items |
| 11 | **Rounding:** work out the discount **per unit**, rounded to the cent half-up, then net = price − discount, and line = quantity × net. Each item at a fixed amount is exact (65 − 31 = 34). A percentage is rounded per unit. Once per order (split across items) needs a cents split, which can give one variant two different unit prices; send those as two device lines so no unit price has more than two decimals. The device then has nothing to round, since `Price` takes up to 5 decimals (p. 26) |
| 12 | **Recommend:** Sales Summary and the CSV export show "Automatic discounts given" (amount and number of sales), from the stored lines. The **Z report waits** for the open ruling on its layout (233 against 234, [phase-235.md:7](phase-235.md)). Totals on every report stay the amount charged. Decision D6 |
| 13 | Each till has its own copy. A sync never touches written sales, which carry their own discount record. Two tills can differ until each one syncs |

## Part 4. The plan (not built)

**Step 1: sync of discounts, and the Sync button. No price changes.** It needs `read_discounts` added to the app (D7).
- `shopify.ts`:
  - `DISCOUNT_LIST_QUERY` (`discountNodes`, paged);
  - collection membership;
  - `mapAutomaticDiscount` → in scope, or skipped with a title and reason.
- `database.ts`:
  - two additive tables, `auto_discounts` and `auto_discount_variants` (resolved to variant ids);
  - a setting row for the last good sync time;
  - `replaceCatalogue` in **one transaction**.
- `index.ts`: `catalog:sync`, one at a time (a single promise in flight), refused while a cart draft exists, returning `{ syncedAt, products, discounts, skipped[] }`. `products:fetch` stays for callers that have not moved over.
- `preload/index.ts`, `window.d.ts`: the bridge.
- `productStore.ts`: `sync()`, `lastSyncedAt`, `syncing`, `skipped`.
- `App.tsx`: the top-bar button and "Last synced"; a sync at start, replacing the mount fetch; disabled while there are items or a payment is in progress (`isPaymentInProgress`).
- `authStore.ts`: after a successful `login`, a sync that is not awaited.

**Step 2: discounts in the cart, the receipt and the stored lines.**
- `src/main/lib/autoDiscounts.ts`, a pure function: (lines, copy, now) → per line `{ id, title, perUnit, net }`.
- The renderer mirrors it in `lib/autoDiscounts.ts`, as `splitPayments.ts` does; the renderer imports types only from `main`. A test runs both on the same cases.
- `cartStore.ts` totals.
- `PosCartTable.tsx`: normal price, title and amount, then net.
- `checkout.ts`: recompute at payment, refuse on a difference, and store `autoDiscount` on each line.
- `receiptLayout.ts`, `enjoySlip.ts`, `receiptTotals.ts`, `reportsExport.ts`, and the Sales Summary per D6.
- **On a live till, step 2 stays off until step 3 is in:** the same fail-closed gate as phase 161. Otherwise the device would file 130 for a 68 sale, which is the phase-160 bug again.

**Step 3, after rulings D3 and D4:**
- `buildFiscalRequest` takes the stored net unit price;
- `buildOrderInput` represents the discount as ruled, on discounted orders only, so undiscounted orders stay byte for byte as they are;
- one real test order on an explicit owner go.

**Existing tests that change:**

| Test | OLD | NEW |
| --- | --- | --- |
| `productStore.test.ts` | mocks `fetchProducts` / `getCachedProducts` | mocks `catalogSync`; the cache fallback is kept |
| Tests that mount `App` and stub `fetchProducts` | the mount fetch | the mount sync; stub renamed |
| `orders.test.ts` | no change for undiscounted orders; new cases for discounted ones | — |
| Fiscal tests (`vatClassFiscal`, `fiscalIntegration`) | no change: undiscounted lines are byte for byte the same | — |
| `requestHasDiscount.test.ts`, `cartDraft.test.ts`, `heldSales.test.ts` | no change | — |

The full list of tests that stub the bridge is **not verified** here; it is to be read before step 1.

**New tests, on a real `:memory:` SQLite:**
- the bread at 1, 2 and 3 loaves;
- every skipped type listed by title, with nothing applied;
- a failed or half-failed sync leaves the last good copy;
- the same sync twice gives no change;
- Sync is disabled with items, and refused by the main process while a draft exists;
- login goes on while offline;
- old sales, receipts and every report read the same (golden on the 1606 copy).

**Mutation checks:**
1. apply the discount to 1 loaf;
2. apply it once per order instead of to each item;
3. let a half-failed sync replace the copy;
4. let the button sync with items in the cart;
5. send the gross price to the device when R5 says net.

**Rollback:**
- Revert each step's commit. The new tables and lines stay unread (additive).
- A sale already stored with `autoDiscount` reprints its stored total and lines; the title line goes.
- A waiting fiscal sale keeps its stored net request, because the request is stored at queue time.

## Decisions for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| D0 | **The bread discount.** "Each item" gives 2 for 68, not 99. 99 is the split setting, and then only for exactly 2 loaves (§1.7) | Check the Shopify admin. If "2 for 99" is meant, the value should be "31 split across items". "Every pair for 99" cannot be made with this discount type |
| D1 | R1 scope | Accept R1, with the additions in Part 2: only `context: all`, only product-class discounts, and Markets contexts skipped. Each item and percentage in version 1; "split across items" too only if D0 needs it |
| D2 | "POS excluded" | **The API has no such field** (§1.5), so the till cannot see the box. Your reading holds: the till applies every active in-scope discount, whatever the box says. If a discount ever must not apply on the till, use a Shopify discount `tag` (the field exists). Not built until asked |
| D3 | R5 fiscal | **Net unit price, no `DiscAddP`.** The reasons: `DiscAddP` is a percentage only, so 31/65 = 47.6923…% is inexact and has no stated sign. A value discount (33h) is only allowed on a one-VAT-group receipt. The fiscal reconciliation flags any device total ≠ charged as "mismatch". The Z report's VAT by class reads the request's lines. Phase 160 Part B reached the same answer. **Ask VIL, with D8,** whether KRA accepts a net price with no separate discount record |
| D4 | R6 Shopify order | **(c)** On a discounted order only: `priceSet` = the till's normal price per line, plus one `itemFixedDiscountCode` (`code` = the title, or "RUBIS-AUTO" when there are several, `amountSet` = the total discount), and the per-line breakdown in the note. Shopify then shows gross, discount and net = charged. **(b)**, the fallback: `priceSet` = the net price, plus the note. Totals right, but no discount figure in Shopify. **(a)** Today: wrong, because Shopify records 130 for a 68 sale. Either (b) or (c) needs one test order on your go. How Shopify spreads a fixed code over the lines is **not verified** |
| D5 | Edge 7 | Recompute at payment from the current copy |
| D6 | Edge 12 | Sales Summary and CSV yes; the Z report after its layout ruling |
| D7 | The scope | Add `read_discounts` to the Shopify app. Whether that changes or reissues the token is **not verified** |
| D8 | Release | Steps 2 and 3 go to a live till in the same release; step 1 can ship alone |

## Observed but not changed

1. When Shopify returns zero products, or the location filter leaves none, `products:fetch` returns success with an empty list. The screen then shows an empty catalogue, not the cache ([index.ts:1360-1368](../src/main/index.ts#L1360-L1368), [productStore.ts:48-50](../src/renderer/src/stores/productStore.ts#L48-L50)).
2. `fetchInventoryLevelDetails` stops at a page with no data (`if (!data) break`, [shopify.ts:587-588](../src/main/services/shopify.ts#L587-L588)). The location merge then keeps only the variants in that partial map, and caches the result ([shopify.ts:687-699](../src/main/services/shopify.ts#L687-L699)), so a half-failed stock read can shrink the cached catalogue.
3. `productStore.reset` says "used on auth change", but nothing calls it.
4. `setItemDiscount` and `setItemPrice` have no screen since 197-1, but they are still in the store and still accepted by the validator. They are refused on a live till.
5. The protocol's sample sequence (§3.2, p. 60) lists "payment (command 35h)" and "sale registration from the article database of CU (32h)". Neither is defined in the KE command list (§2.5). This is relevant to D8 (declaring split payments).
6. `orderCreate` on a development or trial store is limited to five orders a minute (shopify.dev). After a long offline spell the push retries with backoff. Whether `rubisenergykenyaplc` counts as a development store is not checked.

## Not verified

- The bread discount's real settings: Q2 was refused without `read_discounts`.
- What Shopify does with the "POS Pro locations" box: it is not in the API.
- The sign or meaning of `DiscAddP` on 31h.
- Whether the device accepts a 0 price.
- Whether KRA or VIL accept a net price.
- How Shopify spreads a fixed discount code over the lines.
- Whether a minimum subtotal counts only the eligible items.
- Whether `endsAt` is inclusive.
- Whether adding a scope reissues the token.
- The full list of tests stubbing `fetchProducts`.

## Verification

- `git status` was clean and `git log -3` showed `fd08431`, `c415ea4`, `9fdd0b4`, all made in this session.
- The protocol PDF was read in full for the 31h, 2Ch, 33h and §3.2 text.
- Seven read-only GraphQL calls (§1.5); the token was never printed or written. One more body was refused by the helper's own guard before sending, because it named the `Mutation` type in an introspection query; that item was dropped, not sent.
- The 1606 database copy was read from a temporary copy, and the scratchpad copy checked unchanged by SHA-256.
- No tests were run: no code changed.
