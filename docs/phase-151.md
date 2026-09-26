# Phase 151 (Step 4, Part 1) — End-of-day report + manager approval, and on-screen-keyboard coverage: AUDIT (read-only)

- **Date:** 2026-09-26
- **Requested:** Step 4 of the client's locked M-Pesa POC decisions ("END-OF-DAY REPORT BY CASHIER + MANAGER APPROVAL"), which the task itself requires to start with a read-only audit, report, and STOP before any build. The user additionally asked, when authorizing this step, to fold in a second audit: confirm the on-screen keyboard (readonly input + `VirtualKeyboardModal`) is used everywhere a cashier or manager has to type something, and identify every place it is not.
- **Outcome:** Audit only. No code changed. This report proposes designs for both parts and stops for review, per the task's own instruction and per disciplined-engineering's scope discipline (two unrelated designs should not land as one commit).
- **Branch / base commit:** staging @ 32d3db6 (Phase 150 / Step 3).

---

## Part A — End-of-day report + manager approval

### What was examined

- `src/main/services/reports.ts` — `generateZReport`, `generateDailySummary`, `excludeVoided`, `sumByPaymentMethod`, `getUtcDayRange`, read in full.
- `src/renderer/src/components/ZReportModal.tsx` — read in full.
- `src/main/services/database.ts` — `ShiftRow` (§118-128), `OrderRow`/`PaymentMethod` (§26-52), `MpesaPaymentRow`/`MpesaVerificationStatus`/`RecordMpesaPaymentInput` (§780-823), `getOrdersForShift`/`getOrdersForDateRange` (§1406-1428), `listUnreconciledMpesaPayments`/`markMpesaPaymentReconciled` (§2229-2263), the `mpesa_payments` table DDL (§585-599, including the already-existing `reconciled_at`/`reconciled_by_staff_id`/`reconciliation_note` columns and the `idx_mpesa_payments_unreconciled` index).
- `src/main/index.ts` — the `mpesa:reconcile` handler (§1140-1164, PIN-gated single-row reconcile), `shifts:close` (§2590-2606), `reports:z-report` (§2611-2623), `reports:daily-summary` (§2629-2640) — read to see the existing IPC surface and its PIN pattern.
- `src/main/services/stock-take.ts` (§260-310, §700-770, §880-890) — read for its existing "approve with PIN, self-approval rule, second-approver-over-threshold rule, one transaction" pattern, since Step 4's "Approve day" action is the same shape of operation (a manager approving a batch of records already written by someone else).
- `src/renderer/src/components/AdminScreen.tsx` — `dailySummary` state and its "Today's Sales" card (§1851-1878), and the M-Pesa "Reconciliation" tab wiring (§108, §996-1001, §1020) that Step 4 must hide.
- `src/renderer/src/pages/MpesaReconciliationPage.tsx` — read in full (again, after phase-150's relabeling) to confirm its reconcile mechanics are a candidate to reuse, not replace.

### How it currently works

- **`generateZReport`** aggregates one shift: revenue by payment method (`cash`/`mpesa`/`card` — a single `mpesa` bucket, **not** split by mode), order count, tax, and the cash reconciliation (`expectedCash`/`endingCash`/`discrepancy`) already stored on the `shifts` row when it was closed via `closeShift`. It has no concept of a cashier breakdown beyond `staffName` (the shift's own single owner) and no "approve" step of any kind.
- **`generateDailySummary`** is the same aggregation over a calendar-day date range instead of a shift, used only by Admin's "Today's Sales" card. Same limitations: no per-cashier split, no mode split, no approval.
- **Voided orders** are excluded from both via `excludeVoided()` (`status !== 'voided'`), applied uniformly before any totals are computed — this is the one piece of filtering logic both reports already share, and Step 4 must keep using it rather than re-deriving it.
- **No "approve" concept exists anywhere for sales/payments today.** The only "approve" pattern in the codebase is stock-take's (`stock-take.ts`): a manager PIN authorizes pushing a *count* to Shopify, with rules for who may approve (not the counter, unless self-approval is enabled) and when a second approver is required (variance over a configured threshold). It is a useful shape to imitate (PIN-gated, one transaction, records who/when) but operates on a single stock-take record, not a batch of many rows across a day.
- **Manual M-Pesa reconciliation already has almost the exact columns Step 4 needs**, just wired to a *per-payment* action instead of a *per-day-report* one: `mpesa_payments.reconciled_at` / `reconciled_by_staff_id` / `reconciliation_note`, set one row at a time by `markMpesaPaymentReconciled`, itself called by the PIN-gated `mpesa:reconcile` IPC handler and surfaced in `MpesaReconciliationPage.tsx`. Since phase-150, every manual entry's `approved_by_staff_id` is `NULL` at sale time — this reconciliation trio is now the **only** place that records anyone signing off on a manual entry, but it does so one row at a time, with no notion of "a day" or "a report", and nothing refuses a second sign-off of the same *set* — only `WHERE reconciled_at IS NULL` refuses re-reconciling the same *row*.
- **`entered_by_staff_id`/`approved_by_staff_id` on `mpesa_payments`, and `staff_id` on `orders`**, are already sufflicient to build the per-cashier, per-mode breakdown Step 4 needs — `orders.local_id` joins to `mpesa_payments.order_local_id`, and `orders.staff_id` is the cashier who rang up the sale. No schema change is needed to compute the breakdown itself.

### Dependencies found

- **Inbound (callers of what Step 4 would touch):** `reports:z-report`/`reports:daily-summary` are called only from `ZReportModal`'s trigger (via `shifts:close` completion) and `AdminScreen.tsx`'s "Today's Sales" card, respectively — confirmed by grep, no other caller. `mpesa:reconcile`/`listUnreconciledMpesaPayments` are called only from `MpesaReconciliationPage.tsx`.
- **Outbound:** a new "day report" would depend on `getOrdersForDateRange` (or a new query joining `orders`+`mpesa_payments`), `getStaffById` (cashier names), and `requireAdminPin` (the approval gate) — all existing, none needing a signature change.
- **String-based / indirect references:** `verification_status = 'manual_unverified'` and `mode = 'manual'`/`'daraja'` are the two enum values a mode-split query keys on — both already stable, unmodified by Step 4.

### Risks and constraints identified

- **Whether "the report" is per-calendar-day or per-shift matters and is not fully specified by the task text.** The task says "end-of-day report" and "every not-yet-approved manual entry in that report" — a store could run more than one shift per calendar day (multiple cashiers, or one cashier clocking in/out more than once), and `generateDailySummary` already exists as a shift-independent calendar-day aggregation, while `generateZReport` is per-shift. Building the approval action against the wrong granularity would either double-count or leave a shift's entries unapprovable until the calendar day ends. **This needs a decision before Part A is built** — see Proposed design below and the flagged decision at the end of this report.
- **"Approve day" must be idempotent per report, not just per row.** `markMpesaPaymentReconciled`'s existing `WHERE reconciled_at IS NULL` guard prevents re-reconciling one already-approved row, but the task's requirement is stronger: refusing a *second approval of the same report* as a whole (e.g., a manager tapping "Approve day" twice should not error confusingly per-row or silently no-op the second click without saying why). The cleanest way to get this is the same guard, generalized: the bulk update's `WHERE reconciled_at IS NULL` already makes a second click a no-op for every row (0 rows affected), so "refuses a second approval" is naturally true once the SQL is a single guarded batch statement — the only decision is what the handler reports back to the manager on a no-op click (an explicit "already approved" message, not a bare success).
- **Hiding the Admin Reconciliation tab** (§996-1001, §1020 in `AdminScreen.tsx`) is a small, surgical change — the tab button and its `activeTab === 'mpesaReconciliation' && <MpesaReconciliationPage />` render both key off the same `'mpesaReconciliation'` union member; hiding it means removing the tab button (and ideally the union member, since nothing else references it) while leaving `MpesaReconciliationPage.tsx` and its own tests completely alone, per the task's explicit "keep the code and its tests, do not delete."
- **No test file exists today for `reports.ts`, `ZReportModal.tsx`, or the shift-close flow** — confirmed by grep (`tests/*.test.ts` has no matching name). Whatever Step 4 adds needs its own new test file(s); there is no existing coverage to extend.

### Proposed design (smallest version, for review before building)

1. **New aggregation function** in `reports.ts`, e.g. `generateEndOfDayReport(db, taxRate, range)`: for each cashier (`orders.staff_id`) active in the range, sum totals by `payment_method` (reusing `sumByPaymentMethod`/`excludeVoided`), plus an M-Pesa sub-split by `mode` (`manual` vs `daraja`) via a join on `mpesa_payments`, plus the flat list of every `manual_unverified` entry in the range (time, order id, cashier, code/`reference`, amount, whether already `reconciled_at`). Voided orders excluded exactly as `excludeVoided` already does.
2. **New IPC handler + `db` method** for "Approve day": PIN-gated (`requireAdminPin`, same pattern as every other privileged handler in `main/index.ts`), takes the same date range the report was generated for plus a manager-supplied note, and in one transaction runs the equivalent of `UPDATE mpesa_payments SET reconciled_at=?, reconciled_by_staff_id=?, reconciliation_note=? WHERE reconciled_at IS NULL AND mode='manual' AND <order in range>` — reusing the existing columns and the existing `IS NULL` idempotency guard, generalized from "one payment id" to "every unreconciled manual payment whose order falls in this report's range." Returns how many rows it actually updated, so the handler can tell a second click "Already approved — 0 entries were pending" instead of a bare success.
3. **Renderer:** a new page/section (sibling to `ZReportModal`/`MpesaReconciliationPage`) showing the per-cashier table, the manual-entries list, and a manager-PIN-gated "Approve day" button — reusing `ManagerPinModal` exactly as `MpesaReconciliationPage.tsx` already does.
4. **Hide, don't delete,** the Admin "Reconciliation" tab (§996-1001, §1020) — keep `MpesaReconciliationPage.tsx` and `tests/` for it untouched.
5. **New tests** covering the required list verbatim from the task: cashier totals by method, M-Pesa split by mode, the manual-entry list, "Approve day" sets `reconciled_at`/`reconciled_by_staff_id`/a note naming the report on every unapproved entry in one transaction, a second approval attempt is refused/reported as a no-op, and voided orders stay excluded.

**Flagged decision needed before I build Part A:** should "a day" mean the calendar-day range `generateDailySummary` already uses (`getUtcDayRange`), or should the report instead be built per-shift (one "Approve day" per `shifts` row, matching `generateZReport`'s existing granularity)? The task's own wording ("end-of-day report", "manager end-of-day approval") reads more naturally as calendar-day, but a store with more than one shift per day would then let a manager approve entries from a shift that hasn't closed yet. My default, absent your correction, is **calendar-day** (matching `generateDailySummary`'s existing range and the task's literal wording), with the report simply listing which shift each entry belongs to for context — but this is exactly the kind of ambiguity Phase 0 says to ask about rather than guess, so I'm flagging it rather than picking silently.

---

## Part B — On-screen-keyboard coverage audit

### What was examined

Every `.tsx` file under `src/renderer/src` containing an `<input>` (14 files, found by grep), cross-referenced against every file that already calls `useKeyboardStore` or renders `VirtualNumpad` (the two existing on-screen-input mechanisms), plus `src/renderer/src/stores/keyboardStore.ts` (read in full) to confirm the intended contract: a field renders a `readOnly` input, `onClick`s `useKeyboardStore.getState().open({ value, onChange, label, maxLength?, mode?, secret?, docked? })`, and the shared `VirtualKeyboardModal` relays keystrokes back through `onChange` with a live echo. `VirtualNumpad` is a second, older, still-current mechanism for pure numeric/PIN entry: it renders inline beside a normal (non-readOnly) input that the numpad and the physical keyboard both write into — the field is not read-only, but its value is always visible and live either way, so it already satisfies "shows what's being typed" by a different, already-tested route.

### What already complies

| Field | File | Mechanism |
| --- | --- | --- |
| Customer KRA PIN, Company name | `PosCheckoutPanel.tsx` (§170, §186) | `useKeyboardStore` (readonly input) |
| Tendered cash amount | `PosCheckoutPanel.tsx` (§332) | `VirtualNumpad` (live, editable) |
| M-Pesa manual code | `PaymentModal.tsx` (phase-150) | `useKeyboardStore` (readonly input) |
| Manager PIN | `ManagerPinModal.tsx` (§107-120) | `VirtualNumpad` (live, editable) + a plain masked `<input type="password">` echoing it |
| Wrong-PIN correction | `FiscalNotice.tsx` | `useKeyboardStore` |
| Store URL / API token, onboarding fields | `OnboardingScreen.tsx`, `EtimsSetupGate.tsx` | `useKeyboardStore` |

### What does not comply

| Field(s) | File | Today | Who types it |
| --- | --- | --- | --- |
| Company Name, Customer KRA PIN, Reference Number | `CheckoutModal.tsx` (§165-241) | Plain typed `<input>` | **Nobody — this component is dead code.** Confirmed by repo-wide grep: it is never imported or rendered anywhere. `PosCheckoutPanel.tsx`'s own doc comment (§33) says it "replace[s]… the `CheckoutModal` popup entirely for Cash/M-Pesa sales." Not a real gap; a candidate for deletion in a separate, unrelated cleanup — out of scope here. |
| Store URL, New Shopify Token, M-Pesa Shortcode/Consumer Key/Consumer Secret/Passkey/Callback URL, "Where payment messages arrive", Fiscal server address/IP/port/password, Default tax class, Store name, Store KRA PIN, printer label text, new-staff name, staff PIN reset | `AdminScreen.tsx` (~20 `<input>` fields, §1182-2075) | Plain typed `<input>`, none wired to `useKeyboardStore`/`VirtualNumpad` | **A manager**, at the till's own touchscreen — this is the same physical device and the same "manager typing on glass" problem the keyboard store was built for elsewhere (`OnboardingScreen`/`EtimsSetupGate` already do this for the *first-run* version of some of these exact fields — e.g. the fiscal device password, the Shopify token — but the *ongoing* Admin edit screen for the same fields never got it). This is the largest and most genuine gap found. |
| Counted quantity, barcode/search box, second-approver KES threshold, count-expiry hours | `StockTakePage.tsx` (§366-403, §629-644) | Plain typed `<input>` (numeric ones use `inputMode`+regex filtering, not a virtual keypad) | A manager or a trained cashier doing a stock count, at the till |
| Manual price override, discount value | `CartLineItem.tsx` (§193-201, §229-235) | Plain typed `<input type="number">` | A manager (price overrides are PIN-gated elsewhere in the flow) |
| Free-text product/order search | `PosSearchBar.tsx` (§125-129), `ProductSearchBar.tsx` (§41-45) | Plain typed `<input>`, filters on every keystroke | A cashier, continuously while searching — `ProductSearchBar.tsx`'s own comment (§12-14) says it's *deliberately* a plain input with no form so a barcode scanner's Enter keystroke does nothing unexpected. |

### Risks and constraints identified

- **Search boxes are a different kind of field** from the others: they filter live on every keystroke and are the documented target of hardware barcode scanners acting as a keyboard. Routing them through the modal on-screen keyboard (which takes over the whole interaction until "Submit") would break "scan and see results as you go" and is likely not what "enter something" was meant to cover. I recommend leaving these two out of scope unless you say otherwise.
- **`ManagerPinModal.tsx`'s PIN field already has a live, visible on-screen numeric pad** (`VirtualNumpad`) — it satisfies the goal (an on-screen keyboard, showing what's typed) through the older-but-still-current pattern rather than the newer readonly-modal one. I don't think this needs rework; flagging only so it isn't mistaken for a gap.
- **`AdminScreen.tsx` is the real, sizeable gap.** It mixes secret fields (Consumer Secret, Passkey, fiscal device password, Shopify token — these need `secret: true`, the masking `keyboardStore.ts` already supports), plain text/URL fields (`caps`/`text` mode), and numeric fields (port, tax class, starting/ending cash — `numeric`/`ip` mode already exists for exactly this). No new keyboard component or store feature is needed — every mode this would use already exists and is already tested elsewhere. This would be a mechanical but wide-reaching swap: ~20 fields, one file, each `<input>` becoming `readOnly` with an `onClick` opening the shared keyboard, matching the pattern `PosCheckoutPanel.tsx` already established.
- **`CartLineItem.tsx` and `StockTakePage.tsx`'s numeric fields** are smaller, independent pockets of the same gap — each could be its own small, reviewable change.
- **Test impact:** none of the non-compliant files currently have a dedicated component test (confirmed: no `tests/adminScreen*.test.ts`, `tests/cartLineItem*.test.ts`, or `tests/stockTakePage*.test.ts` exist covering these specific inputs) other than `tests/adminIntegrationsSections.test.ts`, which tests the *save handlers* Step 1 split out, not the individual field widgets — so converting a field to `readOnly`+keyboard is unlikely to break an existing assertion, but also has no regression net today beyond what I'd add.

### Proposed design (smallest version, for review before building)

Given the scope difference between "the report" (Part A, a new feature) and "keyboard coverage" (Part B, a mechanical consistency fix across existing screens), I'd sequence Part B as its own commit(s), separate from Part A's end-of-day report — most naturally:

1. **`AdminScreen.tsx`** (the largest, clearest win): convert its ~20 config `<input>` fields to the established `readOnly` + `useKeyboardStore` pattern, choosing `mode: 'caps'` for shortcodes/URLs/names, `mode: 'numeric'`/`'ip'` for port/cash/tax-class fields, and `secret: true` for Consumer Secret/Passkey/fiscal device password/Shopify token (reusing the exact masking behavior `OnboardingScreen`/`EtimsSetupGate` already rely on for some of these same fields). One commit.
2. **`CartLineItem.tsx`** and **`StockTakePage.tsx`**'s numeric fields: same conversion, `mode: 'numeric'`. Could be folded into the same commit as (1) or kept separate — your call.
3. **Leave `PosSearchBar.tsx`/`ProductSearchBar.tsx` as plain inputs** (continuous-filter + barcode-scanner reasons above), and **leave `CheckoutModal.tsx` alone** (dead code — flagging its removal as a separate, unrelated cleanup item, not part of this step).
4. **Tests:** since none of these fields have existing coverage, I'd add focused tests per file confirming the field is `readOnly`, clicking it opens the keyboard with the right `mode`/`secret`/`label`, and typing through the store (the same technique `paymentModal.test.ts` already uses) updates the field.

**Flagged decision needed before I build Part B:** do you want `CartLineItem.tsx`/`StockTakePage.tsx` folded into the same commit as `AdminScreen.tsx`, or kept as their own smaller commits? And should `CheckoutModal.tsx` be deleted while I'm in the area, or left alone as an explicitly out-of-scope observation (my default, since deleting dead code was not asked for and touches nothing else in Part A/B)?

---

## Observed but not changed

- `CheckoutModal.tsx` is dead code (unreferenced anywhere in the render tree) and duplicates fields `PosCheckoutPanel.tsx` already owns correctly. Not touched.
- `ManagerPinModal.tsx`'s PIN field already satisfies the underlying goal via `VirtualNumpad`, not the newer readonly-modal pattern — left alone.
- No schema change is needed for Part A — every column the end-of-day report and its approval action need (`entered_by_staff_id`, `approved_by_staff_id`, `reconciled_at`, `reconciled_by_staff_id`, `reconciliation_note`, `orders.staff_id`) already exists.

## What only a human can check

- Whether "end-of-day" should mean calendar-day or per-shift in this store's actual operating pattern (do cashiers ever share a calendar day across multiple shifts?) — the flagged decision in Part A.
- Whether Part B's scope (Admin config fields, stock-take numeric fields, cart price/discount overrides) matches what you meant by "all the sections or areas," or whether search boxes should be included too despite the scanner/live-filter concern raised above.
- Commit granularity for Part B (one commit vs. several) — the flagged decision at the end of that section.

---

**STOP — audit complete for both parts of Step 4. No code changed. Awaiting your decisions on the three flagged questions (end-of-day granularity, Part B scope/commit granularity, and CheckoutModal.tsx's fate) before I build anything.**
