# Phase 163 - Store the device's per-VAT-group amounts, add a fiscal reconciliation report

- **Date:** 2026-09-27
- **Requested:** store the fiscal device's per-VAT-group amounts for each filed sale (Commit 1), then add a read-only fiscal reconciliation report comparing what the till charged against those device-validated amounts (Commit 2, VIL checklist item 13). Based on docs/phase-159 B1.1, B1.2 and its builds 2-3.
- **Outcome:** Implemented, two commits as requested.
- **Branch / base commit:** staging @ 6b810dd (Phase 162-2 - verifyAlreadyFiled daily-closure carve-out).

## COMMIT 1 - store the device amounts (`45d4669`)

### What was examined

- `src/main/services/database.ts` - the `orders` table's existing additive-column pattern (`migrateOrdersFiscalColumns`, `SCHEMA.orders`), `OrderRow`, `setOrderFiscalInfo`, `markFiscalQueueItemSynced`, every `SELECT` listing the `fiscal_*` columns.
- `src/main/services/integrations/real-etims-provider.ts` - `submitInvoice`'s Step 5 (`ReadCurrentReceiptInfo`) and its final success return; `sumVatGroupSubtotals`/`SUBTOTAL_FIELDS` (the existing read-VAT-gate helper, a different purpose from what this phase needed).
- `src/main/services/integrations/etims.ts` - `FiscalInvoiceResult`, `FiscalInvoiceRequest.taxAmount`.
- `src/main/services/checkout.ts`, `src/main/services/fiscal-engine.ts`, `src/main/services/fiscal-retry.ts` - the three places a successful `submitInvoice` outcome is written to storage (checkout, the background retry queue, and manual resend).
- `tests/realEtimsProvider.test.ts`, `tests/fiscalIntegration.test.ts`, `tests/fiscalResend.test.ts`, `tests/database.test.ts`, `tests/fiscalEngine.test.ts` - existing test conventions and fixtures, in particular `tests/fixtures/wire/readcurrentreceiptinfo-ok.xml` (GA "120.00", cited in the task brief).

### How it worked before this phase

`submitInvoice`'s Step 5 read `ReadCurrentReceiptInfo`'s five `SubtotalAmountVATGA`..`GE` fields only to sum them for a `>0` sanity check (the "read-VAT gate", `sumVatGroupSubtotals`) - the raw values were then discarded. Nothing on the order row recorded what the device had actually validated.

### Changes made

