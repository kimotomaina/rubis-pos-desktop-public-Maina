# Phase 152 (Step 4, Part A) — End-of-day report by cashier + manager "Approve day"

- **Date:** 2026-09-26
- **Requested:** Step 4 Part A of the client's locked M-Pesa POC decisions, per the phase-151 audit plus the review's five locked decisions: a calendar-day report in Africa/Nairobi local time, approval bound to exactly the ids a report displayed (not "everything pending now"), carry-over for entries from earlier days, a recorded `mpesa_day_approvals` row per approval (idempotent, traceable), and hiding (not deleting) the Admin Reconciliation tab.
- **Outcome:** Implemented.
- **Branch / base commit:** staging @ c00ad9a (Phase 151 audit).
- **Standing tripwires:** unmodified and passing — full fiscal suite, `mpesaPaymentGate`, `mpesaManualPayment`, `mpesaPaymentsRecord`, `mpesaProviderFactory`, `darajaMpesaProvider`, the SMS tests, `mpesaPaymentPoller`, `paymentModal`, the Phase E layout tests. No change to checkout, the payment gate, or fiscal logic — this step only reads `mpesa_payments`/`orders` and adds one new table + a bulk update, both reached from new code paths only.
- **Deliberate test changes:** none. Every test in this step is new; nothing existing was rewritten (`tests/ipcValidator.test.ts` gained two new `describe` blocks, no existing test in it changed).

## 1. What was built

### `src/main/services/reports.ts`

