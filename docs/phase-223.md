# Phase 223 — Past shifts: record a shift for sales that had none (Phase B of the Phase 221 proposal)

- **Date:** 2026-10-05
- **Requested:** Phase B of the [Phase 221 audit](phase-221.md), Part B. Tests of the affected areas only; `check:fit` and the full suite were **not** run, by instruction.
- **Status:** built and tested. **Not built as an installer, not installed, not published, not committed.**
- **Layout: to be checked by the owner on the till.** The past-shift form and the new days view were sized by estimate, not measured.
- **Not changed:** any sale's amount, time, payment, fiscal or Shopify field; `sync_queue`; how a normal shift opens, closes or is counted; Phase C (view and export) and `shift_corrections` (not started).

## 1. Decisions applied (the audit's recommendations)

| Question | Applied |
| --- | --- |
| Period before an open shift | **Allowed.** An open shift is `[clock_in, +infinity)`; a period wholly before it is fine. |
| Voided unattached sales | **Left out** of the list and never attached. |
| M-Pesa balances | **Optional**, as on any shift. Cash is **required** (expected cash needs a float). |
| Normal open/close PIN | Unchanged. Only recording a past shift asks for a manager PIN. |
| Corrections | Not built; no edit and no delete of any shift. A mistake in a recorded shift cannot be repaired in place, **and the overlap rule stops it being redone**. That hole is real until `shift_corrections` ships. |

## 2. What changed

