# Phase 227 — Every sale lands in a shift

- **Date:** 2026-10-05
- **Requested:** Nigel's rulings of 2026-10-05 (19:00 and 19:10), after the urgent audit: sales made with no shift open belong to no shift, so the Z report of the shift shows none of them. This phase makes that hard to do and easy to put right. The Z report's printing is **not** in this phase (it is phase 228).
- **Status:** built and tested. **Not installed, not published, no release built.**
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.** Everything below was sized by estimate, not measured.
- **Not changed:** checkout, the payment gate, fiscal and Shopify code, the overlap rule, the "voided sales never join" rule, the normal Close Shift (which still needs a counted figure), how the Z report is sent to a printer.
- **Commits:** `d63a1ac` (the Open Shift inputs extracted into one shared component, Admin unchanged) and this phase's own commit.

## 1. Decisions and rulings applied

| # | What | Done |
| --- | --- | --- |
| D1 | Creating a shift for a period attaches **every** sale with no shift in it, on one confirmation | Already how phase 223 worked (`database.ts` stale-list check). Now pinned by tests. |
| D2 | After a past shift is recorded, the till offers one past shift for each remaining period, each with its own PIN | `listUnattachedOffers`; the form chains to the next offer. |
| D3 | Open Shift and Close Shift warn and offer | Admin Overview: "N sales have no shift. Record them now?", **Record them** / **Carry on without**. |
| D4 | "Cash not counted" for past shifts only | Flag column `cash_not_counted`; toggle on the past-shift form; Z report, printed Z, Shift History tag, correction form. |
| D5 | Cart notice "No shift open" and a dialog to open one | `NoShiftNotice`, `OpenShiftDialog`, `shiftStore`. Selling is **not** refused. |
| Case (b) | A cashier needs a manager PIN; the shift is recorded under **the manager** | `openShiftAsManager`; the Z line "Cashier" is now **"Opened by"**, on screen and on paper. |
| `shifts:open` | Negative starting cash refused; who may open a shift enforced in the main process | See section 2 and the known gap. |

## 2. What changed

| Where | Change |
| --- | --- |
| [OpenShiftForm.tsx](../src/renderer/src/components/OpenShiftForm.tsx) (commit `d63a1ac`) | The shift pick, Starting Cash, M-Pesa balance (optional), Confirm and Cancel, moved out of `AdminScreen.tsx` into one stateless component. The Admin screen renders it; the DOM is the same. Admin's tests (115 in the 7 files that cover it) passed **unchanged**. |
| `shifts.cash_not_counted` ([database.ts](../src/main/services/database.ts)) | `INTEGER NOT NULL DEFAULT 0 CHECK (cash_not_counted IN (0, 1))`, added with the existing idempotent `ALTER TABLE` pattern and in the `CREATE TABLE` for a new till. Existing rows read 0. Only `createRetrospectiveShift` writes it, and only as 1. When set: `starting_cash` 0 (meaningless), `expected_cash`, `ending_cash`, `discrepancy` NULL. A counted shift's `INSERT` is **exactly what it was** (the column is named only when set). |
| `createRetrospectiveShift` / `shifts:create-past` | Accepts `cashNotCounted`. The schema takes both cash figures **or** the flag; neither, or one figure alone, is refused. Returns `expectedCash` and `discrepancy` as `null` when not counted. |
| `addShiftCorrection` | A shift whose cash was not counted has no figures to compare with, so its first correction is never "nothing changed" (even one that enters 0 and 0). Every later correction compares as before. |
| Z report ([reports.ts](../src/main/services/reports.ts), [ZReportModal.tsx](../src/renderer/src/components/ZReportModal.tsx), [printer.ts](../src/main/services/printer.ts)) | `cashNotCounted` (present only when true, so every other report is byte-identical). Screen and paper show **"Cash not counted"** and the cash sales, and **no** starting, expected or counted cash, difference or "Pending". "Cashier:" is now **"Opened by:"** on both. |
| [ShiftCorrectionForm.tsx](../src/renderer/src/components/ShiftCorrectionForm.tsx), [ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx) | The correction form starts blank, not 0, for a not-counted shift. Shift History shows a **"Cash not counted"** tag beside "Recorded later". |
| [PastShiftForm.tsx](../src/renderer/src/components/PastShiftForm.tsx) | A **"Cash not counted"** toggle beside the shift pick. On: both cash fields read "Not counted" and cannot be edited; a reason and the PIN are still required. Off: exactly as before. An optional banner line above the form. |
| D2: `listUnattachedOffers` ([past-shifts.ts](../src/main/services/past-shifts.ts)) | Each Nairobi day's sales with no shift, cut into runs so that no run's period (first sale to last) touches an existing shift (`findOverlappingShift`). `shifts:unattached-days` now returns the offers. `listUnattachedDays` is unchanged and still tested. After a shift is recorded the Shift History screen opens the next offer, oldest first, with "Shift #N recorded for X sales. K more periods have sales with no shift. Record this one, or Cancel to stop." Each offer is its own form with its own PIN. |
| D3: [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) | The count is read with Overview (a failure or a missing call reads as none). **Open Shift** and **Close Shift**, with sales that have no shift, show the question first; **Record them** opens Reports on the first offered period (`ReportsPage initialAction`); **Carry on without** goes on as before. A warning, never a block. |
| [shift-open.ts](../src/main/services/shift-open.ts), `shifts:open` | `openShiftChecked`: with a manager id and PIN, the PIN is re-verified (`requireAdminPin`) and the shift is recorded **under that manager**; without them, the staff id named must be an active admin. `shiftOpenSchema` now refuses a negative starting cash, and a manager id without a PIN or the reverse. Preload `openShiftAsManager` is new; `openShift` is unchanged. |
| D5: [shiftStore.ts](../src/renderer/src/stores/shiftStore.ts), [NoShiftNotice.tsx](../src/renderer/src/components/NoShiftNotice.tsx), [OpenShiftDialog.tsx](../src/renderer/src/components/OpenShiftDialog.tsx), [App.tsx](../src/renderer/src/App.tsx) | The shift is read at sign-in, after each sale, when the cart is shown again and after the dialog. `shouldShowNoShiftNotice` decides the notice: only when the till read its shift and found none. The notice is a fixed-height bar between the catalogue badge and the held-sales strip; the cart drops one line while it shows (as it does for the held strip). Its button is off, with the reason, while a payment is in progress (the same value Hold uses). The dialog suggests Day or Night from the time (17:43 gives Night) and can be changed; an admin opens as themselves; anyone else is asked for a manager PIN. It tells an admin how many sales have no shift with a **Record them** button, and a cashier the same in words only: "A manager can record these in Shift History." |
| [KNOWN_GAPS.md](KNOWN_GAPS.md) | Two entries (section 6). |

