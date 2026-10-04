# Phase 218-1 — the Manual verification panel's sentences reworded

- **Date:** 2026-10-04
- **Follows:** [phase-218.md](phase-218.md), section 2, which left these two sentences alone because neither contained the word "unverified".
- **Outcome:** done. Typecheck clean; full suite **195 files, 3227 tests, all passing** (same counts: one assertion added to an existing test); `npm run build` passes. **Layout not measured** (`check:fit` is not run, by the owner's standing rule).

## 1. What changed

The panel under the Daraja-mode "Manual verification" tab ([PaymentModal.tsx](../src/renderer/src/components/PaymentModal.tsx), the `tab === 'unverified'` branch). Text only:

| | Old | New |
| --- | --- | --- |
| Heading | `This records a payment nobody has confirmed.` | `Checked by the cashier, not by Safaricom.` |
| Description | `Use this only when the customer has paid but the confirmation has not reached this till. The sale will complete and be listed for a manager to check against the M-Pesa statement later.` | `Use this only when the customer has paid but the confirmation has not reached this till. Check the code on the customer’s phone; the manager approves it at End of Day against the M-Pesa statement.` |

The meaning is kept: nothing checks the payment with Safaricom; the cashier checks the code on the phone; the manager approves it at End of Day. The description is about the same length as before (about 190 characters against 178), in the same amber panel; not measured. The panel used on the manual-mode screen ("Record M-Pesa payment" and its sentence) was not asked for and is unchanged.

## 2. Tests

No existing test asserted on either old sentence. In `tests/manualVerificationWording.test.ts` the "new wording" test now also expects the new heading and that `PaymentModal.tsx` no longer contains "nobody has confirmed" (the same words remain in comments in `ipcValidator.ts` and `checkout.ts`, which describe the stored value and are not shown). `paymentModal` (15), `mpesaManualPayment` (28), `mpesaPaymentGate` (24) and `mpesaPaymentsRecord` (7) pass with unchanged counts.

## 3. Affected files, impact, rollback

`PaymentModal.tsx` (two strings), `tests/manualVerificationWording.test.ts`, this document. No behaviour, data or layout code. Rollback: revert this commit.
