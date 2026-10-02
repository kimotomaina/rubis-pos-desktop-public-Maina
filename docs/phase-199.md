# Phase 199 — fixed shift windows (operational labels only)

- **Date:** 2026-10-02
- **Requested:** Part A of "fixed shift windows, and close buttons on keypad and keyboard dialogs": a day and a night window on Nairobi time that label a shift and prefill the Open Shift choice; no scheduled opening or closing; reports unchanged. Part B (close controls) is a separate phase and commit.
- **Outcome:** Implemented. Typecheck clean; vitest **180 files, 2876 tests, all passing** (177 and 2794 before); `npm run build` passes with the no-mock check. `check:fit` not run; no device calls; no new dependency.
- **Branch / base commit:** staging on top of `fc460f3`.

## 1. The decisions this follows

| # | Decision | Value |
| --- | --- | --- |
| D1 | Windows | Day 09:00:00 to 17:30:59, night 17:31:00 to 08:59:59, Africa/Nairobi. The client confirmed 17:30 belongs to the day shift. |
| D2 | What they do | Operational only: labels and prefilled values. No scheduled opening or closing. |
| D3 | Reports | Unchanged. |

| Local time | Shift |
| --- | --- |
| 08:59:59 | night |
| 09:00:00 | day |
| 17:30:00 | day |
| 17:30:59 | day |
| 17:31:00 | night |

`shiftTypeForTime` takes the whole-minute part of the Nairobi wall clock and returns day when it is at or after 09:00 and at or before 17:30. Both ends of each window are therefore stored as inclusive minutes (`DAY_SHIFT` 540 to 1050, `NIGHT_SHIFT` 1051 to 539). 17:30:59 and 17:31:00 are pinned explicitly in the tests.

## 2. Audit (A0), as confirmed and corrected

- **Confirmed:** the `shifts` columns; the `openShift`, `closeShift`, `getOpenShift` and `getShiftById` signatures; `generateZReport`'s shape; `renderZReport`; a renderer file cannot value-import from `main/` (every renderer import from there is `import type`), so a twin is needed.
- **Corrected: there is no Open Shift dialog.** Open Shift and Close Shift are inline forms in the Admin "Shift Controls" card. The tests target the inline form.
- **Corrected: `shifts:close` had no zod schema either**, not only `shifts:open`. See section 4.
- **Corrected: the daily summary is already on the Nairobi day** (phase 158 moved it), so the brief's note about its UTC day was out of date. Nothing here touches it.
- **Found, not changed:** the Z report cannot be opened from the live app. See section 9, flag 1.

## 3. What was built

- **Windows:** [src/main/lib/shiftWindows.ts](../src/main/lib/shiftWindows.ts): `ShiftType`, `SHIFT_TYPES`, `DAY_SHIFT`, `NIGHT_SHIFT`, `shiftTypeForTime`, `shiftWindowLabel` (`Day shift (09:00 to 17:30)`, `Night shift (17:31 to 08:59)`), plus `shiftName`, `shiftEndClock` and `isPastShiftEnd` for the screen note. An instant that is not a time throws `RangeError`, since a guessed shift label would be worse than none.
- **Offset:** `toNairobiWallClock` in [reports.ts](../src/main/services/reports.ts) is now exported (the `export` keyword is the whole change to it); `shiftWindows.ts` uses it, so the main process holds no second copy of the offset. This makes `reports.ts` and `shiftWindows.ts` import each other (the Z report needs the label); both use the other only inside functions, the module loads under vitest and bundles under `npm run build` with no circular-dependency warning.
- **Renderer twin:** [src/renderer/src/lib/shiftWindows.ts](../src/renderer/src/lib/shiftWindows.ts) holds its own `NAIROBI_UTC_OFFSET_MINUTES`; that constant is the only duplication, held in step by the parity test.
- **Storage:** `shifts.shift_type TEXT CHECK (shift_type IN ('day', 'night'))`, nullable, no default, no backfill. In the `CREATE TABLE` for a new database and in a new idempotent `migrateShiftsColumns` for an existing one. `ShiftRow.shift_type?: ShiftType | null` is optional so no existing typed fixture needed editing. `openShift(staffId, startingCash, shiftType = null)` writes it and rejects any value that is not day or night before touching the database. A call that names no shift runs the original `INSERT` unchanged.
- **IPC:** `shifts:open` takes `shiftType` (optional, so an older caller still opens a shift stored as `NULL`); preload and `window.d.ts` updated.
- **Open Shift:** pressing Open Shift preselects `shiftTypeForTime(now)`; both shifts are shown as a radio group with their full labels, the other one is one tap away, and the choice is sent to `openShift`. Suggested afresh each time the form opens.
- **Open shift status:** a shift with a type shows its label under the "Opened ... with ... starting cash" line, and, once past the end of its window, a plain amber note such as `Night shift, due to close at 08:59`. The due moment is the next time the window's end comes round after `clock_in`, so a night shift opened at 02:00 is due at 09:00 that morning and one opened at 18:00 is due at 09:00 the next. The note blocks nothing: Close Shift, the form and Confirm behave exactly as before. The line stays on screen while the close form is open. A shift with `NULL` type shows nothing extra.
- **Z report:** `generateZReport` returns `shiftType` and `shiftWindowLabel` (both `null` for an old shift); `ZReportModal` shows the label under the shift number; `renderZReport` prints it as one line straight after `Shift #n`, and prints nothing extra when it is absent. The label is at most 28 characters, within a 32-column slip. No figure changed.

