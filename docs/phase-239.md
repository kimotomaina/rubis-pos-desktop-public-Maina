# Phase 239 — Shift History: merge two shifts of one window; Correct figures and Z report as row actions

- **Date:** 2026-10-06
- **Asked by the owner:** from the Shift History table (shifts #1 and #2 both in the Night of 5 Oct, "Window report (2 shifts)"): "ensure that we can merge the shifts and have actions for the shift corrections here too."
- **Rulings (2026-10-06):** (1) the surviving shift keeps its own float and count, the absorbed shift's figures stay as history; (2) same window only, the absorbed shift must be closed, the survivor may be open or closed; (3) an actions column per row: Z report, Correct figures, Merge into…; Move a sale stays as the page button; (4) no undo: a merge is recorded forever, a sale can be moved back one at a time.
- **Status:** built and tested. Not released.
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.** Shift History gains an Actions column (three small buttons); the merge form is a new section in the same place the Move a sale form opens; the Z report gains one amber line for a merged shift.
- **Not changed:** checkout, the fiscal and Shopify code, `closeShift`, the one-shift-per-window rule, the close-from rule, automatic assignment, Move a sale, corrections, End of Day. No `shifts` row is edited or deleted. Nothing is queued for Shopify or the tax device.

## 1. Audit

- **A sale leaves a shift one way only:** `reassignSale` (phase 232, S5): a guarded `UPDATE orders SET shift_id = ? WHERE local_id = ? AND shift_id = ? AND status <> 'voided'`, an append-only adjustment pair on both shifts, figures recalculated, no typed numbers, admin PIN re-verified in the main process. A test pins that every `UPDATE orders SET shift_id` in `database.ts` has that shape.
- **Corrections** (phase 224) are append-only rows under a closed shift, reached only through the Z report pop-up's "Correct figures".
- **`shifts.status`** is constrained to `open | closed` and the rows are never edited (phases 224, 232 W4), so "merged" cannot be a status. The window report already knows a window with two shifts.
- The owner's table shows the live case: #1 (opened 17:43, labelled Day, closed 17:43:36) and #2 (opened 20:50, open) in the Night of 5 Oct; both predate the one-shift-per-window rule.

## 2. Change

| Where | What |
| --- | --- |
| [database.ts](../src/main/services/database.ts) | New append-only table **`shift_merges`** (`absorbed_shift_id UNIQUE`, `into_shift_id`, `by_staff_id`, `at`, `reason`, `sales_count`; two triggers refuse UPDATE and DELETE). `previewShiftMerge(absorbed, into)`: a read; refuses the same id, a missing shift, an absorbed shift already merged or a survivor that was itself absorbed, an open absorbed shift, two different windows; returns the live sales that would move and the survivor's figures afterwards (`workedFiguresNow` with the moved cash and M-Pesa). `mergeShifts(input, now)`: one `.immediate` transaction: the preview again, then every live sale moved **with the same guarded single-row `UPDATE` a move uses** (each must change exactly one row), one `reassign_out` record on the absorbed shift and one `reassign_in` on the survivor (reason `Merged shift #A into shift #B: <reason>`, figures as each shift now shows), then the `shift_merges` row. `getShiftMerge(id)`. `listShifts` LEFT JOINs the merge so each row carries `merged_into`. `ShiftRow.merged_into`, `ShiftMergeRow`, `MergeShiftsInput`, `ShiftMergePreview`. |
| [ipcValidator.ts](../src/main/lib/ipcValidator.ts), [index.ts](../src/main/index.ts), [preload](../src/preload/index.ts), [window.d.ts](../src/preload/window.d.ts), [shift-merges.ts](../src/main/services/shift-merges.ts) (new type) | `shifts:merge-preview` (a read) and `shifts:merge` (`requireAdminPin` re-verified, the admin recorded is the PIN's owner), modelled line for line on the move-a-sale pair. `previewShiftMerge` and `mergeShifts` on `window.api`. |
| [reports.ts](../src/main/services/reports.ts), [window-report.ts](../src/main/services/window-report.ts) | `ZReport.mergedInto { shiftId, at, byName, reason }` from `getShiftMerge`. The survivor's report already shows the moved sales through the existing adjustment blocks. |
| [zReportAdjustments.ts](../src/main/lib/zReportAdjustments.ts) (main and renderer twins), [printer.ts](../src/main/services/printer.ts) | `zReportMergedLine`: `Merged into shift #2 on <when> by <who>: <reason>. Its sales are counted there now.` Printed in bold after the window line; shown as an amber line on screen. |
| [ZReportModal.tsx](../src/renderer/src/components/ZReportModal.tsx) | `startCorrecting` prop opens with the correction form showing (closed, unmerged shifts only); the merged line; no "Correct figures" on a merged shift. |
| [ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx) | **Actions** column: **Z report** (every row), **Correct figures** (closed, not merged; opens the Z report on its form), **Merge into…** (closed, not merged, and only when the window holds more than one shift). A merged shift shows **Merged into #N** beside its status. Closing the Z report reloads the list, so a correction or merge shows at once. The row tap still opens the Z report. |
| [MergeShiftsForm.tsx](../src/renderer/src/components/MergeShiftsForm.tsx) (new) | Lists the window's other, unmerged shifts (from the window report) as buttons; choosing one previews (sales that move, the survivor afterwards); a reason and the admin's PIN; the result sentence goes back to the history. Modelled on `MoveSaleForm`. |

The money rule in one sentence, as built: the survivor's expected cash is its own float plus all its cash sales including the ones that joined; its counted cash is its own; the absorbed shift's float and count stay on its row and in its adjustment record and count nowhere else.

## 3. Tests

**New** (`oneShiftPerWindow.test.ts`, 7; `oneShiftPerWindowUi.test.ts`, 4; `ipcValidator.test.ts`, 2):
- Preview: two live sales (the voided one stays), survivor expected 500 + 400 + 300 = 1,200 and difference −300; nothing written.
- Merge: every live sale moves, the voided one stays; a `reassign_out` on the absorbed shift (cash 300, M-Pesa 200; figures 0 / 500 / expected 0 / +500) and a `reassign_in` on the survivor (500 / 900 / 1,200 / −300), same who, when and why; the merge row; the absorbed `shifts` row untouched; `listShifts` carries `merged_into`; the absorbed Z report shows `mergedInto` and 0 orders, the survivor 3.
- Refusals: itself, a missing shift (either side), different windows, an open absorbed shift, a blank reason, an already-merged shift, a survivor that was itself absorbed; snapshot unchanged and no merge row.
- `shift_merges` is append-only; a shift with no sales merges with `sales_count 0`.
- The merged line: main and renderer twins agree; `null` for the survivor; the printed Z report carries it.
- The `shifts:merge` handler re-verifies the PIN; the preview handler only reads.
- Screens: Correct figures only on a closed unmerged shift and it opens the form (`Correct the figures of shift #2`); Merge into… only where the window has two shifts; `Merged into #2` badge; the merge form lists only the other unmerged shift, previews on choosing, refuses without a reason, merges with the PIN and reports `Shift #1 merged into shift #2: 2 sales moved.`; a merged shift's Z report shows the line and no Correct figures even with `startCorrecting`.
- Validators: ids positive integers; the merge needs manager credentials and a trimmed reason of 1–300 characters.

**Existing tests changed, setup only, each line marked `ADDED (docs/phase-239)`:** the hand-made database stubs in `pastShift`, `reports`, `shiftCapture`, `shiftCorrections`, `shiftZReport`, `shiftMpesaBalances` and `vatClassReceiptReports` gain `getShiftMerge: () => undefined`, because `generateZReport` now reads whether a shift was merged. No assertion changed.

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| 14 shift, report, validator and screen test files | 429 passed |
| Mutation: the same-window guard removed from `previewShiftMerge` (file restored after) | exactly 1 test fails (the refusals) |
| Full suite | **214 files, 3593 passed, 1 skipped (the pre-existing build-freshness skip), 0 failed** |

## 4. Possible impact

- **Admin:** on Shift History, every row has Z report; a closed shift has Correct figures; a closed shift in a window with two or more shifts has Merge into…. The owner's #1 can now be merged into #2 (its sales move to #2; #1 shows "Merged into #2"; #2's expected cash grows by #1's cash sales).
- **Reports:** the survivor's Z report lists the merge as a change to its sales (the existing adjustment block, reason starting "Merged shift #1 into shift #2"); the absorbed shift's Z report says it was merged and holds 0 sales; the window report shows both, the absorbed one empty. End of Day is unchanged (it reads sales by day, not by shift).
- **Data:** one new table; `orders.shift_id` written only through the existing guarded statement; no row of `shifts`, `shift_corrections` or the ledgers edited.
- **Older builds:** a database touched by this build still opens on an older build; it would not show the merge, and the absorbed shift would look like an ordinary empty closed shift.

## 5. Rollback

`git revert` the commit. The `shift_merges` table stays in any database that was used; nothing reads it after the revert, and the moved sales stay where the admin put them (the ledgers record why).

## 6. Observed but not changed

- Two shifts in one window can still arise from data made before the rule (the owner's case). The rule itself refuses a second shift at open time; this phase gives the admin the way to fold such pairs.
- "Correct figures" and the merge both exclude the absorbed shift on purpose: its figures are history. If the owner wants to correct an absorbed shift's history, that is a ruling, not a bug.
