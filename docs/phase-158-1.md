# Phase 158-1: small fixes to the Admin Reports tab (docs/phase-158)

Disciplined-engineering build task. Same hard rules as docs/phase-158: no
change to fiscal code, payment code, `orders.ts`, the sync engine, or the
customer receipt; no device commands. British spelling, no em dashes,
`file:line` for every claim.

## 1. Audit

### What was examined

- `src/main/index.ts:2916-2947` - the `reports:export-csv` handler (save
  dialog, defaultPath, filename).
- `src/renderer/src/components/ZReportModal.tsx:132` - the hardcoded
  "VAT included (calculated at 16%)" label.
- `src/main/services/printer.ts:341` (before this change) - the same
  hardcoded label in `renderZReport`.
- `src/renderer/src/pages/ReportsPage.tsx:240` - a third copy of the same
  hardcoded label, in the Sales Summary sub-view (found during audit, not
  named in the task - see decision D1 below).
- `src/main/services/reports.ts` - `ZReport`, `SalesSummary`,
  `computeVatIncluded`, `generateZReport`, `generateSalesSummary`,
  `localDayOf`, `getReportRange` (to see what Nairobi-day helper already
  existed for the filename fix).
- `src/main/services/reportsExport.ts:45-107` - `buildOrdersCsv`'s column
  list and row-building.
- `src/main/services/orders.ts:32,65-100` - `CLIENT_ORDER_UUID_KEY`,
  `buildOrderInput`, to confirm exactly what value orders.ts sends
  Shopify as the `client_order_uuid` customAttribute/metafield.
- `docs/KNOWN_GAPS.md:203-342` - existing gap-entry style and the current
  end of the file, to append consistently.
- `tests/printer.test.ts`, `tests/reportsExport.test.ts`,
  `tests/reportsPage.test.ts`, `tests/reports.test.ts`,
  `tests/reportRanges.test.ts` - existing coverage and fixtures that a
  new required `vatRate` field would touch.

### How it currently works (before this change)

1. **Export dialog**: `reports:export-csv` called `dialog.showSaveDialog`
   with no parent window (the windowless overload) and a `defaultPath` of
   just a bare filename (`orders-today-2026-09-25.csv`), which Electron
   resolves relative to the OS's last-used save location, not always the
   Documents folder. The date embedded in that filename was
   `range.startIso.slice(0, 10)` - the UTC calendar day of the range's
   start instant, not the Nairobi day.
2. **VAT label**: three separate files each printed a literal
   `"VAT included (calculated at 16%)"` string. `ZReport.vatIncluded` and
   `SalesSummary.vatIncluded` were already computed from the store's
   actual configured `taxRate` (docs/phase-158), but the *label* ignored
   that rate entirely.
3. **CSV columns**: `orders.csv` had no column carrying the order's
   `client_order_uuid`, even though this is the same value already
   stored in every order's `payload_json` and already sent to Shopify.

### Dependencies found

- **Inbound (callers of the changed code)**:
  - `reports:export-csv` is called only from `preload/index.ts`'s
    `exportReportsCsv`, called only from `ReportsPage.tsx`'s
    `ExportView` (two buttons). No other caller.
  - `ZReport.vatRate` / `SalesSummary.vatRate` (the new field): consumed
    by `ZReportModal.tsx`, `renderZReport` (printer.ts), and
    `ReportsPage.tsx`'s `SalesSummaryView`. `DailySummary` (used by
    `AdminScreen.tsx`'s "Today's Sales" widget) was deliberately **not**
    given this field - that widget shows no VAT label at all, so there
    is nothing there to fix (see D2).
  - `buildOrdersCsv`'s header/row shape: consumed only by
    `reports:export-csv` and by `tests/reportsExport.test.ts`. Appending
    a column at the end (rather than inserting one) keeps every existing
    column index - including the VAT-included index the phase-158
    mutation-check test asserts on (`dataRow[9]`) - unchanged.
- **Outbound**: `localDayOf` (already exported, `reports.ts:293`, used
  unmodified) for the Nairobi-day filename fix; `app.getPath('documents')`
  and `BrowserWindow.fromWebContents` (both Electron APIs already
  imported in `index.ts`).
- **String-based / indirect references**: none found for these three
  changes - no route names, DI tokens, or env vars are involved.

### Risks and constraints identified