## 4. In-scope extras (recorded, as the brief asks)

Two validators, both in `src/main/lib/ipcValidator.ts` and wired in `src/main/index.ts`:

- **`shiftOpenSchema`** (`staffId` integer, `startingCash` finite number, `shiftType` day, night, null or absent). The brief named this one: the handler read `request?.staffId` and `request?.startingCash` directly (docs/phase-157 Part 3).
- **`shiftCloseSchema`** (`shiftId` integer, `endingCash` finite number). **Not in the brief.** Added on the instruction that followed the audit: `closeShift` takes `endingCash` and feeds it into `expectedCash` and the discrepancy on a Z report somebody signs, and the handler did `Number(request?.endingCash) || 0`, so a string or `NaN` did not fail, it became a silent `0` and a wrong discrepancy. Same file, same pattern, no arithmetic changed (`closeShift` is untouched).

**Every payload the handlers accept today is still accepted** (`tests/ipcValidator.test.ts`, new `describe` block, with the figures passed through unchanged): every call the renderer's preload can make, with or without `shiftType` (an older build's shape), `startingCash` and `endingCash` of 0, 0.01, decimals and large values, and negative figures, which the handlers accepted before and still do.

**What is now refused**, because it was either a silent wrong figure or an error deep in SQLite: a cash figure that is a string (including a numeric string such as `"950"`, which was accepted before and gave the right number), `NaN`, `Infinity`, `null`, missing or an object; a missing, non-integer or string id; a request that is not an object; a shift type other than `day` or `night`. The renderer sends none of these (it parses and checks the cash figure before calling), so nothing the app does today is affected. The one deliberate narrowing worth a look is the numeric string.

The handlers are not unit-testable on their own (they sit inside `registerIpc` with Electron), so the wiring has a source-level check in `tests/shiftZReport.test.ts`: each handler calls `validate(...)` with its schema and no longer contains `Number(request`.

