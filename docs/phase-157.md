# Phase 157 - Admin Reports audit (read-only)

- **Date:** 2026-09-26
- **Requested:** A read-only audit of the Admin "Reports" area: what exists today, what data the till actually stores, every suspected gap confirmed or disproved with evidence, how Rubis's report list maps onto till vs Shopify vs the platform layer, the Shopify profit-reporting route, a smallest-possible design proposal (not built), and the decisions someone needs to make. No code changed, nothing built, no SQL run against a real database, no command sent to the fiscal device or ZFPLabServer, no Shopify write call made.
- **Outcome:** No change needed - audit only, as instructed.
- **Branch / base commit:** staging @ fd90cbb (Phase 156 - on-screen keypad, cart/stock-take/M-Pesa fields).

**Method note:** every claim below carries a `file:line`. A conclusion drawn from more than one fact is labelled **Inference:**. Anything I could not check from inside this repository - the fiscal protocol PDF, the "Rubis Clarifications - Filled" document, the KRA system-requirements document, live device behaviour, the store's actual Shopify scopes - is labelled **Not verified:**. None of these documents were found in the repository; where the task brief itself quotes their content, I have used the brief's own wording and said so.

Safety rules observed throughout: no XML or HTTP request was sent to a fiscal device or ZFPLabServer (the SDK definitions file was only read as a local text file); no SQL was run against any database, real or otherwise (all schema facts come from reading `database.ts`'s own `CREATE TABLE` strings); no Shopify write call was made (one `shopify.dev` documentation page was fetched for Part 5); no device password appears anywhere below.

---

## PART 1 - What exists today

### 1. `src/main/services/reports.ts` - every function

| Function | Line | Date basis | Filters | Output |
| --- | --- | --- | --- | --- |
| `getUtcDayRange` | reports.ts:82 | UTC calendar day (`Date.UTC` on the given date's Y/M/D) | none | `{ startIso, endIso }` |
| `generateZReport` | reports.ts:106 | Shift-bounded, not a calendar day at all - every order with that `shift_id` | `excludeVoided` (reports.ts:54, drops `status === 'voided'`) | `ZReport`: totals by payment method, order count, total revenue, total tax (`totalRevenue * taxRate`, see G2 below), expected/ending cash, discrepancy |
| `generateDailySummary` | reports.ts:153 | UTC calendar day by default (`getUtcDayRange()`), but the `range` parameter accepts any `{startIso,endIso}` - see G4's nuance | `excludeVoided` | `DailySummary`: order count, total revenue, total tax, totals by method |
| `getLocalDayRange` | reports.ts:194 | Africa/Nairobi calendar day, fixed UTC+3 offset (no DST, reports.ts:172-180 explains why a fixed offset is correct for Kenya) | n/a (a pure date-math helper) | `{ startIso, endIso }` |
| `localDayOf` | reports.ts:211 | Inverse of the above - which Nairobi day an ISO instant falls on | n/a | `YYYY-MM-DD` |
| `todayLocalDay` | reports.ts:227 | Today, Nairobi | n/a | `YYYY-MM-DD` |
| `generateEndOfDayReport` | reports.ts:310 | One Africa/Nairobi calendar day (`getLocalDayRange`) | `excludeVoided` on both today's orders and today's M-Pesa payments (reports.ts:316, 336, 357) | `EndOfDayReport`: per-cashier totals (cash/mpesa/card, and M-Pesa split into `manual`/`daraja`, reports.ts:238), every manual M-Pesa entry recorded that day, carry-over (unapproved manual entries from earlier days, reports.ts:357), and the exact list of still-pending ids an approval may act on |
| `excludeVoided` (helper) | reports.ts:54 | - | drops `status === 'voided'` | filtered array |
| `sumByPaymentMethod` (helper) | reports.ts:64 | - | none | `{ cash, mpesa, card }` |

No other functions exist in this file - 407 lines read in full.

### 2. IPC channels under `reports:*` and `shifts:*`

| Channel | Handler | Validator | Role gate |
| --- | --- | --- | --- |
| `shifts:current` | index.ts:2552 | none - no `validate()` call | none |
| `shifts:open` | index.ts:2571 | none - `request?.staffId`/`request?.startingCash` read directly | none |
| `shifts:close` | index.ts:2593 | none | none |
| `reports:z-report` | index.ts:2614 | **none** - `shiftId: number` is read straight off the request with no zod schema at all, unlike every other guarded handler in this file | none |
| `reports:daily-summary` | index.ts:2632 | none (no parameters) | none |
| `reports:end-of-day` | index.ts:2652 | `endOfDayReportSchema` (ipcValidator.ts:294) | **none, documented as deliberate** - index.ts:2648-2650's own comment: "read-only, open to any logged-in staff exactly like the Z-report and daily-summary handlers above it. Only *approving* the report ... is manager-gated." |
| `reports:approve-day` | index.ts:2684 | `approveDayReportSchema` (ipcValidator.ts:318) | `requireAdminPin` (index.ts:2691, requireAdminPin.ts:43) - re-verifies the PIN belongs to an `admin`-role account server-side |

**Finding, not on the task's own list:** none of the three read-only report channels (`reports:z-report`, `reports:daily-summary`, `reports:end-of-day`) has a server-side role check. The Admin screen that calls them is itself gated to `role === 'admin'` in the renderer (App.tsx:395, 444 - see item 3 below), but `contextBridge` exposes `window.api.getZReport`/`getDailySummary`/`getEndOfDayReport` globally (preload/index.ts:352-407) to any renderer script regardless of which screen is showing. **Inference:** a cashier's own authenticated session (or a compromised/DevTools-driven renderer) could call these three read-only channels directly and see another cashier's totals or the whole store's daily figures, bypassing the UI's admin-only gate - the same class of gap `requireAdminPin.ts`'s own doc comment (lines 1-12) describes having closed for `staff:create`/`staff:resetPin`/`integrations:set-config`, but not extended to these three.

Also worth recording: `reports:z-report` is the one channel in this whole file with no zod schema at all (compare `reports:end-of-day`, which at least validates shape). **Inference:** low severity - a malformed `shiftId` just fails `getShiftById` and returns a caught error (database.ts:1844-1846) - but it is inconsistent with this codebase's own established convention of validating every IPC payload.

### 3. UI: where each screen lives

- `AdminScreen.tsx` is reachable only when `currentStaff.role === 'admin'` - App.tsx:395 (nav button), App.tsx:444 (the header shortcut for unfiled sales; both check `role !== 'admin'` and refuse otherwise).
- `AdminScreen.tsx`'s own top nav (AdminScreen.tsx:129-137) has eight tabs: `overview`, `integrations`, `peripherals`, `mpesaLogs`, `needsAttention`, `stockTake`, `endOfDay`, `system`. **There is no "Reports" tab** - reporting surfaces are scattered across `overview` (Today's Sales, Shift Controls) and the dedicated `endOfDay` tab.
- **Today's Sales card** - AdminScreen.tsx:1944-1975, inside `activeTab === 'overview'`. Shows order count, revenue, cash, and M-Pesa+Card combined, sourced from `reports:daily-summary` (i.e. the **UTC** day - see G3).
- **Shift Controls / Z-Report** - AdminScreen.tsx:1977 onward. Opening a shift, closing it, and the Z-report modal are all in this section. `ZReportModal` is only ever opened once, immediately after `handleCloseShift` succeeds (AdminScreen.tsx:846-867, specifically the `getZReport` call at line 862) - there is no button anywhere that reopens a Z-report for a shift that isn't the one just closed. See G1.
- **`ZReportModal.tsx`** - mounted at AdminScreen.tsx:2232, shown when `zReport` state is non-null.
- **`EndOfDayPage.tsx`** - mounted at AdminScreen.tsx:1047, `activeTab === 'endOfDay'`.
- **`MpesaLogsPage.tsx`** - mounted at AdminScreen.tsx:1041, `activeTab === 'mpesaLogs'`. This is a Daraja STK-push attempt log (MpesaLogsPage.tsx:18-27), not a financial report - a per-attempt list with a manual "Check Status" action, no aggregation.
- **`MpesaReconciliationPage.tsx`** - exists on disk (MpesaReconciliationPage.tsx:23) but is imported nowhere in the renderer. Confirmed unreachable from any route. This is documented, not a mystery: EndOfDayPage.tsx:136-139's own doc comment says it "replaces the per-payment Reconciliation tab for the POC ... that page and its tests are untouched, just no longer linked from an Admin tab (docs/phase-151/152 decision 6)."

### 4. Printing - `renderZReport` and `printZReport`

- `renderZReport(client, report, settings)` - printer.ts:312-355. Prints, in order: store name + "Z-REPORT" heading, shift #/opened/closed/cashier, a dashed line, starting cash + cash/M-Pesa/card sales + order count, a dashed line, total revenue (bold) + total tax, a dashed line, expected cash / counted cash / discrepancy (bold). **No line items, no per-cashier breakdown, no M-Pesa manual/Daraja split.**
- `printZReport(report, settings, factory)` - printer.ts:542-553, a thin wrapper that sends `renderZReport`'s output to the configured thermal printer (or a PDF fallback, per the `receipt:print` handler at index.ts:2376-2388).
- **Finding relevant to G1:** `receipt:print` with `isZReport: true` (index.ts:2365-2389) accepts an arbitrary `shiftId` and calls `generateZReport(db, request.shiftId, ...)` fresh - it is **not** restricted to the currently open or just-closed shift. `getShiftById` (database.ts:1844) has no such restriction either. **Inference:** the backend and the print path already fully support reprinting any past shift's Z-report by id; the only missing pieces are (a) a query to list past shifts (see item under Part 2 "Indexes") and (b) a screen to pick one. This is a "small change" item for Part 4/6, not a "blocked by missing data" one.

### 5. CSV / export code

`grep -rniE "\bcsv\b|text/csv|\.csv" src` returns nothing. **Confirmed: no CSV or export code exists anywhere in the codebase.** (G12)

---

## PART 2 - Data available

| Question | Answer | Evidence |
| --- | --- | --- |
| Order header: `local_id` | Column, `orders.local_id` | database.ts:378 |
| `created_at` | Column, ISO-8601 UTC string (`new Date().toISOString()`) | database.ts:1186; schema at database.ts:382 |
| `staff_id` | Column | database.ts:384 |
| `shift_id` | Column | database.ts:389 |
| `payment_method` | Column | database.ts:385 |
| `total` | Column | database.ts:380 |
| `discount` (line and cart level) | **Not a column** - inside `payload_json` only, as `lineItems[].discount` and `cartDiscount` | `OfflineOrderPayload` at shopify-types.ts:202-217; written at database.ts:1191-1207 |
| `tendered_amount` / `change_due` | Columns | database.ts:386-387 |
| Customer KRA PIN | **Not a column** - inside `payload_json` as `customerPin` | shopify-types.ts:213-214 |
| Company/trading name (B2B invoice) | **Not stored on the order at all.** `CheckoutRequest.companyName` (database.ts:235) is used once, at checkout time, to build the fiscal request (checkout.ts:294), but `OfflineOrderPayload` - the shape actually persisted to `payload_json` - has no `companyName` field (shopify-types.ts:202-217). It is only recoverable, if at all, from `fiscal_request_json` (see fiscal fields row below), and only for an order where fiscalisation was attempted. | checkout.ts:266-296, database.ts:1187-1207 |
| Voided flag | Column, `orders.status` (`CHECK (status IN ('pending_sync','synced','failed','voided'))`) | database.ts:381 |

| Line items | Answer |
| --- | --- |
| Stored per line as columns/rows? | **No.** There is no `order_line_items` (or similarly named) table anywhere in the schema - 16 tables total, listed exhaustively at database.ts:367-648, and none of them holds a per-order line. Line items exist only inside `orders.payload_json`, as `OfflineOrderPayload.lineItems: OfflineOrderLine[]` (shopify-types.ts:205; written at database.ts:1191-1198): `variantId`, `title`, `variantTitle`, `quantity`, `unitPrice`, `discount`. |
| VAT class / HS code per line | Not in `payload_json` at all. They exist only transiently in the **fiscal request** built at checkout time (`checkout.ts:275-288`: `vatClass`, `hsCode`, `hsName`, `pluCode`), persisted (if at all) inside `fiscal_request_json`, a JSON blob column, not queryable columns. |

| Tax | Answer |
| --- | --- |
| Stored per order/line, or only computed at report time? | **Computed fresh at report time, from the *current* `printerSettings.taxRate`**, not read back from anything stored. `generateZReport` (reports.ts:136) and `generateDailySummary` (reports.ts:167) both compute `totalRevenue * taxRate` - confirmed, this is the addition the task asked me to check. A `taxAmount` value **is** computed and stored, but only inside `fiscal_request_json` at checkout time (checkout.ts:290: `taxAmount: input.total * taxRate`, persisted by `setOrderFiscalRequest`, database.ts:1473-1477, "written once, on the first attempt, regardless of outcome") - `reports.ts` never reads this back; it recomputes with whatever `taxRate` is configured *now*. **Inference:** `taxRate` is a static environment variable (`VITE_TAX_RATE`, read once at startup, main/index.ts:586), not an Admin-configurable runtime setting, so this is a low-probability drift risk in practice (it would only bite if the till's `.env` were edited and the app restarted) - but it is a real one: every report ever regenerated afterwards would silently use the new rate against old orders, since nothing pins the historical rate to the order. |

| Fiscal fields | Answer |
| --- | --- |
| CU invoice number | Column, `orders.fiscal_invoice_number` (database.ts:390) - set from the device's response (`extractInvoiceNumberFromXml`, real-etims-provider.ts:982-983, 1019) via `setOrderFiscalInfo` (database.ts:1411-1419). |
| Trader system invoice number | **Not stored as its own field.** It is deterministically derived at send time as `INV-<localId>` (zero-padded, real-etims-provider.ts:1408-1414, `buildTraderSystemInvNum`), so it is always recomputable from `local_id`, but there is no column or JSON field literally holding it after the fact except inside `fiscal_request_json`'s serialised request (if that order was fiscalised). |
| `fiscalised_at` | Column, `orders.fiscal_fiscalized_at` (database.ts:392), set at database.ts:1419. |
| QR | Column, `orders.fiscal_qr_code` (database.ts:391). |
| CU serial number | **Not stored anywhere.** `cuSerialNumber` is read from the device (`ReadCUnumbers`, real-etims-provider.ts:846-857) as "ancillary, best-effort" for the printed receipt only (real-etims-provider.ts:846-857, 1023) - there is no `orders` column or any other table for it. A device password did not appear in any of this; none is echoed here. |
| Fiscal status values | `CHECK (fiscal_status IN ('fiscalized', 'waiting', 'needs_fixing'))` - database.ts:393. Plus `fiscal_error_reason` (text), `fiscal_error_kind` (`'data'|'system'|'technical'`, database.ts:395), and `fiscal_data_issue` (currently only `'wrong-pin'`, database.ts:812). |

| M-Pesa | Answer |
| --- | --- |
| `mpesa_payments` columns | `id, order_local_id, mode ('daraja'|'sms'|'manual'), verification_status ('confirmed'|'matched'|'manual_unverified'), reference, amount, entered_by_staff_id, approved_by_staff_id, reconciled_at, reconciled_by_staff_id, reconciliation_note, source_transaction_id, source_sms_message_id, created_at` - database.ts:597-613, `UNIQUE (mode, reference)`. |
| `mpesa_day_approvals` columns | `id, local_day, approved_by_staff_id, approved_at, entry_count, excluded_count, total_amount, note` - database.ts:623-632. |
| `mpesa_day_exclusions` columns | `id, approval_id, payment_id, reason` - database.ts:642-647. |
| Also present (Daraja attempt log, distinct table) | `mpesa_transactions`: `checkout_request_id, merchant_request_id, phone_number, amount, status, mpesa_receipt_number, created_at, updated_at` - database.ts:445-456. This is what `MpesaLogsPage` reads. |

| Cost price | Answer |
| --- | --- |
| Any of `cost`, `unitCost`, `cost_price`, `costPerItem` anywhere in the repo | **None.** `grep -rniE "\bcost(Price|PerItem|_price)?\b|unitCost" src` returns exactly two hits, both the plain English word "cost" in unrelated prose comments (database.ts:788, gammu-inbox.ts:126). Confirmed: nothing. (G5) |

| Retention | Answer |
| --- | --- |
| Does anything delete/prune `orders`, `sync_queue`, or `mpesa_payments`? | `sync_queue` rows are deleted once actioned (database.ts:1326, 1379, 1545, 1574, and on void at 1753-1757) - expected, it is a queue, not a ledger. **No code anywhere deletes a row from `orders` or `mpesa_payments`.** A void is an `UPDATE orders SET status = 'voided'` (database.ts:1752), not a delete - the row and its history are kept forever. `grep -rniE "DELETE FROM (orders|sync_queue|mpesa_payments)|prune|purge|retention|VACUUM" src/main/services/*.ts` finds nothing that prunes either ledger table. **Confirmed: no retention limit exists - a month report would see everything the till has ever recorded**, bounded only by however long the till has been running. |

| Indexes | Answer |
| --- | --- |
| Index on `orders.created_at`? | **None.** The only indexes on `orders`-related data are `idx_orders_fiscal_invoice_number` (database.ts:412) and `idx_products_barcode` (database.ts:411, a different table); the full index list is at database.ts:410-412, 614, 633, 648. `getOrdersForDateRange` (database.ts:1518-1524, `WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC`) and `getMpesaPaymentsForDateRange` (database.ts:2372-2385, joins on `o.created_at`) both scan `orders` in full for every call. **Confirmed: no index on the date column that every day/week/month report would filter on.** This matters more as range queries widen (G4). |

---

## PART 3 - Confirm or disprove the suspected gaps

**G1 - No list of past shifts; only the open shift's Z-report can be seen. CONFIRMED.**
`getZReport` is called from exactly one place in the whole codebase: AdminScreen.tsx:862, immediately after `closeShift` succeeds. There is no "list shifts" query anywhere - `database.ts` has `getOpenShift()` (database.ts:1832-1834, the single open shift only) and `getShiftById(id)` (database.ts:1844-1846, single lookup), and nothing that returns more than one shift row. See Part 1 item 4's finding: the backend (`generateZReport`, `receipt:print`) already supports reprinting any past shift by id - only the listing query and a screen are missing.

**G2 - The Z-report and daily summary add tax on top of VAT-inclusive prices. CONFIRMED for the mechanism; the "1.00 shows 1.16" framing matches the receipt path exactly.**
`reports.ts:136` (`generateZReport`) and `reports.ts:167` (`generateDailySummary`) both compute `totalTax: totalRevenue * taxRate`, an *addition* on top of revenue rather than an extraction from a VAT-inclusive price. `.env:15` sets `VITE_TAX_RATE=0.16`. The identical arithmetic is used to build the printed receipt: `printer.ts:214` `tax = subtotal * settings.taxRate`, `printer.ts:215` `total = subtotal + tax` - so a product priced at 1.00 (the shelf price the customer pays, and Shopify's normal VAT-inclusive convention) prints `Total: 1.16`. This exact concern, with the exact `1.00` → `1.16` example, is already recorded in `docs/POC_AS_BUILT_ASSESSMENT.md:24-29`, dated 2026-09-23 and still true against the current code - I re-verified `printer.ts:210-215` and `reports.ts:136,167` myself rather than trusting that document alone. **Inference:** whether the fiscal device itself treats the `taxAmount`/`VATGrRate` sent to it as additive or extractive is explicitly flagged **VERIFY-ON-DEVICE** in that same document (line 20) and was not (and, per the hard safety rules here, could not be) re-checked in this audit - no command was sent to any device.

**G3 - Mixed day definitions: `generateDailySummary` uses a UTC day, End of Day uses a Nairobi day. CONFIRMED.**
`generateDailySummary`'s default range is `getUtcDayRange()` (reports.ts:153-156), a plain `Date.UTC` calendar day. `generateEndOfDayReport` always uses `getLocalDayRange(localDay)` (reports.ts:310-314), a fixed UTC+3 (Nairobi) calendar day (reports.ts:172-200 explains the fixed-offset reasoning). The `reports:daily-summary` IPC handler (index.ts:2632-2644) calls `generateDailySummary(db, printerSettings.taxRate)` with no range argument, so the Admin "Today's Sales" card is always on **UTC** day boundaries - a sale made between 00:00 and 03:00 Nairobi time falls on a different calendar day in the two reports.

**G4 - No report covers a range longer than one day. CONFIRMED, with a nuance.**
No IPC channel or UI screen ever requests more than one calendar day. **Inference/nuance:** `generateDailySummary`'s own signature (reports.ts:153-156) already takes an arbitrary `{startIso, endIso}` range - the aggregation logic itself is not day-limited, only every caller of it is. This makes a week/month summary (of the fields `DailySummary` already returns) a smaller change than building a wholly new aggregation.

**G5 - No cost price anywhere. CONFIRMED.** See Part 2's cost-price row - a clean, exhaustive search found nothing.

**G6 - No per-product or per-category sales report. CONFIRMED.**
Line items exist only inside `payload_json` (Part 2). `sumByPaymentMethod` (reports.ts:64-74) sums only `order.total`; nothing in `reports.ts`, or anywhere else searched (`grep -rln "lineItems\b" src/main/services` → `database.ts`, `orders.ts`, `shopify-types.ts` only), ever reads `payload_json.lineItems` for aggregation - `orders.ts:65-90`'s only use of `lineItems` is to rebuild the Shopify `orderCreate` mutation, not to report on anything locally.

**G7 - The Z-report has one M-Pesa total, not split into manual and Daraja. CONFIRMED, and the split already exists one report over.**
`ZReport.totalsByMethod` is `{ cash, mpesa, card }` (reports.ts:13-17), a single `mpesa` figure. `EndOfDayReport.cashiers[].mpesaByMode: { manual, daraja }` (reports.ts:238) already carries exactly this split, computed at reports.ts:338-344 - it is simply never surfaced on the Z-report. This is a small-change item, not a missing-data one.

**G8 - No fiscal reconciliation report (system amount vs device-validated amount per invoice). CONFIRMED.**
Searched `real-etims-provider.ts`, `xml-utils.ts`, `fiscal-retry.ts`, `fiscal-routing.ts` for any amount comparison (`TotalAmount`, `ReceiptAmount`, or any "compare"/"validated amount" logic) - nothing. The only values read back from the device and persisted are the invoice number, QR code, and (best-effort, unpersisted) CU serial - never a monetary total. There is nothing to build this report from without a device change; VIL confirmation (per the task's own note) would need to establish whether the device even returns a validated total in a form this app could capture.

**G9 - No sales report listing the CU invoice number next to the trader system invoice number. CONFIRMED as a report, though the underlying data is recoverable for the CU side and derivable for the trader side.**
`orders.fiscal_invoice_number` is stored (the CU invoice number). The trader system invoice number is never stored as its own value but is always `INV-<local_id>` (real-etims-provider.ts:1408-1414) - so a report pairing the two needs no schema change, only a query and a screen.

**G10 - No report of unfiled/failed-fiscal sales per day. CONFIRMED as a *day-bucketed report*; a related, different capability already exists.**
`getOrdersNeedingAttention` (database.ts:1644-1658) already returns every currently `needs_fixing` order plus every `waiting` order stuck past a threshold, with `created_at` on each row - but it is a live work queue (ordered oldest-first, no day grouping, no lower date bound), not a per-day historical count. `NeedsAttentionPage.tsx` renders this list with a Resend action per row (NeedsAttentionPage.tsx:14-26). Building "how many failed on day X" is a query change on data that is already captured, not a missing-data problem.

**G11 - The till never sends the device's daily closure (`DailyReport`). CONFIRMED, and none of the read-back commands are wired either.**

Read directly from the vendor's own definitions file (`tests/fixtures/tremol-defs.xml`, read-only, no device contacted):

| Command | CmdByte | Read-only or state-changing | Arguments | Response |
| --- | --- | --- | --- | --- |
| `DailyReport` | `0x7C` | **State-changing.** "Provides information for the daily fiscal report with zeroing and fiscal memory record, preceded by Electronic Journal report." No `<Response>` element is declared at all - it is a fire command, not a query. | `<'Z'>` (hardcoded option) | none declared |
| `ReadDailyAmountsByVAT` | `0x6D` | Read-only (`Response ACK="false"`) | none | Per-VAT-class accumulated sale/refund amounts (groups A-E) |
| `ReadEODAmounts` | `0x6D` | Read-only | `Option='d'` | EOD sale/credit turnover and VAT |
| `ReadEODAmountsByDate` | `0x6D` | Read-only | `Option='d'`, `EOD_Date` (DDMMYY) | EOD turnover/VAT/invoice/credit counts for that date |
| `ReadFirstEODDate` | `0x6D` | Read-only | `Option='d','f'` | The earliest EOD date on record |

None of these five names appears anywhere in `src/main` (`grep -rn "DailyReport|ReadDailyAmountsByVAT|ReadEODAmounts|ReadEODAmountsByDate|ReadFirstEODDate" src/main` → no hits). More than that: they are not even declared in this app's own command surface. `FiscalEndpointPaths` (real-etims-provider.ts:246-267) lists exactly twelve wired commands - `readStatus, openInvoice, openInvoiceWithPin, sellPLU, sellPLUWithHsCode, readCurrentReceiptInfo, closeReceipt, readDateTime, cancelReceipt, openCreditNote, readCUinvoiceNumber, readCUnumbers` - none of the daily-closure family is among them. **No command in this list was sent; this is a read of the app's own source and of the vendor's static XML definitions only.**

**STE1 `0x3b` ("24hours block - missing Z report"):** `checkDeviceResponse` (real-etims-provider.ts:464-528) only ever names one `STE1` value: `STE1_OPENED_FISCAL_RECEIPT = 52` (real-etims-provider.ts:189, 497-504). Any other `STE1` value - including `0x3b`/59 decimal - falls through: it is logged in full (`console.warn` at real-etims-provider.ts:490-495, both hex and decimal), but the code then acts on **`STE2`** instead (real-etims-provider.ts:505-513), looked up in `mapFiscalDeviceError`'s table (real-etims-provider.ts:383-406). That table happens to have its own, unrelated entry for the string `'59'` - `STE2_WRONG_CLIENT_PIN = '59'` → "Wrong client PIN" (real-etims-provider.ts:212, 391-392) - a coincidental numeric overlap with a completely different meaning in a different byte column. **What the cashier would see:** whatever `STE2`'s value maps to (or a generic "Unknown fiscal device error" if `STE2` is absent, real-etims-provider.ts:514), never a message naming the actual 24-hour/missing-Z-report condition. **Not verified:** the protocol PDF that would confirm what `STE2` (if any) typically accompanies `STE1=0x3b`, and the exact wording KRA's spec gives this condition, were not found in this repository and were not consulted.

**G12 - No CSV export of daily sales and payments. CONFIRMED.** See Part 1 item 5 - nothing found anywhere.

**G13 - Refunds and credit notes are absent from every report. CONFIRMED, with the reason on record in the code itself.**
Void: wired end-to-end at the backend (`voids.ts`, `ipcValidator.ts`, `database.ts`, `index.ts`) but **`grep -rln "voidOrder|Void" src/renderer` returns nothing** - no button, no screen, calls it. The `orders:void` handler itself explains why: "Refuses every void (phase-131). Void was removed from the till because a sale may already be filed with KRA and the till cannot issue the credit note that would reverse it. The channel stays registered so a stale renderer gets a plain refusal, not a missing-handler error." (index.ts:2176-2183). Credit notes: `openCreditNote` is a declared fiscal endpoint (real-etims-provider.ts:258) with supporting logic (real-etims-provider.ts:1051-1091 discusses building one), but `grep -rn "openCreditNote|creditNote|CreditNote|issueCreditNote" src/main/index.ts src/renderer` returns nothing - it is never exposed via any IPC handler and never called from the renderer. Confirmed: refunds/voids/credit notes genuinely cannot appear in any report, because there is no reachable path that produces one.

**G14 - Reports are admin-only; no separate manager/finance view. CONFIRMED at the UI layer, with a server-side nuance.**
Every reporting screen lives inside `AdminScreen`, gated to `currentStaff.role === 'admin'` (App.tsx:395, 444) - there are only two roles in this system, `admin` and `cashier` (`staffCreateSchema`, ipcValidator.ts:129-133: `role: z.enum(['admin', 'cashier'])`), so there is no "manager" or "finance" role to give a narrower view to even if one were wanted. As noted in Part 1 item 2, the three read-only report IPC channels have no matching server-side check, so the UI-level admin gate is the *only* enforcement.

**G15 - Design-box/no-scroll rule and pagination. CONFIRMED as described for both screens, in opposite ways.**
`ZReportModal.tsx:63` - `className="flex max-h-[90vh] min-h-[75vh] w-full min-w-[75vw] max-w-3xl flex-col ..."`, with an internal `overflow-y-auto` region at `ZReportModal.tsx:78`. This is exactly what the task described, and it is a real outlier: `screensFitDesignBox.test.ts`'s own `FILES` list (screensFitDesignBox.test.ts:45-50) - the test that guards against a hardcoded dimension blowing the 1366×772 box - covers `ManagerPinModal.tsx`, `LoginScreen.tsx`, `LocationConfirmScreen.tsx`, and `PosCheckoutPanel.tsx` only. **`ZReportModal.tsx` is not on that list**, so nothing currently guards its `vh`-based sizing.
`EndOfDayPage.tsx` takes the opposite approach: no internal vertical scroll region (only `overflow-x-auto` for wide tables, at EndOfDayPage.tsx:342, 395, 454), and pagination via `ENTRIES_PER_PAGE = 6` (EndOfDayPage.tsx:15, explicitly commented as "keeps a long list within the design box (Phase E)"). `tests/endOfDayPage.test.ts` covers the pagination behaviour (paging preserves selections, endOfDayPage.test.ts:401 onward) but, like `ZReportModal`, is not exercised by `screensFitDesignBox.test.ts` either.

**Further gaps found, not on the task's list:**

- **No server-side role check on the three read-only report IPC channels** (Part 1 item 2). Low-to-moderate severity given they are read-only, but it is a real gap in the "who is allowed to call this, and where is that enforced" sense, and it directly bears on G14.
- **`reports:z-report` has no zod validation at all** (index.ts:2615-2618) - the only handler among the ones read here with none. Low severity (a bad `shiftId` just errors cleanly) but inconsistent with the rest of this codebase's own convention.
- **Tax rate drift risk**: because `taxRate` is read fresh from `.env` at startup (main/index.ts:586) and never pinned per order, changing `VITE_TAX_RATE` and restarting would silently change the computed "Total Tax" on every report ever regenerated for orders taken under the old rate - nothing stores the rate that actually applied at sale time as a queryable value (see Part 2's tax row).
- **Company name is unrecoverable for reporting** on any order that was not fiscalised (Part 2, order-header row) - a real gap if a B2B "sold to" report is ever wanted.

---

## PART 4 - Mapping Rubis's report list to where each should live

**Not verified:** neither "Rubis Clarifications - Filled" nor "POS-Rubis_Kenya_System_Requirements" exists anywhere in this repository (`find . -iname "*clarification*" -o -iname "*System_Requirements*" -o -iname "*Rubis*Kenya*"` → nothing). The report list and daily-payments fields below are taken verbatim from the task brief's own quotation of those documents, not independently read from source. Project rules applied: Shopify is the only stock ledger (never propose a second); Shopify first, keep the till thin; multi-shop/consolidated reporting is not the till's job.

| Report | Till can do it now | Till could, with a small change | Belongs in Shopify native reports | Belongs in the platform (Flient) layer | Blocked by missing data |
| --- | --- | --- | --- | --- | --- |
| Sales by payment method | Yes - `ZReport`/`DailySummary`/`EndOfDayReport` all already return this | | | | |
| Cash expected vs deposited | Yes - `ZReport.expectedCash`/`endingCash`/`discrepancy` (Z-report only, not a day/week view) | Day/week roll-up of shift discrepancies | | | |
| M-Pesa expected vs received | Partially - the till only ever records what a cashier types or Daraja confirms; there is no independent "expected" M-Pesa figure to compare against (that would be the M-Pesa statement, held by the operator, not the till) | | | Yes - matching the till's manual entries against the actual M-Pesa statement is a reconciliation across two systems, which is exactly what `EndOfDayReport`'s approval flow already half-does locally but cannot complete without the statement | | |
| Card | Yes - same shape as cash/M-Pesa | | | | |
| Refunds and voids | No | | | | **Yes** - void has no UI path (G13) and no report could show void data that was never usably created; a refund/credit-note flow does not exist at all |
| Overages and shortages | Yes, per shift (`ZReport.discrepancy`) | Day/week aggregation across shifts | | | |
| Unreconciled items | Yes - `EndOfDayReport.pendingIds`/`carryOver` already is this, for manual M-Pesa | | | | |
| eTIMS status | Yes, live (`NeedsAttentionPage`) | Day-bucketed history view (G10) | | | |
| User responsible and approval status | Yes - every M-Pesa entry already carries `staffName`/`reconciledByStaffName`/`sameApproverAsRecorder` | | | | |
| Per-product / top-seller / category | No | | Yes - Shopify already has this natively over the same orders once synced, and building it locally would mean parsing `payload_json` at report time or adding a line-items table neither of which the till currently needs for anything else | | |
| Profit / margin | No | | Possibly, if cost is ever entered in Shopify - see Part 5 | | **Yes** - no cost data exists anywhere (G5) |
| Month/consolidated/multi-shop reporting | No | | | **Yes, explicitly** - project rule: not the till's job | |
| CSV export of daily sales/payments | No | Yes - `DailySummary`/`EndOfDayReport` already hold the numbers; only the encoding and a download/print-to-file path are missing | | | |

---

## PART 5 - Shopify profit route (documentation check only)

- **API version:** `2026-07` - `GRAPHQL_ENDPOINT_SUFFIX = '/admin/api/2026-07/graphql.json'`, shopify.ts:19.
- **Access scopes:** **Not verified from this repository.** This app authenticates with a merchant-configured custom-app Admin API access token (`X-Shopify-Access-Token` header, shopify.ts:293) rather than an OAuth install flow that would declare a scopes list in code - the granted scopes live in the merchant's own Shopify Admin, not in this repo. The only scope-related code is a generic 403 handler: "Access denied - the token lacks required Shopify API scopes" (shopify.ts:336). `docs/phase-119.md:135-143` records that the app has never needed `write_inventory` and would need to ask for it explicitly if that changed - a prior audit's note, not something I re-verified against a live token.
- **Does the order push send `variantId` per line item?** Yes - `buildOrderInput` (orders.ts:65-90): `lineItems: payload.lineItems.map((line) => ({ variantId: line.variantId, quantity: line.quantity }))` (orders.ts:76-79).
- **shopify.dev check (fetched 2026-09-26):**
  - [`InventoryItem`](https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryItem) - cost per item is held on `InventoryItem.unitCost` (type `MoneyV2`), documented as requiring the "View product costs" permission once granular product permissions are enabled, and it lives on the inventory item (shared across every variant that points to it), not per-variant.
  - [`orderCreate`](https://shopify.dev/docs/api/admin-graphql/latest/mutations/orderCreate) - the mutation's own documentation says nothing about analytics or profit-report visibility either way.
  - **Plainly: not in the official documentation.** Shopify does not state, in either page checked, whether an order created through `orderCreate` appears in its built-in profit/analytics reports the same way a checkout-created order does.
  - This app's current scopes were not checked against "View product costs" (that permission is not a standard OAuth scope name and cannot be confirmed without inspecting the actual custom app's grants in the merchant's Shopify Admin) - **Not verified.**

---

## PART 6 - Proposed smallest design (proposal only - nothing built)

An Admin "Reports" tab, touch-first, `check:fit`-compliant, paginated, on-screen keyboard for any input field, built only from data already confirmed to exist:

| Feature | Data source | New queries needed | New indexes | Touches fiscal/payment code? |
| --- | --- | --- | --- | --- |
| Shift history + reprint | `shifts` table (already has every field `ZReport` needs) | One new `listShifts(limit, offset)`-style query; `generateZReport`/`printZReport`/`receipt:print` need no change (Part 1 item 4) | Optional: none strictly required for a paginated list ordered by `id DESC`, since `id` is already the primary key | No - read-only, reuses `generateZReport` unchanged |
| Day/week/month sales summary (Nairobi time) | `generateDailySummary`, generalised to take a Nairobi-anchored range built from `getLocalDayRange`/a new `getLocalWeekRange`/`getLocalMonthRange` | A small date-range helper alongside the existing ones in `reports.ts`; no new SQL beyond what `getOrdersForDateRange` already runs | **`CREATE INDEX idx_orders_created_at ON orders (created_at)`** - becomes worth adding once ranges widen past a day (Part 2's Indexes finding) | No |
| Payments by method (day/week/month) | Same as above, `totalsByMethod` | none beyond the above | same | No |
| M-Pesa manual vs Daraja split, surfaced on the Z-report | `EndOfDayReport.cashiers[].mpesaByMode` logic (reports.ts:338-344), reused for a shift's own orders | none | none | Touches `reports.ts` only - no payment-writing code |
| Fiscal status by day (needs-fixing / waiting / fiscalised counts) | `orders.fiscal_status` + `created_at`, same table `getOrdersNeedingAttention` already reads | A day-grouped count query, separate from the live work-queue one | Same `idx_orders_created_at` as above | No - read-only |
| CU invoice ↔ trader system invoice number list | `orders.fiscal_invoice_number` + `INV-<local_id>` derivation | none new | none | No - read-only, no device contacted to build it |
| CSV export (daily sales/payments) | Whatever `DailySummary`/`EndOfDayReport` already return | none | none | No |

**Explicitly marked as needing a decision before any work, not proposed here:** anything requiring cost data (per-product profit/margin - G5, blocked), anything requiring a device command (the daily-closure family - G11, must not be sent without VIL confirmation), and a fiscal-vs-system amount reconciliation report (G8, blocked - the device apparently never returns a comparable validated total to this codebase).

**Tests, if built:** would follow this codebase's existing pattern - a real-mount test per new screen (matching `endOfDayPage.test.ts`/`adminScreen.test.ts`'s style), a schema test for any new IPC validator (matching `ipcValidator.test.ts`), and a database test against a real in-memory SQLite instance for any new query (matching `reports.test.ts`/`shifts.test.ts`), never against a live till database.

---

## PART 7 - Decisions needed

- **Which reports the POC actually needs, from the Part 4 table** - product owner / VIL.
- **Day definition** - should `generateDailySummary`/the Admin "Today's Sales" card move from a UTC day to a Nairobi day, matching `EndOfDayReport` (G3)? - product owner, since it changes what a cashier sees as "today's" total.
- **Where profit is reported** - Shopify (once/if cost is entered there) or not at all for this POC - product owner, informed by whether the merchant will actually maintain `InventoryItem.unitCost` in Shopify.
- **Whether and how the device's daily closure (`DailyReport`) ever runs** - needs explicit VIL confirmation before any code path is added; this audit did not send it and recommends nobody does without that confirmation, given it "cannot be undone" per the task's own framing.
- **Retention period on the till** - currently unlimited (Part 2); someone should decide whether that is acceptable for the life of the POC or whether a policy is needed before the database grows large enough to make `getOrdersForDateRange`'s unindexed scan (Part 2, Indexes) a real performance problem.
- **Whether to close the two IPC-level gaps found here even without new features**: a server-side role check on `reports:z-report`/`reports:daily-summary`/`reports:end-of-day`, and a zod schema on `reports:z-report` - engineering decision, small and low-risk, but a scope decision nonetheless since it wasn't asked for.
- **Whether `ZReportModal`'s `min-h-[75vh]`/internal-scroll pattern should be brought in line with `EndOfDayPage`'s pagination-based approach**, and whether both should be added to `screensFitDesignBox.test.ts`'s guarded file list (G15) - engineering/design decision.

---

## Verification

This was a read-only audit. What was actually run:

- `git status --short` and `git log -1` - confirmed a clean tree on `staging @ fd90cbb` before starting.
- Full reads of `src/main/services/reports.ts` (407 lines) and `requireAdminPin.ts` (57 lines); targeted reads of `src/main/index.ts` (IPC handlers), `src/main/services/database.ts` (schema and every query cited), `src/main/lib/ipcValidator.ts`, `src/main/services/checkout.ts`, `src/main/services/integrations/real-etims-provider.ts`, `src/main/services/printer.ts`, `src/main/services/orders.ts`, `src/main/services/shopify.ts`, `src/main/services/shopify-types.ts`, `src/renderer/src/components/AdminScreen.tsx`, `ZReportModal.tsx`, `src/renderer/src/pages/EndOfDayPage.tsx`, `MpesaLogsPage.tsx`, `MpesaReconciliationPage.tsx`, `src/renderer/src/App.tsx`, `src/preload/index.ts`, and `tests/screensFitDesignBox.test.ts`.
- `grep`/`find` searches across the whole `src/` tree for: cost-price terms, CSV/export code, void/credit-note UI references, pruning/retention SQL, and every fiscal command name under audit - all reported verbatim above with their result (including "no hits" where that was the finding).
- One local, offline read of `tests/fixtures/tremol-defs.xml` via a small Node script, to extract the five named fiscal commands' definitions - no network call, no device contacted.
- Two `WebFetch` calls to `shopify.dev` documentation pages (`InventoryItem`, `orderCreate`) - read-only, no write endpoint called, no store credentials used.
- **Not run, deliberately, per the hard safety rules:** any command to a fiscal device or ZFPLabServer; any SQL against a real till database (all schema facts came from reading the `CREATE TABLE` source strings, never from querying a live file); any Shopify write call.
- `npm run typecheck` / `npx vitest run` / `npm run build` were **not run** - nothing in the repository changed, so there is nothing new for them to verify.

## Rollback

Not applicable - no file was modified, no commit other than this report was made, nothing was built.

## Observed but not changed

Everything in Part 3's "Further gaps found, not on the task's list" and Part 7's decision list is exactly this section's content, surfaced there instead of duplicated here to avoid two copies drifting apart. In short: the two IPC-level gaps (no role check, one missing schema on `reports:z-report`), the tax-rate-drift risk, and company name being unrecoverable for reporting on a non-fiscalised order.

---

**STOP.**