- `getLocalDayRange(localDay)` / `localDayOf(iso)` / `todayLocalDay()` — Africa/Nairobi (EAT, fixed UTC+3, no DST) calendar-day arithmetic, deliberately separate from the existing `getUtcDayRange` (which answers a different question and stays exactly as it was, still used by `generateDailySummary`).
- `generateEndOfDayReport(db, localDay = todayLocalDay())` → `EndOfDayReport`:
  - `cashiers` — per `orders.staff_id`: order count, totals by payment method (reusing `sumByPaymentMethod`), and M-Pesa further split by `mode` (`manual`/`daraja`) from `mpesa_payments.entered_by_staff_id`.
  - `manualEntries` — every manual M-Pesa entry recorded that Nairobi day (time, order, cashier, code, amount, `approved`, and who/when if so).
  - `carryOver` — unapproved manual entries from **any** earlier day, each labeled with its own day.
  - `pendingIds` — exactly the ids of every entry above (today's + carry-over) that is not yet approved, at the moment the report was built.
  - `pendingManualTotal` — sum of those.
  - Voided orders excluded via the existing `excludeVoided`, not re-derived.

### `src/main/services/database.ts`

- New table `mpesa_day_approvals (id, local_day, approved_by_staff_id, approved_at, entry_count, total_amount, note)` — one row per "Approve day" action, created idempotently (`CREATE TABLE IF NOT EXISTS`) and registered in `init()`.
- `getMpesaPaymentsForDateRange` / `getUnapprovedManualPaymentsBefore` — both join `mpesa_payments` to `orders` and alias the order's own `status` column as `status`, so the existing `excludeVoided()` in `reports.ts` can filter them without a second voided-order rule.
- `getMpesaDayApprovalById`.
- `approveMpesaEntries(paymentIds, managerId, localDay, note)` — the "Approve day" action itself, in one `this.conn.transaction(...)`:
  1. Selects which of the given ids are still `mode = 'manual' AND reconciled_at IS NULL`.
  2. If none are, does **not** create a new approval row — see "already approved" below.
  3. Otherwise inserts one `mpesa_day_approvals` row, then updates exactly those still-pending rows (`reconciled_at`, `reconciled_by_staff_id`, and `reconciliation_note` set to `Approved in day report #<id>` — a fixed, parseable template naming the approval, not the manager's free-text note, which lives once on the approval row instead of repeated per payment).
  - The UPDATE itself is a separate private method, `markMpesaPaymentsApproved`, purely so a test can force it to throw and prove the whole transaction — including the just-inserted approval row — rolls back together.
  - **"Already approved":** if every given id was already reconciled, the method looks for a `reconciliation_note` naming an earlier day-approval among those ids and returns it (`alreadyApproved: true`, `approvedCount: 0`, `approval` = that earlier row). If the ids were instead settled one-by-one on the *older* per-payment Reconciliation page (a different note, or none), `approval` is `null` — still correctly "already approved", just honestly not attributable to a day approval that never touched them.

### IPC / preload (`ipcValidator.ts`, `main/index.ts`, `preload/index.ts`, `preload/window.d.ts`)

- `reports:end-of-day` — read-only, any logged-in staff (same gate level as the existing Z-report/daily-summary handlers); validates an optional `localDay` (`YYYY-MM-DD`).
- `reports:approve-day` — manager-gated via the same `requireAdminPin` every other privileged handler in this file uses; validates `managerId`/`managerPin`/`localDay`/`paymentIds` (≥1 positive integer)/optional `note` (≤500 chars).
- `window.api.getEndOfDayReport(localDay?)` / `window.api.approveDayReport({...})` added to the preload bridge and its type declaration, mirroring every existing method's shape.

### Renderer — `src/renderer/src/pages/EndOfDayPage.tsx` (new)

- Per-cashier table (sales, cash, card, M-Pesa manual, M-Pesa Daraja) with a grand-total row.
- Today's manual entries and a separate carry-over section (shown only when non-empty), each row showing approved/pending and, when approved, by whom.
- Both lists paginate at 8 rows/page via the existing `lib/paginate.ts` (Phase E: keeps a busy day's list from overflowing the design box instead of growing the page indefinitely).
- A day-picker (Previous/Next day, pure `YYYY-MM-DD` string arithmetic in UTC so the browser's own timezone can never shift the label by a day — the actual Nairobi boundary math stays server-side).
- The optional approval note is a `readOnly` input opening the shared on-screen keyboard (`useKeyboardStore`, `mode: 'text'`) — per this step's own instruction, ahead of the still-undecided general keyboard-coverage sweep from phase-151 Part B.
- "Approve day" opens the existing `ManagerPinModal` (same component every other manager-gated action in this app uses) and is disabled outright when `pendingIds` is empty.

### `src/renderer/src/components/AdminScreen.tsx`

- The `'mpesaReconciliation'` tab slot is now `'endOfDay'`, rendering `EndOfDayPage` instead of `MpesaReconciliationPage` (decision 6: hide, don't delete — `MpesaReconciliationPage.tsx` and its reconcile mechanics are untouched; it is simply no longer linked from a tab).

## 2. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/main/services/reports.ts` | Modified | New Africa/Nairobi day helpers + `generateEndOfDayReport` |
| `src/main/services/database.ts` | Modified | New `mpesa_day_approvals` table, 4 new/queries methods, `approveMpesaEntries` |
| `src/main/lib/ipcValidator.ts` | Modified | New `endOfDayReportSchema` / `approveDayReportSchema` |
| `src/main/index.ts` | Modified | New `reports:end-of-day` / `reports:approve-day` handlers |
| `src/preload/index.ts`, `src/preload/window.d.ts` | Modified | New `getEndOfDayReport` / `approveDayReport` bridge methods |
| `src/renderer/src/pages/EndOfDayPage.tsx` | Added | The End of Day admin page |
| `src/renderer/src/components/AdminScreen.tsx` | Modified | Reconciliation tab → End of Day tab (decision 6) |
| `tests/endOfDayReport.test.ts` | Added | `generateEndOfDayReport`, day-boundary math, `approveMpesaEntries` (real SQLite) |
| `tests/endOfDayPage.test.ts` | Added | Renderer behavior, including the keyboard-driven note and the approve flow |
| `tests/ipcValidator.test.ts` | Modified (additive) | Wire-contract tests for both new schemas |

## 3. Possible impact

- **Direct:** every manual M-Pesa sale from phase-150 onward, previously accumulating with `approved_by_staff_id = NULL` forever, now has a concrete path to being signed off — a manager opens Admin → End of Day, reviews the day (and any carry-over), and taps "Approve day" behind a PIN. The old per-payment Reconciliation page still exists and still works exactly as before; it is simply no longer reachable from a tab, per the locked decision.
- **Indirect:** none identified — `checkout.ts`, the payment gate, and every fiscal path are untouched; the new queries only read `orders`/`mpesa_payments` and the new table only this feature writes to.
- **Data / schema / contract:** one new table (additive, `CREATE TABLE IF NOT EXISTS`, safe on an existing database — no migration of existing rows needed since nothing before this step ever populated it). No existing table's columns changed.
- **Security posture:** unchanged for the sale path (Step 3's decision — no PIN at the till — stands). The *only* check on a manual entry is now, as designed, this approval action, and it is PIN-gated exactly like every other privileged write in this app.
- **Idempotency / re-run safety:** approving is safe to click twice — the second click changes nothing (`alreadyApproved: true`) and is backed by a real record when the first click was itself a day approval. A forced mid-transaction failure leaves neither a partial approval nor an orphaned `mpesa_day_approvals` row (tested).
- **Residual risk:** `npm run check:fit`'s CDP script covers only the POS/catalog screen today (its own doc comment calls extending it to the rest of the app "future work") — it does not, and did not before this change, cover any Admin tab. I ran it unmodified to confirm this step introduced no regression on what it does cover (18/18 cases still fit), but the new Admin → End of Day page's real-window fit is unverified by that tool, same as every other existing Admin tab. See §6.

## 4. Verification

- `npm run typecheck` — clean throughout (checked after each group of changes: backend types, IPC, renderer).
- `npx vitest run tests/endOfDayReport.test.ts` — **14/14 passed**: per-cashier totals/mode-split/voided-exclusion, both Nairobi day-boundary cases (00:30 and 23:59), carry-over, an entry recorded after report generation staying unapproved, a second approval reporting "already approved" with the earlier record, an id settled by the old per-payment page reporting "already approved" with no fabricated record, and the forced mid-transaction-failure rollback (including a real retry afterward succeeding).
- `npx vitest run tests/endOfDayPage.test.ts` — **6/6 passed**: rendering, carry-over display, the disabled "nothing pending" state, the keyboard-driven note field, and the full approve flow (including the "already approved" notice) via `ManagerPinModal`.
- `npx vitest run tests/ipcValidator.test.ts` — full file still passes; 9 new tests added for both new schemas.
- Full suite: `npx vitest run` — **110 test files, 1662 tests passed**, zero failures (up from phase-150's 108/1633: +2 files, +29 tests).
- `npm run build` then `npm run check:fit` — **18/18 cases fit**, no regression on the POS/catalog screens this tool covers.
- `git status --short` confirmed exactly the 10 files in §2 were touched.
- Every diff re-read top to bottom; confirmed the dynamic `IN (...)` clauses in `database.ts` only ever interpolate placeholder *counts*, never values — every id is still bound as a parameter.

## 5. Rollback

`git revert` of this step's commit. This removes the two new IPC handlers, the two new preload methods, `EndOfDayPage.tsx`, and the Admin tab wiring, restoring the Reconciliation tab exactly as it was. The `mpesa_day_approvals` table is left in place on any database that reached this version — harmless (an additive, never-referenced-again table if reverted) and consistent with this app's existing "expand, don't contract" migration style.

## 6. Observed but not changed

- `scripts/check-fit.mjs` does not cover any Admin tab, old or new — this predates this step and is unrelated to it, but is worth naming here since the task asked for `check:fit` "including the new page." Extending that CDP script to drive into Admin → End of Day (log in, navigate, wait for the report load, measure) is a real, separate piece of work in the same spirit as its own "future work" note — flagging it rather than quietly declaring it done.
- `MpesaReconciliationPage.tsx` and its reconcile mechanics (PIN-gated per-payment sign-off) are untouched, per the locked decision to keep the code and its tests.

## 7. What only a human can check

- A real manager approving a real day's manual entries on the till: the PIN modal, the on-screen keyboard for the note, and the resulting notice, all on actual touchscreen hardware.
- The End of Day page's actual layout at the supported window sizes — not covered by `check:fit` today (see §6).
- Two cashiers each recording a manual M-Pesa sale, confirming the report shows each under the right name with the right totals, and that a third sale recorded while the report is open is still pending after approving and refreshing — the task's own suggested human test.

---

**STOP — Step 4 Part A complete, awaiting review.** Not yet done: bumping the version and the full "rebuild once, `npm run check:fit`, human test on the till" sequence the task reserves for **after** Step 4 is complete — Part A is one piece of Step 4, not the whole step, so that sequence is held until you confirm there is nothing further planned for Step 4.