- `BrowserWindow.fromWebContents(event.sender)` can return `null` if the
  invoking window has already been destroyed mid-call - handled by
  falling back to the windowless `dialog.showSaveDialog` overload rather
  than throwing.
- No existing test exercises `index.ts`'s IPC handlers directly (grep
  confirms no `tests/index*.ts` file exists in this codebase) - this is
  an established gap in this project's own test pyramid, not something
  introduced here. See Verification, below, for what this means for the
  dialog/filename change specifically.

## 2. Changes made

1. **`src/main/index.ts`** (`reports:export-csv` handler,
   `index.ts:2916-2953`):
   - Renamed the handler's first parameter from `_event` to `event` and
     passed `BrowserWindow.fromWebContents(event.sender)` as the save
     dialog's parent window (falling back to the windowless overload if
     that lookup returns `null`).
   - `defaultPath` is now `join(app.getPath('documents'), fileName)`.
   - `fileName` is now `` `rubis-${kind}-${preset}-${localDayOf(range.startIso)}.csv` ``
     - both the `rubis-` prefix the task asked for, and the Nairobi
       calendar day via the already-exported `localDayOf`, replacing the
       old UTC-day `range.startIso.slice(0, 10)` (see Mutation/manual
       check, below - this really was off by a day for the "today"
       preset).
   - Added `localDayOf` to the existing `reports.js` import list.

2. **`src/main/services/reports.ts`**:
   - Added `export function formatVatRateLabel(rate: number): string`
     returning `` `VAT included (calculated at ${Math.round(rate * 100)}%)` ``,
     placed directly after `computeVatIncluded` (the two are always used
     together).
   - Added a required `vatRate: number` field to the `ZReport` and
     `SalesSummary` interfaces, populated from each generator's own
     `taxRate` parameter (`generateZReport`, `generateSalesSummary`) -
     the same rate already used to compute `vatIncluded`, so the label
     and the figure can never disagree.
   - `DailySummary` was deliberately left unchanged - see decision D2.

3. **`src/main/services/printer.ts`** (`renderZReport`):
   - Imported `formatVatRateLabel` and replaced the hardcoded
     `` `VAT included (calculated at 16%): ...` `` line with
     `` `${formatVatRateLabel(report.vatRate)}: ...` ``.

4. **`src/renderer/src/lib/vatLabel.ts`** (new file):
   - A one-line renderer-side twin of `formatVatRateLabel`. Not a value
     import from `main/services/reports.ts` - every existing renderer
     import from that directory in this codebase is `import type` only
     (confirmed by grep across `src/renderer/src`); main-process code is
     never bundled into the renderer. A second copy of one line of
     arithmetic is a smaller risk than breaking that boundary
     convention, and far smaller than the `buildTraderSystemInvNum`
     duplication docs/phase-158 already accepted for the same reason.

5. **`src/renderer/src/components/ZReportModal.tsx`**:
   - Replaced the hardcoded label with
     `formatVatRateLabel(report.vatRate)` (renderer copy).

6. **`src/renderer/src/pages/ReportsPage.tsx`** (`SalesSummaryView`):
   - Replaced its own hardcoded `"VAT included (16%)"` with
     `formatVatRateLabel(summary.vatRate)`. Not named in the task's step
     2, but the same defect - see decision D1.

7. **`src/main/services/reportsExport.ts`** (`buildOrdersCsv`):
   - Appended one column, `'Client order UUID'`, at the **end** of the
     header (not inserted mid-list, to avoid shifting any existing
     column index), with value `payload?.clientOrderUuid ?? ''` - the
     exact same field `orders.ts:83,90` sends Shopify as the
     `customAttributes`/`metafields` value.

8. **`docs/KNOWN_GAPS.md`**:
   - Appended one new section, "Reports VAT uses one rate per order, not
     per line", using the task's own wording for the "what's still open"
     line, matching the file's existing heading/blast-radius structure.

