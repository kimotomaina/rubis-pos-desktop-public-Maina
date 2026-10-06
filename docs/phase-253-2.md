# Phase 253-2 — Buy X get Y discounts on the till (pairs), net price to the device

- **Date:** 2026-10-07
- **Asked by the owner:** the 00:40 file, rulings D0 to D6. The pairs deal: 1 loaf 65, 2 loaves 99, 3 loaves 164, 4 loaves 198.
  - The device gets the discounted price, as separate lines.
  - Shopify gets the same lines with `priceSet` (option b).
- **Follows:** [phase-253-audit.md](phase-253-audit.md) and [phase-253-1.md](phase-253-1.md), which built the discount copy.
- **Status:** built and tested in one commit. Not released, with no version bump and no installer. **No live till gets this until one test order passes, on a separate written go (D4, D8).**
- **Standing rules kept:**
  - nothing was sent to Shopify, the device or Safaricom; the device and Shopify are fakes in every test;
  - the app was not launched;
  - no `check:fit`.

## The rule, in one place

[lib/autoDiscounts.ts](../src/main/lib/autoDiscounts.ts) has three exported functions.

**`priceLines(lines, copy, now)`:**
- Only discounts live at `now` count (`startsAt` ≤ now < `endsAt`).
- For each discount:
  - n is the units of the lines it names (by variant id, or by product id);
  - it applies ⌊n ÷ (buys + gets)⌋ times, capped by `usesPerOrderLimit`;
  - times × gets units are discounted, the cheapest first, as Shopify does;
  - a discounted unit costs price − amount, or price less the percentage rounded half-up to the cent;
  - a discount that would bring any unit to 0 or below is not applied.
- With several discounts, the best saving goes first; a tie goes to the earliest `startsAt`, then the id. Each discount takes the lines it names, so no line is in two.

**`applyAutoDiscounts(lines, copy, now)`:**
- turns each discounted cart line into its full-price units and its discounted units, as two lines. The second carries `autoDiscount: { id, title, amountOffEach }`;
- a line with nothing discounted passes through as **the same object**;
- it also says whether any line is named by any discount in the copy, live or not.

**The screen's mirror:** [renderer lib/autoDiscounts.ts](../src/renderer/src/lib/autoDiscounts.ts) repeats `priceLines` line for line, as `splitPayments.ts` does. A test runs both on 9 cases.

## What changed

| File | Change |
| --- | --- |
| [checkout.ts](../src/main/services/checkout.ts) | `soldLinesOf`, after the 249 key check and before anything else (detailed below). The fiscal request is built from the sold lines; `buildFiscalRequest` itself is unchanged. New optional deps `autoDiscounts` and `now`: leaving them out keeps today's behaviour exactly |
| [index.ts](../src/main/index.ts) | `autoDiscounts: () => db.getAutoDiscounts()` for the checkout; `autoDiscount` passed to the printed lines |
| [database.ts](../src/main/services/database.ts), [shopify-types.ts](../src/main/services/shopify-types.ts) | `QueueOrderInput.items` and `OfflineOrderLine` may carry `autoDiscount`. The stored line gets the field only when it has one, so a sale with no discount stores exactly what it did |
| [receiptLayout.ts](../src/main/lib/receiptLayout.ts), [enjoySlip.ts](../src/main/lib/enjoySlip.ts) | `autoDiscountLines`, under a discounted line: `Probakery Bread 2 @99/= saved 31.00` when it fits; otherwise the title wraps and `saved 31.00` goes on its own line, right-aligned. On 32 columns the bread title wraps this way (35 characters). The receipt and the slip print the lines filed |
| `printer.ts`, `pdf-receipt.ts` | `autoDiscount` passed through the three line mappings |
| [orders.ts](../src/main/services/orders.ts) | D4, option (b), on a sale with a discounted line only (detailed below) |
| [reports.ts](../src/main/services/reports.ts), [ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx) | `SalesSummary.autoDiscountsGiven { amount, saleCount }`, **present only when a sale in the range has one**, so a range without any reads exactly as before (the golden). A card "Automatic discounts given, on N sales" |
| [reportsExport.ts](../src/main/services/reportsExport.ts) | `lines.csv`: the existing "Line discount" column says `automatic <title>: 31.00 off each` on a discounted line. The header and every other row are unchanged |
| [cartStore.ts](../src/renderer/src/stores/cartStore.ts) | `getSubtotal` and `getTotal` use the copy when it holds any discount and the cart has no manual discount; otherwise exactly as before. The checkout sends the cart lines as they are, with the discounted total |
| [PosCartTable.tsx](../src/renderer/src/components/PosCartTable.tsx) | On a discounted line, the second line shows `title -Ksh saving` in green in place of the variant title, so the row height is unchanged. The price column keeps the normal price, and the total column shows the net |

**What `soldLinesOf` does:**
- With no discount in the copy, or a manual discount on the cart (mock mode only; a live till refuses those, phase 161-1), it returns the cart's lines exactly as sent.
- Otherwise it prices the cart at the time of payment. When any line is named by any discount in the copy, the screen's total must equal that price to the cent; if not: **"Prices changed, check the cart"**, with nothing written, paid or filed.

**The Shopify order (D4, option b):**
- **Only a sale with a discounted line changes:** each line is sent with `priceSet.shopMoney` (`amount` = the price it was sold at, `currencyCode` `KES`), and ` — discounts: <title> -<amount>` is added to the note.
- **Any other sale sends exactly what it did.**

