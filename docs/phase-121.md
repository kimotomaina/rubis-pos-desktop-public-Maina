# Phase 121 — M-Pesa manual entry and the unified payment record

**Date:** 2026-09-23 · **Branch:** `staging` · **Base:** `d640c47` · **Audit:** [Phase 120](./phase-120.md)

Builds the third M-Pesa route designed in the [phase-120](./phase-120.md)
audit: **manual code entry**, plus the unified `mpesa_payments` record that
finally links every M-Pesa payment to the sale it settled.

```
npm run typecheck   → clean (node + web)
npm test            → 89 files, 1384 tests, all passing
tests/mpesaPaymentGate.test.ts → UNMODIFIED (the tripwire)
```

---

## 0. The tripwire, first

[Phase-102](./phase-102.md)'s regression suite passes **byte-unmodified**:

```
$ git diff --stat tests/mpesaPaymentGate.test.ts
(empty)
$ npx vitest run tests/mpesaPaymentGate.test.ts
24 passed
```

That was the condition on this whole change. Two consequences shaped the
implementation:

- **`manualEntryEnabled` had to be optional on `RunCheckoutDeps`.** The
  tripwire's `makeDeps` builds a full `RunCheckoutDeps` literal; a required
  field would have broken its typecheck, which counts as modifying it. Optional
  is also the correct semantics — an omitted flag means *not allowed*, so no
  caller can enable the exception by forgetting about it. There is a test for
  exactly that.
- **The Daraja and SMS refusal paths are textually untouched.** The only
  additions on those branches are `mpesaSettlement = …` on the *success* side.
  Every `return { success: false, … }` in the gate is the same line it was.

`tests/runCheckout.test.ts` needed three lines added to its hand-rolled
`CheckoutDb` fake, because the structural interface grew. No assertion in it
changed.

## 1. The rule, and what this change does to it

Phase-102's gate had exactly two outcomes: **confirmed**, or **refused**. This
adds a third — *completed without confirmation* — and, as the audit said
plainly, there is no way to do that which is not a relaxation of the rule **as
written**.

What is preserved completely is the rule's **purpose**. Phase-102 closed a hole
where *the system silently claimed verification it did not have*. Manual entry
is an exception an operator opens deliberately, by name, that the record
describes as open for ever:

| | The phase-102 hole | Manual entry |
| --- | --- | --- |
| Who opened it | nobody — it was the default | an administrator, explicitly |
| Who knew | nobody | the cashier, the manager, and the record |
| What it recorded | a payment, indistinguishable from real | `manual_unverified`, permanently |
| What happens next | nothing | it sits on the Reconciliation tab until checked |

## 2. `mpesa_payments` — one row per payment that settled a sale

[database.ts](../src/main/services/database.ts), `SCHEMA.mpesaPayments`.
Additive: no column, index or constraint on `mpesa_transactions` or
`mpesa_sms_messages` changed.

`order_local_id` is **NOT NULL**, which is the point. Before this,
`mpesa_transactions.order_local_id` was optional and **never once populated** —
both callers are in `PaymentModal` and both fire before the order exists, so
every row ever written has `NULL` there (phase-120 §3.3, Gap 1). The audit
trail could not answer *"which sale did this pay for?"*. Now every mode answers
it.

`verification_status` (`confirmed` | `matched` | `manual_unverified`) is set in
`checkout.ts` **from which gate branch actually ran**. There is no field for it
anywhere on the wire, and a value smuggled onto the payload object changes
nothing — tested.

## 3. The gate

```ts
if (input.manualApproval) {
  if (!manualEntryEnabled)                          refuse   // switched off
  if (!MPESA_MANUAL_CODE_PATTERN.test(reference))   refuse   // not a code
  if (!acknowledgedUnverified)                      refuse   // not acknowledged
  if (db.hasRecordedMpesaPayment(reference))        refuse   // already settled a sale
  → manual / manual_unverified
} else if (verifyReferenceNumbers) {
  …unchanged…                                       → sms / matched
} else if (!db.hasConfirmedStkPayment(reference)) {
  …unchanged…
} else {
  → daraja / confirmed
}
```

**`verifyTransactionCode` is never called on the manual branch.** Routing manual
through the provider would make an unverified payment indistinguishable from a
verified one at the gate — the precise regression phase-102 exists to prevent.
There is a test asserting the provider is not touched.

The order and its payment row are written in **one transaction**, mirroring
`queueOrderClaimingSmsPayment`'s existing claim-and-insert atomicity: an
unverified sale whose payment record failed to write would be indistinguishable
from a confirmed one.

## 4. 🚩 A gap found on diff review, and closed

Reviewing my own diff before claiming completion turned up a hole I had
introduced: `UNIQUE (mode, reference)` would have let **the same M-Pesa code be
typed in manually after Daraja had already confirmed it** — two rows, two sales,
one real payment, because the modes differ.

Closed with `db.hasRecordedMpesaPayment(reference)`, a cross-mode check on the
manual branch only. It is deliberately not applied to the confirming branches,
which must keep behaving exactly as they did.

