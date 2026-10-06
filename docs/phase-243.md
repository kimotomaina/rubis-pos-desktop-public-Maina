# Phase 243 — A closed shift keeps its sales, and only the latest closed shift can be updated

- **Date:** 2026-10-06
- **Asked by the owner:** "ensure a closed shift cannot be removed a sale and only one preceding shift can be updated. If we had a shift yesterday morning, then yesterday night, we can only update the yesterday night one."
- **Owner's choices (2026-10-06):** (1) block Move a sale **out of** a closed shift, and keep the merge of two shifts of one window as the single way sales leave a closed shift; (2) "updating" means **Correct figures and sales moved into a shift**, allowed on the **latest closed shift only**; (3) the till's own **automatic assignment still files a late sale by its time**, even into a frozen shift.
- **Status:** built and tested. Not released: the version was bumped to 2.2.7 (`cde9792`, "phases 240 to 242") before this phase, and nothing is built yet.
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.** Shift History shows a small "Locked" tag in place of Correct figures on an older closed shift; the Z report loses its Correct figures button for one.
- **Not changed:** checkout, fiscal and Shopify code, `closeShift`, the one-shift-per-window rule, the automatic assignment and the automatic merge (the till is not a person), End of Day, printing.

## 1. The rule, in the owner's example

Yesterday morning (closed), yesterday night (closed), today's shift (open):

| Shift | Correct figures | Be given a sale | Have a sale taken out |
| --- | --- | --- | --- |
| yesterday morning (closed, older) | refused | refused | refused (closed) |
| yesterday night (closed, **latest closed**) | allowed | allowed | refused (closed) |
| today (open) | not yet (it is open) | allowed | allowed |

When today's shift closes it becomes the latest closed shift, and yesterday night is frozen from then on. "The latest closed shift" is the closed shift opened last, leaving out one that was merged into another.

## 2. Audit

