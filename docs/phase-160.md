# Phase 160 - Discounts and totals, cart to fiscal device to receipt (read-only)

- **Date:** 2026-09-26
- **Requested:** A read-only audit tracing how a discounted (or price-overridden) sale's total moves from the cart through the fiscal device to the printed receipt and the Shopify order, with two worked examples, a plain answer to whether each of the KRA filing, the printed receipt, and the Shopify order can diverge from the amount actually charged, what discount commands the fiscal device supports, whether a price override reaches the device, and a smallest-fix proposal in two separately reviewable parts. No code changed, no device command sent, no Shopify call, no SQL against real data.
- **Outcome:** No change needed - audit only, as instructed.
- **Branch / base commit:** staging @ acd28d8 (Phase 159 - fiscal read-back and Shopify invoice-number audit).

**Method note:** every claim below carries a `file:line`, except for `tests/fixtures/tremol-defs.xml`, which is a single 109,522-byte line with no internal newlines - it is cited by its `<Command Name="...">` block instead, which is the exact equivalent anchor for that file. A conclusion drawn from more than one fact is labelled **Inference:**. Something I could not check from inside this repository is labelled **Not verified:**. No command was sent to a fiscal device or ZFPLabServer (never `DailyReport`). No Shopify call was made, live or otherwise. No SQL was run against any database - every schema/behaviour fact comes from reading source directly. No device password appears anywhere below.

---

## Plain answers (item 2)

**Can the amount filed with KRA differ from the amount charged? Yes, whenever any discount is applied - line, cart, or both.** The fiscal device is told each line's *undiscounted* catalog price (`buildSellPluArgs`/`buildSellPluHsArgs`, `real-etims-provider.ts:1492-1530`, `Price: formatPrice(item.unitPrice, ...)`) with quantity, and no discount argument is ever populated (`DiscAddP` exists on the command and in this codebase's own types but is never set - see item 3/4 below). The device computes and files its own total from those undiscounted lines. It never sees the cart's discounted `input.total` at all, in any command.

**Can the printed receipt total differ from the amount charged? Yes, for the same reason, on top of the already-known additive-tax bug (docs/phase-159).** `printer.ts:renderReceipt` and `pdf-receipt.ts:generatePdfReceipt` both recompute a subtotal from `items[].unitPrice * quantity` with no discount applied at all - `ReceiptLineItem` (`printer.ts:67-72`) has no `discount` field, so it is structurally impossible for either renderer to apply one even if it tried. A cart-level discount is dropped even earlier: the IPC handler that builds these line items (`index.ts:2446-2451`) never reads `payload.cartDiscount` either.

**Can the Shopify order total differ from the amount charged? Yes, essentially always whenever a discount, a price override, or a Shopify catalog-price change is in play, and this is not new to discounts.** `buildOrderInput` (`orders.ts:76-79`) sends only `variantId`/`quantity` per line - no price, no discount. Shopify prices every line at the variant's own live catalog price and computes the order total itself; whatever the till actually charged is never communicated. (`OrderCreateLineItemInput` does have a `priceSet` field precisely for setting a custom line price, confirmed against `shopify.dev`, 2026-09-26 - it is simply never used here. This is a factual note, not a proposal; Shopify is out of scope for the fix in item 5, which covers only the receipt and the fiscal device.)

---

## Item 1 - Tracing a sale, step by step, for four scenarios

### 1a. No discount, no override - baseline

1 x 100.00, no discount, no override. Every step carries 100.00 (per unit) through unchanged:

