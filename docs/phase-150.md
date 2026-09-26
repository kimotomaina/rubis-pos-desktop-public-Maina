# Phase 150 (Step 3) — Manual mode at the till: no per-sale approval, plus a fail-safe correction to Step 2

- **Date:** 2026-09-26
- **Requested:** Step 3 of the client's locked M-Pesa POC decisions, with one addition the user asked to fold in ("point 1"): (1) a correction to Step 2's own fail-safe default — `PaymentModal` should show "Loading…" while the till's M-Pesa mode is still being resolved, and a plain "M-Pesa is unavailable right now" notice if resolving it fails, instead of falling back to the Daraja STK form; and (2) Step 3 itself — remove the manager PIN from manual M-Pesa sales, attribute every manual entry to the logged-in cashier server-side (with approval deferred to Step 4's end-of-day report), turn the acknowledgement into a positive attestation, enter the code via the on-screen keyboard, keep `verification_status` as `manual_unverified` but label it plainly, and confirm the whole flow works offline.
- **Outcome:** Implemented.
- **Branch / base commit:** staging @ 49bdbdb (Phase 149 / Step 2).
- **Standing tripwires:** unmodified and passing, full list in §5 — plus two tripwire files that legitimately needed a documented, deliberate change (`mpesaManualPayment.test.ts`, named explicitly in the task, and `mpesaPaymentsRecord.test.ts`, an unavoidable consequence of the same type change — see below).

## 1. Audit

### What was examined