## 5. Affected files

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/main/lib/shiftWindows.ts` | Added | The windows, labels, boundary, due-to-close rule |
| `src/renderer/src/lib/shiftWindows.ts` | Added | Renderer twin |
| `src/main/services/reports.ts` | `export` on `toNairobiWallClock`; `ZReport` gains two optional fields; `generateZReport` fills them | Z report only |
| `src/main/services/database.ts` | Column, migration, `ShiftRow` field, `openShift` third argument | Shift storage |
| `src/main/lib/ipcValidator.ts`, `src/main/index.ts` | `shiftOpenSchema`, `shiftCloseSchema`, both handlers validate | `shifts:open`, `shifts:close` |
| `src/preload/index.ts`, `src/preload/window.d.ts` | `openShift` takes `shiftType` | Renderer API |
| `src/main/services/printer.ts` | One line in `renderZReport` | Printed Z report |
| `src/renderer/src/components/AdminScreen.tsx` | Radio group, status line, note | Admin Shift Controls |
| `src/renderer/src/components/ZReportModal.tsx` | One line | Z report window |

Untouched, as A6 requires: `generateDailySummary` and the Today's Sales card, `generateEndOfDayReport`, `EndOfDayPage`, `mpesa_day_approvals`, every other `reports:*` channel, checkout, the payment gate, anything fiscal, the one-shift-open-at-a-time rule.

## 6. Tests

- **New files: 3, 60 tests.** `tests/shiftWindows.test.ts` (36): `shiftTypeForTime` at 00:00, 08:59, 08:59:59, 09:00, 09:00:01, 09:01, 12:00, 17:29, 17:30, 17:30:59, 17:31:00, 17:31:01 and 23:59:59 Nairobi, across month and year ends and a leap day; the same instants as UTC (`2026-10-02T06:00:00Z` is day, `14:31:00Z` is night, which a UTC-naive version would get the wrong way round); both labels; the due-to-close rule (night opened 02:00, night opened 18:00, day opened 10:00, day opened late); and the renderer twin agreeing on every minute of the day at its first and last second, on every label, constant and the due rule over a grid, and on refusing an invalid time. `tests/shiftZReport.test.ts` (9). `tests/adminShiftWindows.test.ts` (15, real mount): preselection at day and night times and at each boundary second, both options always visible, switching in both directions, sending the suggested and the overridden shift, suggesting afresh on each open, the status line and note inside and past the window including 17:30:59, a night shift opened 02:00 and one opened the evening before, no extra text for an old shift, close still works when past the window, and the note staying on screen with the close form open.
- **Added to existing files, appended only:** `tests/shifts.test.ts` (+6: `openShift` persists `day` and `night`; the original `INSERT` when no shift is named; an invalid value is rejected with nothing written; a `NULL` row and a typed row read back; the column in the new and migrated schema, nullable, with the check) and `tests/ipcValidator.test.ts` (+16, one new `describe` block, plus two `import` lines at the top).
- **Changed existing `expect()`: zero.** No existing test file was edited except those appends.
- **Layout guards** `screensFitDesignBox` and `posCheckoutPanelFit` ran in the full suite and pass.

## 7. Mutation checks (each restored afterwards; run over the five shift test files, 225 tests)

| Mutation | Failed | Which |
| --- | --- | --- |
| `shiftTypeForTime` in `main` always returns `'day'` (the brief's check) | **14** | 13 `shiftTypeForTime` tests (every night time, the UTC night cases, "does not read the UTC clock", the 17:30:59/17:31:00 pin, the date-range test) and the renderer-twin agreement test |
| the same in the renderer twin | **4** | the twin agreement test, and three Admin tests: "preselects the night shift at a night time", "follows the boundary", "sends the suggested shift when the operator changes nothing" |
| end boundary `<=` becomes `<` in `main` (17:30:59 would be night) | **5** | 17:30:00, 17:30:59, the UTC 14:30:59 case, the pin, and the twin agreement |
| `openShift` ignores the shift type | **2** | `openShift` persists `day` and `night` |
| `shiftCloseSchema` accepts any `endingCash` | **1** | "refuses the cash figures that used to become a silent 0..." |
| `generateZReport` drops the label | **2** | the day and the night label tests |

The first run of the always-`'day'` mutation on `main` does not fail any Admin test, because the screen uses the renderer twin; the parity test is what ties the two together, which is why the twin was mutated as well.

## 8. Verification

- `npm run typecheck`: clean. `npx vitest run`: 180 files, 2876 tests passed. `npm run build`: exit 0, "neither mock provider is in out/main", no circular-dependency warning.
- **Not run:** `check:fit`; a real device; the app itself (nothing here needs a till: the screen is covered by real-mount tests).

## 9. Flags

1. **The Z report cannot be opened from the live app, and has not been since phase 158.** `reports:z-report` validates `{ shiftId }` (`zReportRequestSchema`), but the preload sends the bare number (`ipcRenderer.invoke('reports:z-report', shiftId)`, `src/preload/index.ts`), and the validator answers `request: Invalid input: expected object, received number` (confirmed with a scratch check). So the Z-report window after closing a shift, and the Reports page's shift Z report, get an error. The tests mock `getZReport`, so nothing caught it. **Not changed**, because A6 fences the `reports:*` channels. The fix is one line in the preload (`{ shiftId }`), and this phase's Z report fields can only be seen live once it is made. Say if you want it.
2. **"Due to close at 08:59", not 09:00.** The label the client approved ends the night at 08:59, so the note says the same. If the note should read 09:00, it is the one `shiftEndClock` helper.
3. **The note appears on the next render, not on a timer.** The Admin screen reads the clock when it renders, so a screen left open past the end of the window shows the note after its next refresh (opening the tab, closing a form, and so on). It does not tick.
4. **Numeric strings are refused** by the two schemas (section 4); the renderer never sends one.
5. **Old shifts show nothing.** A shift opened before this phase has `NULL`, the Z report carries `null`, and the screens show nothing extra for it.
6. **A late handover is still possible.** The operator can pick either shift whatever the time, and the Z report prints the one picked, not the one the clock would have chosen.
7. **Not built, by instruction:** scoping sales or reports by shift window. A6 stands. A closing remark in the instruction about showing a line that a night shift spans two End of Day reports was not built either, since it came with the reporting question that is not decided; it is one line on the Z report or the status line if wanted.
8. **The updated brief file could not be opened** (`claude/Rubis_POS_Shift_Windows_and_Dialog_Close_Instructions.md` is not on this machine), so this follows the original brief plus the answers that were sent with the go-ahead, including the 17:30 boundary change and the amendments to A1, A6 and A7 as described there.

## 10. Rollback

`git revert` the phase 199 commit. The only stored change is the nullable `shifts.shift_type` column, which older builds ignore; leaving it in place after a revert is harmless. Nothing was backfilled.