| Where | Change |
| --- | --- |
| `shifts` table ([database.ts](../src/main/services/database.ts)) | Four columns by the idempotent `ALTER TABLE` loop: `kind` (`'normal'` default, CHECK `normal`/`retrospective`), `created_by_staff_id`, `created_at`, `reason`. Every existing shift reads `kind = 'normal'` and NULL for the rest. |
| Period and overlap rules ([pastShift.ts](../src/main/lib/pastShift.ts)) | Pure. Refuses an unreadable time, an end before the start, an end after now (main-process clock). Window = closed interval; **touching counts as overlap**, to the millisecond; an unreadable shift time is treated as open-ended (refuses more, never less). |
| `createRetrospectiveShift` | **One write transaction** (`.immediate`): period rules, overlap check, then a check that the sales shown are exactly the sales with no shift now in the period (a sale that appeared since the list was shown refuses, "refresh the list"), then the shift is inserted **already closed** with its cash and, if both balances were given, M-Pesa figures worked out as `closeShift` does, then **one guarded `UPDATE` per sale**: `SET shift_id = ? WHERE local_id = ? AND shift_id IS NULL AND status <> 'voided' AND created_at >= start AND created_at <= end`. A sale that does not match throws, naming why (now belongs to shift #N / voided / outside the period / does not exist), and the transaction rolls back. The only column of `orders` written is `shift_id`, only from NULL. |
| IPC | `shifts:unattached-days` and `shifts:past-preview` (reads, open like every `reports:*` read, see the KNOWN GAP note on `reports:end-of-day`); **`shifts:create-past`** re-verifies the manager PIN with `requireAdminPin`, and the creator recorded is that manager. Zod schemas in [ipcValidator.ts](../src/main/lib/ipcValidator.ts): reason required (max 300), cash figures required, at least one sale. |
| Day list and preview ([past-shifts.ts](../src/main/services/past-shifts.ts)) | Unattached sales grouped by **Nairobi day** (`localDayOf`, the day every other report uses). Preview returns the exact sales, count, total, total by method, the day/night label from the period start, and a `problem` string instead of throwing. |
| Z report | `ZReport` carries `kind`, `createdAt`, `createdByName`, `reason`. A retrospective shift prints and shows **"RETROSPECTIVE SHIFT, created <date> by <name>"** and **"Reason: …"** in place of the cashier line (the cashier is not known; the manager recorded it). New twin helpers `zReportRetroLines` ([main](../src/main/lib/zReportRetro.ts), [renderer](../src/renderer/src/lib/zReportRetro.ts)), same pattern as Phase 222. |
| Shift History ([ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx)) | When sales with no shift exist, one button on the title row, **"Sales with no shift: N"** (no extra height, because the history table already fills the screen). It opens a days view (day, count, first to last time in Nairobi, total, **Create shift for these**). Retrospective rows get a "Recorded later" tag. |
| [PastShiftForm.tsx](../src/renderer/src/components/PastShiftForm.tsx) | Period prefilled from the chosen day, as Nairobi `YYYY-MM-DD HH:MM` text fields (minute precision on screen; start is `:00.000`, end is `:59.999`, so a sale at 17:30:42 is inside "to 17:30"). Live preview with a paged sales list (4 a page: no scrolling). Day/night suggested from the start, changeable. Cash and optional M-Pesa fields, required reason, then `ManagerPinModal`. Nothing is sent without a PIN. A refusal from the main process is shown and the list is re-read. |
| Shared helpers | `parseOptionalBalance` and the invalid-balance message moved from `AdminScreen.tsx` to [optionalBalance.ts](../src/renderer/src/lib/optionalBalance.ts) so the new form uses the same code; behaviour unchanged. |

**Not built from the audit:** the read-only "N sales have no shift" count on the Overview Shift Controls card (the Overview layout is tight; the Shift History button carries the count instead), and the shared `buildZReportLayout` (only the new lines are shared; the PDF in Phase C will need the full one).

## 3. Existing tests changed

| Test | Old | New |
| --- | --- | --- |
| `shiftZReport.test.ts` "leaves every other figure as it was" | Set aside the type, label and (Phase 222) four M-Pesa fields | Also sets aside `kind`, `createdAt`, `createdByName`, `reason`. Every figure it compares is unchanged. |
| `reportsPage.test.ts` `stubApi` | No `getUnattachedDays` | Adds `getUnattachedDays` returning `[]` (setup only, no assertion changed): Shift History now asks for it. |

## 4. Tests added

[pastShift.test.ts](../tests/pastShift.test.ts) (28): period rules; overlap at the millisecond (touching either end, inside, around, straddling, open shift before and after, unreadable time); exact INSERT and per-sale UPDATE SQL and parameters; cash and M-Pesa figures; every refusal writes nothing before the guard; stale list; the reason a sale could not join; Nairobi-day grouping across the UTC day; preview; schemas; the Z report fields, the lines, the renderer twin, and the printed slip. [pastShiftForm.test.ts](../tests/pastShiftForm.test.ts) (16): the period text and its end-of-minute rule, bad dates, the title-row button and days view, the form's validation order (period, cash, reason, M-Pesa, then PIN), exactly what is sent, shift type, and a refusal shown with the list re-read.

## 5. Checked against a real database

Not only the recording fake (which cannot roll back): the app's own code was run over a real SQLite file (scratchpad only, `vite-node`) with five sales (cash 500, M-Pesa 300, card 150, a voided 999, one on the next day). The list grouped them on two Nairobi days and left the voided one out. A stale list was refused with the database byte-identical. A sale taken by another shift after the preview made the third `UPDATE` fail **after** the shift row and two attachments were written: the database was byte-identical afterwards, so the rollback holds. The good run attached exactly three sales, stored expected cash 1500 and difference −20 and M-Pesa expected 1300, difference −20, and the Z report read back as retrospective with the manager's name and reason. The same period, and a period touching its last millisecond, were then refused as overlapping shift #1, with nothing written. The sales' amount, status, time and method were unchanged.

## 6. Test run

`npm run typecheck` clean. Affected-area tests run (shift, report, admin, printer, database, ipc, held, zReport, preload, pastShift; then the two new and two layout-rule files): all pass. **The full suite was not run, by instruction**; the one known unrelated failure is `updateBackup.test.ts` (Windows path separator on this Mac). Electron is not installed on this PC, so test runs used `ELECTRON_OVERRIDE_DIST_PATH`.

## 7. For the owner

- Look at the days view and the form on a till at the smallest size.
- **Nothing is sent to Shopify, Flient or the fiscal device**: `shift_id` is not part of the sync payload and the sales' sync rows are untouched.
- A night that crosses midnight appears as two days; widen the period in the form to cover both.
- The real tills' gap counts still need the Phase 221 query run on a copy of each till's database.