- `src/main/services/checkout.ts` — the manual-approval branch of `runCheckout`'s payment gate, read in full, including its doc comments explaining why manual entry exists and what must stay impossible.
- `src/main/index.ts`'s `orders:checkout` handler — the exact block that re-verified a manager's PIN and stripped `mpesaManual` before calling `runCheckout`.
- `src/main/services/database.ts` — `CheckoutRequest`, `ManualMpesaEntry`, `ManualMpesaApproval`, `CheckoutIpcRequest`, `RecordMpesaPaymentInput` — every type touching a manual entry, read in full to trace exactly where a manager's id could enter or leave the flow.
- `src/main/lib/ipcValidator.ts`'s `checkoutRequestSchema.mpesaManual` — the wire-level schema a renderer's payload is validated against.
- `src/renderer/src/components/PaymentModal.tsx` — read in full (again, after phase-149's restructuring) before touching the capabilities-loading logic or the manual-entry panel.
- `src/renderer/src/components/PosCheckoutPanel.tsx` — confirmed `handleMpesaPaid` forwards whatever `ManualMpesaEntryInput` shape `PaymentModal` gives it straight into `checkout()`, with no destructuring of individual fields — so narrowing that type needed no change here.
- `src/renderer/src/stores/cartStore.ts` — confirmed `checkout()`'s `mpesaManual` field is likewise a pure pass-through to the IPC call, no field-level logic.
- `src/renderer/src/stores/keyboardStore.ts` and `src/renderer/src/components/VirtualKeyboardModal.tsx` — read in full to confirm the existing "caps layout, echo, Submit" on-screen-keyboard pattern (already used by `PosCheckoutPanel`'s customer-KRA-PIN and company-name fields) was the one the task meant by "Phase C/C2" — it is: `VirtualKeyboardModal`'s own doc comment already describes exactly this ("Above the keys sits a read-only echo… Both are given the label `Submit` for their closing key").
- `src/renderer/src/pages/MpesaReconciliationPage.tsx` and `src/renderer/src/pages/MpesaLogsPage.tsx` — read in full to find every place `verification_status`/`manual_unverified` might be shown to a human. Only `MpesaReconciliationPage.tsx` discusses it at all (in prose, never as a raw enum string); `MpesaLogsPage.tsx` deals exclusively with `mpesa_transactions` (STK attempts), which a manual entry never creates a row in.
- `tests/mpesaManualPayment.test.ts` (the file the task named for a deliberate change) and `tests/mpesaPaymentsRecord.test.ts` (a standing tripwire) — both read in full before editing; both construct a `ManualMpesaApproval` literal that the type change below makes a compile error.
- `tests/paymentModal.test.ts` (phase-149's own new file) — read in full; its "fails closed… to the Daraja form" test is exactly what "point 1" corrects.

### How it currently worked (before this step)

A manual M-Pesa sale required a manager's PIN, re-verified in `main/index.ts`'s `orders:checkout` handler via `requireAdminPin(db, mpesaManual.managerId, mpesaManual.managerPin)`, **before** `runCheckout` was even called. The verified manager's id was written straight onto the `mpesa_payments` row as `approved_by_staff_id` at the moment of sale. `PaymentModal`'s "Unverified"/manual-entry panel collected the code via a plain `<input>`, required a checkbox reading "I confirm this payment has not been verified…", then opened `ManagerPinModal` and only called `onPaid` once that PIN was entered and forwarded. Separately, `PaymentModal` fell back to the Daraja STK form both while `getMpesaCapabilities` was still pending and if that call ever failed — a fail-safe choice that made sense when Daraja was the till's default method (phase-148) but became actively misleading once manual is (phase-149): a manual-mode till could flash, or on a real failure permanently show, a phone-number form it can never use.

### Dependencies found

- **Inbound (who calls the changed types/functions):** `ManualMpesaEntry`/`ManualMpesaApproval` are used only by `database.ts` (their own definitions), `checkout.ts` (the gate), `main/index.ts` (the IPC handler), `cartStore.ts` and `PaymentModal.tsx` (the renderer side) — confirmed by grep, no other file constructs or destructures either type.
- **Inbound (tests depending on the old shape):** `tests/mpesaManualPayment.test.ts` (named by the task) and `tests/mpesaPaymentsRecord.test.ts` (not named, but its one manual-sale test constructs `manualApproval: { approvedByStaffId, acknowledgedUnverified }` — a literal the type change turns into a compile error). No other test file constructs this type — confirmed by a repo-wide grep for `approvedByStaffId`/`ManualMpesaApproval`.
- **Outbound:** `renderManualEntryPanel`'s code field now depends on `keyboardStore.ts`'s `open()`/`request` contract, already used by three existing fields in this codebase (`PosCheckoutPanel`'s company-name and customer-KRA-PIN fields, `FiscalNotice.tsx`'s wrong-PIN correction) — no new dependency, no new component.
- **String-based / indirect references:** `verification_status = 'manual_unverified'` is a stored SQLite value, untouched by this step (still written exactly as before) — only its *display* in `MpesaReconciliationPage.tsx`'s prose changed, never the stored enum.

### Risks and constraints identified

- **`checkout.ts`'s four guard rails (switch, format, attestation, cross-mode uniqueness) were explicitly the parts to keep unchanged.** Verified by inspection: `manualEntryEnabled` check, `MPESA_MANUAL_CODE_PATTERN` check, `db.hasRecordedMpesaPayment` check, and `queueOrderRecordingManualPayment`'s one-transaction write are all untouched — only the PIN re-verification (removed) and the `approvedByStaffId` assignment (now always `null`) changed.
- **This step's changes to the manual-approval mechanism apply to *both* UI entry points that reach it** — pure `'manual'`-mode's sole screen (phase-149) and `'daraja'`-mode's optional "Unverified" fallback tab — because both funnel through the exact same `input.manualApproval` branch in `checkout.ts`; there is no way for the backend to distinguish which screen a request came from, and the task's own framing ("the control for manual M-Pesa is now: physical check on the customer's phone + cashier attribution + manager end-of-day approval") describes one unified replacement for the old per-sale-PIN control, not two.
- **`entered_by_staff_id` attribution was already correct before this step** — `checkout.ts` has always derived it from `staff.id` (`db.getStaffById(input.staffId)`), never from anything inside `manualApproval`, and there was never a field on the wire payload that could "name someone else" for it. What changed is `approved_by_staff_id`: it used to be the PIN-verified manager's id, and is now always `null` at sale time, full stop.

## 2. Changes made

### Point 1 — the fail-safe correction

- **`src/renderer/src/components/PaymentModal.tsx`:** replaced the single `mode: MpesaMode` state (defaulting to `'daraja'`) with a discriminated `MpesaCapabilitiesState` (`'loading' | 'unavailable' | { status: 'ready', mode, manualEntryEnabled }`), defaulting to `'loading'`. The `getMpesaCapabilities().then()`/`.catch()` handlers now set `'ready'` only on an actual successful reply with data, and `'unavailable'` on any failure (a rejected promise, a resolved-but-unsuccessful result, or a resolved result with no data). Two new early returns render a plain "Loading…" notice and a plain "M-Pesa is unavailable right now. Take payment another way." notice respectively — neither shows any form.

### Step 3 — manual mode at the till, no per-sale approval

- **`src/main/services/database.ts`:** `ManualMpesaEntry` drops `managerId`/`managerPin` (keeps `code`/`confirmUnverified`). `ManualMpesaApproval` drops `approvedByStaffId` entirely (keeps only `acknowledgedUnverified`). Doc comments on both, and on `CheckoutRequest.manualApproval`, rewritten to describe the new no-PIN, attribution-plus-deferred-approval model.
- **`src/main/lib/ipcValidator.ts`:** `checkoutRequestSchema.mpesaManual`'s zod object drops the `managerId`/`managerPin` fields — the wire contract now accepts only `{ code, confirmUnverified }`.
- **`src/main/index.ts`:** the `orders:checkout` handler no longer calls `requireAdminPin` for `mpesaManual` at all; `manualApproval` is now built as simply `{ acknowledgedUnverified: mpesaManual.confirmUnverified }`.
- **`src/main/services/checkout.ts`:** the manual branch now writes `approvedByStaffId: null` unconditionally (previously `input.manualApproval.approvedByStaffId`, which no longer exists on the type). `MPESA_MANUAL_NOT_ACKNOWLEDGED_MESSAGE` reworded to the positive-attestation framing. The gate's own big doc comment rewritten to describe the reversal of phase-121's manager-PIN design.
- **`src/renderer/src/components/PaymentModal.tsx`:**
  - `ManualMpesaEntryInput` drops `managerId`/`managerPin`.
  - Added `openCodeKeyboard()`, which opens the shared on-screen keyboard (`useKeyboardStore.getState().open({ mode: 'caps', docked: true, maxLength: 10, ... })`) for the M-Pesa code field — the same pattern `PosCheckoutPanel`'s customer-KRA-PIN field already uses. The code field itself is now `readOnly` with an `onClick` opening the keyboard, instead of a plain typed `<input>`.
  - `handleUnverifiedContinue` no longer opens `ManagerPinModal` — after validating the code format and the attestation checkbox, it calls `onPaid` directly. `handleUnverifiedAuthorized` and the `ManagerPinModal` import/usage/`collectingManagerPin` state are all removed.
  - The attestation checkbox's label changed from "I confirm this payment has not been verified, and this sale will be recorded as unverified." to the exact positive statement the task specified: "I have seen the M-Pesa confirmation message on the customer's phone."
  - The panel's submit button changed from "Continue — needs a manager's PIN" to "Complete Sale".
- **`src/renderer/src/stores/cartStore.ts`:** `CheckoutParams.mpesaManual`'s doc comment updated (no functional change — it was already a pure pass-through).
- **`src/renderer/src/pages/MpesaReconciliationPage.tsx`:** heading changed from "Unverified M-Pesa payments" to "Manual (cashier-recorded) M-Pesa payments", and its description reworded to match — the only screen in the app that discusses `manual_unverified` at all today. Its reconciliation mechanics (PIN-gated "Mark checked", `verification_status` never rewritten) are untouched; Step 4 owns hiding this tab from Admin, not this step.

### Deliberate test changes (recorded, as instructed)

- **File:** `tests/mpesaManualPayment.test.ts` (named explicitly by the task)
  - **`manualSale()` helper** dropped its `managerId` parameter and no longer puts `approvedByStaffId` in the `manualApproval` literal it builds — every one of its ~17 call sites updated accordingly (a mechanical, unambiguous change: `manualSale(cashierId, managerId, …)` → `manualSale(cashierId, …)`).
  - **Old:** `'ignores a cashier or approver the caller tries to name'` asserted `payment.approved_by_staff_id` equals the seeded manager's id.
    **New:** `'ignores a cashier or approver the caller tries to name, and records no approver at all'` asserts `payment.approved_by_staff_id` is `null`.
    **Decision that required it:** there is no manager involved in a manual sale at sale time any more, so nothing — hostile or genuine — can make this anything but `null` until Step 4.
  - **Old:** `'refuses without the unverified acknowledgement'` built `manualApproval: { approvedByStaffId: managerId, acknowledgedUnverified: false }`.
    **New:** `'refuses without the cashier's attestation'` builds `manualApproval: { acknowledgedUnverified: false }` — the field no longer exists to include.
  - **Old (the task's own named change):** `'requires a manager on every manual entry'` asserted a payload with just `code`/`confirmUnverified` (no `managerId`/`managerPin`) was **rejected** by the schema.
    **New:** `'needs no manager PIN — just the code and the cashier's attestation'` asserts that exact payload is now **accepted**, and additionally asserts the schema's `mpesaManual` shape has exactly the two remaining keys (`code`, `confirmUnverified`) — nothing left to require a manager with.
  - The two wire-contract tests that built a `{ code, managerId: 2, managerPin: '2222', ... }` fixture had those two now-nonexistent fields dropped from the fixture (their assertions were about the *code* format and the *confirmation* literal, not about the manager fields, so this is a fixture cleanup, not a behavior change).
  - **Added:** `'completes fully offline — no network call of any kind'`, explicitly setting `monitor.isOnline: () => false` and asserting success plus zero calls to `verifyTransactionCode` — the task's own "confirm with a test" instruction for offline behavior.
  - The file's header doc comment updated to describe the new no-PIN/no-approver-at-sale-time model.
- **File:** `tests/mpesaPaymentsRecord.test.ts` (a standing tripwire, **not** named by the task — but the type change above makes its one manual-sale test's fixture a compile error, so this is an unavoidable, minimal, mechanically-forced change, not a design change to this file)
  - **Old:** `'records a manual sale as manual_unverified with its approver'` asserted `approved_by_staff_id: managerId`.
  - **New:** `'records a manual sale as manual_unverified with no approver yet'` asserts `approved_by_staff_id: null` — same reasoning as the `mpesaManualPayment.test.ts` change above, applied to this file's own copy of the same scenario.
- **File:** `tests/paymentModal.test.ts` (point 1's own test, from phase-149)
  - **Old:** `"defaults to daraja's STK form before the capabilities reply arrives, and fails closed the same way on error"` — a single test asserting `container.textContent` contains `'Phone Number'` after a rejected `getMpesaCapabilities()` call.
  - **New:** split into three tests reflecting the corrected behavior: `'shows a plain "Loading…" notice before the capabilities reply arrives'` (using a promise that never resolves, asserting `'Loading…'` and the absence of any form); `'shows a plain unavailable notice, not the Daraja form, when the capabilities call is rejected'` (asserting the unavailable notice and the absence of `'Phone Number'`); and `'shows the same unavailable notice when capabilities resolves without success'` (the `{success:false}` case, not previously covered).
  - **Decision that required it:** the point-1 correction itself — the old test was asserting the exact fallback behavior being replaced.
  - **Added** (new coverage, not a change to an existing assertion): a `'manual mode completes with no manager PIN'` describe block with two tests — a full happy-path completion using the on-screen keyboard (clicking the readOnly code field, driving `useKeyboardStore.getState().request?.onChange(...)` directly, the same technique `NeedsAttentionPage.test.ts` documents for keyboard-driven fields, then checking the attestation box and tapping "Complete Sale") asserting `onPaid` is called with exactly `{ code, confirmUnverified: true }` and that no PIN prompt ever appears; and a refusal test confirming `onPaid` is never called without the attestation checked.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/main/services/database.ts` | Modified | `ManualMpesaEntry`/`ManualMpesaApproval`/`CheckoutRequest` types — the wire and internal shapes of a manual M-Pesa entry |
| `src/main/lib/ipcValidator.ts` | Modified | `orders:checkout`'s wire-level validation of `mpesaManual` |
| `src/main/index.ts` | Modified | The `orders:checkout` handler — no more manager-PIN re-verification for manual entries |
| `src/main/services/checkout.ts` | Modified | The payment gate's manual branch — attribution, approval deferral, message wording |
| `src/renderer/src/components/PaymentModal.tsx` | Modified | Capabilities loading/unavailable states; the manual-entry panel's PIN removal, attestation copy, and on-screen-keyboard code entry |
| `src/renderer/src/stores/cartStore.ts` | Modified (doc comment only) | No functional change |
| `src/renderer/src/pages/MpesaReconciliationPage.tsx` | Modified (copy only) | Heading/description reflecting the "Manual (cashier-recorded)" label |
| `tests/mpesaManualPayment.test.ts` | Modified | Deliberate assertion changes + new offline coverage (see above) |
| `tests/mpesaPaymentsRecord.test.ts` | Modified | One deliberate assertion change, forced by the type change |
| `tests/paymentModal.test.ts` | Modified | Deliberate assertion changes (point 1) + new no-PIN-flow coverage |

## 4. Possible impact

- **Direct:** a cashier completing a manual M-Pesa sale (the till's default mode, or the Daraja-mode Unverified fallback) no longer needs a manager to walk over and enter a PIN — they check the phone, tick the attestation, enter the code via the on-screen keyboard, and tap Complete Sale. Every such sale is still recorded exactly as `manual_unverified`, attributed to the logged-in cashier, with no approver until a manager later approves the whole day's entries at once (Step 4, not yet built). A till whose M-Pesa mode cannot be determined (a slow or failed `getMpesaCapabilities` call) now shows "Loading…" then, if it never resolves, a plain "M-Pesa is unavailable right now" notice, instead of a Daraja phone-number form it cannot use.
- **Indirect:** `MpesaReconciliationPage.tsx`'s reconcile-PIN flow (a manager confirming *after the fact* that a payment matches the M-Pesa statement) is untouched and still requires a PIN — this step only removed the PIN *at the moment of sale*, not the existing after-the-fact reconciliation mechanism, which Step 4 will fold into (and hide behind) the new end-of-day approval instead.
- **Data / schema / contract:** no database migration — `mpesa_payments.approved_by_staff_id` already accepted `NULL` (it's `number | null` on `RecordMpesaPaymentInput`); this step just changes what gets written there for a manual entry, from a real id to always `NULL`. The `mpesaManual` wire payload shrinks (two fields removed); no existing consumer other than this exact flow reads the removed fields.
- **Security posture:** a cashier can now complete an unverified-M-Pesa sale entirely on their own authority, with no independent verification at the point of sale — this is the explicit, locked product decision (docs/phase-148.md's original task text: "NO manager/admin approval per sale"), not an oversight. The control shifts from *prevention* (a manager must agree before the sale completes) to *detection* (every entry is attributed and will be reviewed at end-of-day, Step 4) — a materially different risk model that the client chose deliberately. Every other control this step was told to keep (code format, cross-mode-reuse refusal, the amount fixed to cart total, the one-transaction write) is unchanged.
- **Idempotency / re-run safety:** unchanged — a manual sale is still a single atomic queue-order-and-payment write, safe to retry only in the sense it always was (a repeated identical code is still refused by the `UNIQUE(mode, reference)` constraint).
- **Residual risk:** none identified beyond what Step 4 is explicitly responsible for closing (the actual end-of-day approval mechanism does not exist yet — every manual entry from this step onward accumulates with `approved_by_staff_id = NULL` until Step 4 ships).

## 5. Verification

- `npm run typecheck` — clean, both node and web projects, re-run after each group of changes (backend types/schema/handler, then PaymentModal, then each test file fix).
- `npx vitest run tests/mpesaManualPayment.test.ts tests/mpesaPaymentsRecord.test.ts` — **35/35 passed**, including the new offline test and the `.unwrap()`-based schema-shape assertion.
- `npx vitest run tests/paymentModal.test.ts` — **9/9 passed** on first write, including the keyboard-store-driven no-PIN completion flow.
- Full suite: `npx vitest run` — **108 test files, 1633 tests passed**, zero failures (up from phase-149's 108 files / 1628 tests: net +5 tests after this step's deliberate rewrites and additions).
- `git status --short` confirms exactly the 10 files listed in §3 were touched — nothing else.
- `git diff` of every changed file re-read top to bottom before this report (including a full re-read of the `PaymentModal.tsx` diff): no accidental deletions, no debug output, no unrelated edits. Confirmed `ManagerPinModal` is fully removed from `PaymentModal.tsx` (grep, zero hits) while remaining legitimately in use elsewhere (`MpesaReconciliationPage.tsx`'s own after-the-fact reconcile flow, and the Admin screen's `requestManagerPin` gate) — not orphaned.

## 6. Rollback

`git revert` of this step's commit. This restores: the manager-PIN re-verification in `orders:checkout`; `approvedByStaffId` flowing from that verified PIN onto the payment record; `managerId`/`managerPin` on the wire schema and both `ManualMpesaEntry`/`ManualMpesaApproval` types; `PaymentModal`'s `ManagerPinModal`-driven Continue flow with the plain typed `<input>` and the old "nobody has verified" checkbox copy; the Daraja-STK-form fallback while capabilities are loading or unavailable; and every deliberately-changed test assertion back to its phase-149 wording. Nothing outside the 10 files in §3 was touched, so the revert is clean.

## 7. Observed but not changed

- **Step 4 is not built yet.** Every manual entry recorded from this step forward has `approved_by_staff_id = NULL` and stays that way until Step 4's end-of-day approval mechanism exists — this is the expected, intermediate state the task's own sequencing produces, not a gap in this step.
- **`MpesaReconciliationPage.tsx`'s per-payment PIN-gated reconcile flow is untouched.** It still exists, still requires a manager PIN, and still never rewrites `verification_status` — Step 4 explicitly owns hiding this tab from Admin (keeping the code and its tests), not reworking its mechanics, so this step left it alone beyond the heading/description wording.
- **No other screen currently displays the raw `verification_status` enum to a human** — confirmed by reading `MpesaLogsPage.tsx` (which only ever shows `mpesa_transactions`/STK-attempt data, never touched by a manual entry) and every other renderer file referencing M-Pesa. Step 4's own end-of-day report is where a per-cashier "Manual (cashier-recorded) vs Daraja" split needs to appear, per that step's own spec — not retrofitted here onto a page being hidden next.
- **The Daraja-mode "Unverified" fallback tab shares 100% of this step's mechanism change** (no PIN, same attestation copy, same on-screen keyboard) with pure manual mode, since both reach the identical `checkout.ts` branch — this was a deliberate scope decision (§1), not an oversight, since the backend has no way to tell the two screens apart and the task's own framing describes one unified replacement for the old per-sale PIN control.

## 8. What only a human can check

- A real cashier completing a manual M-Pesa sale end to end on the actual till hardware: tapping the code field opens the on-screen keyboard docked at the bottom (not covering the Complete Sale button), typing shows a live echo, "Submit" closes the keyboard with the typed code visible in the field, ticking the attestation, and tapping Complete Sale finishes the sale with no PIN prompt anywhere.
- The "Loading…" and "M-Pesa is unavailable right now" notices actually being visually distinct and legible on the real touch till (both are simple, unstyled-beyond-Tailwind text, not yet seen rendered on real hardware).
- Confirming a fresh sale via the Daraja-mode "Unverified" tab (not pure manual mode) also completes with no PIN prompt, since this step's mechanism change applies to both entry points identically.

---

**STOP — Step 3 complete (including the point-1 correction), awaiting review before Step 4 (end-of-day report by cashier + manager approval).**