| Step | Value |
| --- | --- |
| Cart store (`cartStore.ts`) | `item.price = 100`, `item.discount = undefined`, `cartDiscount = null` |
| `getTotal()` (`checkoutMath.ts:139-141`) | `calculateSubtotal` = 100.00 -> `calculateCartTotal` = 100.00 |
| `PosCheckoutPanel` (`PosCheckoutPanel.tsx:54-55`) | `cartTotal = 100.00` |
| `CheckoutRequest` (`ipcValidator.ts:26-56`) | `items: [{ price: 100, quantity: 1 }]`, `total: 100.00` |
| `input.total` (`checkout.ts`) | `100.00` (accepted as-is - `checkoutRequestSchema` validates only `finite().nonnegative()`, `ipcValidator.ts:47`; nothing recomputes or cross-checks it against `items`) |
| `OfflineOrderPayload` (`database.ts:1195-1216`) | `lineItems: [{ unitPrice: 100, quantity: 1, discount: undefined }]`, `total: 100.00` |
| `buildFiscalRequest` items (`checkout.ts:266-296`) | `[{ unitPrice: 100, quantity: 1, taxRate }]`, `total: 100.00`, `taxAmount: 100 * taxRate` (additive - docs/phase-159, unrelated to discounts) |
| `buildSellPluArgs` `Price` (`real-etims-provider.ts:1499`) | `Price = "100"`, `Quantity = "1"`, `DiscAddP` omitted (`formatOptionalDiscAddP` returns `undefined` when unset, `real-etims-provider.ts:1647-1650`) |
| Device total | 100.00 - matches |
| `printer.ts` receipt | `subtotal = 100.00`, `tax = 100 * rate` (additive), `total = 100 + tax` |
| `pdf-receipt.ts` | identical to the above, independently computed |
| Shopify `orderCreate` | `lineItems: [{ variantId, quantity: 1 }]` - Shopify prices the line at its own current catalog price for that variant, which is typically 100.00 (matches, **unless the Shopify catalog price has since diverged from what the till displayed** - a pre-existing risk, not a discount-specific one) |

No discrepancy in the amount filed or charged here; the only pre-existing gap is the additive-tax figure on the receipt (docs/phase-159), unrelated to this audit.

### 1b. Line discount - worked example: 2 x 100.00 with a 10.00 line discount

