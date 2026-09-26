# Phase 158 - Admin Reports tab (build)

- **Date:** 2026-09-26
- **Requested:** Build the Admin "Reports" tab (shift history, date-range sales summary, fiscal status by day, invoice number list, CSV export), from data the till already stores, per the docs/phase-157 audit. Correct the Z-report/daily-summary tax formula from adding tax on top of revenue to extracting the VAT already included in a VAT-inclusive shelf price. Fix the daily-summary UTC/Nairobi day mismatch. Add a zod schema to `reports:z-report`. Investigate (read-only) whether the main process can gate reports reads by role. Report what `orders.ts` sends to Shopify today, for phase 159.
- **Outcome:** Implemented.
- **Branch / base commit:** staging @ 1ac5258 (Phase 157 - Admin Reports audit).

Hard rules observed throughout: no change to `real-etims-provider.ts`, `fiscal-retry.ts`, `fiscal-routing.ts`, `checkout.ts`, the M-Pesa payment gate/providers, `mpesa_payments` writes, `orders.ts`, or the printed customer receipt (`printer.ts`'s `renderReceipt`) - confirmed with `git diff --stat` against every one of these paths, which returns nothing. No command was sent to a fiscal device or ZFPLabServer. No SQL was run against a real till database - every new query was exercised against a real **in-memory** SQLite instance (`tests/reportsDatabase.test.ts`) or a lightweight fake, never a file on disk. No device password appears anywhere below or in any new file.

---

## 1. Audit

Built directly on docs/phase-157's audit, which already established (with file:line evidence) what data exists, what was missing, and every gap this phase closes. Re-read before starting: `src/main/services/reports.ts` (407 lines, in full), `src/main/services/database.ts`'s schema and every query this phase touches, `src/main/lib/ipcValidator.ts` (in full, 599 lines), the `reports:*`/`shifts:*` IPC handlers in `src/main/index.ts`, `src/preload/index.ts`/`window.d.ts`'s existing surface, `src/renderer/src/components/AdminScreen.tsx`'s tab structure, `EndOfDayPage.tsx`'s pagination pattern, `ZReportModal.tsx` (in full), `checkout.ts`'s `runCheckout` (lines 330-560, for step 10), `orders.ts` (in full, 186 lines, for step 10), and `real-etims-provider.ts`'s `buildTraderSystemInvNum` (lines 1408-1420) and `FiscalEndpointPaths` (lines 246-267).

Confirmed before writing anything: the main process has **no concept of a currently logged-in staff member** anywhere (`grep -n "currentStaff\|currentSession" src/main/index.ts` finds nothing of the kind) - every privileged write re-verifies a manager PIN passed explicitly on that request (`requireAdminPin.ts`). This settled step 4c before any code was written: there is no session to gate a read against, so none was invented.

## 2. Changes made

### 2a/2b/2c/2d/2e - `reports.ts`

- **VAT extraction** (`reports.ts:129-131`): new `computeVatIncluded(total, rate) = round(total * rate / (1 + rate), 2)`, replacing `totalTax = totalRevenue * taxRate` in `generateZReport` (`reports.ts:165-202`) and `generateDailySummary` (`reports.ts:214-231`). The field was renamed `totalTax` -> `vatIncluded` on both `ZReport` and `DailySummary`. `totalRevenue` is unchanged - it is still the total as charged, nothing subtracted from it.
- **Z-report M-Pesa split** (`reports.ts:179`, `194`): `generateZReport` now calls a new `db.getMpesaPaymentsForShift(shiftId)` and a shared `sumMpesaByMode` helper (`reports.ts:102-111`, extracted from the per-staff loop `generateEndOfDayReport` already had at the old `reports.ts:338-344` - that loop now calls the same helper, `reports.ts:407-415`, so the two are the same arithmetic, never copied).
- **Nairobi range presets** (`reports.ts:506-650`): `REPORT_RANGE_PRESETS` (`'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'thisMonth' | 'lastMonth'`) and `getReportRange(preset, now?)`, built entirely on the existing `getLocalDayRange`/`todayLocalDay` - no new UTC-offset arithmetic, only calendar-day label math (`shiftLocalDay`, `mostRecentMonday`, `monthBounds`) feeding into the already-audited offset conversion. "This week"/"last week" start Monday.
- **`generateSalesSummary(db, taxRate, range)`** (`reports.ts:655-673`): order count, revenue, VAT included, totals by method, M-Pesa by mode, for any resolved range. Voided orders excluded via the existing `excludeVoided`.
- **`generateFiscalStatusByDay(db, range)`** (`reports.ts:700-714`): per-Nairobi-day counts of `fiscalized`/`waiting`/`needs_fixing`, grouped in JS with `localDayOf` (not SQL). **Deliberately not run through `excludeVoided`** - a fiscalised sale stays filed with KRA even if later voided (voiding cannot un-file it, docs/phase-157 G13), so a fiscal-compliance view should keep counting it. This wasn't explicit in the brief for this one function (only `generateSalesSummary` was told to exclude voided); documented here as the judgement call it is.
- **`formatNairobiDateTime`** (`reports.ts:301-315`): the CSV's "date and time (Nairobi)" column, sharing a new private `toNairobiWallClock` helper with `localDayOf` rather than duplicating the offset shift a third time.

**Deviation from the brief's literal signature, noted plainly:** the brief wrote `generateSalesSummary(db, range)`. Every other aggregation function in this file (`generateZReport`, `generateDailySummary`) takes `taxRate` as an explicit parameter - `reports.ts` has no access to config, so VAT cannot be computed without it. `generateSalesSummary(db, taxRate, range)` matches that existing convention instead of the brief's shorthand.

### 2f - `database.ts`

- `idx_orders_created_at` (`database.ts:419`, applied at `database.ts` init, right after the existing `fiscalInvoiceIndex`) - `CREATE INDEX IF NOT EXISTS`, idempotent by construction, confirmed present after `init()` in `tests/reportsDatabase.test.ts`.
- `listShifts(limit, offset)` / `countShifts()` (`database.ts:1913-1931`) - most recently opened first, closing docs/phase-157 G1 (no shift-history listing existed at all).
- `getOrdersForDateRange` widened (`database.ts`, same function, now selects every fiscal column) so `generateFiscalStatusByDay` can read `fiscal_status` off the same rows the revenue reports already fetch - backward-compatible, every existing caller already typed its result as the full `OrderRow`.
- `getOrderRowsForRange(startIso, endIso, limit, offset)` (`database.ts:1558-1589`) - one page of orders, newest first, plus the true total, for the invoice list and CSV export. Distinct from `getOrdersForDateRange`: that one is for aggregation (every row, no pagination), this one for display/export of a page.
- `getMpesaPaymentsForShift(shiftId)` (`database.ts:2478-2486`) - mirrors `getMpesaPaymentsForDateRange`'s join exactly, keyed by shift instead of date range.

### 2, step 10 (Part 10 answer) - read only, nothing changed

Read `orders.ts` (`buildOrderInput`, lines 65-100) and `checkout.ts`'s `runCheckout` (lines 330-560) in full.

- **What `buildOrderInput` sends besides line items:** `financialStatus: 'PAID'`, `note` (a free-text string: local UUID, cashier name, taken-at timestamp, and a payment summary - `orders.ts:81`), `customAttributes: [{ key: 'client_order_uuid', value }]` (`orders.ts:82-84`), and `metafields: [{ namespace: 'rubis_pos', key: 'client_order_uuid', value }]` (`orders.ts:85-92`), plus `options: { inventoryBehaviour: 'DECREMENT_OBEYING_POLICY', sendReceipt: false, sendFulfillmentReceipt: false }` (`orders.ts:94-98`).
- **`tags`, `sourceName`, `sourceIdentifier`, `poNumber`:** none of these keys appears anywhere in `buildOrderInput`'s returned object. Not sent.
- **Is the trader invoice number or the CU invoice number on the Shopify order at all?** No. `grep -n "invoice" src/main/services/orders.ts` finds nothing. `OfflineOrderPayload` (the shape `payload_json` stores and `buildOrderInput` reads from) has no fiscal field of any kind (`shopify-types.ts:202-217`, confirmed in docs/phase-157 Part 2).
- **Is it set at order create, or would it need a later update?** It would need a later update - and nothing currently performs one. `runCheckout` fires the Shopify sync as a **fire-and-forget background tick before fiscalisation even starts**: `void engineTick().then(...)` at `checkout.ts:511-521`, followed only afterwards by `buildFiscalRequest`/`submitInvoice` at `checkout.ts:538-548`. The order can already be pushed to Shopify (or queued for later, if offline) before a CU invoice number exists, so it is structurally impossible for `orderCreate` to carry it at creation time. No code anywhere calls a Shopify update mutation after fiscalisation succeeds. This feeds phase 159 directly: attaching either invoice number to the Shopify order would need a new, separate write (e.g. an `orderUpdate`/metafield-set call after `setOrderFiscalInfo` succeeds) - out of scope here, and it would touch Shopify write code, which this phase's hard rules kept untouched.

### 2, step 3 - "Today's Sales" moves to the Nairobi day

`reports:daily-summary` (`index.ts`) now calls `generateDailySummary(db, printerSettings.taxRate, getReportRange('today'))` instead of defaulting to `getUtcDayRange()`. Closes docs/phase-157 G3 - the Admin overview card and the end-of-day report now agree on what "today" means.

### 4a/4b - IPC (`ipcValidator.ts`, `index.ts`, preload, `window.d.ts`)

- `zReportRequestSchema` (`ipcValidator.ts`, new) - `{ shiftId: positive int }`. `reports:z-report` (`index.ts:2648`) now validates it; this was the one reports handler with no schema at all (docs/phase-157 finding).
- `reportRangePresetSchema = z.enum(REPORT_RANGE_PRESETS)` (imported from `reports.ts`, so the preset list has one source of truth) and five new schemas built on it: `shiftsListSchema`, `salesSummarySchema`, `fiscalByDaySchema`, `invoiceListSchema`, `exportCsvSchema` (the last with `kind: z.enum(['orders', 'lines'])`).
- Five new read-only channels (`index.ts:2783` onward): `reports:shifts-list`, `reports:sales-summary`, `reports:fiscal-by-day`, `reports:invoice-list`, `reports:export-csv`. Each validates its request and returns a `ServiceResult`, matching every existing handler's shape.
- `reports:invoice-list`'s response pairs each order with a pre-computed `traderInvoiceNumber` (`index.ts`, the handler itself, using the new shared helper below) - computed **once, server-side**, never in the renderer, so the trader-invoice format lives in exactly two places (the real fiscal provider, and this shared helper), never three.
- Preload (`preload/index.ts`) and `window.d.ts` gained matching `getShiftsList`, `getSalesSummary`, `getFiscalStatusByDay`, `getInvoiceList`, `exportReportsCsv` entries, each documented the same way as the existing `getEndOfDayReport`/`approveDayReport` pair.

### 4c - the role-check investigation (a gap, recorded, not worked around)

As established in the audit: the main process has no session concept, so there is nothing to check a read against. Per the task's own explicit instruction, **no session was invented and no PIN prompt was added to a read**. This is recorded, in full, as a new entry in `docs/KNOWN_GAPS.md` ("`reports:*` read channels have no server-side role check") and referenced in every one of the affected handlers' own doc comments (`index.ts`, above `reports:z-report`).

### 5 - CSV export

- `src/main/lib/csv.ts` (new) - generic, report-agnostic CSV encoding: `csvCell` (quote/comma/newline escaping, plus a leading `'` prefix on any cell starting with `= + - @ \t \r` to block formula injection), `buildCsv` (UTF-8 BOM, `\r\n` line endings), `csvMoney` (`toFixed(2)`).
- `src/main/services/reportsExport.ts` (new) - `buildOrdersCsv`/`buildLinesCsv`, read-only against `getOrdersForDateRange`/`getMpesaPaymentsForDateRange`/`getStaffById`. No fiscal or payment code is called.
- `reports:export-csv` (`index.ts:2917`) - validates `{ preset, kind }`, builds the CSV text, opens Electron's `dialog.showSaveDialog` (no forced parent window - `BrowserWindow.getFocusedWindow()` was not threaded through since `dialog.showSaveDialog(options)` works standalone and no `mainWindow` reference is in scope at the handlers' registration point), writes the file with `writeFileSync(path, csv, 'utf8')` on confirmation, or returns `{ saved: false }` on cancel (never an error).
- **The renderer's Export screen has two separate buttons ("Export orders CSV"/"Export lines CSV"), each its own IPC call and its own save dialog** - matching the task's own UI description of two buttons, rather than one call producing two files. Recorded here as the reading taken of "Two files for the chosen preset."