**The mirror case is left open and is recorded honestly in §9.3.**

## 5. Manual is a fallback flag, not a third mode

`confirmationMethod` stays `'daraja' | 'sms'` — the *confirming* methods.
`manualEntryEnabled` is a separate boolean, default `false`, permitting manual
**alongside** whichever confirming method is set.

Manual is the only route that works with no credentials, no modem and no
internet. Offered as a third choice in the same dropdown, it is the setting any
shop with a flaky modem quietly settles on — and phase-102's hole reopens by
configuration rather than by code. As a flag, every manual payment stays a
visible exception against a till that has a working confirming method, which is
what makes the reconciliation queue mean anything.

## 6. The four guard rails

| # | Guard rail | Where |
| --- | --- | --- |
| 1 | **Format allowlist** `/^[A-Z0-9]{10}$/` | in `checkoutRequestSchema` **and** re-checked in `checkout.ts`. The renderer's copy is a courtesy to the cashier; the main-process one is the control. |
| 2 | **Amount is the cart total by construction** | `PaymentModal` has no editable amount field; the gate uses `total` |
| 3 | **Manager PIN per manual payment** | `requireAdminPin` in the `orders:checkout` handler, before `runCheckout` is told an approval exists at all |
| 4 | **Explicit unverified acknowledgement** | `confirm: z.literal(true)` on the wire, re-checked in the gate, and the UI says *"This records a payment nobody has confirmed"* in those words |

## 7. Security by design

Every control is server-side; none is satisfiable in the renderer.

| Requirement | How |
| --- | --- |
| `verification_status` never from the payload | derived from the gate branch; **no such field exists on `checkoutRequestSchema`** |
| Approver never named by the renderer | the handler strips `mpesaManual`, verifies the PIN, and passes only the **verified** `managerId` as `manualApproval.approvedByStaffId`. `CheckoutRequest.manualApproval` has no wire representation at all — the same structural trick as the stock-take commit having no `locationId`. |
| Cashier from server-side auth | `staff.id` from `db.getStaffById`, as `runCheckout` always did |
| Code validated server-side | §6.1 |
| Manual never reads as verified | `verifyReferenceNumbers` unchanged for every mode; manual never calls the provider |
| Every payment recorded with its true status | `verification_status` NOT NULL — **the audit trail is the control** |

The PIN itself never reaches `runCheckout`.

## 8. The reconciliation view — the load-bearing control

[MpesaReconciliationPage.tsx](../src/renderer/src/pages/MpesaReconciliationPage.tsx),
a new Admin tab. Lists every `manual_unverified` payment with no
`reconciled_at`, and takes one off the list only through a PIN-gated
`mpesa:reconcile` with an optional note.

**Reconciling does not change `verification_status`.** The sale completed on an
unverified code and that stays true for ever; signing it off records that
somebody later *looked*, not that the till had proof at the time. Rewriting the
status would erase the only evidence the sale took the exception route. Tested.

This screen is why the exception is defensible. A record marked "pending
reconciliation" that no screen ever shows would be a silent pass, not a control
— so it is built here, not deferred.

## 9. Observed but not changed

1. **The Daraja re-use residual.** `hasConfirmedStkPayment` is a read-only check
   with no claim, so one confirmed STK payment can still settle two sales
   (phase-120 §10.2). Out of scope, as instructed, and **verified unchanged** by
   a test that runs two Daraja sales on one reference and asserts both still
   complete. The payment insert uses `ON CONFLICT DO NOTHING` for the confirming
   modes precisely so a bookkeeping row cannot abort a sale the gate approved —
   so the second sale leaves no payment row, making the residual *detectable
   after the fact*, not prevented.
2. **SMS mode is still non-functional** — `MPESA_SMS_PARSER_READY = false`, and
   `listUnmatchedMpesaPayments` still has no renderer caller. Its own phase.
3. **🚩 The mirror of §4 is open: a *message* that arrives after a manual entry
   for the same code can still be claimed by a second sale.** The SMS claim path
   consults `mpesa_sms_messages`, not `mpesa_payments`. Closing it means adding
   a check to the SMS gate branch, which this change was required to leave
   byte-identical — so it is a decision for review, not something to slip in.
   The narrow scenario: manual entry now, message arrives later, a different
   cashier picks it off the unmatched list for a different sale. The
   reconciliation view would surface it, since the manual row is still queued.
   **Recommended fix for a following phase:** have
   `queueOrderClaimingSmsPayment` refuse when `hasRecordedMpesaPayment` is
   already true for that code.
4. **`mpesa_transactions.amount` is INTEGER** while cart totals and SMS amounts
   are REAL. Left alone; `mpesa_payments.amount` is REAL.
5. **Changing the mode or the manual flag needs a restart** — the provider and
   all three flags resolve once at boot. The Admin toggle says so.
6. **Historical Daraja rows are not backfilled.** Gap 1 is closed going forward
   only.