| Step | Value |
| --- | --- |
| Cart store | `item.price = 100`, `item.quantity = 2`, `item.discount = { type: 'fixed', value: 10 }` |
| `calculateLineTotal` (`checkoutMath.ts:116-118`) | `applyDiscount(100 * 2, { fixed, 10 })` = `round2(max(200 - 10, 0))` = **190.00** |
| `getTotal()` | 190.00 (one line, no cart discount) |
| `PosCheckoutPanel` | `cartTotal = 190.00` - this is what the cashier sees and what `tenderedAmount`/`changeDue` are computed against (`calculateChange`, `checkoutMath.ts:41-44`) |
| `CheckoutRequest` | `items: [{ price: 100, quantity: 2, discount: { type: 'fixed', value: 10 } }]`, `total: 190.00` |
| `input.total` | **190.00** - the amount actually charged |
| `OfflineOrderPayload` | `lineItems: [{ unitPrice: 100, quantity: 2, discount: { type: 'fixed', value: 10 } }]`, `total: 190.00` - the discount is faithfully **stored** here, for the record (this is what `reportsExport.ts`'s "Line discount" CSV column already reads, docs/phase-158) |
| `buildFiscalRequest` items | `[{ unitPrice: 100, quantity: 2, taxRate }]` - **`item.discount` is never read.** `grep -n "discount" checkout.ts` returns exactly one hit in the whole file (`checkout.ts:460`, `cartDiscount: input.cartDiscount` in the object built for `db.queueOrder` - not in `buildFiscalRequest`). `total: 190.00` (correct - `input.total` is used as-is here) |
| `buildSellPluArgs` | `Price = "100"`, `Quantity = "2"`, `DiscAddP` omitted (`item.discAddP` was never set - see item 3/4) |
| **Device total** | **200.00** (100 x 2, no discount applied) |
| **Mismatch** | **+10.00 filed with KRA versus what was charged** (200.00 vs. 190.00) |
| `printer.ts` receipt | `subtotal = 100 * 2 = 200.00` (`ReceiptLineItem.unitPrice`, `index.ts:2450`, is `line.unitPrice` - the raw, undiscounted price; `line.discount` exists on `OfflineOrderLine` but `ReceiptLineItem` has no field to carry it into `printer.ts` at all), `tax = 200 * rate` (additive), `total = 200 + tax` |
| **Mismatch** | **Printed total is built from 200.00, not the 190.00 actually charged** - before the additive-tax error even compounds it further |
| `pdf-receipt.ts` | Identical: `subtotal = 200.00`, same mismatch, independently computed (`pdf-receipt.ts:36-38`) |
| Shopify `orderCreate` | `lineItems: [{ variantId, quantity: 2 }]` - no price sent at all; Shopify prices the line at its own catalog rate (likely 100.00/unit again) x 2 = 200.00, unrelated to either the 190.00 charged or the 200.00 filed/printed - it simply never receives any of this discount information |

### 1c. Cart discount - worked example: 1 x 100.00 with a 10% cart discount

| Step | Value |
| --- | --- |
| Cart store | `item.price = 100`, `quantity = 1`, `item.discount = undefined`, `cartDiscount = { type: 'percent', value: 10 }` |
| `calculateSubtotal` | 100.00 (no line discount) |
| `calculateCartTotal` (`checkoutMath.ts:139-141`) | `applyDiscount(100, { percent, 10 })` = `round2(max(100 - 10, 0))` = **90.00** |
| `PosCheckoutPanel` | `cartTotal = 90.00` |
| `CheckoutRequest` | `items: [{ price: 100, quantity: 1 }]`, `total: 90.00`, `cartDiscount: { type: 'percent', value: 10 }` |
| `input.total` | **90.00** |
| `OfflineOrderPayload` | `lineItems: [{ unitPrice: 100, quantity: 1 }]`, `cartDiscount: { type: 'percent', value: 10 }`, `total: 90.00` |
| `buildFiscalRequest` items | `[{ unitPrice: 100, quantity: 1, taxRate }]`, `total: 90.00` (correct figure, but see below) - **`cartDiscount` is never read anywhere in `checkout.ts`'s fiscal path; there is not even a dead field for it on `FiscalInvoiceRequest`** (`etims.ts:43-84` has no `cartDiscount`/`discAddV` property at all) |
| `buildSellPluArgs` | `Price = "100"`, `Quantity = "1"`, `DiscAddP` omitted |
| **Device total** | **100.00** |
| **Mismatch** | **+10.00 filed with KRA versus charged** (100.00 vs. 90.00) - the same class of problem as 1b, but a cart discount has no representation whatsoever in the fiscal request object, not even an unused field |
| `printer.ts`/`pdf-receipt.ts` | `subtotal = 100.00` (cart discount never reaches `ReceiptLineItem`, and `payload.cartDiscount` is never read by `index.ts:2446-2451`'s mapping either), `tax = 100 * rate`, `total = 100 + tax` |
| **Mismatch** | Printed total built from 100.00, not the 90.00 charged |
| Shopify `orderCreate` | Same as 1b - no price/discount sent, Shopify prices independently |

### 1d. Price override

Cart store: `setItemPrice(id, newPrice)` (`cartStore.ts:149-157`) validates `newPrice` against `basePrice` (`validatePriceOverride`, `checkoutMath.ts:191-208`) and, if valid, replaces `item.price` directly - `basePrice` is kept as a separate field purely for future validation, never sent onward as a second figure.

From that point on, **the overridden price *is* `item.price`** - there is no separate "override" flag or field carried through the rest of the pipeline; an overridden price is indistinguishable from a catalog price by the time it reaches `CheckoutRequest`, `OfflineOrderPayload`, or `buildFiscalRequest`. Concretely: `buildFiscalRequest`'s `unitPrice: item.price` (`checkout.ts:278`) uses the (possibly overridden) `item.price`, never `item.basePrice` - `basePrice` is not even part of `CheckoutRequest`'s `cartItemSchema` output that reaches `buildFiscalRequest` in any way other than through `item.price` already having been changed.

**Unlike a discount, an override is not dropped anywhere in this trace.** The overridden price flows correctly into the fiscal request's `Price` argument, the printed receipt's `unitPrice`, and would flow into Shopify too if Shopify were sent a price at all (it isn't, per the baseline case - that gap exists independent of overrides). See item 4 for the direct answer.

---

## Item 3 - Does the device support discounts in the commands this codebase already has?

**Yes, in two different, non-overlapping ways - and this codebase wires up neither.**

### Per-line: `SellPLUfromExtDB` / `SellPLUfromExtDB_HS`'s own `DiscAddP`

Quoted from `tests/fixtures/tremol-defs.xml`, the `SellPLUfromExtDB` command block (`CmdByte="0x31"`):
```
<Arg Name="DiscAddP" Value="" Type="Decimal" MaxLen="7">
  <Desc>1 to 7 for percentage of discount/addition</Desc>
  <Meta MinLen="1" Compulsory="false" ValIndicatingPresence="," />
</Arg>
```
`SellPLUfromExtDB_HS` (same `CmdByte`, the non-class-A variant) has the identical `DiscAddP` argument. **This is a percentage only** - neither Sell command has a value/fixed-amount discount argument at the line level; only a percentage.

This app's own types already have a field for exactly this - `FiscalInvoiceLine.discAddP?: string` (`etims.ts:38-39`, "Per-line discount/addition percentage. Omitted from the fiscal payload entirely when unset.") - and the provider already reads it: `formatOptionalDiscAddP` (`real-etims-provider.ts:1647-1650`) sends it verbatim when non-empty, used by both `buildSellPluArgs` (`real-etims-provider.ts:1505`) and `buildSellPluHsArgs` (`real-etims-provider.ts:1528`). **The plumbing exists end-to-end on the provider side. The one and only caller, `buildFiscalRequest` (`checkout.ts:266-296`), simply never sets `discAddP` on any line it builds** - confirmed by reading the full function: it produces `{ description, quantity, unitPrice, taxRate, pluCode, vatClass, hsCode, hsName }` and nothing else.

### Receipt-level (cart-level): the `Subtotal` command's `DiscAddV`/`DiscAddP`

Quoted from `tests/fixtures/tremol-defs.xml`, the `Subtotal` command block (`CmdByte="0x33"`):
```
<FPOperation>Calculate the subtotal amount with printing and display visualization options.
Provide information about values of the calculated amounts. If a percent or value
discount/addition has been specified the subtotal and the discount/addition value will be
printed regardless the parameter for printing.</FPOperation>
...
<Arg Name="DiscAddV" Value="" Type="Decimal" MaxLen="13">
  <Desc>Up to 13 symbols for the value of the discount/addition. Use minus sign '-' for discount</Desc>
  <Meta MinLen="1" Compulsory="false" ValIndicatingPresence=":" />
</Arg>
<Arg Name="DiscAddP" Value="" Type="Decimal" MaxLen="7">
  <Desc>Up to 7 symbols for the percentage value of the discount/addition. Use minus sign '-' for discount</Desc>
  <Meta MinLen="1" Compulsory="false" ValIndicatingPresence="," />
</Arg>
```
This is a **receipt-wide** discount or addition, by value (`DiscAddV`) or percentage (`DiscAddP`), applied to the running subtotal across everything sold so far on the open receipt - the natural device-side mechanism for a cart-level discount. **`Subtotal` is never called anywhere in `real-etims-provider.ts`** - `submitInvoice`'s seven documented steps (`real-etims-provider.ts:22-32`: settings, `ReadStatus`, `OpenInvoiceWithFreeCustomerData`, `SellPLUfromExtDB`/`_HS` per line, `ReadCurrentReceiptInfo`, `CloseReceipt`, `ReadDateTime`) do not include it. `grep -n "'Subtotal'" real-etims-provider.ts` returns no hits.

### The "one and same VAT group" rule

**Not verified against this repository's own files.** I searched `tests/fixtures/tremol-defs.xml` exhaustively (`grep -i "belonging\|same VAT group"`) and found no sentence matching the task brief's quoted rule anywhere in the fixture. The vendor's protocol PDF - the document `docs/phase-157`/`docs/phase-159` already established is not present in this repository - is the likely source; I have taken the brief's quoted wording at face value rather than independently confirming it.

**Inference**, from the schema shape itself, of why the rule would make sense here: `SellPLUfromExtDB`'s `OptionVATClass` (this build's `defVer`) has exactly one legal value, `"A"` (`real-etims-provider.ts:1425-1437`'s own doc comment, confirmed against the XML's `<Options><Option Name="VAT Class A" Value="A" /></Options>`), so a per-line `DiscAddP` is intrinsically scoped to whatever single VAT class that one line already carries - it cannot itself mix VAT classes. The `Subtotal` command's `DiscAddV`/`DiscAddP`, by contrast, applies retroactively across every line already rung up on the open receipt, which may span several different VAT classes (via `SellPLUfromExtDB_HS`'s HS-code-driven classes) - a receipt-level discount command would need to know how to split that reduction fairly across mixed VAT groups, which is presumably exactly why the vendor restricts it to a single-VAT-group receipt. This reasoning is offered to explain why the quoted rule is plausible, not as a substitute for confirming its exact wording on a real device or in the protocol PDF.

---

## Item 4 - Price override: is the overridden price sent to the device?

**Yes.** Traced in item 1d: `setItemPrice` (`cartStore.ts:149-157`) overwrites `item.price` directly (after validating against `basePrice`); `buildFiscalRequest` (`checkout.ts:278`) reads `unitPrice: item.price`; `buildSellPluArgs`/`buildSellPluHsArgs` (`real-etims-provider.ts:1499, 1525`) send that value verbatim as the `Price` argument. No separate "original price" is sent alongside it, and `item.basePrice` never reaches the fiscal request at all. A price override is filed with KRA and printed on the receipt correctly - it is only discounts (line and cart) that are dropped.

---

## Item 5 - Smallest correct fix, in two separately reviewable parts

### Part A - Receipt (total = amount charged, discounts shown, VAT extracted not added)

**Scope**: `printer.ts`'s `renderReceipt` and `pdf-receipt.ts`'s `generatePdfReceipt` only. The fiscal block (the invoice number/QR code printed after "Thank you!", `printer.ts:259-267`) is untouched - this only changes how the subtotal/discount/tax/total lines above it are computed and printed.

**Design**:
- One new shared function (e.g. `receiptTotals.ts`, a plain module with no printer-specific dependency, following the existing pattern of `checkoutMath.ts` being framework-free and directly testable) taking the order's line items (with their per-line `discount`), the `cartDiscount`, and the VAT rate, and returning `{ rawSubtotal, discountTotal, total, vatIncluded }` - where **`total` is `order`'s own stored `total` (the amount actually charged), never recomputed from the lines**, and `vatIncluded` uses the already-corrected extraction (`computeVatIncluded`, `reports.ts:129`, "docs/phase-158" - reused, not reimplemented, since `reports.ts` is a `main`-side module `printer.ts` can import directly, both being main-process code, unlike the renderer-boundary case docs/phase-158-1 had to work around).
- Both `renderReceipt` and `generatePdfReceipt` call this one function and print its result - removing the two independent, drifted copies of `subtotal`/`tax`/`total` math (`printer.ts:211-216` and `pdf-receipt.ts:36-38`).
- A discount line is added to the printed layout when `discountTotal > 0` (e.g. `Discount: -12.00`), so the customer can see why the total is lower than the sum of listed line prices - currently no discount ever appears on either receipt at all, even though it's already stored in `payload_json`.
- `ReceiptLineItem` (`printer.ts:67-72`) needs no new field for this - the shared function takes the full `OfflineOrderLine`/`OfflineOrderPayload` shape (which already carries `discount`/`cartDiscount`), rather than the stripped-down `ReceiptLineItem` the current mapping produces; `index.ts:2446-2451`'s mapping would need to pass the discount fields through instead of dropping them.

**Files touched**: `printer.ts`, `pdf-receipt.ts`, a new shared totals module, `index.ts`'s `receipt:print` handler (to stop stripping `discount`/`cartDiscount` before they reach the printer).

**Tests**: a new unit test file for the shared totals function (mirroring `checkoutMath.test.ts`'s pure-function style) covering no-discount/line-discount/cart-discount/both, asserting `total` always equals the input order's own `total` verbatim, never a recomputation; updated `tests/printer.test.ts`/a new `pdf-receipt.test.ts` (**Not verified**: whether a `pdf-receipt.test.ts` already exists - not opened during this audit) asserting the printed lines include a discount line and the corrected VAT label/figure (docs/phase-158-1's `formatVatRateLabel`, reused the same way).

**Tripwire tests affected**: none of the fiscal suite, `mpesaPaymentGate`, keyboard, or Phase E layout tests reference `renderReceipt`/`generatePdfReceipt`'s internal math (confirmed by this audit's own reading of `tests/printer.test.ts`, which has no discount-related assertions today). `tests/printer.test.ts`'s **existing** subtotal/tax/total assertions (e.g. `printer.test.ts:98-101`, the "Subtotal: 44.99 / Tax: 3.60 / Total: 48.59" case) would need to keep passing unchanged for a no-discount order, since Part A's `total` still equals the order's own stored total in that case - only the discount and VAT-label lines are new. Any assertion that does need to change must be listed by name, per this project's standing rule.

**What needs explicit review**: this is the fix `docs/KNOWN_GAPS.md` already names "go-live plan Item 3" (the receipt tax fix) - Part A folds the discount fix into the same change, since both live in the same two files and the same shared function is the natural place for both. Review should confirm the shared function's `total` is genuinely never recomputed (a regression here would silently reintroduce exactly this audit's finding).

### Part B - Fiscal (only because item 2 shows a real mismatch)

**Recommendation: (i) send the net (discount-inclusive) unit price per line - not (ii) the device's own `DiscAddP`/`DiscAddV`.**

**Why not (ii)**: `DiscAddP` (per-line, `SellPLUfromExtDB`/`_HS`) is percentage-only - a `fixed`-type line discount (worked example 1b) would need a lossy value-to-percentage conversion (`percent = discount.value / (unitPrice * quantity) * 100`), adding a second rounding step on top of whatever Part B already needs. A cart-level discount has **no per-line representation at all** in `DiscAddP`; the only device mechanism for it is `Subtotal`'s `DiscAddV`/`DiscAddP` (item 3), which is not part of `submitInvoice`'s current seven-step sequence at all - wiring it in would mean inserting a new command between the last `SellPLU...` call and `ReadCurrentReceiptInfo`, a bigger change to the sequence itself. It would also collide directly with the "one and same VAT group" restriction (item 3) the moment a cart mixes VAT classes and carries a cart discount - exactly the kind of cart this store's HS-coded, non-class-A items make possible. Folding the discount into `Price` sidesteps both problems: it needs no new command, and a per-line net price has no VAT-group restriction to violate.

**Design**: for each line, compute a net unit price that already reflects both its own line discount and its proportional share of the cart discount, then send that as `Price` with no `DiscAddP` at all - the device is told the true price actually charged for that line, nothing more.

**Rounding rule** (so the lines still add up to `input.total` to the cent):
1. Apply each line's own discount to get that line's discounted subtotal (`calculateLineTotal`'s own logic, `checkoutMath.ts:116-118` - already correct and already tested; Part B would reuse this exact function's *reasoning*, reimplemented main-process-side the same way docs/phase-158-1 reused `computeVatIncluded`'s reasoning for a different figure).
2. If a cart discount exists, prorate it across lines in proportion to each line's own discounted subtotal (line's share of the pre-cart-discount total), then subtract each line's share.
3. Round each line's net total to 2 decimal places.
4. Sum the rounded line totals and compare to `input.total`. Independent per-line rounding can leave the sum a cent or two off (classic rounding-remainder problem). **Assign the entire difference to the line with the largest quantity-value (or simply the last line, for a deterministic, order-stable rule)** - the standard "largest remainder" fix-up this class of problem always needs, rather than silently accepting a total that's a cent off from what was actually charged.
5. Derive `Price` for that line as `roundedLineNetTotal / quantity` (not `roundedLineNetTotal` itself - the device command's `Price` is a per-unit figure, `Quantity` a separate argument) - **flagging a genuine sub-cent-per-unit edge case**: dividing a rounded line total by a large quantity can reintroduce a fraction the device's own `Price` field (up to 5 decimal places per `tests/fixtures/tremol-defs.xml`'s `SellPLUfromExtDB` definition, `MaxLen="15"`, "up to 5 digits after decimal point") can actually represent more precisely than 2dp currency can - this needs its own explicit worked check during implementation, not assumed away here.

**Files touched**: `checkout.ts`'s `buildFiscalRequest` (the only place that needs to change - it already has every input it needs: `input.items`, each with `.price`/`.discount`, and `input.cartDiscount`), a new small pure function for the proration/rounding (parallel to `checkoutMath.ts`, but main-process-side since `buildFiscalRequest` cannot import a renderer file).

**Tests**: a new unit test for the proration function covering 1b/1c's exact worked numbers (asserting the sum of derived `Price * Quantity` values equals `input.total` to the cent in both cases) plus a three-line, two-VAT-class, cart-discount case (to exercise the "same VAT group" concern that ruled out option (ii) - proving option (i) has no such restriction); a `checkout.test.ts` addition asserting `buildFiscalRequest`'s output items, when summed, equal `input.total`.

**Tripwire tests affected**: this changes `checkout.ts`'s `buildFiscalRequest` - the fiscal suite's own tests that construct a `FiscalInvoiceRequest` from a `CheckoutRequest` with no discount must keep producing byte-identical `unitPrice`/`Price` values (the proration is a no-op when there is no discount, by construction, but this must be asserted, not assumed). **Not verified**: whether any existing fiscal-suite test happens to already carry a `discount` field on a fixture `CheckoutRequest` that would silently change behaviour under this fix - not checked in this audit (would require reading every fiscal test's fixtures, out of this audit's time budget); flagged so it is checked before Part B is built, not after.

**What needs explicit review**: this is the one change in this whole report that alters what is actually sent to the fiscal device - the exact category of change this project's hard rules single out for the most scrutiny. Any reviewer should independently re-derive at least one worked example's `Price` values by hand against `input.total` before approving it.

---

## Item 6 - Interim safeguard (proposed, not built)

**Smallest option: hide the discount controls (`setItemDiscount`/`setCartDiscount`'s UI entry points) whenever the active fiscal provider is the real one, not the mock.**

- The provider identity is already known at runtime - `fiscalProviderFactory.ts` (referenced by `tests/fiscalProviderFactory.test.ts`) is what decides `RealFiscalizationProvider` vs. `MockFiscalizationProvider`; a renderer-visible flag derived from that same decision (e.g. one more field on whatever settings/config object the renderer already reads at startup, mirroring how `printerSettings.mock` already exists for the printer side) would let `PosCheckoutPanel`/the discount UI hide the "Add discount"/"Cart discount" buttons entirely when the real provider is active.
- **Deliberately not a `checkout.ts`-side rejection of a `CheckoutRequest` carrying a discount** - the task says "stop discounts on live fiscal sales", and a UI-level hide is smaller, fully reversible (delete the flag check to restore the feature the moment Part B ships), and does not add a new failure mode to the checkout path itself (no new rejected-request case to test, no risk of blocking a legitimate sale on a false positive). A server-side reject would additionally need to handle "what happens to an in-flight cart that already has a discount applied when this ships" - the UI-hide sidesteps that entirely, since it only prevents *new* discounts from being added, and (per item 1) an already-applied discount still flows through correctly to `input.total`/the receipt's stored data even if the fiscal/printed figures are wrong - nothing about hiding the button needs to touch already-queued orders.
- **Not proposing** to disable price overrides - item 4 already shows overrides are filed and printed correctly; only discounts are the live problem.
- This is not built here, per the task's instruction; it is recorded as the smallest reversible option, ready for a decision on whether the interim risk (an in-progress build gap) outweighs the cost of temporarily removing a cashier-facing feature.

**STOP. Do not implement.**