## 3. Existing assertions changed (all of them)

| Test | Old | New |
| --- | --- | --- |
| `tests/pastShift.test.ts`, "prints those lines in place of a cashier, and prints the cashier for a normal shift" | `normal.some((l) => l.startsWith('Cashier:'))` is true | `startsWith('Opened by:')` is true. Ruled: the line names the opener. |
| `tests/ipcValidator.test.ts`, "still accepts a negative cash figure…" | `validate(shiftOpenSchema, { staffId: 1, startingCash: -5 })` succeeds | It fails. Renamed "refuses a negative float (docs/phase-227) and still accepts a negative closing figure". The close line is unchanged. Ruled: a float cannot be negative. |

Two changes that would have needed an edit were avoided by design instead: a counted shift's `INSERT` keeps its exact text and parameters, and `cashNotCounted` is present on a Z report only when true, so the deep-equality tests over reports pass untouched. The past-shift form's refusal message is unchanged.

## 4. Tests

- **New files:** [shiftCapture.test.ts](../tests/shiftCapture.test.ts) (29), [shiftCaptureUi.test.ts](../tests/shiftCaptureUi.test.ts) (27), [shiftCaptureAdmin.test.ts](../tests/shiftCaptureAdmin.test.ts) (9). 65 tests.
- **D1:** one call gives one shift row and one guarded `UPDATE` per sale in the period; a confirmation that leaves out a sale of the period is refused and writes nothing.
- **D2:** one offer per day; today's sales split around shift #1 (before 17:43:21, after 17:43:36) with no offer touching it; no sale in two offers or none; the next offer follows a recorded shift with its banner; Cancel stops; the next offer needs its own PIN (no second call without it).
- **D3:** the question with the count ("1 sale has"), both buttons, the form held back; Carry on without goes on; no prompt when none or unreadable; Record them hands over to Reports and attaches nothing; Close Shift asks the same and still needs a counted figure.
- **D4:** the migration statement; no figures stored and none returned; a counted shift's statement unchanged; nothing queued for Shopify or the tax device; the request needs figures or the flag; the close request still needs a counted figure whatever else it says; the Z report on paper and on screen (no "Pending", no difference); "Opened by"; a shift from before has no flag at all; a correction may add figures (even 0 and 0); a correction on a counted shift still refuses "nothing changed"; the form starts blank; the history tag.
- **D5:** the notice rule; the notice sits between the catalogue badge and the held strip and drops a cart line; the button is off with the reason during a payment; the store reads open, none and, on failure, unknown and logs it; the dialog (Night at 17:43, Day at 10:30, changeable; admin opens as themselves with what was typed and no PIN; a cashier needs the PIN and the shift is opened **only** through `openShiftAsManager`; nothing opens before the PIN; refusals shown; the count line with Record them for an admin and words only for a cashier; nothing when none); checkout still reads the shift without requiring it.
- **Handlers:** `shifts:open` goes through `openShiftChecked`; `shifts:create-past` verifies the PIN before it writes; `shifts:unattached-days` returns offers.
- **`shifts:open` through the handler logic:** an active admin's own id opens; a cashier with no PIN is refused with the database never called; unknown or inactive accounts refused; a manager's PIN opens it under the manager; a wrong PIN or a cashier's PIN refused; the database's own refusal passes through. Negative cash and M-Pesa opening refused; the manager id and PIN go together.

