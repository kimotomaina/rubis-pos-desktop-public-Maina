# Phase 224 — Shift corrections: fix a mistyped figure without editing the shift

- **Date:** 2026-10-05
- **Requested:** the `shift_corrections` remedy from [Phase 221](phase-221.md) Part B item 6, after [Phase 223](phase-223.md) (past shifts) was committed (`d88adb2`). Tests of the affected areas only; `check:fit` and the full suite were **not** run.
- **Status:** built and tested. **Not committed, not installed, not published.**
- **Layout: to be checked by the owner on the till.** The Z report modal gets a button and, only on a corrected shift, a small block (see section 2). Sized by estimate, not measured.
- **Not changed:** the `shifts` row of any shift (never written by a correction); any sale; `sync_queue`; how a shift opens, closes, or is created after the fact; Phase C (view and export).

## 1. Decisions (mine; the audit left them open)

| Question | Decision |
| --- | --- |
| What can be corrected | The **four figures a person types**: starting cash, counted ending cash, M-Pesa opening and closing balance. The audit named "the corrected cash and M-Pesa counted figures"; a mistyped float is the same kind of mistake and changes expected cash, so it is included. **Not** the period, the sales attached, or the shift type: a wrong period still cannot be repaired. |
| Which shifts | **Closed shifts only**, normal or recorded-afterwards. An open shift has not been counted. |
| Who | A manager PIN, re-checked in the main process (`requireAdminPin`, as `reports:approve-day` and past shifts); the corrector recorded is the manager the PIN belongs to. A reason is required. |
| Many corrections | Allowed. They are a list; **the latest is the current figures**. A correction that changes nothing from the current figures is refused. |
| Original figures | Left exactly as they were on the shift row and the Z report. The correction is shown under them, never in place of them. |
| Expected and difference | **Worked out at the time of the correction** from the shift's non-voided sales then, with the same arithmetic as at close, and stored. If a sale was voided after the shift closed, the correction's expected cash reflects that and the original's does not; both are visible. |

## 2. What changed

| Where | Change |
| --- | --- |
| `shift_corrections` ([database.ts](../src/main/services/database.ts)) | New table: shift id, corrected by, corrected at, reason, the four figures, and the stored expected cash, discrepancy, M-Pesa expected and difference. An index on `shift_id`. **Two triggers refuse any `UPDATE` or `DELETE`**, so append-only is enforced by the database, not by convention (the repo's other append-only tables rely on convention). |
| `addShiftCorrection` | One write transaction (`.immediate`): refuses a missing or open shift, a blank reason, a figure that is not a finite number of 0 or more, and a no-change correction (compared with the last correction, else the shift's own figures, inside the transaction so two managers cannot both pass); works the figures out ([shiftFigures.ts](../src/main/lib/shiftFigures.ts)); inserts one row. It writes nothing else. `listShiftCorrections` returns a shift's corrections oldest first. |
| IPC | `shifts:correct`, with `shiftCorrectionSchema` (every figure required, M-Pesa ones may be `null`; reason required, max 300), preload `correctShift`, `window.d.ts`. |
| Z report | `ZReport.corrections` (oldest first, with the corrector's name). The original fields are unchanged. Wording in new twin helpers `zReportCorrectionBlocks` ([main](../src/main/lib/zReportCorrections.ts), [renderer](../src/renderer/src/lib/zReportCorrections.ts)); the M-Pesa lines inside a correction come from the Phase 222 helper, so "Not recorded" and "Check against the M-Pesa statement" are worded in one place. |
| Printed Z report | After the originals, each correction under a dashed line: **"Corrected on <date> by <name>: <reason>"** (bold), then the starting, expected and counted cash, the discrepancy, and the four M-Pesa lines. Every correction is printed. |
| [ZReportModal.tsx](../src/renderer/src/components/ZReportModal.tsx) | A **"Correct figures"** button beside Print (same row, no extra height), on closed shifts only. If the shift has corrections, one compact amber block under the cash and M-Pesa cards shows the **latest** one (heading, counted cash, discrepancy, M-Pesa counted and check line) and "N corrections in all; the printed report lists each one". That block adds about 60 px **only on a corrected shift**; if it does not fit on the till, say so and I will move it. After a correction the modal re-reads its report. |
| [ShiftCorrectionForm.tsx](../src/renderer/src/components/ShiftCorrectionForm.tsx) | Four fields starting from the current figures (the last correction's, else the shift's own), a required reason, then the manager PIN. Shows the main process's refusal and stays open. It and the PIN dialog are siblings of the modals behind them, so closing one cannot close another. |

## 3. Existing tests changed

| Test | Old | New |
| --- | --- | --- |
| `shiftZReport.test.ts` "leaves every other figure as it was" | Set aside the type, label, four M-Pesa fields and four retrospective fields | Also sets aside `corrections`. Every figure it compares is unchanged. |
| The database stub in `shiftZReport`, `shiftMpesaBalances`, `pastShift`, `reports`, `vatClassReceiptReports` tests | No `listShiftCorrections` | Each stub gains `listShiftCorrections` returning `[]` (setup only, no assertion changed): `generateZReport` now reads a shift's corrections. |

## 4. Tests added

[shiftCorrections.test.ts](../tests/shiftCorrections.test.ts) (24): the arithmetic and the no-change comparison (a typed 0 differs from "not recorded"); the table, index and both triggers are created at start-up; the inserted row, its parameters, and that the one write is the new row (no `UPDATE`, no sales, no queue); M-Pesa blank vs 0; no-change refused against the shift's own figures first and the last correction after; missing shift, open shift, blank reason, negative, NaN and infinite figures refused; one transaction; the request schema; the Z report keeps the originals and lists corrections oldest first with the name; the twin wording; printed order and dashed lines; and the screen (button on closed shifts only, the latest correction shown, the form starts from the current figures, the validation order before the PIN, exactly what is sent, the report re-read, a refusal keeps the form open, cancelling the PIN or the form does not close the one behind).

## 5. Checked against a real database

The app's own code over a real SQLite file (scratchpad only, `vite-node`): a second `init()` is a no-op. A correction on the **open** shift was refused. After closing (counted 1480, M-Pesa 1280), a first correction (counted 1500, M-Pesa 1500) stored expected 1500, discrepancy 0 and M-Pesa difference 0, using the non-voided sales only (cash 500, M-Pesa 300 + 200; the voided 999 and the card sale did not count). An identical second correction was refused. A third with M-Pesa 1490 stored difference −10. **The shift row, every order and the sync queue were byte-identical afterwards.** An `UPDATE`, a single-row `DELETE` and a bare `DELETE FROM shift_corrections` from a separate connection were each refused with "shift_corrections is append-only", and both rows were still there. The Z report read back the original (1480, −20) and both corrections with the manager's name.

## 6. Test run

`npm run typecheck` clean. Affected-area tests (shift, report, admin, printer, database, ipc, held, zReport, pastShift, preload, vatClass, endOfDay, and the two layout-rule files): **898 passed, 0 failed** (37 files). **The full suite was not run.** The one known unrelated failure is `updateBackup.test.ts` (Windows path separator on this Mac). Electron is not installed on this PC, so test runs used `ELECTRON_OVERRIDE_DIST_PATH`.

## 7. For the owner

- **What a correction does not do:** it does not change the Shift History list, and Phase C's export must use the **latest correction's figures** (with the original beside them) when it builds the shift table. Nothing reads corrections except the Z report today.
- A correction cannot be edited or removed. A wrong correction is fixed by a further correction.
- Nothing is sent to Shopify, Flient or the fiscal device.
- Look at the Z report on a corrected shift on a till at the smallest size.