## 10. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` (node + web) | clean |
| `npm test` | 89 files, **1384 tests**, all passing |
| `tests/mpesaPaymentGate.test.ts` | **unmodified**, 24/24 passing |
| `tests/mpesaManualPayment.test.ts` | **new**, 27 tests |
| `tests/mpesaPaymentsRecord.test.ts` | **new**, 7 tests |

Both new files run against a **real in-memory SQLite database** — the `UNIQUE`
constraint and the order-and-payment transaction are part of the safety
argument, so they have to actually execute.

What the new tests hold:

- manual records `manual_unverified`, never `confirmed`;
- a caller-supplied `verificationStatus` / `mode` is **ignored**;
- a caller-supplied `enteredByStaffId` / `approvedByStaffId` is **ignored**;
- the provider is never asked to verify a manual code;
- refused when the flag is off, **and when the flag is merely absent**;
- seven bad code formats refused (blank, whitespace, 9 chars, 11 chars,
  lowercase, `AAA`, punctuation) — no order, no payment row;
- refused without the acknowledgement; refused with no approval at all
  (falls through to the unchanged phase-102 refusal);
- order and payment row are one fact — both, linked, or neither;
- a duplicate manual code rolls the whole sale back;
- a code another mode already settled is refused (§4);
- the reconciliation queue lists it, and it leaves only by reconciling;
- reconciling leaves the status `manual_unverified` for ever;
- double-reconcile refused; a confirmed payment never appears in the queue;
- all three modes write exactly one row naming their sale; cash and card write
  none; a refused sale writes none;
- the wire schema has no `verificationStatus` / `enteredByStaffId` /
  `approvedByStaffId` / `manualApproval` field.

## 11. Rollback

- **Config-level, instant, no deploy:** turn off *Allow recording unverified
  M-Pesa payments* in Admin > Integrations and restart. The gate reverts to
  exactly today's two branches; `input.manualApproval` can still arrive but the
  first check refuses it.
- **Code-level:** `git revert`. The `mpesa_payments` table is left in place and
  ignored — `CREATE TABLE IF NOT EXISTS` means no migration to undo, and the
  recorded rows survive for audit.

## 12. Files changed

| File | Change |
| --- | --- |
| [database.ts](../src/main/services/database.ts) | `mpesa_payments` + index; mode/status/row/input types; `ManualMpesaEntry`, `ManualMpesaApproval`, `CheckoutIpcRequest`; `insertMpesaPayment` (private), `queueOrderRecordingMpesaPayment`, `queueOrderRecordingManualPayment`, `hasRecordedMpesaPayment`, `listMpesaPayments`, `listUnreconciledMpesaPayments`, `markMpesaPaymentReconciled`; `queueOrderClaimingSmsPayment` gains an optional payment arg; the rollback signal renamed `PaymentUnavailableError` now that two paths use it |
| [checkout.ts](../src/main/services/checkout.ts) | the third gate branch; four messages + the code pattern; `manualEntryEnabled` dep; `settledBy`; the order-and-payment write |
| [mpesa-provider-factory.ts](../src/main/services/mpesa-provider-factory.ts) | `manualEntryEnabled` in and out; **`verifyReferenceNumbers` unchanged for every mode** |
| [ipcValidator.ts](../src/main/lib/ipcValidator.ts) | `mpesaManual` on the checkout payload; `manualEntryEnabled` on the integration config; `reconcileMpesaPaymentSchema` |
| [index.ts](../src/main/index.ts) | PIN verification and stripping in `orders:checkout`; `manualEntryEnabled` at boot and on the capabilities channel; `mpesa:list-payments`, `mpesa:list-unreconciled`, `mpesa:reconcile` |
| [preload/index.ts](../src/preload/index.ts), [window.d.ts](../src/preload/window.d.ts) | `CheckoutIpcRequest`; three reconciliation methods; widened capabilities |
| [PaymentModal.tsx](../src/renderer/src/components/PaymentModal.tsx) | the amber **Unverified** tab — code entry, acknowledgement, manager PIN — styled apart from the confirming routes throughout |
| [CheckoutModal.tsx](../src/renderer/src/components/CheckoutModal.tsx), [PosCheckoutPanel.tsx](../src/renderer/src/components/PosCheckoutPanel.tsx), [cartStore.ts](../src/renderer/src/stores/cartStore.ts) | thread `mpesaManual` through `onPaid` → `checkout` |
| [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) | the toggle with its plain-language warning; the Reconciliation tab |
| [MpesaReconciliationPage.tsx](../src/renderer/src/pages/MpesaReconciliationPage.tsx) | **new** |
| [mpesaManualPayment.test.ts](../tests/mpesaManualPayment.test.ts), [mpesaPaymentsRecord.test.ts](../tests/mpesaPaymentsRecord.test.ts) | **new** |
| [runCheckout.test.ts](../tests/runCheckout.test.ts) | three methods added to its fake `CheckoutDb`; no assertion changed |

**STOP for review** — in particular on §9.3, the one gap left deliberately open.