**"Order status" vs "sync status" - a judgement call, recorded:** this schema has exactly one `orders.status` column (`pending_sync | synced | failed | voided`), not two independent concepts. The brief asked for both an "order status (a voided row is kept and marked 'voided')" column and a separate "sync status" column. Read literally: **Order status** = `'voided'` if the order was voided, else `'completed'` (a business-level yes/no on whether the sale stands). **Sync status** = the raw `orders.status` value verbatim (`pending_sync`/`synced`/`failed`/`voided`), since that is what the rest of this codebase already calls sync status. This keeps both columns, non-redundant, from the one column the schema actually has.

Every claim in `docs/KNOWN_GAPS.md`'s "no PIN in the export" statement and the "customer KRA PIN present" column was verified directly: `buildOrdersCsv` never reads `payload.customerPin` into a cell, only `payload?.customerPin?.trim() ? 'yes' : 'no'` (`reportsExport.ts`).

### 6 - Renderer: the "Reports" tab

New `src/renderer/src/pages/ReportsPage.tsx` (standalone page, matching `EndOfDayPage.tsx`/`StockTakePage.tsx`'s own pattern rather than growing `AdminScreen.tsx` further), with an internal sub-nav (five buttons, same visual pattern as `AdminScreen`'s own Integrations sub-nav) for:

- **Shift History** - paginated table, tap a row to open its Z-report in the existing, **unchanged** `ZReportModal` (with its own Reprint button, which still calls `window.api.printZReport(shiftId)` exactly as before).
- **Sales Summary** - preset buttons, then the resolved figures.
- **Fiscal Status by Day** - preset buttons, then a paginated table (paginated client-side via the existing `paginate.ts`, since a month is at most 31 rows - the server-side pagination pattern was reserved for shift history/invoices, whose row counts are unbounded).
- **Invoice List** - preset buttons, paginated server-side (`REPORTS_PAGE_SIZE = 10`, matching the main process's own constant), pairing the trader invoice number with the CU invoice number (or the fiscal status/"not filed" when there is none).
- **Export** - preset buttons, then the two export buttons described above.

No field in this whole page opens the on-screen keyboard - every input is a preset button, exactly as asked ("there should be none").

### 7 - `ZReportModal` and the fit checks

- Removed the internal `overflow-y-auto` and the `max-h-[90vh] min-h-[75vh] min-w-[75vw]` sizing (docs/phase-157 G15) - the modal now sizes to its own content (`w-full max-w-2xl`, no forced height), which is a fixed, small handful of lines. Added the M-Pesa manual/Daraja split as two new lines under "M-Pesa Sales" (on-screen only - **not** added to the printed thermal Z-report, a deliberate, minimal-touch decision: the brief's own printer instruction named only the VAT label).
- `renderZReport` in `printer.ts` (the Z-report print path, not the customer receipt) - one line changed: `Total Tax: ${formatCurrency(report.totalTax)}` -> `` VAT included (calculated at 16%): ${formatCurrency(report.vatIncluded)} ``, exactly as instructed. `renderReceipt` (the customer receipt) was not opened for editing at all.
- `screensFitDesignBox.test.ts`'s `FILES` list gained `ZReportModal.tsx` and `ReportsPage.tsx` (the hardcoded-px guard) - `ZReportModal` was never on this list before, which is exactly how its old `vh`-based sizing went unguarded (docs/phase-157 G15).
- `scripts/check-fit.mjs` gained a new `checkReportsTab` step, run once per window-size case after the existing Cash/M-Pesa scenarios: clicks the "Admin" nav button, then "Reports", then each of the five sub-nav buttons in turn, censusing each for page overflow and inner scrollers exactly like the existing scenarios - best-effort (skipped with a note, not a failure, if the seed account isn't an admin). **Result: 18/18 cases pass, all nine window sizes, with zero overflow on every Reports sub-view** (§6 below has the full run).

### 8 - `docs/KNOWN_GAPS.md`

Five entries added (docs/phase-157's five relevant open findings, written up properly rather than left as audit prose): the fiscal daily-closure family (`DailyReport` and its read-only companions - none wired, `STE1 = 0x3b` not decoded), the fiscal reconciliation report (nothing reads back a device-validated amount to compare), profit/margin reporting (no cost data anywhere; Shopify's `unitCost`/`orderCreate`-visibility both checked against `shopify.dev` on 2026-09-26), refunds/voids/credit notes (void removed in Phase 131, credit notes wired to no caller), and the `reports:*` role-check gap from step 4c above.

## 3. Deliberate test changes

Every changed assertion, old -> new -> why, all in `tests/reports.test.ts`:

| Test | Old assertion | New assertion | Why |
| --- | --- | --- | --- |
| `generateZReport` computes tax | `report.totalTax` close to `8` (`100 * 0.08`) | `report.vatIncluded` close to `7.41` (`100 * 0.08 / 1.08`) | The field was renamed and the formula corrected (docs/phase-157 G2) - the old assertion tested the bug. |
| `generateDailySummary` aggregates by method | `summary.totalTax` close to `5` (`50 * 0.1`) | `summary.vatIncluded` close to `4.5454545` (`50 * 0.1 / 1.1`) | Same reason, same file. |

No other existing assertion in this file, or in any other test file, was changed. Two new tests were added to the same `generateZReport` describe block (M-Pesa split) and a new `generateSalesSummary` describe block was added (voided-exclusion, M-Pesa split, label passthrough) - additions, not changes.

**Standing tripwires - unmodified and passing**, explicitly re-run: `realEtimsProvider.test.ts` (109), `tremolConformance.test.ts`, `tremolFixtures.test.ts`, `fiscalRouting.test.ts`, `fiscalValidate.test.ts`, `fiscalRetry.test.ts`, `fiscalSanitize.test.ts` (the fiscal suite); `mpesaPaymentGate.test.ts` (24); `VirtualKeyboard.test.ts`, `VirtualNumpad.test.ts`, `keyboardStore.test.ts`, `keyboardEchoSubmit.test.ts`, `setupScreens.test.ts`, `virtualKeyboardLayouts.test.ts` (the keyboard tests); `screensFitDesignBox.test.ts` (modified only to add two files to a list, all 8 tests still pass, no existing assertion touched), `belowLgUnreachable.test.ts`, `headerLayout.test.ts`, `posCheckoutPanelFit.test.ts` (Phase E layout). **18 files, 329 tests, all green** - none of these files had any assertion changed except the two rows in the table above, which live in `reports.test.ts`, not in this list.

## 4. Mutation checks (docs/phase-158's own required verification)

- **Nairobi offset**: `NAIROBI_UTC_OFFSET_MINUTES` in `reports.ts` was temporarily changed from `3 * 60` to `4 * 60`. Re-running `tests/reportRanges.test.ts` and `tests/reports.test.ts` failed exactly the boundary-dependent tests (all six `getReportRange` preset tests, plus the Nairobi-day-bucketing test) while every non-boundary test in those files kept passing. Restored; `git diff` on `reports.ts` showed the constant back to `3 * 60` with no residue.
- **VAT formula**: `computeVatIncluded` was temporarily changed to `total * rate` (the old, wrong, additive formula). Re-running `tests/reportRanges.test.ts`, `tests/reports.test.ts`, and `tests/reportsExport.test.ts` failed the three `computeVatIncluded` unit tests and the two `generateZReport`/`generateDailySummary` VAT tests - **but not** `reportsExport.test.ts`'s own VAT test, which passed anyway. Investigating why: that test asserted `csv.toContain('16.00')`, and the fixture's own `total` field (116) formats to `'116.00'`, which contains `'16.00'` as a substring - a vacuous assertion. Fixed by parsing the actual CSV column instead of a substring search (`tests/reportsExport.test.ts`, the VAT test, now indexes the specific column); re-verified this catches the same mutation (it now fails: `expected '18.56' to be '16.00'`), then restored the formula and confirmed all tests pass clean. This is exactly the kind of gap this exercise exists to catch, and it caught one.

## 5. Affected files

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/main/services/reports.ts` | Modified | VAT extraction, Z-report M-Pesa split, Nairobi range presets, sales summary, fiscal status by day, Nairobi datetime formatting |
| `src/main/services/database.ts` | Modified | New index, `listShifts`/`countShifts`, `getOrderRowsForRange`, `getMpesaPaymentsForShift`, widened `getOrdersForDateRange` |
| `src/main/services/printer.ts` | Modified (one line) | The printed Z-report's VAT label only - customer receipt untouched |
| `src/main/lib/ipcValidator.ts` | Modified | Six new/changed schemas |
| `src/main/index.ts` | Modified | `reports:z-report` validated; `reports:daily-summary` moved to Nairobi; five new IPC handlers |
| `src/main/lib/csv.ts` | Added | Generic CSV escaping/BOM/formula-injection prevention |
| `src/main/lib/traderSystemInvoiceNumber.ts` | Added | Trader invoice number format, duplicated from the fiscal provider by necessity (see below) |
| `src/main/services/reportsExport.ts` | Added | `orders.csv`/`lines.csv` builders |
| `src/preload/index.ts`, `src/preload/window.d.ts` | Modified | New API surface for the five new channels |
| `src/renderer/src/pages/ReportsPage.tsx` | Added | The whole Admin Reports tab |
| `src/renderer/src/components/AdminScreen.tsx` | Modified | New "Reports" tab wired in |
| `src/renderer/src/components/ZReportModal.tsx` | Modified | No internal scroll; VAT label; M-Pesa split display |
| `tests/screensFitDesignBox.test.ts` | Modified | Two files added to the hardcoded-px guard list |
| `scripts/check-fit.mjs` | Modified | New Admin Reports fit-check scenario |
| `docs/KNOWN_GAPS.md` | Modified | Five new gap entries |
| `tests/reports.test.ts` | Modified | Two assertions renamed/corrected (see §3); new `generateSalesSummary` tests |
| `tests/reportRanges.test.ts`, `tests/reportsDatabase.test.ts`, `tests/reportsExport.test.ts`, `tests/reportsPage.test.ts`, `tests/csv.test.ts`, `tests/traderSystemInvoiceNumber.test.ts` | Added | New coverage for every piece of this phase |

## 6. A hard-rule conflict, resolved conservatively and recorded

The brief asked for the CSV/invoice list to use "the SAME function as `real-etims-provider.ts:1408-1414`; import it, do not re-implement the format." That function, `RealFiscalizationProvider.buildTraderSystemInvNum`, is a **private method** on a class in a file this phase's own hard rules forbid changing (`real-etims-provider.ts` is fiscal code). Exporting it would mean editing that file. Given a direct conflict between a hard rule (no changes to that file, stated absolutely) and a build instruction (import, don't re-implement), the hard rule was treated as binding: `src/main/lib/traderSystemInvoiceNumber.ts` is a **deliberate, guarded duplicate** of the format (same `INV-<9-digit local id>` / dash-stripped-UUID-fallback logic), with its own doc comment explaining exactly why, and `tests/traderSystemInvoiceNumber.test.ts` asserting it produces byte-identical output to the real provider's own documented test fixtures (`tests/realEtimsProvider.test.ts`'s `localId=42`/`localId=7`/UUID-fallback cases) - so any future drift between the two is caught by a failing test, not silently. If this resolution is wrong, the fix is a one-line decision (export the method instead), not a redesign.

## 7. Possible impact

- **Direct:** an admin can now see shift history with reprint, a date-range sales summary, fiscal status by day, an invoice list pairing both invoice numbers, and export CSVs - none of which existed before. The Z-report and daily summary now show a correct VAT figure instead of double-counted tax; "Today's Sales" now agrees with the end-of-day report's definition of "today".
- **Indirect:** `ZReport`'s and `DailySummary`'s shape changed (`totalTax` -> `vatIncluded`, plus `mpesaByMode` on `ZReport`) - every caller in this codebase was updated (`printer.ts`, `ZReportModal.tsx`, both test files); nothing outside this codebase consumes these types.
- **Data / schema / contract:** one new index (`idx_orders_created_at`), additive and idempotent. No column added, no data migrated.
- **Security posture:** unchanged for writes (nothing here touches a payment or fiscal write path). The pre-existing lack of a server-side role check on `reports:*` reads is now explicit and documented rather than merely implicit, and was not widened by the five new channels being added to the same unguarded family.
- **Idempotency / re-run safety:** every new query is read-only except CSV export, which only writes a file the user explicitly chose via the OS save dialog - re-running it overwrites that same file if the same path is chosen again, the ordinary save-dialog behaviour.
- **Residual risk:** `check:fit` does not open a Z-report modal specifically (it exercises the five Reports sub-views' own layouts, not a shift row's tap-through) - `screensFitDesignBox.test.ts`'s px guard and this phase's own real-mount test (confirming no internal scroll container renders) cover it instead. The role-check gap (§4c) is unresolved by design, per instruction.

## 8. Verification

- `npm run typecheck` - clean throughout (checked after every group of changes, and finally at the end).
- `npx vitest run` (full suite) - **119 test files, 1797 tests passed**, zero failures.
- Standing tripwires re-run explicitly - **18 files, 329 tests, all green** (§3 lists them).
- `npm run build` - succeeds (97 modules, no version bump, no installer rebuilt).
- `npm run check:fit` - **18/18 cases pass** across all nine supported window sizes, including the new "Admin Reports > {Shift History, Sales Summary, Fiscal Status, Invoice List, Export}" scenario added for this phase - zero page overflow, zero unexpected inner scroll container, at every size.
- The two required mutation checks (§4) performed and reverted; `git diff` on `reports.ts` confirmed clean before committing.
- `git status --short` confirmed exactly the files in §5 were touched, and `git diff --stat` against every hard-rule-protected file (`checkout.ts`, `fiscal-retry.ts`, `fiscal-routing.ts`, `real-etims-provider.ts`, `mock-etims-provider.ts`, `mpesa-provider-factory.ts`, `integrations/mpesa.ts`, `orders.ts`) returned nothing.

## 9. Rollback

`git revert` of this commit restores the additive-tax formula, the UTC "Today's Sales" default, `ZReportModal`'s old scroll-based sizing, and removes the Reports tab, the five new IPC channels, the new index, and the new library files - nothing here is destructive: the new index can be dropped with no data loss, and no existing column or table changed shape.

## 10. Observed but not changed

- The double-fetch on the Invoice List when switching presets (a `page`-reset effect racing the data-fetch effect) was noticed and fixed during this phase's own work (folded the reset into the preset handler) rather than left as a separate finding, since it was trivial and caught before verification.
- `reports:z-report`'s new schema and the five new channels' schemas all default sensibly, but none of them re-verifies that a *shift* or *order* actually exists before returning an empty/error result - this already matches `generateZReport`'s own existing "throws for a non-existent shift" behaviour, surfaced as a clean `ServiceResult` failure, so no change was needed there.
- Everything in docs/KNOWN_GAPS.md's five new entries (§2, step 8) remains open by design - none of it was in scope to close this phase.

---

**STOP.**
