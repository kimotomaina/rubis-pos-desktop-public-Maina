# Phase 246 — One Reports tab scoped by shift or range; card at close; the windows usable at any length; Open Shift at 0

- **Date:** 2026-10-06
- **Asked by the owner:** the rules R1 to R7 of the order of 2026-10-06 17:50 Nairobi, with the amendment that End of Day approval is per shift, not per day.
- **Built in three commits**, each with the full suite green: **(a)** the shared window shell, the four windows moved onto it, Open Shift at 0 (R1, R4); **(b)** card counted at close, on the Z report and in corrections (R5); **(c)** the one Reports tab, scoped by shift or range, with End of Day approval per shift (R2, R3 and the amendment).
- **Status:** built and tested, all three parts. Not released: no installer built. `package.json` stays at 2.2.9.
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.**
- **First rule of the phase, kept:** every report keeps calling the function it calls today. No calculation moved or was rewritten.
- **Rulings applied** (the eight decisions of the audit, as the owner left them standing): both Open Shift figures pre-filled with 0; a shift scope is the span of the shift's own sales, with a count note; End of Day per shift (amendment); M-Pesa logs unscoped (latest 50); Export in the Detail section; a custom range typed as two date-times; the End of Day and M-Pesa Logs cards leave the Admin grid; card columns also on the adjustment ledger.

---

## Part (a): the shared shell, the four windows, Open Shift at 0

### Audit