9. **Tests** (all new assertions, no existing assertion's expected value
   was changed):
   - `tests/reportRanges.test.ts`: two new tests for
     `formatVatRateLabel` (16% and 8%).
   - `tests/printer.test.ts`: a new `describe('renderZReport (docs/phase-158-1)', ...)`
     block (`renderZReport` had **no** existing test coverage at all
     before this change - a gap found during audit, not introduced by
     it) with two tests, one at 0.16 and one at 0.08.
   - `tests/reports.test.ts`: one new test each for `generateZReport` and
     `generateSalesSummary` asserting `.vatRate` equals the rate passed
     in, at both 0.08 and 0.16.
   - `tests/reportsExport.test.ts`: one new test building a real
     `OfflineOrderPayload`, running it through both `buildOrdersCsv` and
     the real `buildOrderInput` (imported read-only, `orders.ts` itself
     is untouched), and asserting the CSV column, the customAttribute
     value, and the metafield value are all the same string.
   - `tests/reportsPage.test.ts`: three new tests - Sales Summary at 8%
     (label only, not 16%), Shift History's Z-report modal at 8% (same),
     and the existing SAMPLE_Z_REPORT/getSalesSummary fixtures updated
     with `vatRate: 0.16` (a required field addition, not a behaviour
     change to an existing assertion).

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/main/index.ts` | Modified | `reports:export-csv` handler: save-dialog parenting and default filename/folder |
| `src/main/services/reports.ts` | Modified | Adds `formatVatRateLabel`; adds `vatRate` to `ZReport`/`SalesSummary` |
| `src/main/services/printer.ts` | Modified | `renderZReport`'s printed VAT label |
| `src/main/services/reportsExport.ts` | Modified | `orders.csv`'s column list (one new column, appended) |
| `src/renderer/src/lib/vatLabel.ts` | Added | Renderer-side VAT label formatting, shared by two components |
| `src/renderer/src/components/ZReportModal.tsx` | Modified | On-screen Z-report VAT label |
| `src/renderer/src/pages/ReportsPage.tsx` | Modified | Sales Summary sub-view's VAT label |
| `docs/KNOWN_GAPS.md` | Modified | Records the still-open per-order-not-per-line VAT approximation |
| `tests/reportRanges.test.ts`, `tests/printer.test.ts`, `tests/reports.test.ts`, `tests/reportsExport.test.ts`, `tests/reportsPage.test.ts` | Modified | New coverage; no existing assertion's expected value changed |

## 4. Decisions made (not explicitly specified in the task)

- **D1 - fixed the Sales Summary view's own hardcoded 16% too.** The
  task named only `ZReportModal` and `renderZReport` for step 2. Auditing
  turned up a third, identical hardcoded string in
  `ReportsPage.tsx:240`. Leaving it would mean two of three "VAT
  included" labels in this app were correct at a non-16% rate and one
  was silently wrong - a worse, more confusing state than before this
  change. Fixed it the same way (`formatVatRateLabel(summary.vatRate)`),
  using the `SalesSummary.vatRate` field added for the same reason.
- **D2 - did not add `vatRate` to `DailySummary`.** `DailySummary`
  (used only by `AdminScreen.tsx`'s "Today's Sales" widget) shows no VAT
  label at all today - only order count, revenue, cash, and M-Pesa/card
  totals. Adding an unused field would be speculative. If a VAT label is
  ever added there, `taxRate` is already threaded through
  `generateDailySummary`'s call site and the field can be added then.
- **D3 - appended the new CSV column at the end, not inline.** The task
  didn't specify a position. Docs/phase-158's own VAT mutation-check test
  in `tests/reportsExport.test.ts` indexes the VAT column by a fixed
  position (`dataRow[9]`); appending rather than inserting keeps every
  existing index - including that one - unchanged, so this change cannot
  silently break a check written for a different reason.

## 5. Possible impact

- **Direct**: the CSV "Save" dialog now opens the Documents folder by
  default and is parented to the app window (a sheet on macOS, a modal
  on Windows) instead of a detached top-level dialog; exported filenames
  now read `rubis-orders-today-2026-09-26.csv` instead of
  `orders-today-2026-09-25.csv` for the same export (Nairobi date, one
  day later than before for "today"/"yesterday" - a corrected filename,
  not new data). The three on-screen/printed VAT labels now read the
  store's real configured rate. `orders.csv` gains one trailing column.
- **Indirect**: none identified. No other screen reads `ZReport`,
  `SalesSummary`, or `orders.csv`'s column list.
- **Data / schema / contract**: none. No database schema change, no IPC
  request/response shape change (the new `vatRate` field is additive on
  an existing response type; `exportCsvSchema`'s request shape is
  unchanged).
- **Security posture**: unchanged. No new input is accepted; the CSV's
  new column reuses `payload_json`'s already-validated
  `clientOrderUuid`, run through the same `csvCell` escaping as every
  other column.
- **Idempotency / re-run safety**: unchanged - every touched operation
  was already a pure read (CSV export, report generation) or a
  user-confirmed file write via the OS's own save dialog.
- **Residual risk**: the `dialog.showSaveDialog(win, options)` wiring
  itself (the `BrowserWindow.fromWebContents` parenting and the
  Documents-folder default) is not covered by an automated test - see
  Verification, below, for why and what is covered instead.

## 6. Verification

- `npm run typecheck` - clean (both `typecheck:node` and `typecheck:web`),
  run twice (once after the interface change, once after the final test
  additions).
- `npx vitest run` (full suite) - **119 test files, 1806 tests, all
  passing**, run twice in a row for a clean result. (One `tests/stockTake.test.ts`
  timeout was seen on the first full-suite run under load; it passed in
  39/39 in 127ms run in isolation immediately after, and touches nothing
  in this change - recorded as pre-existing flakiness, not a regression.)
- `npm run build` - succeeds; `verify-no-mock-provider.cjs` confirms
  neither mock fiscal provider is in the packaged output.
- `npm run check:fit` - **18/18 cases pass**, including the existing
  Admin Reports scenario (all 5 sub-views, including Export) at every
  window size, with no overflow or unexpected inner scroller.
- **Manual/mutation checks** (each mutation introduced, verified to fail
  the expected tests, then reverted and re-verified clean via `git diff`):
  - Hardcoded `formatVatRateLabel` back to a literal `"...16%)"` string:
    `tests/reportRanges.test.ts`'s 8% test and
    `tests/printer.test.ts`'s 8% `renderZReport` test both failed, as
    expected. `tests/reportsPage.test.ts`'s 8% tests correctly kept
    passing - they render the separate **renderer-side** copy in
    `vatLabel.ts`, which this mutation did not touch, confirming the two
    copies are genuinely independent (a real drift between them would be
    caught by the correspondingly-placed test on each side, not masked
    by the other).
  - Blanked the new `orders.csv` client-order-UUID column to `''`:
    `tests/reportsExport.test.ts`'s new test failed exactly as expected
    (`expected '' to be 'uuid-42'`).
  - Confirmed `git diff` on both mutated files was byte-identical to the
    pre-mutation version after reverting, then re-ran both affected test
    files to confirm a clean pass.
- **Not verified by automation**: the `reports:export-csv` handler's
  `BrowserWindow.fromWebContents`/`dialog.showSaveDialog(win, ...)`
  wiring and the `app.getPath('documents')` default path. This codebase
  has no existing test that exercises any `index.ts` IPC handler
  directly (confirmed by grep: no `tests/index*.ts` file exists) - every
  `reports:*` handler is only exercised indirectly, through
  `ReportsPage.tsx`'s mocked `window.api`. Adding direct main-process IPC
  handler tests (mocking Electron's `dialog`/`BrowserWindow`) would be a
  test-infrastructure change well beyond this task's scope, so this is
  recorded honestly rather than silently claimed as tested. What *is*
  covered: the Nairobi-day date computation itself (`localDayOf`) has
  its own existing, passing test coverage in
  `tests/reportRanges.test.ts`, and `npm run check:fit` confirms the
  Export sub-view renders and its two buttons exist without ever
  clicking them (clicking would open a real native OS dialog that CDP
  automation cannot drive, so `check-fit.mjs`'s `checkReportsTab`
  deliberately stops short of that).

## 7. Rollback

`git revert` the commit for this phase. No data or config migration is
involved - every change is in application code, tests, and
documentation. Reverting restores the previous (UTC-day, hardcoded-16%,
no-client-UUID-column, windowless-dialog) behaviour exactly.

## 8. Observed but not changed

- The `reports:export-csv` handler itself, along with every other
  `reports:*` IPC handler, remains untested at the IPC-handler level
  (see Verification). This is a pre-existing property of this codebase's
  test pyramid, not introduced here, and is beyond this task's scope to
  fix.
- `docs/KNOWN_GAPS.md`'s new "per-order, not per-line" VAT entry
  cross-references G8 (device figures) and Item 3 (per-item VAT
  classes) - both already tracked elsewhere in that file; no new gap
  category was invented.

**STOP for review.**
