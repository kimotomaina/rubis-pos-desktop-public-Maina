# Phase 242 — A window with more than one shift is merged into one by the till

- **Date:** 2026-10-06
- **Asked by the owner:** after merging two shifts by hand, "its not still seamless, can it be automerged into 1 based on the time frames."
- **Owner's choices (2026-10-06):** the shift opened **last** holds the window; Shift History shows **one row per window**.
- **Status:** built and tested. Not released (2.2.6 is built and unpublished; this is not in it).
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.** Shift History loses the absorbed shifts' rows and gains an "includes #N" button on the row that holds them; the "Window report" and "Merge into…" buttons go for a window that now holds one shift.
- **Not changed:** the merge rule of phase 239 (the surviving shift keeps its own float and count), `closeShift`, one shift per window for new shifts, Move a sale, corrections, End of Day. No `shifts` row is edited or deleted.
- **Not seen:** the owner's "still getting this" came without a screenshot or text. What a merge by hand left behind, from the code, was: the absorbed shift stayed as its own row with a "Merged into" badge, the "Window report (2 shifts)" button stayed (it counted the absorbed shift), and the window report still listed both. This phase removes those three, and the merge itself no longer needs a person.

## 1. Audit

- `mergeShifts` (phase 239) needs an admin PIN and a reason, absorbs one closed shift into one other, and records `shift_merges` plus an adjustment pair. Only one pair at a time, by hand.
- The window of a shift is the one its `clock_in` falls in (`shiftWindowOf`); one window can hold more than one shift only in older data (phase 232 refuses a second one).
- **A hole found:** after a merge the absorbed shift stayed in `listShiftWindows()`, so a later automatic assignment could give a sale to it (a sale made inside its times, or nearest to it, in a window of two shifts), and `openShift` and the window status could name it as the shift that holds the window. Both are fixed here.
- `shift_merges.by_staff_id` is `NOT NULL`, so the till is recorded as staff 0, as it is for a shift it makes (phase 232).

## 2. What changed

| Where | What |
| --- | --- |
| [database.ts](../src/main/services/database.ts) `autoMergeSameWindowShifts(nowMs)` | One `.immediate` transaction. Groups every shift not already absorbed by its window. A window with two or more: the shift that holds it is the **open** one, else the one **opened last**; the others are absorbed into it, earliest first. A window with two open shifts, or one whose merge `previewShiftMerge` refuses, is skipped whole. Any failure writes nothing. A run during a run does nothing. Running it again changes nothing. |
| `performMerge` (extracted from `mergeShifts`) | The move of the sales (the guarded `UPDATE`, one change each), the adjustment on each shift, the merge row. A merge by hand and the till's use the same code. `byStaffId` 0 is the till: the adjustments name nobody ("the till"). |
| [shiftRules.ts](../src/main/lib/shiftRules.ts) | `AUTO_MERGE_REASON` = "Merged automatically: a window has one shift". |
| [auto-assign.ts](../src/main/services/auto-assign.ts) `runAutoAssign` | Merges **first**, then gives sales their shift. A failed merge is written to `till.log` as `auto-assign-failed` ("merge: …") and the assignment still runs. It therefore runs at start, before Open Shift, after Close Shift and when Shift History opens, with no new trigger. |
| [autoAssign.ts](../src/main/lib/autoAssign.ts) | An absorbed shift is never a target: a sale inside its times goes to the shift that absorbed it; "the nearest of N shifts" ignores it. |
| `openShift`, [shift-window-status.ts](../src/main/services/shift-window-status.ts) | The shift named as holding the window is one that was not absorbed. |
| `listVisibleShifts`, `countVisibleShifts`, `listAbsorbedShiftIds` | Shift History pages through shifts that were not merged into another, and each carries `absorbed_shifts`. `listShifts` and `countShifts` are unchanged. |
| [index.ts](../src/main/index.ts) `reports:shifts-list` | Uses the visible list, and counts a window's shifts without the absorbed ones (so "Window report (2 shifts)" goes). |
| [ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx) | One row per window; an "includes #1" button on the row opens that shift's own Z report. |
| [reports.ts](../src/main/services/reports.ts) | The absorbed shift's Z report says it was merged by "the till". |

**Money, as it was ruled in phase 239 and is not changed:** the surviving shift keeps its own float and count, so its expected cash is its float plus every cash sale it holds, including the ones that moved in. If the drawer count taken when the survivor opened already held the first shift's cash, that cash is counted twice and a difference shows. The live case (#1 counted 3,790; #2 opened with 3,790) is exactly this: after the automatic merge #2's expected cash is 3,790 + 4,090. The difference is then put right with Correct figures on #2 (a correction recalculates from the sales and keeps the new count). This is recorded in `KNOWN_GAPS.md`.

## 3. Tests

[autoMergeWindows.test.ts](../tests/autoMergeWindows.test.ts), 18 tests on real in-memory SQLite:

- the open shift holds the window and the older closed one is absorbed (live pair: #1 at 17:43, #2 open from 20:50); the voided sale stays; both `shifts` rows untouched;
- the merge row and the two adjustments, by the till, with the reason; the survivor's expected cash pinned as above;
- all closed: the latest holds the window and the others go in earliest first; a window with one shift and shifts of different windows are left alone; two open shifts are skipped while other windows merge;
- merged by hand already: untouched; a second and third run change nothing; all or nothing (a failure writes nothing); a run during a run does nothing;
- after a merge: no sale goes to the absorbed shift (inside its times, nearest); the shift named by `openShift` and the window status is the survivor; Shift History lists the window once with the absorbed shift named, the count and paging are right; the absorbed shift's Z report says the till merged it, and the survivor's lists the move;
- the run merges before it assigns, logs a failed merge and still assigns; the handler reads the visible list.

[autoMergeWindowsUi.test.ts](../tests/autoMergeWindowsUi.test.ts), 3 tests: one row with "includes #1"; that button opens shift #1's own Z report; no Window report or Merge button for a window that holds one shift.

### Mutation checks (each restored)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | The earliest shift holds the window | caught, 3 |
| 2 | An absorbed shift can still be given a sale (nearest) | caught, 1 |
| 3 | A sale inside an absorbed shift's times is not redirected | caught, 1 |
| 4 | Shift History still lists the absorbed shift | caught, 1 |
| 5 | Sales are given their shift before the merge | caught, 2 |

### Existing tests changed (setup only)

Four hand-made fakes gained `listAbsorbedShiftIds: () => []` and one `runAutoAssign` fake gained `autoMergeSameWindowShifts`, each marked `ADDED (docs/phase-242)`. No assertion changed.

## 4. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 219 files, 3645 passed, 1 skipped (the build-freshness check), 0 failed |

## 5. Before it goes on a till

- **The dry run on a copy of the live data now matters more:** the first start will merge every window that holds two or more shifts, and each survivor's figures change (expected cash, difference) by the rule above. The dry-run script is the place to see it first.
- **Correct figures after the merge** on any survivor whose float already held the earlier shift's cash.
- Layout.

## 6. Observed but not changed

- A merge by the till needs no PIN, by the owner's request ("automerged"); every merge is a permanent record with the reason.
- Nothing un-merges: a merge is append-only (phase 239).
- The window report still lists absorbed shifts (with no sales): it is the history of the window.
- An open shift is always the survivor; two open shifts in one window (impossible since phase 232 for new data) are left for a person.

## 7. Not verified

Anything on a till; the layout; the first-start run on real data (the dry run).

## 8. Rollback

Revert the commit. Windows merged by the till stay merged (the records are permanent); the absorbed shifts show as rows again with the "Merged into" badge, as after a merge by hand.
