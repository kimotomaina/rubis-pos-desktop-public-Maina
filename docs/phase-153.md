# Phase 153 (Step 4, Part A2) — Let the manager leave individual entries out of an approval

- **Date:** 2026-09-26
- **Requested:** A follow-up to Step 4 Part A (docs/phase-152.md): "Approve day" was all-or-nothing — a manager who found one code not on the M-Pesa statement had to either approve everything or approve nothing. This adds a per-entry tick box (ticked by default), lets a manager leave an entry pending with a reason instead, records that decision (not just implies it), shows the history on carry-over, and flags — display only — when the same person recorded and approved an entry.
- **Outcome:** Implemented.
- **Branch / base commit:** staging @ b6cbbeb (Phase 152 / Step 4 Part A).
- **Standing tripwires:** unmodified and passing — full fiscal suite, `mpesaPaymentGate`, `mpesaManualPayment`, `mpesaPaymentsRecord`, `mpesaProviderFactory`, `darajaMpesaProvider`, the SMS tests, `mpesaPaymentPoller`, `paymentModal`, the Phase E layout tests, and every existing assertion in `endOfDayReport.test.ts` (only call-site signatures changed, mechanically — see §4).

## 1. What changed

### `src/main/services/database.ts`

- New table `mpesa_day_exclusions (id, approval_id, payment_id, reason)`, FK'd to `mpesa_day_approvals`, plus an index on `payment_id`. `mpesa_payments` is never written for an excluded entry — `reconciled_at` stays `NULL`, so it surfaces again on the next report's carry-over, exactly as before this step for any pending entry.
- `mpesa_day_approvals` gains `excluded_count` (in the `CREATE TABLE` for a fresh database, and via a new idempotent `migrateMpesaDayApprovalsColumns` `ALTER TABLE ... ADD COLUMN ... DEFAULT 0` for an existing one — the same try/catch pattern `migrateOrdersFiscalColumns` already uses).
- `getLatestExclusionsForPayments(paymentIds)` — one query, joining exclusions to their approval, picking the highest-id (most recent) exclusion per payment.
- `approveMpesaEntries` signature changed from `(paymentIds, managerId, localDay, note)` to `(approvedIds, excluded, managerId, localDay, note)`. New logic, in one transaction:
  - Loads every id across both lists in a single query.
  - **Unchanged phase-152 shortcut:** if `excluded` is empty and every `approvedId` is already reconciled, returns the existing "already approved" lookup (`lookupPriorDayApproval`, extracted verbatim from phase-152's inline logic) — no new row, no refusal.
  - **Otherwise:** every id in either list must currently be a manual, still-pending payment, or the whole call throws (covers "a non-manual id" and "an already-approved id in excluded").
  - Inserts one `mpesa_day_approvals` row (`entry_count`/`excluded_count`/`total_amount` reflecting only the approved subset), updates only `approvedIds` (skipped entirely when empty — decision 4's "untick everything" case), then inserts one `mpesa_day_exclusions` row per excluded entry.
  - `markMpesaPaymentsApproved` stays the single throwable seam the rollback test forces to fail — a new test proves the exclusion rows roll back with it too.

### `src/main/lib/ipcValidator.ts`

- `approveDayReportSchema` rewritten: `paymentIds` → `approvedIds: number[]` (may be empty) + `excluded: Array<{ paymentId, reason? }>` (may be empty, `reason` capped at 200 chars). Three `.refine()`s reject: both arrays empty, an id in both lists, or a duplicate id within either list. This is the layer that owns those three checks — `approveMpesaEntries` doesn't re-check them (see its own doc comment) since it's also reachable directly and dedupes each list independently, but has no way to know two different meanings were intended for the same id.

### `src/main/index.ts`, `src/preload/index.ts`, `src/preload/window.d.ts`

- `reports:approve-day`'s handler and the `approveDayReport` bridge method updated for the new request shape (`approvedIds`/`excluded` in place of `paymentIds`) and the new `ApproveMpesaEntriesResult.excludedCount` field.

### `src/main/services/reports.ts`

- `ManualMpesaEntrySummary` gains two derived, display-only fields:
  - `sameApproverAsRecorder` — `true` when `reconciled_by_staff_id === entered_by_staff_id` on an approved entry (decision 6). No new storage; purely a comparison of two columns that already existed.
  - `lastExclusion` — the most recent exclusion for that payment id (day, manager name, reason), computed once per report via `getLatestExclusionsForPayments` over every today's-manual-entry and carry-over id together.

### `src/renderer/src/pages/EndOfDayPage.tsx`

- Every still-pending entry (today's and carry-over) gets a tick box, ticked by default; unticking reveals a `readOnly` reason field opening the shared on-screen keyboard (`mode: 'text'`), same pattern as the review note.
- Selections live in a `Map<paymentId, {ticked, reason}>` keyed independently of which page is showing, so paging back and forth never loses a choice.
- A summary line — "Approving N of M entries, KES X. K left out." — updates live as entries are ticked/unticked.
- The submit button reads **"Approve"** whenever at least one entry is ticked, or **"Record review"** when every pending entry has been unticked (decision 4) — either way it stays enabled as long as there is at least one pending entry; a report with nothing pending still shows "Nothing pending", disabled, exactly as phase-152 left it.
- An approved entry shows "Recorded and approved by the same person." when `sameApproverAsRecorder` is true, and any entry (pending or approved) shows its `lastExclusion` history line when present.
- `ENTRIES_PER_PAGE` reduced from 8 to 6 (phase-152's value) since a pending row can now grow a second line for its reason field — keeps the page within the Phase E design box.

## 2. Deliberate/forced test changes

- **`tests/ipcValidator.test.ts`'s `approveDayReportSchema` block** — rewritten in full, since the schema's own shape changed:
  - **Old:** a single well-formed `{ paymentIds: [1,2,3] }` was accepted; `{ paymentIds: [] }` was refused unconditionally.
  - **New:** a well-formed `{ approvedIds, excluded }` payload is accepted; `approvedIds` alone may be empty (decision 4 — leaving everything out is a valid review) and `excluded` alone may be empty (the phase-152 all-approved case), but not both; an id in both lists, or a duplicate within one list, is refused; an exclusion's `reason` is optional and capped at 200 characters.
  - **Decision that required it:** docs/phase-153 itself — the wire contract changed on purpose, not by accident.
- **`tests/endOfDayReport.test.ts`'s existing `approveMpesaEntries` call sites** — every call updated from `(ids, manager, day, note)` to `(ids, [], manager, day, note)` (an empty `excluded` array inserted as the new second argument). This is a mechanical signature update, not a behavior change: every existing assertion in the file passes unmodified, confirming the phase-152 all-approved/already-approved/rollback paths behave identically once exclusions are simply absent.
- **`tests/endOfDayPage.test.ts`** — the two existing tests referencing `paymentIds`/the "Approve day" button label were rewritten for the new payload shape and the new "Approve"/"Record review" labels (the button text itself is a deliberate product change from phase-152, not a bug); every other phase-152 test (rendering, carry-over, disabled state, the keyboard-driven note) kept its original assertions, just adjusted for the new required `sameApproverAsRecorder`/`lastExclusion` fields on the fixture type.

## 3. Affected files

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/main/services/database.ts` | Modified | New `mpesa_day_exclusions` table + migration, `getLatestExclusionsForPayments`, `approveMpesaEntries` rewritten |
| `src/main/lib/ipcValidator.ts` | Modified | `approveDayReportSchema` rewritten |
| `src/main/index.ts` | Modified | `reports:approve-day` handler updated |
| `src/preload/index.ts`, `src/preload/window.d.ts` | Modified | `approveDayReport` bridge method updated |
| `src/main/services/reports.ts` | Modified | `sameApproverAsRecorder`/`lastExclusion` added to `ManualMpesaEntrySummary` |
| `src/renderer/src/pages/EndOfDayPage.tsx` | Modified | Per-entry tick boxes, reasons, summary line, button label logic |
| `tests/endOfDayReport.test.ts` | Modified (additive + mechanical) | New exclusion/rollback/same-person tests; existing call sites updated |
| `tests/endOfDayPage.test.ts` | Modified | New per-entry UI tests; two tests updated for the new payload/labels |
| `tests/ipcValidator.test.ts` | Modified | `approveDayReportSchema` test block rewritten |

## 4. Possible impact

- **Direct:** a manager reviewing a day's manual entries can now approve what matches the statement and leave the rest pending with a reason, instead of an all-or-nothing choice. A left-out entry is unaffected in every other way — it is not marked, flagged, or hidden; it simply stays exactly as pending as it always was, with its reason now attached to the review that left it that way.
- **Indirect:** none — `checkout.ts`, the payment gate, and every fiscal path remain untouched. The phase-152 "already approved" shortcut is byte-for-byte the same logic, only relocated into its own method.
- **Data / schema / contract:** one new table (additive) and one new column on an existing table (additive, with an idempotent migration for a pre-existing database). No existing row's meaning changed.
- **Security posture:** unchanged — still gated by the same `requireAdminPin` every other privileged handler uses; the new schema refinements (no id in both lists, no duplicates) close a class of confusing/self-contradictory input before it reaches the database.
- **Idempotency / re-run safety:** a forced mid-transaction failure now covers exclusions too — tested to leave no approval row, no exclusion rows, and no approved payment behind, with a real retry afterward succeeding.
- **Residual risk:** none identified beyond phase-152's own (the CDP `check:fit` script still does not cover any Admin tab — see docs/phase-152.md §6, unchanged by this step).

## 5. Verification

- `npm run typecheck` — clean throughout.
- `npx vitest run tests/endOfDayReport.test.ts` — **22/22 passed**, including 8 new tests: per-entry approve/exclude, the left-out entry's history surfacing on the next report's carry-over, "untick everything" recording a 0-approved review, the exclusion-rollback test, and the same-person marker.
- `npx vitest run tests/endOfDayPage.test.ts` — **14/14 passed**, including new tests for ticking/unticking, the reason keyboard field, the button-label switch, paging preserving selections, and the same-person/last-exclusion display.
- `npx vitest run tests/ipcValidator.test.ts` — **119/119 passed**, the rewritten `approveDayReportSchema` block covering every combination the task's "the server refuses…" line names.
- Full suite: `npx vitest run` — **110 test files, 1684 tests passed**, zero failures (up from phase-152's 110/1662: +22 tests, no new files).
- `git status --short` confirmed exactly the 9 files in §3 (plus this report) were touched.
- Every diff re-read top to bottom; confirmed every dynamic `IN (...)` clause still only interpolates placeholder counts, values always bound as parameters.

## 6. Rollback

`git revert` of this step's commit. This restores the phase-152 all-or-nothing `approveMpesaEntries(paymentIds, managerId, localDay, note)` signature, schema, IPC payload, and `EndOfDayPage` UI. The `mpesa_day_exclusions` table and `mpesa_day_approvals.excluded_count` column are left in place on any database that reached this version — harmless (additive, unreferenced by the reverted code) and consistent with this app's existing migration style.

## 7. What only a human can check

- Record three manual M-Pesa sales on the till, open End of Day, untick one with the reason "not on statement", approve; confirm two are approved and the third shows in carry-over with the reason on the next day's report (the task's own suggested check).
- The tick boxes, reason field, and summary line actually rendering legibly and staying tappable on real touchscreen hardware at the supported window sizes — not covered by any automated check today (same residual gap noted in phase-152 §6/§7).

---

**STOP — Part A2 complete, awaiting review.**