- **Why a long Z report was out of view on the till:** `ZReportModal` was a `fixed inset-0` overlay with a centred box that had no maximum height and no scroll, and its Print and Correct figures buttons were the last thing in the body. A report with several adjustment and correction blocks grew past the 772 px screen, and since the overlay cannot scroll, the buttons were off screen. `WindowReportModal` and `ShiftCorrectionForm` had the same shape; Move a sale was a section that replaced the list.
- **Rules in the way:** phase 158 had chosen "no internal scroll" for the Z report, and `noUnexpectedScroll.test.ts` kept `ZReportModal` at zero scroll classes. R1 reverses that on purpose. The single scroll class now lives in one component, so the four windows stay at zero and the shell has one allow-listed entry.
- **Open Shift:** `OpenShiftDialog` (the cart's) and the Admin screen both started the cash and M-Pesa fields blank. One shared form, `OpenShiftForm`.

### What changed

| Where | What |
| --- | --- |
| [ModalShell.tsx](../src/renderer/src/components/ModalShell.tsx) (new) | `ShellPanel`: a header and a footer that never shrink, a body between them (`touch-scrollbar min-h-0 flex-1 overflow-y-auto`, the always-visible bar of phase 220). `ModalShell`: the backdrop and a box never taller than the screen (`max-h-full`) around a `ShellPanel`. The one place these windows scroll. |
| [ZReportModal.tsx](../src/renderer/src/components/ZReportModal.tsx) | On the shell: the report scrolls in the body; the print message and the Print Z-Report and Correct figures buttons are in the footer. No content change. |
| [WindowReportModal.tsx](../src/renderer/src/components/WindowReportModal.tsx) | On the shell, same dialog name; the table scrolls under a fixed header. |
| [ShiftCorrectionForm.tsx](../src/renderer/src/components/ShiftCorrectionForm.tsx) | On the shell: the fields scroll; Cancel, Record correction and the error message are in the footer, so an error is never scrolled out of sight. |
| [MoveSaleForm.tsx](../src/renderer/src/components/MoveSaleForm.tsx), [ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx) | On a `ShellPanel`: Cancel in the header; the form scrolls; Move sale and the error are in the footer. The page's wrapper for it is a column that fills the height it is given. |
| [openShiftFloat.ts](../src/renderer/src/lib/openShiftFloat.ts), [OpenShiftDialog.tsx](../src/renderer/src/components/OpenShiftDialog.tsx), [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) | `OPEN_SHIFT_FIGURE_DEFAULT = '0'`: the drawer count and the M-Pesa balance both start at 0, editable, in the cart's dialog and on the Admin screen, and are put back to 0 after an open or a cancel. The S6 rule is unchanged: sales already made in the window join and the float is still the drawer less their cash. |

### Two consequences of "both at 0" the owner should know

1. **The M-Pesa field no longer means "not recorded" by default.** A shift opened by leaving the field alone now records an opening balance of 0, so its Z report shows the M-Pesa expected and the "Check against the M-Pesa statement" lines. To record "not recorded", clear the field.
2. **With earlier M-Pesa sales in the window, Confirm is held until the field is counted or cleared.** The existing S6 rule refuses an M-Pesa balance below the earlier M-Pesa sales (the float would be negative), and a pre-filled 0 is below them. The cashier must type the balance or clear the field. Cash behaves as before: a 0 drawer below earlier cash sales is refused until it is counted, or an admin ticks "start at 0".

### Tests

[modalShell.test.ts](../tests/modalShell.test.ts), 8 tests: the shell's body scrolls and the header and footer are outside it and do not shrink; the box is never taller than the screen; the scroll class appears in the shell and in none of the four windows; for each window, which parts are in the body and which in the footer (the Z report with twelve adjustment blocks keeps Print and Correct figures in the footer; the print message stays in the footer; the correction and Move a sale errors are in the footer).

In [shiftCaptureUi.test.ts](../tests/shiftCaptureUi.test.ts), two added tests: both figures start at 0, editable; and a pre-filled M-Pesa 0 holds Confirm below earlier M-Pesa sales until it is counted or cleared.

### Mutation check (restored; the file compared byte for byte afterwards)

| # | Mutation | Failing tests |
| --- | --- | --- |
| R1 | A modal body that does not scroll (`overflow-y-auto` removed from the shell's body) | 3: `the shell > scrolls its body, keeps the header and the footer outside it…`, `the shell > has the one scroll class of the four windows…`, `noUnexpectedScroll > ModalShell.tsx has exactly its allow-listed count` |

### Existing tests changed (each with an old/new note in the file)

| Test | Old | New |
| --- | --- | --- |
| `adminShiftMpesaBalance.test.ts` (2) | the M-Pesa field started empty; a blank one sent `undefined` | it starts at 0 (placeholder "Not recorded" when cleared); the blank test clears it first |
| `adminShiftWindows.test.ts` (1) | the call carried `undefined` for M-Pesa | it carries 0 |
| `shiftCaptureUi.test.ts` (5) | `undefined` for M-Pesa; a blank cash field gave "Enter a valid starting cash amount" | 0 for M-Pesa; the cash field is cleared first; the two earlier-sales tests clear the M-Pesa 0 |
| `noUnexpectedScroll.test.ts` | no entry for the shell | `ModalShell.tsx` allow-listed at exactly 1 |

Every other test, including all the Z report, correction, Move a sale and window report tests, passes unchanged.

### Verification (a)

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 226 files passed, 1 skipped (the rehearsal); 3,718 tests passed, 9 skipped (8 rehearsal, 1 build-freshness) |

---

## Part (b): the card settlement counted at close

### Audit

- **Close today:** `shifts:close` (`shiftCloseSchema`: `shiftId`, `endingCash`, optional `mpesaClosingBalance`) goes through `closeShiftUnlessHeld` to `RubisDatabase.closeShift`, which writes `ending_cash`, `expected_cash`, `discrepancy`, `clock_out`, the status and, with an M-Pesa figure, `mpesa_closing_balance`, `mpesa_expected` and `mpesa_difference`. The only Close Shift form is on the Admin screen.
- **The same figures live in three places:** the `shifts` row, an append-only `shift_corrections` row, and a snapshot on each `shift_adjustments` row. Corrections and the adjustment snapshot read "the figures typed in as they now stand" through one function, `latestTypedFigures`.
- **The Z lines** come from one library, in a main copy for the printed slip and a renderer twin for the window; tests run both over the same reports.

### What changed

| Where | What |
| --- | --- |
| [database.ts](../src/main/services/database.ts) | Three nullable columns, `card_closing_balance`, `card_expected`, `card_difference`, on `shifts`, `shift_corrections` and `shift_adjustments` (also in the `CREATE TABLE`s of a new database). `migrateCardColumns` adds them to an existing database by checking `PRAGMA table_info` first, so it runs any number of times and a real failure is not swallowed. `closeShift(…, mpesaClosingBalance, cardClosingBalance)` stores the counted figure, the shift's non-voided card sales and the difference, only when a figure was counted; the result carries them only then. `addShiftCorrection` takes `cardClosingBalance` and stores the same three. `recordAdjustment`, `latestTypedFigures` and `workedFiguresNow` carry the card figures, so a sale that joins or leaves a shift records what its card figures now are. |
| [shiftFigures.ts](../src/main/lib/shiftFigures.ts) | `cardClosingBalance` (optional) on the typed figures; `workShiftFigures` takes the card sales as an optional last argument and adds `cardExpected` and `cardDifference` only with a counted figure; a changed card figure counts as a change. A caller from before the phase is unchanged. |
| [ipcValidator.ts](../src/main/lib/ipcValidator.ts), [index.ts](../src/main/index.ts), [held-sales.ts](../src/main/services/held-sales.ts), [preload](../src/preload/index.ts), [window.d.ts](../src/preload/window.d.ts), [shift-corrections.ts](../src/main/services/shift-corrections.ts) | `cardClosingBalance` as an optional amount of 0 or more on `shifts:close` and `shifts:correct`. `closeShiftUnlessHeld` takes it as its last argument, so every existing call keeps its meaning. `closeShift(shiftId, cash, mpesa?, card?)` on the window API. |
| [reports.ts](../src/main/services/reports.ts) | `ZReport`, its corrections and its adjustments carry `cardClosingBalance`, `cardExpected`, `cardDifference` only when a card figure was counted. `generateZReport` reads the stored figures; nothing is worked out again on screen. |
| [zReportCard.ts](../src/main/lib/zReportCard.ts) and its renderer twin (new) | Three lines, **Card expected**, **Card counted**, **Check against the PDQ settlement**: "Not recorded" when blank (never 0), "Pending" for an open shift. Worded "check", never "shortage". |
| [printer.ts](../src/main/services/printer.ts), [ZReportModal.tsx](../src/renderer/src/components/ZReportModal.tsx) | The three lines under the M-Pesa lines, on paper and on screen. |
| [zReportCorrections.ts](../src/main/lib/zReportCorrections.ts), [zReportAdjustments.ts](../src/main/lib/zReportAdjustments.ts) and their twins | A correction or adjustment block lists its card lines only when it holds a card figure, so every older block reads exactly as it did. |
| [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx), [optionalBalance.ts](../src/renderer/src/lib/optionalBalance.ts) | Close Shift has a third counted field, **Card settlement (optional)**, empty and marked "Not recorded". Left blank, the call is exactly the one it always was. |
| [ShiftCorrectionForm.tsx](../src/renderer/src/components/ShiftCorrectionForm.tsx) | A fourth field, **Card settlement at end (optional)**, starting from the current figure; sent only when given. |

### Tests

- [shiftCardClose.test.ts](../tests/shiftCardClose.test.ts), 17 tests on real SQLite:
  - **Migration:** a file database made old (the nine columns dropped) is brought forward by three consecutive `init` runs with no error, its closed shift reading `NULL`; a new database has the same columns and a second `init` changes nothing.
  - **Close:** the counted figure, the card sales with the voided one left out, and the difference are stored; a blank figure leaves all three columns `NULL` and the result without card keys; a counted 0 is 0; a second close is refused and changes no row in the shift, corrections or adjustments; the held-sales guard passes the figure through as its last argument; the schemas take it as an optional amount of 0 or more.
  - **Figures:** expected and difference only with a counted figure; 0 differs from "not recorded".
  - **Corrections:** stored with the sales worked now; a card figure alone is a change, a repeat is "Nothing has changed", a later correction without it clears it and never stores 0; below 0 is refused with nothing written.
  - **Adjustments:** a sale joining a closed shift records the card figures the shift now shows, `NULL` when never counted.
  - **Z report:** stored figures on a closed shift, no card keys for one that never had them; the main and renderer twins agree; the printed slip carries the three lines under the M-Pesa lines.
- [shiftCardCloseUi.test.ts](../tests/shiftCardCloseUi.test.ts), 5 tests: the Z window's card lines; the correction form's field (empty, from the current figure, sent only when given, 0 included, a bad figure refused before the PIN).
- In [adminShiftMpesaBalance.test.ts](../tests/adminShiftMpesaBalance.test.ts), 4 added tests: the third close field, a blank card sends the old two- and three-argument calls, a card figure sends `[id, cash, null, card]`, a bad figure sends nothing.

### Mutation checks (each restored; `database.ts` compared byte for byte afterwards)

| # | Mutation | Failing tests |
| --- | --- | --- |
| 3 | Card counted stored as 0 when blank (the default of the card argument is 0) | 3: `keeps a blank figure as not recorded…`, `the adjustment ledger > leaves the card columns NULL…`, `the Z report > carries the stored figures… and no card keys for one that never had them` |
| 4 | A migration that fails on the second run (the `table_info` check removed) | 12, the first being `the migration > adds the three card columns… and is safe to run again and again` and `makes the same columns in a new database, and a second init on it changes nothing` |

### Existing tests changed (each with an old/new note in the file)

| Test | Old | New |
| --- | --- | --- |
| `shiftCorrections.test.ts`, "appends one row…" | the returned row and the INSERT's twelve parameters | the three card columns, `null`, and fifteen parameters |
| `shiftMpesaBalances.test.ts`, the guard | `closeShift` called with `(3, 100, 640)` | `(3, 100, 640, null)` |
| `shiftMpesaBalances.test.ts`, the printed slip | the M-Pesa lines ended the slip | three card lines follow, "Not recorded" |

### What to know

- **Existing shifts are untouched:** no backfill. Every closed shift from before reads "Not recorded" on its Z report, which now shows three more lines for it on screen and on paper.
- **Card has no opening balance,** so "expected" is the shift's card sales; it is stored only beside a counted figure, as M-Pesa's is.
- **A sale moved into or out of a closed shift** that has a card figure changes its expected card figure; the adjustment record shows the new one, and the counted figure stays, so the difference moves with it.

### Verification (b)

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 228 files passed, 1 skipped (the rehearsal); 3,744 tests passed, 9 skipped (8 rehearsal, 1 build-freshness) |

---

## Part (c): one Reports tab scoped by shift or range, End of Day approved per shift

### Audit (the findings of the audit stop, as built on)

- **Every report except two takes a range.** The sales summary, fiscal status, fiscal reconciliation, invoice list and CSV export each take `{startIso, endIso, label}` and were given one by a fixed preset. The Z report takes a shift id and End of Day took one Nairobi day. So a new scope needs no change to any report function, only to how the range is made.
- **A shift's clock times are not its sales.** On the 1606 copy shift #1 (closed after 14 seconds) holds 60 sales and its clock range holds 0; merged-away shift #2 held 59 by clock and 0 by shift. The scope of a shift is therefore the span of its own sales (the earlier of its start and its first sale to the later of its end and its last sale), made in `report-scope.ts`. It reads times; it adds nothing.
- **Approval was already by payment id,** not by day: `approveMpesaEntries` acted on exactly the ids a report showed, the `local_day` being only a label. A per-shift approval is therefore the same call with a shift's ids and one more column.
- **M-Pesa logs read the latest 50 transactions with no range,** so they cannot follow a scope without a new query.

### Rulings applied

Shift scope = the span of the shift's sales, with a note when the summary and the Z disagree on the number of sales. End of Day approval is per shift (the amendment): approving needs the admin PIN, records who and when, is refused for an open shift, refused a second time, and covers the shift's own manual entries and its carry-over from earlier shifts (ticked entry by entry) and nothing else. Old per-day reviews stay as history ("Approved earlier"). `reports:approve-day` refuses with "approve a shift". The freeze rules of phases 243 and 244 do not apply to approval. M-Pesa logs are unscoped (latest 50, said so on screen). Export is in the Detail section. A custom range is two typed date-times. The End of Day and M-Pesa Logs cards leave the Admin grid.

### What changed

| Where | What |
| --- | --- |
| [report-scope.ts](../src/main/services/report-scope.ts) (new) | `resolveReportRange(db, scope)`: a preset gives `getReportRange` as before; a shift gives `shiftScopeRange`; two typed `YYYY-MM-DD HH:MM` (Nairobi) give `customRange`, which refuses a text that is not a real date and time, an end not after the start, and more than 62 days. |
| [ipcValidator.ts](../src/main/lib/ipcValidator.ts), [index.ts](../src/main/index.ts) | The five report requests take exactly one of `preset`, `shiftId` or `from` and `to` (a plain preset is accepted as before); each handler calls `resolveReportRange` and then the report's own function with the range. New: `reports:shift-end-of-day`, `reports:end-of-day-shifts` (reads), `reports:approve-shift` (admin PIN re-verified before the write). `reports:approve-day` refuses and writes nothing. |
| [reports.ts](../src/main/services/reports.ts) | The body of the day report (cashier totals, entries, carry-over, pending) moved into one private function, `buildEndOfDayReport`, now called by the day report and the shift report; the arithmetic did not change and the day report's tests pin its output. New: `generateShiftEndOfDay` (the shift's own sales and entries, carry-over from earlier shifts, the approval, whether Approve is offered and why not) and `listShiftApprovalRows` (the shifts of a range with their approval state). |
| [database.ts](../src/main/services/database.ts) | `mpesa_day_approvals.shift_id`, nullable, with a partial unique index (a shift is approved once, in the database as well as in the code); a migration that checks before it adds and runs any number of times. `approveMpesaEntries` takes an optional shift id; `getUnapprovedManualPaymentsOfEarlierShifts` (carry-over by the shift's `clock_in`); `getShiftMpesaApproval`; `approveShiftMpesa`: one write transaction that refuses a missing, open or merged shift, a shift already approved, an empty call, and any id that is not a pending manual entry of the shift's own sales or its carry-over, then writes through the same code a day review used. |
| [preload](../src/preload/index.ts), [window.d.ts](../src/preload/window.d.ts), [reportScope.ts](../src/main/lib/reportScope.ts) (new) | The report calls take a scope: a preset string, `{ shiftId }` or `{ from, to }`. `getShiftEndOfDayReport`, `getEndOfDayShifts`, `approveShiftReport` added; `approveDayReport` removed. |
| [ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx) | One tab, five numbered sections (Scope, Takings, Checks, Detail, Shifts), scrolling as a whole. Takings: the sales summary and, for a shift, its Z report beside it with Print. Checks: End of Day, fiscal status, fiscal reconciliation. Detail: invoice list, M-Pesa logs and CSV export, shut until opened. Shifts: Shift History as in phase 245 in a box of its own height. Every section gets the one scope; none works anything out. |
| [ScopePicker.tsx](../src/renderer/src/components/ScopePicker.tsx), [reportScopeChoice.ts](../src/renderer/src/lib/reportScopeChoice.ts) (new) | One picker: the shifts first, ten at a time, newest first, the open one on top ("Shift #8, Day, 6 Oct 11:35 to now"), then the six periods, then a typed range; Back to Today. |
| [ZReportBlock.tsx](../src/renderer/src/components/ZReportBlock.tsx) (new), [ZReportModal.tsx](../src/renderer/src/components/ZReportModal.tsx) | The Z report's state and markup, handed out as body, footer and correction form, so the same report sits in the window (unchanged to look at) and beside the summary. |
| [ShiftEndOfDay.tsx](../src/renderer/src/components/ShiftEndOfDay.tsx), [ShiftApprovalList.tsx](../src/renderer/src/components/ShiftApprovalList.tsx) (new) | The shift's end of day with its ticks, reasons, note and PIN, and the list of a range's shifts with their state and one "Open shift" button each; no approve button on the list. |
| [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) | The End of Day and M-Pesa Logs cards and tabs are gone. `EndOfDayPage.tsx` is deleted. |

### Not changed

Fiscal code, checkout, the payment gate, Shopify, automatic assignment, merges, the override (244), the pager of Shift History (245) and the arithmetic of every report. `reports:end-of-day` and `generateEndOfDayReport` are still there, unused by any screen, so the day report keeps its tests and the way back is a revert.

### Tests

- [shiftApproval.test.ts](../tests/shiftApproval.test.ts), 21 tests on real SQLite: the migration and the unique index; the shift report (own entries, carry-over from earlier shifts only, voided, approved and non-manual entries left out, why Approve is not offered, the day report's own body); approving (ticked entries, who, when, which shift, exclusions with reasons, a second approval refused naming who and when with no row changed, an open, missing or merged shift refused, every outside id refused with the whole call, all or nothing, not held to the freeze, a day review still records no shift); the list of a range (open first then newest, the five states, only the sales in the range); the handlers (PIN before the write; `approve-day` refuses and touches nothing; the request shape).
- [reportScope.test.ts](../tests/reportScope.test.ts), 13 tests: a shift's range covers its own sales so the summary and the Z report agree (and would be 0 on clock times alone); an open shift runs to now; a typed range is read in Nairobi time and refused when it is not a real date, not after its start, or over 62 days; every report request names exactly one scope; each handler gives its own function the range the scope makes; the Z report stays on the shift id.
- [reportsPage.test.ts](../tests/reportsPage.test.ts), 25 tests: the five sections; every report asked with the scope as the plain preset string, `{ shiftId }` or `{ from, to }`; the shifts before the periods in the picker; the Detail shut until opened; the takings as the main process returned them, the Z block and Print for a shift, the count note; the fiscal views; the approval list with no approve button; one tap from a list to the shift's end of day; the detail; the Admin menu; the page scrolling as a whole and summing nothing.
- [shiftEndOfDayUi.test.ts](../tests/shiftEndOfDayUi.test.ts), 16 tests: the old page's ticking, reasons, note, PIN, notices and the held-sales block, ported to one shift; approving only when the shift can be approved, and why not when it cannot; the list of a range.

### Mutation checks (each restored; the file compared byte for byte afterwards)

| # | Mutation | Failing test |
| --- | --- | --- |
| a | Approve an open shift (the open check removed) | `approving a shift > is refused for an open shift, a missing shift and a shift merged into another…` |
| b | Approve twice (the already-approved check removed) | `approving a shift > is refused a second time, naming who and when, and changes no row` |
| c | Approval that reaches outside the shift's sales (the allowed set not checked) | `approving a shift > refuses every entry outside the shift and its carry-over…` |
| d | A report recomputed on screen instead of calling its function (revenue added from the method totals) | `the takings > shows the sales summary the main process returned… worked out nowhere on screen` |
| e | A shift scope that passes the wrong range (the shift's clock times only) | 2: `a shift scope > covers the shift's own sales when its clock times do not…` and `goes to every other report as the same kind of range` |

### Existing tests changed (each with an old/new note in the file)

| Test | Old | New |
| --- | --- | --- |
| `reportsPage.test.ts` | six sub-views reached from cards, each with its own preset buttons | the one tab and its five sections (rewritten, 25 tests) |
| `endOfDayPage.test.ts`, `endOfDayShiftFilterUi.test.ts` | the day's page, its day buttons, its shift filter and its scroll | removed with the page; ported to `shiftEndOfDayUi.test.ts` |
| `heldSalesUi.test.ts` (End of Day block) | mounted the day's page; the rows in its scrolling part | mounts the shift's end of day; the tab scrolls as a whole |
| `autoMergeWindowsUi`, `frozenShiftsUi`, `oneShiftPerWindowUi`, `shiftCaptureUi`, `shiftHistoryPagingUi` | Shift History reached by tapping its card | it is the last section of the tab; the stubs answer the tab's other calls (`tests/helpers/reportsTabApi.ts`) |
| `shiftHistoryPagingUi` | the section filled a column | the section is a box of its own height inside the tab's scroll; "opens on page 1 again" is a new mount of the tab |
| `adminTitleRemoved.test.ts` | End of Day was a card | not listed |
| `noUnexpectedScroll.test.ts` | `EndOfDayPage.tsx` 1; `ReportsPage.tsx` 1 | `EndOfDayPage.tsx` gone; `ReportsPage.tsx` 2 (the tab and the history) |
| `tests/rehearsal/paulCopy.test.ts` | shift #8's whole row identical | the columns it had are identical and the three new card columns read NULL |

### For the owner to check on the till after install

1. A long Z report: scroll the body, Print stays in view.
2. Pick shift #1 in the scope: Takings show its Z report with the shift's orders and the sales summary agreeing; pick Yesterday: the same sales are in the summary, no Z block, and the End of Day lists the shifts with their state.
3. Open a closed shift: End of Day shows its entries and Approve; an open shift says why it cannot be approved.
4. Open Shift shows 0 and 0 pre-filled; Close Shift shows three counted fields, and a blank card prints "Not recorded".

### Observed but not changed

- **M-Pesa logs are the latest 50,** not the scope's: they have no range. Said so on the tab.
- **A shift's range can hold another shift's sales** where two shifts overlap in time; the Takings block then says so instead of staying silent.
- **`reports:end-of-day`, `generateEndOfDayReport` and `getEndOfDayReport`** are no longer reached by any screen. They are kept so the day report and its tests stand; removing them is a separate change.
- **A sale auto-assigned into an already-approved shift** leaves entries that shift cannot approve again; they appear as carry-over on the next shifts, which is why carry-over is approvable.
- **Nothing was run on a till or in the app:** the layout, the scroll box of Shift History inside the scrolling tab, and the picker are for the owner to check.

### Rollback

Revert the three commits of the phase. The columns they add (`card_*`, `mpesa_day_approvals.shift_id`) stay as unused nullable columns; the approvals, corrections and adjustments already written stay in their ledgers.

### Verification (c) and of the phase

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 229 files passed, 1 skipped (the rehearsal); 3,769 tests passed, 9 skipped (8 rehearsal, 1 build-freshness) |
| Rehearsal on the 1606 copy (`RUBIS_COPY_DIR` set) | 8 of 8 passed, with the card and approval migrations run on the real database |
| `npm run build` | passed, `verify-no-mock-provider` confirmed |
| Installer | not built, by instruction |