- **Ways a sale leaves a shift:** `reassignSale` (Move a sale, phase 232 S5) from any shift, and the merge (phase 239, and the till's own in phase 242), which moves a closed absorbed shift's sales into the survivor. Voiding is not a path: `orders:void` is a stub. Automatic assignment only gives sales a shift, never takes one away.
- **Ways a closed shift is "updated" by a person:** `addShiftCorrection` (phase 224), Move a sale into it, and a hand merge into it as the survivor. Automatic assignment (a late sale joining its window's closed shift, S7) and the automatic merge are the till's own rules.
- **A consequence the owner should know:** an older closed shift can no longer be corrected, so a shift the till made for an earlier window (cash not counted) cannot be given its real counts once a later shift has closed. Its counts must be entered while it is the latest closed shift, or not at all. Recorded in `KNOWN_GAPS.md`.

## 3. What changed

| Where | What |
| --- | --- |
| [database.ts](../src/main/services/database.ts) | `latestClosedShiftId()` and `isFrozenShift(shift)`. `previewSaleMove` (and so `reassignSale`) refuses a sale in a **closed** shift, and a target that is closed and not the latest closed. `addShiftCorrection` refuses a closed shift that is not the latest closed one. `previewShiftMerge(absorbed, into, byTill = false)` refuses a survivor that is frozen for a person; the automatic merge passes `byTill` and is not held to it, so an older pair is still merged by the till. The absorbed shift's sales still leave it in a merge. |
| [shiftRules.ts](../src/main/lib/shiftRules.ts) | The two messages: "Shift #1 is closed. A sale cannot be taken out of a closed shift." and "Shift #1 is closed and is not the latest closed shift (#2). Only the latest closed shift can be corrected or be given sales." |
| [index.ts](../src/main/index.ts), [reports.ts](../src/main/services/reports.ts) | `reports:shifts-list` marks a closed shift that is not the latest closed one `frozen`; `reports:z-report` does the same for the one report (not `generateZReport` itself, which is unchanged). |
| [ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx), [ZReportModal.tsx](../src/renderer/src/components/ZReportModal.tsx) | A frozen shift shows a "Locked" tag and no Correct figures; its Z report prints but has no Correct figures. The refusals are in the main process: the screen only avoids offering what would be refused. Move a sale's form already shows the refusal as the problem. |

## 4. Tests

[frozenShifts.test.ts](../tests/frozenShifts.test.ts), 15 tests on real in-memory SQLite, built on the owner's example (yesterday morning and night closed, today open):
- the latest closed shift, and how it moves when today's closes; null when none; never an open shift; a merged shift is left out;
- Correct figures on the night, refused on the morning (message quoted), refused on yesterday night once today closes and allowed on today's, an open shift still refused as before; nothing written on a refusal;
- Move a sale: out of a closed shift refused with the message, in both directions; out of the open shift into the latest closed shift allowed; into the frozen morning refused; nothing written;
- hand merge into a frozen shift refused, into the latest closed shift allowed, the sales leaving the absorbed closed shift as before; the till's own merge of an older pair still happens;
- the till's automatic assignment still files a late sale into a frozen shift;
- the handlers mark frozen shifts and the database methods refuse (not only the screens).

[frozenShiftsUi.test.ts](../tests/frozenShiftsUi.test.ts), 3 tests: Locked and no Correct figures on older rows while the latest keeps it; the Z report.

### Mutation checks (each restored)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | A sale can leave a closed shift | caught, 2 |
| 2 | A frozen shift can be corrected | caught, 3 |
| 3 | A frozen shift can be given a sale | caught, 2 |
| 4 | The oldest closed shift, not the latest, is the updatable one | caught, 8 |
| 5 | A person can merge into a frozen shift | caught, 1 |
| 6 | The till's own merge is held to the rule | caught, 1 |
| 7 | The Z report is never marked frozen | caught, 1 |

### Existing tests changed (each with an old/new note in the file)

| Test | Old | New |
| --- | --- | --- |
| `oneShiftPerWindow.test.ts`, "Move a sale" group (fixture and 5 tests) and the Z-report "moved out" test | both shifts closed; the sale moved out of the closed Day shift into the closed Night one; the Z-report test moved a sale out of a closed shift | the sale is in the **open** Night shift and goes into the latest closed Day shift (a different window, so the tick); the open shift has no figures to recalculate; the "moved out" Z-report test uses a merge, the one way sales leave a closed shift |
| `zReportScope.test.ts` "follows a sale when an admin moves it" | moved out of the closed shift A into B | moved out of the open shift B into the latest closed shift A |
| `autoMergeWindows.test.ts` handler text | `db.listVisibleShifts(` | `.listVisibleShifts(` (the handler's call now spans lines) |
| `shiftCorrections.test.ts`, `shiftCapture.test.ts` (setup only) | fake database | answers the latest-closed-shift query with shift 1, the shift corrected (marked `ADDED (docs/phase-243)`) |

## 5. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 221 files, 3663 passed, 1 skipped (the build-freshness check), 0 failed |

## 6. For the owner to check on the till

1. On Shift History, only the latest closed shift has Correct figures; older closed shifts say Locked; the open shift has neither.
2. Move a sale: taking a sale out of a closed shift is refused with its reason; moving a sale from today's open shift into last night's shift works (with the tick if it was made in another window).
3. After today's shift closes, last night's shift becomes Locked and today's can be corrected.
4. Layout.

## 7. Observed but not changed

- A shift cannot be un-frozen. If a shift needs its counts and is no longer the latest closed, the only record left is a note elsewhere; say if a way for an admin to lift the lock is wanted.
- A sale cannot be moved between two open shifts or from a closed shift into an open one: there is only one open shift, and a closed shift keeps its sales.
- The automatic assignment adding a late sale to a frozen shift changes that shift's recalculated figures (with a permanent record). That is the owner's choice (3).
- Reports other than Z (End of Day, the window report) are not "updates" and are unchanged.

## 8. Not verified

Anything on a till; the layout.

## 9. Rollback

Revert the commit. Nothing stored changed: the freeze is a rule, not a column.
