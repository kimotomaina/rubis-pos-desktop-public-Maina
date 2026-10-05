# Phase 222 — M-Pesa opening and closing balances on every shift (Phase A of the Phase 221 proposal)

- **Date:** 2026-10-05
- **Requested:** Phase A of the [Phase 221 audit](phase-221.md), Part C: record the M-Pesa till balance when a shift opens and closes, and show expected and difference on the Z report.
- **Status:** built and tested. **Not built, not installed, not published.**
- **Layout: to be checked by the owner on the till.** `check:fit` was not run (it drives the built app and Electron is not installed on this PC). The Z report modal was reshaped to avoid growing, see section 2; that is an estimate, not a measurement.
- **Not changed:** how cash is counted, expected or stored; Close Shift's held-sale guard; any sale, order, fiscal or Shopify field; Shift History; past shifts and the export screen (Phases B and C).

## 1. Decisions applied (the audit's recommendations)

| Question | Applied |
| --- | --- |
| Required or optional | **Optional**, blank means "Not recorded". A blank is never turned into 0; a typed 0 is stored as 0. |
| Wording | **"Check against the M-Pesa statement"**, never shortage, over or discrepancy: the balance also moves for withdrawals, transfers, charges and reversals the till never sees. |
| Old shifts | New columns are NULL; the Z report says "Not recorded", never 0. |
| Card | Untouched (no card line added). |
| Pre-filling the opening from the last closing | **Not done.** It was only a suggestion, and a silently stale figure is the risk the optional field avoids. |

## 2. What changed

| Where | Change |
| --- | --- |
| `shifts` table ([database.ts](../src/main/services/database.ts)) | Four nullable `REAL` columns: `mpesa_opening_balance`, `mpesa_closing_balance`, `mpesa_expected`, `mpesa_difference`. In the `CREATE TABLE` and added to an existing table by the idempotent `ALTER TABLE` loop in `migrateShiftsColumns`. No default, no backfill. |
| `openShift` | Optional 4th argument. The `INSERT` is built from the columns given, so a call with neither a shift type nor a balance produces the **same statement as before** (and the type-only call the same one as phase 199). |
| `closeShift` | Optional 3rd argument. Expected M-Pesa = opening balance + the shift's non-voided M-Pesa orders (same source as the Z report's M-Pesa Sales). Difference = counted − expected. **Both are stored only when both balances exist**, so a stored expected always has its difference and a later change to report code cannot rewrite a closed shift. The cash `UPDATE` is the unchanged statement with unchanged parameters; the M-Pesa columns are a second `UPDATE` in the same transaction, only when a counted balance was given. Returns `ShiftCloseResult` (cash fields as before, plus `mpesaExpected`, `mpesaDifference`, `null` when not recorded). |
| IPC | `shiftOpenSchema` and `shiftCloseSchema` take an optional, finite, non-negative balance (absent or null is allowed). `shifts:open`, `shifts:close`, `closeShiftUnlessHeld`, preload and `window.d.ts` pass it through. |
| `ZReport` ([reports.ts](../src/main/services/reports.ts)) | Four optional fields. A closed shift reports what was stored; an open shift with an opening balance shows its expected figure live. |
| Lines | New `zReportMpesaLines` ([main/lib](../src/main/lib/zReportMpesa.ts), twin in [renderer/lib](../src/renderer/src/lib/zReportMpesa.ts)): opening, expected, counted, "Check against the M-Pesa statement". "Not recorded" for a balance nobody entered, "Pending" for what an open shift has not reached. Used by `renderZReport` (a dashed line, then the four lines, below the cash figures) and by the modal. |
| [ZReportModal.tsx](../src/renderer/src/components/ZReportModal.tsx) | The four lines sit in a card **beside** the cash card (a two-column grid; the modal goes from `max-w-2xl` to `max-w-3xl`), not under it, so the modal should be no taller than before. |
| [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) | An "M-Pesa balance (optional)" field (on-screen keyboard, placeholder "Not recorded") on the Open Shift and Close Shift forms. A blank sends the call exactly as before (no extra argument). A bad figure shows "Enter a valid M-Pesa balance, or leave it blank" and sends nothing. The open shift's status line states the opening balance when one was recorded. |

## 3. Existing assertion changed (the only one)

| Test | Old | New |
| --- | --- | --- |
| `shiftZReport.test.ts` > "leaves every other figure as it was" | Set aside only `shiftType` and `shiftWindowLabel` before comparing the rest of the report | Also sets aside the four new M-Pesa fields (they are new and are covered by the new tests). Every figure it compares is unchanged. |

## 4. Tests added

[shiftMpesaBalances.test.ts](../tests/shiftMpesaBalances.test.ts) (21): exact SQL and parameters for open and close with and without balances; the old statements unchanged; expected excludes voided, cash and card; stored only when both balances exist; cash figures identical; schemas (absent, null, 0, negative, NaN, text); Z report for closed, open, old and half-recorded shifts; the lines' wording and "Not recorded"/"Pending"/0; renderer twin equals main over the same reports; thermal print order. [adminShiftMpesaBalance.test.ts](../tests/adminShiftMpesaBalance.test.ts) (8): both forms, blank vs figure vs typed 0 vs bad figure, and the status line.

## 5. Checked against a real database

Not only the recording fake: a copy of the pre-phase `shifts` schema with one closed shift was opened with the app's own code (via `vite-node`, scratchpad only). The four columns were added, a second `init()` was a no-op, the old shift read back with all four NULL and its Z report showed all four null. A new shift opened at 1000 with sales cash 500, M-Pesa 300 + 200 (and a voided 999), card 150 closed with counted 1480: expected 1500, difference −20, the same as the Phase 221 fixture. A shift with no balances closed exactly as before.

## 6. Test run

Full `vitest run` (with `ELECTRON_OVERRIDE_DIST_PATH` set so the missing Electron binary does not abort every file that loads the printer): **3310 passed, 1 failed.** The one failure, `updateBackup.test.ts` "retention", expects a Windows path separator and fails on this Mac; it failed identically before this change. `npm run typecheck` is clean. Run on the Windows build machine before release.

## 7. Not done / for the owner

- Layout of the three touched screens (open form, close form, Z report modal) on the till, at the smallest supported size.
- Nothing is sent to Shopify, Flient or the fiscal device; `shifts` never leaves the till (Phase 221 A4).
- The shared `buildZReportLayout` the audit proposed is **not** built: only the new M-Pesa lines are shared. It is needed in Phase B/C (past-shift line, PDF) and will be extracted there.
- Phase B (past shifts) and Phase C (view and export) are not started.