### Mutation checks (each restored; the suites above were green again after)

| # | Mutation | Test that failed |
| --- | --- | --- |
| 1 | The offers no longer cut at existing shifts | `D2 … > stops at an existing shift: today's sales split around shift #1, and each offer's period misses it` |
| 2 | `shifts:create-past` without the PIN check | `the handlers in main/index.ts > shifts:create-past re-verifies the manager PIN before it writes anything` |
| 3 | A voided sale may join (the `status <> 'voided'` guard removed from the attach `UPDATE`) | `createRetrospectiveShift > attaches with one guarded UPDATE per sale, and writes nothing else to orders` (phase 223) |
| 4 | "Not counted" on a normal Close Shift (`endingCash` made optional) | `D4 … > is never offered to a normal Close Shift…` and `shifts:open and shifts:close schemas > refuses the cash figures that used to become a silent 0…` |
| 5 | The notice shown while a shift is open | `the cart notice (D5) > shows only when the till read its shift and found none` |

## 5. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean (node and web) |
| Full suite (`npx vitest run`) | **208 files, 3454 passed, 1 skipped, 0 failed** (205 files and 3389 tests before: +3 files, +65 tests). `tests/updateBackup.test.ts`, the known failure, did not fail in this run. |
| Admin tests, unchanged, after the extraction | 7 files, 115 passed |
| M-Pesa payment gate (`mpesaPaymentGate`, `mpesaManualPayment`, `paymentModal`, `mpesaPaymentPoller`) | 4 files, **76** passed |
| Fiscal suite (`fiscal*`, `etims*`, `realEtimsProvider`, `posCheckoutPanelFiscalGate`) | 25 files, **512** passed |
| Layout rule files (`noUnexpectedScroll`, `screensFitDesignBox`, `belowLgUnreachable`, `scale`, `posCheckoutPanelFit`) | 5 files, **96** passed |
| `npm run build` | passes; "Confirmed: neither mock provider is in out/main." |
| The migration statement on a real SQLite (`node:sqlite`, outside the repo) | existing rows read 0; a second `ALTER` is refused as a duplicate column (the pattern catches it); the `CHECK` refuses 2; a flagged row stores 1 |

Layout: not checked by check:fit (owner's rule). For the owner to check on the till.

### For the owner to check on the till

1. **The notice and Complete Sale together.** With no shift open, the cart shows "No shift open. Sales made now belong to no shift." with **Open shift**, and Complete Sale is visible. Hold a sale, add a cached-catalogue state, fill the cart: the held strip, the notice and the cart footer should all still fit (the cart drops a line for each).
2. **The dialog with the keypad open.** Open shift, tap Starting Cash: the keypad docks and Confirm stays reachable. As a cashier, Confirm asks for a manager PIN.
3. **The warnings.** Admin → Overview with sales that have no shift: Open Shift and Close Shift show "N sales have no shift. Record them now?". **Record them** opens Shift History on the first period; **Carry on without** continues.
4. **Cash not counted.** Record a past shift with the toggle on; open its Z report: "Cash not counted", the cash sales, no starting, expected or counted cash, no difference, no "Pending"; print it. In Shift History the shift carries a "Cash not counted" tag. The past-shift form's toggle row should not wrap badly at the till's size.
5. **Opened by.** A Z report reads "Opened by".

## 6. Observed but not changed

- **`shifts:open` cannot check who is at the till.** The main process keeps no session. It checks the staff id the request names (an active admin) or a manager PIN. A hostile or broken renderer that names an admin's id passes. Recorded in `KNOWN_GAPS.md`; a real fix needs a session, which was not invented here.
- **The renderer cannot write a log file.** A shift that cannot be read hides the notice and is written with `console.error`, which a packaged build keeps nowhere. Recorded in `KNOWN_GAPS.md`. Not "logged" in the sense of a file.
- **The Z report still prints to the default printer.** That is phase 228.
- **The warning's count is every sale with no shift, the offers are cut at shifts.** A sale that sits inside an existing shift's window (should not happen) is counted but gets an offer of its own that the form then refuses with "This period overlaps shift #N".
- **A day with two offers shows two rows with the same date** in the "Sales with no shift" list; their times differ.
- **A negative M-Pesa opening was already refused** by `shiftOpenSchema` (phase 222); only the starting cash was newly refused.
- `listUnattachedDays` (phase 223) is no longer used by a handler; it stays, with its tests, because it is the simple per-day count.

## 7. Not verified

- Anything about layout on the till (section 5).
- A real database through the whole path: the tests use the recording fake of the other shift tests. Only the migration statement was run against a real SQLite.
- A real renderer-to-main call of `openShiftAsManager`, and a real cashier opening a shift from the cart with a manager's PIN.
- That D2's chain through three or more periods reads well on the screen; the tests cover two.

## 8. Rollback

Revert this phase's commit, and `d63a1ac` if the shared Open Shift component should go too. Nothing is stored that the reverted code reads wrongly: the new column stays in a till's database, unused and defaulting to 0, and a shift recorded as "not counted" would then read as a closed shift with a starting cash of 0 and no counted cash.