- **`src/main/services/integrations/etims.ts`:** added `FiscalVatGroupAmounts` (`{ A?, B?, C?, D?, E? }`, raw strings, keyed by the same VAT-class letters `FiscalInvoiceLine.vatClass` already uses) and `FiscalInvoiceResult.vatGroups?: FiscalVatGroupAmounts`. Added the requested doc comment on `FiscalInvoiceRequest.taxAmount` ("Calculated by the till, added on top. Not sent to the device. Do not use for reports; prices include VAT.").
- **`src/main/services/integrations/real-etims-provider.ts`:** added `extractVatGroupAmounts(receiptInfo)` (exported, next to `sumVatGroupSubtotals`) - reads the same five fields, raw, no parsing/summing, omitting any field the response didn't include. Added `vatGroups: extractVatGroupAmounts(receiptInfo)` to `submitInvoice`'s **one** normal-completion success return only - not to the `verifyAlreadyFiled` "already-filed" recovery's `ok: true` return, which never re-runs Step 5.
- **`src/main/services/database.ts`:** added `fiscal_vat_groups_json TEXT` to `SCHEMA.orders` and to `migrateOrdersFiscalColumns`'s idempotent `ALTER TABLE` list; added the column to `OrderRow` and to every `SELECT` that already lists the other `fiscal_*` columns (`getOrder`, `getOrderByFiscalInvoiceNumber`, `getOrdersForDateRange`, `getOrderRowsForRange`, `getOrders`). `setOrderFiscalInfo` gained an optional `vatGroups?: FiscalVatGroupAmounts` parameter, `JSON.stringify`d or `NULL`; `markFiscalQueueItemSynced` gained the same parameter and forwards it.
- **`src/main/services/checkout.ts`, `fiscal-engine.ts`, `fiscal-retry.ts`:** every caller of `setOrderFiscalInfo`/`markFiscalQueueItemSynced` now passes `invoice.data.vatGroups` / `result.data.vatGroups` / `outcome.data.vatGroups` through.
- **Tests** (all additions, see Verification for the one required list of changed existing assertions): `tests/fiscalIntegration.test.ts` (success via the real provider fed the `readcurrentreceiptinfo-ok.xml` fixture; failure stores nothing; a queued retry that succeeds stores its own figures), `tests/fiscalResend.test.ts` (a manual resend stores its figures), `tests/realEtimsProvider.test.ts` (`extractVatGroupAmounts` unit tests; a normal success carries `vatGroups` through; the already-filed recovery's outcome carries `vatGroups: undefined`), `tests/fiscalVatGroupsMigration.test.ts` (new file - a real, file-backed `better-sqlite3` database simulating an old install: the column is added via `ALTER TABLE`, the pre-existing row reads back `NULL`, and the column works going forward).

### Verification

- `npm run typecheck` - clean.
- `npx vitest run` - **125 test files, 1891 tests passed** (up from 1880 at the base commit).
- **Changed existing assertions** (fiscal suite, listed by name per the task's rule):
  - `tests/database.test.ts` > `RubisDatabase.markFiscalQueueItemSynced` > `'saves the invoice number/QR code on the order and deletes the queue row'`: `updates[0].params[3]` was `toBe(7)` (the localId) -> now `toBe(null)` (the new vatGroups param) with a new `updates[0].params[4]` -> `toBe(7)`. **Why:** `setOrderFiscalInfo`'s `UPDATE` gained a new bound parameter ahead of `localId`.
  - `tests/database.test.ts` > `RubisDatabase.setOrderFiscalInfo` > `'sets fiscal_status = fiscalized and clears any previous error reason/kind'`: `params` was `toEqual(['KRA-0001', 'base64qr', expect.any(String), 7])` -> now `toEqual(['KRA-0001', 'base64qr', expect.any(String), null, 7])`. **Why:** same new parameter.
  - `tests/fiscalEngine.test.ts` > `'resubmits every due item and marks successes synced'`: `markFiscalQueueItemSynced` was expected called with 3 args -> now 4, with `undefined` as the new trailing `vatGroups` arg (the stub outcome carries none). **Why:** `markFiscalQueueItemSynced`'s new parameter is always forwarded, even as `undefined`.
  - `tests/fiscalEngine.test.ts` > `'makes NO device call and marks the queue item synced when the order was already fiscalized (race with a resend)'`: same change, same reason - the already-fiscalized race guard's stored outcome carries no `vatGroups`.
  - No other existing assertion was changed.
- **Mutation test:** temporarily removed `vatGroups: extractVatGroupAmounts(receiptInfo)` from `submitInvoice`'s success return. Reran the storage tests: **exactly 2 failed** (`fiscalIntegration.test.ts`'s success-path storage test, and `realEtimsProvider.test.ts`'s direct "carries Step 5's raw VAT-group amounts through" test) - the failure-path, retry-success, and already-filed tests were unaffected (they don't depend on the provider's own return, or exercise a different path entirely), confirming the blast radius was exactly as expected. Restored; reran - all passed again.

## COMMIT 2 - reconciliation report, read-only (`42a9931`)

### What was examined

- `src/main/services/reports.ts` in full - `generateFiscalStatusByDay` (the exact precedent for "run against every order, including a voided-but-fiscalised one, deliberately not through `excludeVoided`"), `getReportRange`/`ReportRange`, `generateSalesSummary`/`SalesSummary`, `computeVatIncluded`/`formatVatRateLabel`.
- `src/main/services/reportsExport.ts` in full - `buildOrdersCsv`'s header/row-building pattern.
- `src/main/lib/traderSystemInvoiceNumber.ts` - the already-extracted, already-tested `buildTraderSystemInvNum`, reused rather than re-derived (docs/phase-158's own precedent for exactly this situation).
- `src/main/index.ts` - the `reports:sales-summary`/`reports:fiscal-by-day`/`reports:invoice-list` handler shapes, `REPORTS_PAGE_SIZE`.
- `src/main/lib/ipcValidator.ts` - `salesSummarySchema`/`fiscalByDaySchema`, the schema pattern for a preset-only request.
- `src/preload/index.ts`, `src/preload/window.d.ts` - the bridge/type pattern for a `getXxx(preset)` method.
- `src/renderer/src/pages/ReportsPage.tsx` in full - `FiscalStatusView` (client-side pagination via `paginate()`, the precedent this phase's sub-view follows exactly, since a reconciliation preset's counts need the whole range, not one server page at a time), `SalesSummaryView`'s summary-counts grid, `InvoiceListView`'s table styling, `PresetButtons`/`Pager`.
- `scripts/check-fit.mjs` - `checkReportsTab`'s exact-text-match sub-view label array, and the "no unexpected internal scrollers" rule.
- `docs/phase-65.md` - the confirmed VIL manual VAT-class table (`'A'`=16%, `'B'`=8%, `'C'`=0%, `'D'`="usually free for any other rates", `'E'`=Exempt), the source for the per-group VAT derivation the task specified.

### Changes made

- **`src/main/services/reports.ts`:**
  - `generateFiscalReconciliation(db, range, logger = console)`: for every order in `range` with `fiscal_status === 'fiscalized'` (via `db.getOrdersForDateRange`, deliberately **not** run through `excludeVoided` - identical reasoning to `generateFiscalStatusByDay`: a filed sale stays filed with KRA even if later voided), builds one `FiscalReconciliationRow` per order (`buildReconciliationRow`, exported so `reportsExport.ts` can reuse it) and aggregates `FiscalReconciliationTotals`.
  - `buildReconciliationRow`: `charged = order.total`; if `fiscal_vat_groups_json` is `NULL`, status is `'no-device-figure'` (`deviceTotal`/`difference`: `null`). Otherwise each present group's raw string is `Number()`-parsed; **any** non-numeric value makes the **whole row** `'no-device-figure'` (not just that group) and logs once via the injected `logger.warn`. Otherwise `deviceTotal` = the sum of parsed amounts, `difference = deviceTotal - charged`, `status` = `'matched'` when `|difference| <= 0.01`, else `'mismatch'` - **never** `'mismatch'` for a missing/unparseable figure.
  - `deriveGroupVat(letter, amount)`: `'A'` → `amount * 16/116`, `'B'` → `amount * 8/108`, `'C'`/`'E'` → `0`, `'D'` → `'not-known'` (never guessed) - the confirmed VIL manual table (docs/phase-65).
  - Rows are sorted mismatches first, then no-device-figure, then matched, each group otherwise in creation order (a stable sort).
  - `SalesSummary` gained `vatFromDeviceGroups: number` (via a new `sumVatFromDeviceGroups` helper) - a separate, best-effort aggregate shown alongside the existing `vatIncluded` figure, not replacing it; silently skips orders with no/non-numeric device figures and excludes group `'D'` (no known rate).
- **`src/main/services/reportsExport.ts`:** `orders.csv` gained 8 columns appended after the existing last column (`Client order UUID`, so no existing column shifted): `Device total`, `Difference`, `Reconciliation status` (via the shared `buildReconciliationRow`, blank for a never-fiscalized order), and `VAT group A`..`E` (the raw device strings, independent of fiscalization outcome).
- **`src/main/lib/ipcValidator.ts`:** `fiscalReconciliationSchema` (`{ preset }`, identical shape to `salesSummarySchema`).
- **`src/main/index.ts`:** `reports:fiscal-reconciliation` handler - validates, resolves the preset via `getReportRange`, calls `generateFiscalReconciliation(db, range)` (default `console` logger).
- **`src/preload/index.ts`, `src/preload/window.d.ts`:** `getFiscalReconciliation(preset)`.
- **`src/renderer/src/pages/ReportsPage.tsx`:** new "Fiscal Reconciliation" sub-view/tab - preset buttons, a summary-counts grid (matched/mismatch/no-device-figure counts, charged/device sums), and a client-side-paginated table (time, trader invoice #, CU invoice #, charged, device, difference, status - mismatches already sorted first by the backend). No new `overflow: auto/scroll` container - the same `overflow-x-auto` table wrapper every other sub-view uses.
- **`scripts/check-fit.mjs`:** added `'Fiscal Reconciliation'` to `checkReportsTab`'s sub-view label array, so `check:fit` actually opens and measures the new tab.

### Tests (all additions unless noted)

- `tests/reportRanges.test.ts` - `generateFiscalReconciliation`: matched (1.00 charged, GA "1.00"); mismatch (charged 190.00, GA "200.00", the docs/phase-160 discount case); no device figure (`NULL`); mixed groups (GA "116.00" + GE "50.00" → device total 166.00, VAT 16.00 from A, 0 from E); group D present → VAT `'not-known'`; non-numeric value → no device figure, logged once; a voided-but-fiscalised order still listed; a never-fiscalized order excluded entirely; mismatches sorted first; totals (counts + sums); trader/CU invoice numbers.
- `tests/reports.test.ts` - `SalesSummary.vatFromDeviceGroups`: sums the derivable VAT across stored groups; excludes group D and orders with no stored figure.
- `tests/reportsExport.test.ts` - `orders.csv`'s 8 new columns: filled correctly for a mismatch; blank for a never-fiscalized order; `'no-device-figure'` (not blank, not a mismatch) for a fiscalized order with no stored figure.
- `tests/reportsPage.test.ts` - the sub-nav's existing "declares the five named sub-views" test **updated** to six (see below); new "Fiscal Reconciliation" describe block: renders summary counts and a mismatch row; switching presets re-fetches; shows "no device figure" text (not blank).

### Verification

- `npm run typecheck` - clean.
- `npx vitest run` - **125 test files, 1910 tests passed** (up from 1891 after Commit 1).
- `npm run build` - succeeded (all three targets); `verify-no-mock-provider.cjs` postbuild check clean.
- `npm run check:fit` - **18/18 cases fit**, no overflow, including the new "Fiscal Reconciliation" sub-view at every tested zoom level (confirmed the new label was added to `checkReportsTab`'s array first, so this genuinely exercised the new screen rather than skipping it).
- **Changed existing assertion** (outside the fiscal protocol suite strictly speaking, but listed for the same reason): `tests/reportsPage.test.ts` > `ReportsPage > sub-nav` > `'declares the five named sub-views'` → renamed `'declares the six named sub-views'`, with `'Fiscal Reconciliation'` added to the list of expected buttons. **Why:** a sixth sub-view/tab was added; the old assertion would otherwise silently miss covering it.
- **Mutation test** (re-run after all of Commit 2's code was in place, not just Commit 1's storage layer): temporarily reverted `buildReconciliationRow`'s `NULL` branch to treat a missing device figure as `deviceTotal: 0`/`status: 'mismatch'` instead of `'no-device-figure'`. Reran every test touching this behaviour: **exactly 4 failed** - the three `generateFiscalReconciliation` tests that depend on the `'no-device-figure'` classification (the direct test, the sort-order test, and the totals test) plus the one `orders.csv` "no-device-figure" column test. Every other test, including all three new `reportsPage.test.ts` UI tests (which use a different, already-`'mismatch'`-shaped fixture and so were never going to be sensitive to this branch), stayed green - confirming the mutation's blast radius was exactly the tests actually exercising the `NULL`-handling branch, not a coincidence of unrelated tests happening to fail. Restored; reran the full suite - 1910/1910 passed again.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/main/services/integrations/etims.ts` | Modified | `FiscalVatGroupAmounts` type, `FiscalInvoiceResult.vatGroups`, `taxAmount` doc comment |
| `src/main/services/integrations/real-etims-provider.ts` | Modified | `extractVatGroupAmounts`, `submitInvoice`'s success return |
| `src/main/services/database.ts` | Modified | `orders.fiscal_vat_groups_json` column, `setOrderFiscalInfo`/`markFiscalQueueItemSynced` |
| `src/main/services/checkout.ts`, `fiscal-engine.ts`, `fiscal-retry.ts` | Modified | Thread `vatGroups` from a submitInvoice outcome to storage |
| `src/main/services/reports.ts` | Modified | `generateFiscalReconciliation`, `buildReconciliationRow`, `deriveGroupVat`, `SalesSummary.vatFromDeviceGroups` |
| `src/main/services/reportsExport.ts` | Modified | `orders.csv`'s 8 new columns |
| `src/main/lib/ipcValidator.ts` | Modified | `fiscalReconciliationSchema` |
| `src/main/index.ts` | Modified | `reports:fiscal-reconciliation` IPC handler |
| `src/preload/index.ts`, `src/preload/window.d.ts` | Modified | `getFiscalReconciliation` bridge/type |
| `src/renderer/src/pages/ReportsPage.tsx` | Modified | New "Fiscal Reconciliation" sub-view |
| `scripts/check-fit.mjs` | Modified | New sub-view added to the exercised tab list |
| Various `tests/*.ts` | Modified/Added | Coverage for all of the above |

## 4. Possible impact

- **Direct:** every future successful fiscalization (checkout, background retry, manual resend) now also writes `fiscal_vat_groups_json`. A new read-only Admin Reports sub-view and 8 new `orders.csv` columns surface a comparison against those figures; the Sales Summary gains one new figure alongside the existing one.
- **Indirect:** none identified - `OrderRow` widened additively; every existing `SELECT` that already returned the other `fiscal_*` columns now also returns this one, with no behavioural change to any existing caller (confirmed by the full suite passing unmodified apart from the four listed parameter-shift assertions).
- **Data / schema / contract:** one new nullable `TEXT` column, added additively and idempotently (confirmed against a real, file-backed database simulating an existing install). No command, argument, sequence, or filed data sent to the fiscal device changed - confirmed by `git diff` showing the only production change inside `real-etims-provider.ts` is the one new field on an already-successful return.
- **Security posture:** unchanged. The new IPC channel follows the exact same (documented, pre-existing) no-extra-role-check pattern every other `reports:*` read channel already uses.
- **Idempotency / re-run safety:** unaffected - this is read/store-only, no retries or resends changed.
- **Residual risk:** the report's "matched"/"mismatch" verdict is only as good as what the device actually returns at Step 5 - a device that returns a subtly wrong (but numeric) figure would be reported as a genuine mismatch or match with no way for this build to tell the difference, which is the point of the report, not a gap in it. `docs/KNOWN_GAPS.md` was not updated this phase (out of this task's explicit scope); a future phase could note that `vatFromDeviceGroups` on the Sales Summary silently excludes group D's contribution.

## 5. Verification (combined, final)

- `npm run typecheck` - clean throughout both commits.
- `npx vitest run` - **125 test files, 1910 tests passed**, 0 failed, at the final state.
- `npm run build` - succeeded.
- `npm run check:fit` - **18/18 cases fit**, no overflow, at the final state.
- Both required mutation tests performed and reported above, each showing an exact, expected, non-vacuous blast radius.
- All changed existing assertions listed by name, old → new → why, in each commit's own Verification section above.

## 6. Rollback

```
git revert 42a9931
git revert 45d4669
```
(Commit 2 first, since it depends on Commit 1's column/return field.) No data to unwind beyond the new column itself, which is additive and safe to leave in place even if the code reading it is reverted.

## 7. Observed but not changed

- `docs/KNOWN_GAPS.md` was not updated - out of this task's explicit scope, but a natural follow-up would note the reconciliation report's dependence on the device actually returning correct (if not necessarily matching) VAT-group figures, and that `vatFromDeviceGroups` excludes group D.
- The reconciliation report fetches the whole preset range in one IPC call (client-side paginated), matching `generateFiscalStatusByDay`'s existing precedent - fine for the volumes a single till preset will see, but would need revisiting if presets ever grow to cover much larger ranges.