**Not changed:**
- the 249 key: a repeat compares the discounted total;
- split payments: they add up to the discounted total;
- the 252-1 lock;
- shifts and the Z report;
- the fiscal provider and `buildFiscalRequest`;
- the phase-161-1 refusal of manual discounts: the validator still drops any `autoDiscount` the screen might send.

## The 3-loaf sale, end to end (test values)

| Where | What |
| --- | --- |
| Cart | `PB WHITE BREAD 400G`, 3 × 65.00, with "Probakery Bread 2 @99/= -Ksh 31.00" under it; line total 164.00 |
| Stored lines | `2 × 65.00`, then `1 × 34.00` with `autoDiscount { title "Probakery Bread 2 @99/=", amountOffEach 31 }`; total 164 |
| Fiscal device | `SellPLUfromExtDB` twice: `Quantity 2, Price 65`, then `Quantity 1, Price 34`. No `DiscAddP`, no `Subtotal` |
| Receipt (48) | `2 x 65.00 130.00 A`, then `1 x 34.00 34.00 A`, then `Probakery Bread 2 @99/= saved 31.00`, then TOTAL KSH 164.00 |

## Tests

| File | Tests | What |
| --- | --- | --- |
| [autoDiscounts.test.ts](../tests/autoDiscounts.test.ts) (new; real `:memory:` SQLite, the real `runCheckout`) | 24 | **Pricing:** 1, 2, 3 and 4 loaves give 65, 99, 164 and 198, with the device lines 65 / 65+34 / 65+65+34 / 65+65+34+34; a loaf out of a pair gives 65; a cap of one use per order; a percentage rounded per unit; a discount bringing a unit to 0 not applied; the best saving and the earliest start win. **Payment time:** not started, so a screen total of 99 is refused with nothing written; expired, so it sells at the normal price; a differing screen total refused with nothing written; a repeat submit gives one sale; a split of 164 (100 M-Pesa by code + 64 cash). **Phase 161-1:** the refusal still refuses a manual discount and never sees an automatic one; the validator drops an `autoDiscount` sent from the screen; a mock cart with a manual discount is priced as before. **A sale with no discount:** with the bread discount in the copy, a milk sale stores, files, pushes and reports exactly as with no copy at all (payload, fiscal request, Shopify input, Sales Summary). **Readers:** the receipt at 48, 42 and 32 columns; the Enjoy slip; Shopify's lines and note; the Sales Summary and `lines.csv` |
| [autoDiscountsCart.test.ts](../tests/autoDiscountsCart.test.ts) (new; real stores, a real mount) | 19 | the screen's mirror gives exactly the main process's pricing on 9 cases; the cart total for 1 to 4 loaves; a loaf out of a pair; **a resumed held sale is priced again**; a manual discount cart as before; no copy as before; the checkout sends 164 and the lines unchanged; the cart table shows the title, the saving and the net on the bread line only |

**The golden on the 1606 copy** (`rehearsal/paymentLegsGolden`, on a temp copy): payment figures identical to the cent and the orders CSV byte for byte, so every existing sale reads the same. The copy was unchanged by SHA-256.

### Mutation checks (each restored; the file compared byte for byte afterwards)

| # | Mutation | Failing tests |
| --- | --- | --- |
| 1 | Discount 1 loaf (`ceil` for `floor`) | 14 |
| 2 | Discount every loaf instead of one per pair | 19 |
| 3 | Send the device 65 for the discounted loaf | 3: the 2, 3 and 4 loaf device lines |
| 4 | Trust the screen's total | 2: not started, and differing total |
| 5 | Send the discount as `item.discount` | 9 |

## Existing tests changed

None. Every existing test passes unchanged.

## Behaviour to know

- **The screen's total is worked out when the cart changes.** If a discount starts or ends while a cart sits open, the screen keeps the old figure until the next change. The main process then refuses with "Prices changed, check the cart"; changing the cart shows the new price.
- **A held sale keeps its lines as held** (phase 217), and its discount is worked out again when it is resumed and again at payment (D5).
- **Shopify will record a different price for each line** of the same variant (65 and 34), and the note carries the discount. Shopify's own reports show no separate discount figure (option b).

## Rollback

Revert the commit. Readers that do not know `autoDiscount` ignore it:
- a sale already stored with discounted lines still reads, prints, files and pushes those lines at their prices;
- its receipt loses the title line;
- its Shopify push loses `priceSet` and the note's discount part, so Shopify would price those lines at 65. **So revert only before any discounted sale exists, or keep `orders.ts`.**

## Not verified

- **`orderCreate` accepting two lines of one variant with different `priceSet` values:** the test order (D4) settles it. The exact input a 3-loaf sale sends is in the session report.
- **The cart row and the Sales Summary card are not measured** (no `check:fit`).
- **Never run on a till**, and never against Shopify.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 243 files passed, 2 skipped (the copy rehearsals); 3,977 tests passed, 9 skipped |
| Copy rehearsals and golden on a temp copy of the 1606 copy | 9 of 9; the copy unchanged by SHA-256 |
| Mutation checks | 5 of 5 caught, every file restored byte for byte (run again after the tests' type fixes) |
| `npm run build` | passed |
