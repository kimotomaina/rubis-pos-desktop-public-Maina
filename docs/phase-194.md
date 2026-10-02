# Phase 194 — Per-item VAT class (A, C, D, E), fail-closed: audit and proposal (read-only)

- **Date:** 2026-10-02
- **Requested:** Part 1 only. Audit how a VAT class gets from Shopify to the device and onto the receipt, find every place that does VAT arithmetic, show what happens today to a product carrying class E, propose the smallest change and its tests, then STOP.
- **Outcome:** Audit complete. **Today nothing can put a non-A class on a sale**: the Shopify sync never reads the metafields, so every line is filed as class A at 16%. The device-side code for C/D/E (`_HS` routing) exists but has never been reachable from the till. Seven decisions are needed before Part 2 (§7).
- **Branch / base commit:** staging @ 343b874, tree clean. No source file changed. The device, ZFPLabServer and Shopify were not called.
- **Numbering:** phase 187 is still reserved (phase 188 §header), so this is 194.
- **Proof run:** a throwaway script in the session scratchpad (outside the repo) drove the real `runCheckout`, `RealFiscalizationProvider` and `mapShopifyToSummary` against a mocked HTTP client and an in-memory database. Output in §5.
- **Baseline:** `npx vitest run` gave 153 of 154 files and 2368 of 2369 tests passing. The one failure, `cardManualPayment.test.ts` "has no cardApproval field…", was a 5000 ms cold dynamic-import timeout. It passed when re-run alone, together with `fiscalEngine`, `fiscalRouting` and `mpesaPaymentGate` (76 of 76).

---

## 1. Catalogue: where a line's class comes from

**The sync does not read the metafields.** [PRODUCT_LIST_QUERY](../src/main/services/shopify.ts#L27-L61) asks for id, title, handle, status, image and, per variant, id, title, availability, barcode, image and price. There is no `metafield(...)`, `metafields` or `hs_code`/`hs_name`/`vat_class` anywhere in `src/main/services/shopify*.ts`. Phase 55 recorded this as a known gap ([phase-55.md §"VAT/HS plumbing"](phase-55.md)): "wiring the actual Shopify fetch is a follow-up". It never happened.

| Hop | What it does today | Where |
| --- | --- | --- |
| Shopify node → `ProductSummary` | `mapVariant` copies id, title, price, availability, image, barcode. No class fields. | [shopify.ts:178-200](../src/main/services/shopify.ts#L178-L200) |
| `ProductSummary` / `VariantSummary` types | No `vatClass`, `hsCode`, `hsName`. | [types/shopify.ts:11-35](../src/renderer/src/types/shopify.ts#L11-L35) |
| `products` table | `id, title, variant_id, variant_title, price, inventory_quantity, image_url, barcode`. No class columns. `cacheProducts` and `getCachedProducts` read and write only those eight. | [database.ts:560-569](../src/main/services/database.ts#L560-L569), [:1351-1373](../src/main/services/database.ts#L1351-L1373), [:1393-1432](../src/main/services/database.ts#L1393-L1432) |
| Product → cart line | `buildCartItem` sets id, productId, title, variantTitle, price, image. **Never** `vatClass`, `hsCode` or `hsName`. | [App.tsx:149-163](../src/renderer/src/App.tsx#L149-L163) |
| Cart type | `CartItem` has the three optional fields, documented as "read from the variant's `rubis.vat_class` metafield when present". Nothing sets them. | [types/shopify.ts:59-64](../src/renderer/src/types/shopify.ts#L59-L64) |
| Checkout payload schema | `cartItemSchema` accepts `vatClass`, `hsCode`, `hsName` as free `z.string().optional()`. No allowlist. | [ipcValidator.ts:35-41](../src/main/lib/ipcValidator.ts#L35-L41) |
| `buildFiscalRequest` | `vatClass: item.vatClass \|\| 'A'`, `hsCode: item.hsCode \|\| ''`, `hsName: item.hsName \|\| ''`, and **`taxRate` (the one global rate) on every line**. | [checkout.ts:302-315](../src/main/services/checkout.ts#L302-L315) |

So phase 183 §2's description ("class A lines send VATGrRate 16.00 and others go to `_HS`") is right about the **provider**, but the **cart never supplies a non-A class**. The first half of the chain does not exist.

**The metafield level differs from your brief.** You wrote `product.metafields.rubis.vat_class`. The code comments and phase 55 say **variant** metafields. A variant-level read multiplies the query cost: the query already asks for `variants(first: 250)` on `products(first: 250)`. A product-level read adds three scalar fields per product. See decision D3.

The stored request is the single source of truth for a sale's classes. `queueOrder` writes `fiscal_request_json` in the same transaction as the order, and a retry or resend rebuilds from it verbatim ([fiscal-retry.ts:202-212](../src/main/services/fiscal-retry.ts#L202-L212)). The receipt reads item classes back from it ([index.ts:2797-2806](../src/main/index.ts#L2797-L2806)). A class decided at checkout therefore cannot drift between filing, retry and reprint. This is what keeps "never file twice" intact.

## 2. Tax arithmetic: every place

`VITE_TAX_RATE` has exactly one reader: `taxRate: Number(process.env.VITE_TAX_RATE) || 0` at [index.ts:692](../src/main/index.ts#L692). It is unset-safe only by luck: unset gives `0`, and a class-A line then sends `VATGrRate "0.00"` (the `.env.example` warns of this). The hard-coded `16`, `8`, `0.16` and `0.08` are separate.

| # | Where | file:line | What it does | Class-aware? |
| --- | --- | --- | --- | --- |
| 1 | Checkout, per line | [checkout.ts:306](../src/main/services/checkout.ts#L306) | `taxRate` (0.16) stamped on every line, whatever its class | No |
| 2 | Checkout, invoice | [checkout.ts:317](../src/main/services/checkout.ts#L317) | `taxAmount = total * taxRate`. Additive, wrong for VAT-inclusive prices. Never sent to the device and never read back (docs/phase-159 §B1.3, the `etims.ts:52-55` warning) | No |
| 3 | Checkout, wiring | [checkout.ts:346](../src/main/services/checkout.ts#L346), [:534](../src/main/services/checkout.ts#L534), [:619](../src/main/services/checkout.ts#L619); [index.ts:1330](../src/main/index.ts#L1330) | passes `printerSettings.taxRate` through | n/a |
| 4 | Device, class A | [real-etims-provider.ts:1756](../src/main/services/integrations/real-etims-provider.ts#L1756) | `VATGrRate = (item.taxRate*100).toFixed(2)`. **The only rate the device is told.** Class A only | A only |
| 5 | Device, `_HS` | [real-etims-provider.ts:1772-1783](../src/main/services/integrations/real-etims-provider.ts#L1772-L1783) | no rate sent. The device derives treatment from the HS table | n/a |
| 6 | Receipt, totals | [receiptTotals.ts:128](../src/main/lib/receiptTotals.ts#L128) → [reports.ts:140-141](../src/main/services/reports.ts#L140-L141) | `vatIncluded = round2(total*rate/(1+rate))` on the **whole order total** | **No** |
| 7 | Receipt, totals print | [receiptLayout.ts:404-405](../src/main/lib/receiptLayout.ts#L404-L405) | `TOTAL EXCL. VAT = total − vatIncluded`, and `VAT = vatIncluded`, both from #6 | **No** |
| 8 | Receipt, VAT table | [receiptLayout.ts:142](../src/main/lib/receiptLayout.ts#L142), [:293-300](../src/main/lib/receiptLayout.ts#L293-L300), [:424-436](../src/main/lib/receiptLayout.ts#L424-L436) | rate map `{A .16, B .08, C 0, D null, E 0}`; per row `vat = round2(taxable × rate)`, `gross = taxable + vat`, where `taxable` is the device's stored group amount | Yes, but see §3b |
| 9 | Receipt, no stored groups | [receiptLayout.ts:426](../src/main/lib/receiptLayout.ts#L426) | fallback `{ A: String(rawSubtotal) }`: **every line as class A** | **No** |
| 10 | Receipt, footer | [receiptLayout.ts:461](../src/main/lib/receiptLayout.ts#L461) | the literal `A = VAT 16%. Prices include VAT.` | A only |
| 11 | Receipt, item line | [receiptLayout.ts:285-290](../src/main/lib/receiptLayout.ts#L285-L290) | prints `qty x price amount CLASS`, with `item.vatClass \|\| 'A'` | letter only |
| 12 | Receipt, class source | [index.ts:2805](../src/main/index.ts#L2805) | `line.vatClass \|\| 'A'` from the stored request | letter only |
| 13 | Z report (shift) | [reports.ts:222-223](../src/main/services/reports.ts#L222-L223), [index.ts:2752](../src/main/index.ts#L2752), [:3064](../src/main/index.ts#L3064) | `computeVatIncluded(totalRevenue, taxRate)`, one rate over all revenue | **No** |
| 13b | Z report, shown | [ZReportModal.tsx:134](../src/renderer/src/components/ZReportModal.tsx#L134); [printer.ts:453](../src/main/services/printer.ts#L453) | prints the figure from #13, labelled "calculated at 16%" | **No** |
| 14 | Daily summary | [reports.ts:254](../src/main/services/reports.ts#L254), [index.ts:3090](../src/main/index.ts#L3090) | same formula | **No** |
| 15 | Sales summary | [reports.ts:720-721](../src/main/services/reports.ts#L720-L721), [index.ts:3226](../src/main/index.ts#L3226); shown at [ReportsPage.tsx:271](../src/renderer/src/pages/ReportsPage.tsx#L271) | same formula | **No** |
| 15b | Sales summary, device figure | [reports.ts:787-792](../src/main/services/reports.ts#L787-L792), [:856](../src/main/services/reports.ts#L856) | `deriveGroupVat`: A `amount*16/116`, B `amount*8/108`, C and E `0`, D `'not-known'`. Hard-coded 16 and 8 | Yes (treats the stored amount as **gross**) |
| 16 | Orders CSV | [reportsExport.ts:123](../src/main/services/reportsExport.ts#L123), [index.ts:3365](../src/main/index.ts#L3365) | `computeVatIncluded(order.total, taxRate)` per order, plus raw group columns | **No** (group columns are raw) |
| 17 | Fiscal reconciliation | [reports.ts:949-992](../src/main/services/reports.ts#L949-L992) | `deviceTotal = Σ group amounts`; `matched` if \|deviceTotal − charged\| ≤ 0.01. **Total only, never per group** | Total only |
| 18 | End of Day report | [reports.ts:429-](../src/main/services/reports.ts#L429) | **no VAT arithmetic at all.** Totals by payment method only | n/a |
| 19 | Fiscal status report | [reports.ts:752-766](../src/main/services/reports.ts#L752-L766) | **no VAT arithmetic.** Counts by fiscal status per day | n/a |
| 20 | Shopify order push | [orders.ts:75-100](../src/main/services/orders.ts#L75-L100) | sends `variantId`, `quantity`, `financialStatus: PAID`, note, attributes. **No `taxLines` and no price.** Shopify computes the order's tax from its own store and product tax settings | n/a |
| 21 | Demo / check-fit data | [App.tsx:63-64](../src/renderer/src/App.tsx#L63-L64) | fixed `vatIncluded: 38.62, vatRate: 0.16` for the layout check | n/a |
| 22 | Test page | [printer.ts:800](../src/main/services/printer.ts#L800) | `taxRate: 0` | n/a |

Two consequences for a mixed receipt:
- **#6, #7, #13-16 over-report VAT.** With a C or E line, they still take 16/116 of the whole total. A 1.00 receipt of one exempt item would print `VAT 0.14` when the true VAT is 0.
- **#9 files nothing wrong but prints wrong** when a fiscalised sale has no stored groups (the already-filed recovery path never re-reads the receipt). It would show the whole sale as class A.

### 2b. The same stored number is read two opposite ways (unresolved, device-only)

`fiscal_vat_groups_json` holds the five `SubtotalAmountVATG*` values verbatim.
- **Reconciliation and "VAT from device groups" treat them as gross.** `deriveGroupVat('A', amount) = amount*16/116` and the status compares `Σ groups` to the **charged total** (#15b, #17).
- **The receipt's VAT table treats them as ex-VAT.** `vat = taxable*0.16`, `gross = taxable + vat` (#8; phase 171 §3g calls them "taxable (ex-VAT)").

Both cannot be right. For a 1.00 class-A sale one says VAT 0.14, the other 0.16 and gross 1.16. **No document or fixture settles it:** the only sample, `tests/fixtures/wire/readcurrentreceiptinfo-ok.xml`, is hand-authored ("not captured live"), and no phase before this one stored a live `ReadCurrentReceiptInfo`. **VERIFY-ON-DEVICE.** It does not matter for C and E (0%, so gross equals net), which is why the proposed gate (§6, step 3) enforces the **non-A groups only** until the spare-till proof settles A.

## 3. Device path

**Routing.** `resolveSellCommand` ([real-etims-provider.ts:1703-1724](../src/main/services/integrations/real-etims-provider.ts#L1703-L1724)): `vatClass = item.vatClass ?? this.defaultVatClass`; exactly `'A'` goes to `SellPLUfromExtDB`, **anything else goes to `SellPLUfromExtDB_HS`**. Details that matter:
- `??` only falls through on `undefined`/`null`. A blank string is not "no class" here (see §5; `checkout.ts` shields it with `||`).
- `defaultVatClass` is an Admin field ("Default tax class", [AdminScreen.tsx:749](../src/renderer/src/components/AdminScreen.tsx#L749), schema at [ipcValidator.ts:692](../src/main/lib/ipcValidator.ts#L692), any non-empty string). Setting it to `E` would route every class-less line to `_HS`. `checkout.ts` always supplies a class, so it is dormant today, but it is a fail-open knob.
- Before any of this, `validateFiscalInvoiceRequest` runs ([real-etims-provider.ts:993](../src/main/services/integrations/real-etims-provider.ts#L993)). It uses `item.vatClass ?? 'A'` against `{A,B,C,D,E}` and **refuses** (`kind: 'data'`) an unknown class, or a non-A class with a blank HS code or HS name ([fiscal-validate.ts:59-69](../src/main/services/integrations/fiscal-validate.ts#L59-L69)).

**What `_HS` sends** ([:1772-1783](../src/main/services/integrations/real-etims-provider.ts#L1772-L1783)): `NamePLU`, `Price`, `HSCode`, `Quantity`, and `DiscAddP` only when set. **No class, no rate, no unit, no HS name.** The device decides the group from its HS table (`ReadHScode` returns `OptionTaxable` 1 exempt or 0 taxable, and `VAT_Rate`; `ProgHScode` sets them). So for `_HS` lines **the app's class letter is only a claim**. The device's group subtotal is the evidence. This is the reason a per-group check is worth building.

`SellPLUfromExtDB` (class A) sends `NamePLU`, `OptionVATClass=A`, `Price`, `MeasureUnit`, `HSCode`, `HSName`, `VATGrRate`, `Quantity`, `DiscAddP`.

**What `ReadCurrentReceiptInfo` returns and where it goes** (step 5, [:1152-1182](../src/main/services/integrations/real-etims-provider.ts#L1152-L1182)): `OptionIsReceiptOpened`, `SalesNumber`, `SubtotalAmountVATGA…GE` (up to 13 characters each), plus format and power-down flags. Today the only gate is `receiptOpened && Σ groups > 0`. It then reaches `extractVatGroupAmounts` ([:1831-1840](../src/main/services/integrations/real-etims-provider.ts#L1831-L1840)), which keeps the raw strings and omits an absent group, and the result rides `FiscalInvoiceResult.vatGroups`. Storage: `orders.fiscal_vat_groups_json TEXT`, written by `setOrderFiscalInfo` with `COALESCE(fiscal_vat_groups_json, ?)`, so **write-once** ([database.ts:1892-1908](../src/main/services/database.ts#L1892-L1908)). It is one JSON column holding five groups, not five columns. The already-filed recovery path never runs step 5, so it stores `NULL`.

**Not checked today:** nothing compares a group to what the sale's lines should have put there. A line the device files in the wrong group (HS-table mismatch) would pass step 5 and be filed permanently at `CloseReceipt`, which has no undo (no credit-note path in the POC).

## 4. Receipt today

- **Item line:** name, then `qty x unit-price amount CLASS`, right-aligned ([receiptLayout.ts:285-290](../src/main/lib/receiptLayout.ts#L285-L290)). The letter is the class (`'A'` when absent). No rate, no HS code. Per-line discount is printed as "Discount: -x" under it.
- **Totals:** `TOTAL EXCL. VAT`, `VAT`, `TOTAL KSH`. `TOTAL` is the stored order total. VAT is the single-rate extraction (#6).
- **VAT table** (fiscalised only): one row per stored group, `letter rate taxable vat gross` (#8).
- **Footer:** `A = VAT 16%. Prices include VAT.` Nothing explains C, D or E.
- **PDF fallback** uses the same `buildReceiptLayout` ([pdf-receipt.ts:92-118](../src/main/services/pdf-receipt.ts#L92-L118)), so a change is made once.
- **KRA sample invoice** (VIL manual p. 14, an image; extracted and read): columns `DESCRIPTION | HS CODE | QTY | PRICE(INCL.) | VAT % | AMOUNT`. Lines show `16.00` in the VAT % column. Below: `TOTAL: 905,880.03`, `VAT: 144,940.77`, `TOTAL DUE: 1,050,820.80`, so TOTAL is ex-VAT, VAT is the tax, and TOTAL DUE equals the sum of line AMOUNTs (gross). It has **no per-class table and no letter**. Today's receipt differs from it: a letter in place of the rate, no HS code column, and its VAT table is an addition (phase 171). For a C/E line, a rate column would read `0.00` for **both**, so the sample's format alone cannot tell zero-rated from exempt. See D5.

## 5. What happens today to a product carrying `vat_class` E? (proved)

**It is filed as class A, at 16%.** Not because the class is mapped wrongly, but because the metafield never leaves Shopify. Script `proof194.ts` (session scratchpad, not in the repo), run with `npx vite-node`, mocked HTTP, in-memory database. A product node carrying the E metafield, mapped by the real `mapShopifyToSummary`:

```
MAPPED VARIANT: {"id":"gid://shopify/ProductVariant/2","productId":"1","title":"D","price":1,"availableForSale":true,"inventoryQuantity":0,"image":null,"barcode":null}
```
No class, no HS fields. Then the real `runCheckout` with the cart line shaped exactly as `buildCartItem` shapes it, filed through the real provider:

```
CHECKOUT: true fiscal_status= fiscalized
WIRE SELL: <Command Name="SellPLUfromExtDB"><Args><Arg Name="NamePLU" Value="Maize"/><Arg Name="OptionVATClass" Value="A"/><Arg Name="Price" Value="1"/><Arg Name="MeasureUnit" Value="pcs"/><Arg Name="HSCode" Value=""/><Arg Name="HSName" Value=""/><Arg Name="VATGrRate" Value="16.00"/><Arg Name="Quantity" Value="1"/></Args></Command>
STORED REQUEST item: {"description":"Maize","quantity":1,"unitPrice":1,"taxRate":0.16,"pluCode":"gid://shopify/ProductVariant/2","vatClass":"A","hsCode":"","hsName":""}
```
The `WIRE SELL` line is the **golden for "nothing changes for class A"**. Part 2's tests must reproduce it byte for byte.

**The provider's behaviour for each raw class value** (same script; one line item, HS code and name present, direct to `submitInvoice`):

| `vatClass` | Today | Sell command |
| --- | --- | --- |
| `undefined` | filed | `SellPLUfromExtDB`, A, 16.00 |
| `""` (blank) | **refused** (`data`): `VAT class "" is not one of A/B/C/D/E` | none sent |
| `A` | filed | `SellPLUfromExtDB`, A, 16.00 |
| `B` | filed | `SellPLUfromExtDB_HS` |
| `C`, `D`, `E` | filed | `SellPLUfromExtDB_HS` |
| `e`, ` E`, `Z` | **refused** (`data`) | none sent |

Two corrections to the brief's premise, both important:
1. **A blank class is class A today, but only through `runCheckout`** (`item.vatClass || 'A'`). The provider alone refuses it.
2. **An unknown class is not class A today. It is refused**, and the sale lands in `needs_fixing` with the cash already taken. "Unknown → A at 16%" is therefore a behaviour **change**, not "exactly as today". It is the safer direction for the till (the sale files) and the riskier one for the tax (an exempt item filed at 16%, permanently). See D2.

## 6. Proposed change, smallest first

All "no change for class A" claims are gated by the golden in §5. New code follows the repo's JSDoc-only comment style.

| Step | File | Change | Behaviour change for class A |
| --- | --- | --- | --- |
| 1 | **new** `src/main/lib/vatClass.ts` | Pure, no I/O. `type VatClass = 'A'\|'C'\|'D'\|'E'`. `resolveVatClass(raw: unknown): VatClass` — `typeof raw === 'string'`, `trim().toUpperCase()`, exact member of the set, **otherwise `'A'`**. Also `expectedGroupTotals(lines)` (Σ `round2(unitPrice*quantity)` per resolved class) and `compareVatGroups(expected, device, {enforce})`. **The single place the default lives.** | none |
| 2 | `fiscal-validate.ts` | Use `resolveVatClass`. The "not one of A/B/C/D/E" branch becomes unreachable and is removed. **Keep** "HS code and HS name required for a non-A class" (the sale's data, refused before any device call). | none |
| 3 | `real-etims-provider.ts` | (a) `resolveSellCommand`: `resolveVatClass(item.vatClass)`; `'A'` → `SellPLUfromExtDB`, others → `_HS`. **Stop reading `this.defaultVatClass`.** (b) After step 5, **before `CloseReceipt`**: if the sale has any non-A line, compare device groups C, D, E (and B must be 0.00) to `expectedGroupTotals`. A mismatch means `rollback()` (existing `CancelReceipt`), return `{ok:false, kind:'system', retryable:false}` with a reason naming the group. **Never reaches `CloseReceipt`, so nothing is filed.** An A-only sale skips the new check and sends the same commands as today. | none for an A-only sale |
| 4 | `checkout.ts` `buildFiscalRequest` | `vatClass: resolveVatClass(item.vatClass)`. `taxRate` is `taxRate` for A and `0` for others. `hsCode`/`hsName` as today. | none |
| 5 | `receiptLayout.ts`, `receiptTotals.ts`, `index.ts:2805` | Item classes via `resolveVatClass`. `vatIncluded` = Σ over **class-A lines** of `round2(amount*rate/(1+rate))`, others 0 (not the whole total). Fallback table (#9) builds rows from item classes, not `{A: rawSubtotal}`. Footer keys the classes **present on that receipt**. | none for an A-only receipt (same numbers) |
| 6 | `reports.ts`, `reportsExport.ts` | One helper `orderVatIncluded(order, rate)`: parse `fiscal_request_json`, Σ class-A lines; if absent or unparsable, the legacy formula. Used by #13-16. Reconciliation row gains per-group `expected` and the same `compareVatGroups` (non-A groups only) next to the existing total check. | none for an A-only order (identical figure) |
| 7 | Sync | `shopify.ts` query: product-level `metafield(namespace:"rubis", key:…){value}` aliased to `vatClass`, `hsCode`, `hsName`; `shopify-types.ts`; `mapShopifyToSummary` copies them to every variant; `VariantSummary` gains the three optionals; `database.ts`: three TEXT columns by the existing idempotent `ALTER TABLE` pattern, `cacheProducts`/`getCachedProducts` read and write them; `App.tsx` `buildCartItem` passes them. | **none until a product carries a metafield** |

Order: 1, 2, 3, 4 first. They are unreachable for non-A (no source) and invisible for A. Then 5 and 6, then 7 last, because step 7 is the switch that lets a non-A line exist. **A product with no metafield stays class A, so the pilot till stays class A as long as no product in its Shopify store carries `rubis.vat_class`.** Part 2 must keep that true until the spare-till proof passes.

**Why the offline cache matters (step 7).** `products:fetch` falls back to the `products` table when offline ([database.ts:1393](../src/main/services/database.ts#L1393)). If the class columns were skipped, an offline till would silently turn every exempt product into class A. Without the columns the default becomes a hidden tax change.

**What stays out:** `VITE_TAX_RATE` for class A, the discount refusal ([index.ts:1278-1289](../src/main/index.ts#L1278-L1289), [requestHasDiscount.ts](../src/main/lib/requestHasDiscount.ts)), retry and resend, `verifyAlreadyFiled`, the write-once columns, and credit notes. None is touched, so "never file twice" is unchanged: the new refusal happens before `CloseReceipt`, and a refused sale is flagged for a person, never resent.

### Test list (Part 2)

New `tests/vatClass.test.ts`, plus cases in `realEtimsProvider`, `runCheckout`, `receiptLayout`, `reports`, `shopifyService`/`database`.

1. **Resolver:** `A`, `C`, `D`, `E` → themselves; `undefined`, `null`, `''`, `'  '`, `5`, `'Z'`, `'AA'` → `A`; `' e'` → `E` (D1); `B` per D1.
2. **Wire per class**, through the real provider with a recording client:
   - `A`, `undefined`, `''`, `'Z'` → `SellPLUfromExtDB`, byte-identical to the §5 golden, **no `_HS` in the command list**.
   - `C`, `D`, `E` → `SellPLUfromExtDB_HS` with exactly `NamePLU, Price, HSCode, Quantity`, no `OptionVATClass`, no `VATGrRate`.
   - `defaultVatClass: 'E'` set on the provider → a class-less line is still `A`.
3. **Checkout:** stored `fiscal_request_json` carries the resolved class per line, `taxRate` 0 on non-A lines. Blank, unknown and absent all store `A`.
4. **Mixed receipt** (A + C + E): the stored `fiscal_vat_groups_json` equals the device fixture's strings **verbatim**; the printed VAT-table rows equal those amounts; `VAT` counts only the A line; the footer lists A, C and E only.
5. **Group gate:** device returns the E amount in group C → sale refused with `kind:'system'`, `retryable:false`; the command list ends `…ReadCurrentReceiptInfo, CancelReceipt` with **no `CloseReceipt`** and exactly one `OpenInvoice`. Matching groups → files. A-only sale → command list identical to today's.
6. **Discount refusal:** a cart with a C line and a discount is still refused (`shouldRefuseCheckoutForDiscount`).
7. **Reports:** Z, daily, sales summary and CSV VAT exclude C/E amounts; an A-only order's figure is unchanged to the cent; an order without a stored request uses the legacy formula.
8. **Reconciliation:** per-group `expected` vs device; a non-A group disagreement is `mismatch` even when the total matches.
9. **Sync:** the mapper copies product-level metafields to every variant; absent metafield → `undefined`; a database created before this change gains the columns and `cacheProducts`/`getCachedProducts` round-trip them; the offline path keeps the class.
10. **Tripwires unchanged:** the fiscal engine and routing tests and `mpesaPaymentGate.test.ts` pass unmodified.

### Mutation checks (each applied by hand, run red, reverted, recorded in the build phase)

| # | Mutation | Test that must fail |
| --- | --- | --- |
| M1 | In `resolveVatClass`, return the input instead of `'A'` for unknown | test 2 (`'Z'` reaches `_HS`) and test 1 |
| M2 | Swap C and E in the class → expected-group mapping (and the receipt row mapping) | tests 4 and 5 |
| M3 | Delete the per-group comparison in step 3 | test 5 (a `CloseReceipt` is sent, the sale files) |
| M4 | Make `resolveSellCommand` read `defaultVatClass` again | test 2, `defaultVatClass: 'E'` case |
| M5 | Stamp the global `taxRate` on non-A lines again | test 3 |
| M6 | Compute receipt `vatIncluded` from the whole total again | test 4 |

### Part 2 spare-till proof, as agreed

`ReadHScode` for the five codes (read-only), then **one** 1 KSh class C sale and **one** 1 KSh class E sale, each attempted **once**, receipt and reconciliation compared with the device's per-group totals. The proof should also settle:
- which **group** each HS code lands in (the gate assumes class letter = group letter, so confirm it);
- whether **group A is gross or net** (§2b), by one extra 1 KSh class-A line on the same receipt;
- what a code that is not in the table does (the 0x40 refusal, from phase 188), so the sync can warn.

The pilot till stays class A until all of that is recorded.

## 7. Decisions needed before Part 2

| # | Question | Recommendation |
| --- | --- | --- |
| **D1** | **Class B.** The device has B at 8.00 and today B routes to `_HS`. Your list omits it, so under "unknown → A" an 8% item would be filed at 16%. Is B in or out? Also whether `D` stays (it is on the device at 0.00 and has no KRA code in use). | Keep B and D supported, as today; they cost nothing and an 8% item must not become 16%. If you want B out, say so and it falls to A. |
| **D2** | **Unknown class → A** is a change (§5): today it is **refused**, and refusal is the fail-closed direction for tax, since a filing is permanent. | Follow your rule (unknown → A), **trim and upper-case first** so `e` and ` E` still mean E, and log one warning with the product id. |
| **D3** | **Product-level or variant-level metafield?** You wrote product; the code and phase 55 say variant. Variant level raises the query cost on an already 250 × 250 query. | Product level, as you wrote it. |
| **D4** | **A non-A line with a missing or malformed HS code.** Today this is refused before the device, but **after** the sale is saved and paid, so the cash is taken and the sale cannot be filed. | Refuse it at the `orders:checkout` gate, beside the discount refusal, naming the item, so nothing is saved or paid. |
| **D5** | **Receipt per-line marking.** The KRA sample prints a VAT % column. Both C and E read `0.00`. | Keep the letter, add a key of the classes on the receipt, and leave the rate column out. |
| **D6** | **Are Z, daily, sales-summary and CSV VAT in scope?** Without step 6 a C/E sale overstates VAT on every report. | In scope (step 6). It is the part most likely to be wrong and then relied on at month end. |
| **D7** | **Which HS code maps to which class.** You gave five KRA codes but not their classes. The proof will show them via `ReadHScode`, and the gate assumes class letter = group letter. | I will not hard-code a code-to-class table. The metafields carry both; the gate and the proof catch a mismatch. Tell me if you want an allowlist of the five codes instead. |

## 8. Possible impact (of the proposal)

- **Direct:** a product with `rubis.vat_class` set files through `_HS` with its HS code; receipts and reports stop attributing its amount to 16% VAT.
- **Indirect:** retries and reprints read the stored request, so a class is fixed at checkout. A device that disagrees on a group now stops the sale before filing, leaving it `needs_fixing` and paid. That is the cost of the gate, and D4 narrows it.
- **Data:** three additive nullable columns on `products`. No orders-table change; no rewrite of existing rows.
- **Security:** `vatClass` and `hsCode` are renderer-supplied (the same trust the price already has, [requestHasDiscount.ts](../src/main/lib/requestHasDiscount.ts) §"price override"). The resolver is an allowlist in the main process, so a forged value can only become a known class or A. A renderer that sends `E` for a taxable product still files it as E, exactly as it can already understate a price. A main-side lookup by variant id from the `products` table would remove that, but it is a larger change and I have not proposed it.
- **Idempotency:** the resolver is pure; the migration reuses the existing swallow-if-exists `ALTER TABLE`; the gate runs before the point of no return.
- **Residual risk:** the group A basis (§2b), the group each HS code lands in, and the real shape of `ReadCurrentReceiptInfo`, are all unverified and are what the spare-till proof is for.

## 9. Observed but not changed

1. **`VITE_TAX_RATE` unset sends class A at `VATGrRate "0.00"`.** The device's own A rate is 16.00 (phase 188). Pinning A to 16.00 would remove an env-dependent mis-filing. It is a class-A behaviour change, so it is left out of this work.
2. **`taxAmount = total * taxRate`** ([checkout.ts:317](../src/main/services/checkout.ts#L317)) is additive and wrong for VAT-inclusive prices. It is write-only; phase 159 recorded it.
3. **The Admin "Default tax class" field** accepts any string and is stored in the integration config. Step 3 stops it driving routing; the field itself can then be removed in a later phase.
4. **Shopify orders carry no tax lines**, so Shopify's own tax for a C/E product depends on that product's "Charge tax" setting in the store. The POS cannot control it. Worth a check of the metafield setup and the store's product tax flags together.
5. **Phase 171 and phase 163 disagree on the stored group amounts** (§2b). Whichever way the proof resolves, one of reconciliation or the receipt table needs a one-line fix, in a separate phase.
6. **Stale cart on reclassification.** A cart line persisted in `localStorage` keeps the class it had when added, exactly as it keeps its price.
7. **The default class `'A'` is written four times**: `real-etims-provider.ts:93`, `fiscal-validate.ts:22`, `checkout.ts:312` and the literals at `receiptLayout.ts:287` and `index.ts:2805`. Step 1 collapses them into one resolver.

## 10. Verification and rollback

- **Run:** the proof script (§5), `npx vitest run` (§header), `git status --short` empty before and after. Everything read: `checkout.ts`, `shopify.ts` (lines 1-400 and 596-682), `real-etims-provider.ts` (lines 930-1300 and 1660-1974), `fiscal-validate.ts`, `etims.ts`, `reports.ts` (lines 100-270, 395-470, 640-1040), `receiptLayout.ts` and `receiptTotals.ts`, the relevant parts of `database.ts`, `index.ts`, `orders.ts`, `printer.ts`, `reportsExport.ts`, the VIL manual p. 14 and phases 55, 159, 163, 171, 183, 188 and 193.
- **Not run:** anything against the device, ZFPLabServer or Shopify; the typecheck.
- **Rollback:** nothing changed in code. Delete this file.


---

# Part 2: built as agreed (2026-10-02)

- **Outcome:** Built in three local commits on staging, on top of 4757dc8. Not pushed, not installed, nothing sent to a device, ZFPLabServer or Shopify. The spare-till proof (the `ReadHScode` reads and the two 1 KSh sales) was **not** run: this brief stops after the three commits.
- **Commits:**

| # | Commit | Steps | Tests added |
| --- | --- | --- | --- |
| 1 | `c1aa92e` resolver, validator, provider routing, group gate, request builder, checkout gate | 1 to 4 | `vatClass.test.ts` (41), `vatClassFiscal.test.ts` (30) |
| 2 | `4d53fa7` receipt, receipt totals, receipt class source, reports, CSV, reconciliation | 5 and 6 | `vatClassReceiptReports.test.ts` (30) |
| 3 | `a214b7f` sync, types, three `products` columns, cache round-trip, cart line | 7 | `vatClassSync.test.ts` (15) |

- **Report placement:** you asked for Part 2 to be appended to this file, so it is. That departs from the one-new-phase-doc-per-task habit, on your instruction.

## P2.1 The decisions, as built

| Decision | Built as |
| --- | --- |
| **D1** keep B and D | `VAT_CLASSES = A B C D E` ([vatClass.ts](../src/main/lib/vatClass.ts)); B, C, D, E all route to `SellPLUfromExtDB_HS`. Footer keys: `A = VAT 16%`, `B = VAT 8%`, `C = Zero rated`, `D = Other rate`, `E = Exempt` (the VIL rate table, phase 65), printed only for classes on the receipt. |
| **D2** absent or blank → A, other unknown → refused | `resolveVatClass` returns `A` for `undefined`, `null`, `''` and whitespace, the class for A to E (trimmed and upper-cased, so `e` and ` E` mean E), and **`null` for anything else**. `null` is never turned into A: the gate refuses it before anything is written, `buildFiscalRequest` keeps the raw value so the provider's validator refuses it if the gate were ever bypassed, and the provider cannot reach `_HS` with it (the routing function throws on `null`, unreachable after validation). |
| **D3** product-level metafields | `PRODUCT_LIST_QUERY` reads `metafield(namespace: "rubis", key: …)` for `vat_class`, `hs_code`, `hs_name` on the product, aliased, none under `variants`. A test asserts that. |
| **D4** refuse non-A with blank or malformed HS code | [vatClassGate.ts](../src/main/lib/vatClassGate.ts), `findVatClassRefusal`, with the form `^\d{4}\.\d{2}\.\d{2}$`. Names the item (`"Maize flour (2kg)"`). |
| **D5** letter plus key | Item line still ends in the class letter; footer key as above. For an all-A receipt the footer is the old string, character for character. |
| **D6** reports in scope | `orderVatBase` and `sumVatBase` in [reports.ts](../src/main/services/reports.ts), used by the Z report, daily summary, sales summary and the orders CSV. |
| **D7** no code-to-class table | None. The metafields carry class and HS code; the group gate and reconciliation compare the device's groups with the lines. |

## P2.2 What changed, by commit

**Commit 1.**
- `vatClass.ts` (new): the resolver, `hasNonAClass`, `expectedGroupTotals`, `compareVatGroups`, `HS_CODE_PATTERN`. Pure.
- `vatClassGate.ts` (new): the D2/D4 gate.
- `fiscal-validate.ts`: uses the resolver; a non-A line still needs an HS code and name.
- `real-etims-provider.ts`: `resolveSellCommand` uses the resolver and no longer reads `defaultVatClass`; after `ReadCurrentReceiptInfo` and **before `CloseReceipt`**, a sale with any non-A line has its B, C, D and E group amounts compared with its lines. A mismatch means `CancelReceipt` and `{ ok:false, kind:'system', retryable:false }`, naming every group that disagrees. A sale with only class-A lines skips the comparison.
- `checkout.ts` `buildFiscalRequest`: resolved class per line, `taxRate` 0 on non-A lines. `runCheckout` runs the gate first, before the staff check, the payment gates and `queueOrder`. The M-Pesa gate block is untouched.

**Commit 2.**
- `receiptTotals.ts`: VAT from the class-A lines alone when another class is on the receipt; the legacy whole-total extraction otherwise.
- `receiptLayout.ts`: item class through the resolver; the fallback VAT table (no stored device groups) built from the lines per class instead of the whole sale as A; the footer key.
- `index.ts`: the receipt's per-item class read from the stored request through the resolver.
- `reports.ts`, `reportsExport.ts`: `orderVatBase`; the aggregate is `computeVatIncluded(Σ orderVatBase)`, so an all-A set gives exactly `computeVatIncluded(Σ total)`.
- `database.ts`: `getOrdersForShift` now also selects `fiscal_request_json` (the Z report needs it).
- Reconciliation: a row gains `expectedByGroup` and `groupMismatch`; a non-A group that disagrees with the lines makes it a `mismatch` even when the totals agree.

**Commit 3.**
- `shopify.ts`, `shopify-types.ts`: the query and the mapper. Only a non-blank trimmed value is carried, so a product without metafields maps to the same variant object as before.
- `types/shopify.ts`: optional `vatClass`, `hsCode`, `hsName` on `VariantSummary`.
- `database.ts`: three nullable `TEXT` columns on `products` (in `SCHEMA.products` and by the idempotent `ALTER TABLE`); `cacheProducts` and `getCachedProducts` round-trip them.
- `buildCartItem` moved from `App.tsx` to `lib/cartItem.ts` so a test can drive it; it adds the three fields only when present.

## P2.3 Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean after each commit |
| Full suite after commit 3 | **158 files, 2485 tests, all passing** (baseline 154 files, 2369 tests, one cold-import timeout that passed on re-run). 116 tests added |
| Class-A golden, wire | `tests/fixtures/vat-class-a-golden.json`, captured on the **pre-change** build: three sales (1 KSh; two lines with a special character and quantity 3; buyer PIN and company). Every command **and every request body** is compared with it byte for byte, through `runCheckout` and again through Shopify node → cache → cart → checkout. The §5 `WIRE SELL` line is also asserted as a literal |
| Class-A golden, receipt | `tests/fixtures/receipt-class-a-golden.json`, 6 all-A scenarios at widths 48 and 32, captured pre-change by stashing the source |
| `electron-vite build` | built; `verify-no-mock-provider.cjs`: neither mock provider is in `out/main` |
| `check:fit` | **Not completed, and not needed for this change (your call).** Baseline on 4757dc8: 283 measured and fit, 9 failed, every failure being `Admin > Needs Attention: card not found` (one per window size). After the changes, one run reached 264 fit cases with the same 9 `Needs Attention: card not found` failures and nothing else failing, then the harness died with `Timed out waiting for: CDP endpoint up` (Electron did not start in time, a launch flake, not a fit result). A second run was abandoned on your instruction. **Needs Attention count: 9, equal to baseline.** No screen layout was touched; the only renderer changes are `buildCartItem` moving files and two optional type fields |

**Tripwires, `git diff --stat 4757dc8`:** `fiscal-engine.ts`, `fiscal-routing.ts`, `fiscal-retry.ts`, `build/installer.nsh`, `electron-builder.yml`, `updater.ts`: **all empty**. In `checkout.ts` the three changed hunks are the imports, `buildFiscalRequest` and the gate at the top of `runCheckout`, all before the M-Pesa gate block. No diff line mentions `COALESCE` or `verifyAlreadyFiled`. `mpesaPaymentGate.test.ts`, `fiscalEngine`, `fiscalRouting` pass unmodified.

### Mutation checks, each applied by hand, run red, then reverted

| Mutation | Result |
| --- | --- |
| **M1a** unknown class resolves to A (the old default) | 11 failed |
| **M1b** unknown class passes through unchanged (reaches `_HS`) | 12 failed |
| **M2** swap C and E in the expected-group mapping | 6 failed (commit 1 tests), 6 failed (commit 2 tests) |
| **M2r** swap C and E in the receipt's fallback table | 1 failed |
| **M3** remove the per-group comparison before `CloseReceipt` | 3 failed (a `CloseReceipt` is sent and the sale files) |
| **M4** provider reads `defaultVatClass` again | 1 failed |
| **M5** global `taxRate` on non-A lines | 1 failed |
| **M6** receipt VAT from the whole total | 3 failed |
| **M7** the gate never refuses | 4 failed |
| **M8** report VAT from the whole total | 5 failed |
| **M9** remove the reconciliation per-group comparison | 1 failed |
| **M10** footer key always the legacy `A` string | 1 failed |
| **M12** shift query without the stored request | 1 failed |
| **M13** fallback VAT table the whole sale as A | 1 failed |
| **M14** a product without the metafield gets a class | 9 failed |
| **M15** to **M20** mapper, cache insert, rehydrate, cart line, query and migration each broken | 1 to 5 failed each |

After every mutation the file was restored and the file's tests re-run green.

### Tests you asked for, and where

1 resolver: `vatClass.test.ts`. 2 wire per class, golden, `defaultVatClass` ignored: `vatClassFiscal.test.ts`. 3 request per class: same file. 4 mixed receipt (A + C + E, from a real checkout, device strings stored verbatim, rows equal the returned amounts, VAT from the A line only, footer): `vatClassReceiptReports.test.ts`. 5 group gate (E amount in group C refused before `CloseReceipt`, one `OpenInvoice`, ends `ReadCurrentReceiptInfo, CancelReceipt`): `vatClassFiscal.test.ts`. 6 discount refusal with a C line: same file. 7 reports and CSV: `vatClassReceiptReports.test.ts`, including a real shift and a real database. 8 reconciliation: same file. 9 sync, cache, old-database migration: `vatClassSync.test.ts`. 10 tripwires: above. Also asked for: the gate names the item, a blank class files as A, and the D4 refusal writes no order row and no payment row (a manual M-Pesa sale, `hasRecordedMpesaPayment` false, no order 1).

## P2.4 Things I did that you did not list, or that differ

1. **The gate is in `runCheckout`, not in the `orders:checkout` handler in `index.ts`.** The handler calls `runCheckout`, so every checkout passes through it; and it is the only place a test can prove "before `queueOrder`" against a real database. It also runs in mock-provider mode, where an unknown class is equally wrong.
2. **The gate also refuses a non-A line with a blank HS name**, which D4 does not say. The validator already refuses that after the sale is paid (the VIL manual asks for an HS description on every non-16% item), so the gate mirrors the validator exactly. Without it, a product with a class and a code but no name would be sold and then stuck.
3. **`defaultVatClass`** stays in the provider's options type so the Admin setting still saves, but the private field is gone (the repo's `noUnusedLocals` rejects an unread one). §9.3 (removing the Admin field) stays for its own phase.
4. **The provider on its own now treats a blank class as A**; before, it refused it and only `runCheckout` shielded that.
5. **I broke two tests in commit 2 and my first run missed it.** My test selection used `tests/reports…`, which does not match `reportRanges.test.ts`, whose two reconciliation tests assert the exact shape of a group entry. The full suite caught it. I moved the per-group figure out of the group entry into a separate row field (`expectedByGroup`) so the existing shape is unchanged, and folded the fix into commit 2 with a fixup and autosquash, before any push. The fixed commit 2 passed the full suite.
6. **One existing test fixture changed:** `tremolConformance.test.ts` fed a sale with a 150 KSh class C line a device answer holding only group A, which the new gate rightly refuses. Its answer now holds `A 120.00` and `C 150.00`. `database.test.ts` gained three `null`s in its expected insert parameters.
7. **Line endings:** the working tree is CRLF with `core.autocrlf=true`; my new files are LF and git warns that it will convert them. Content is unaffected.

## P2.5 What is still unverified, and what has not been done

- **Not tested through the IPC layer:** the `index.ts` line that reads each item's class for the receipt (no test mounts that handler, as in phase 158-1). It is a one-line map through the same resolver the tests cover.
- **Group A basis (§2b) is still open.** The gate does not compare group A; the receipt table and reconciliation still read it in opposite ways. That is §9.5, its own phase after the proof.
- **The group each HS code lands in** is still an assumption (class letter = group letter), enforced by the gate and reconciliation, and only the spare-till proof can confirm it.
- **Not in this phase, as you said:** §9.1 (`VITE_TAX_RATE` unset sends 0.00), §9.3 (remove the Admin default tax class field), §9.5 (gross versus net).
- **The pilot till stays class A.** The sync change ships dark: a product with no `rubis.vat_class` metafield is class A and its traffic is pinned to the pre-change golden. Do not set the metafield on any pilot-store product until the proof passes.
- **Next, after your review:** the spare-till proof as in Part 1 §6: `ReadHScode` for the five codes, then one 1 KSh class C and one class E sale, each attempted once, receipt and reconciliation checked against the device's group totals.
