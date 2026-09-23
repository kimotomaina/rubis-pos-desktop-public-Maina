# Phase 125 — M-Pesa three-mode payment — audit and plan

> Skill-structured report, moved from the retired `tracker/2026-09-23-0736-mpesa-three-mode.md`. Companion: [phase-120](./phase-120.md) (audit) · [phase-121](./phase-121.md) (build).

- **Date:** 2026-09-23 07:36
- **Requested:** Make M-Pesa a payment method with three selectable modes per till — Daraja STK push (built), SMS/Gammu (built, parked), and manual code entry (new) — with all three recorded in one unified auditable transaction record. Full audit and written plan first; stop for review before implementing.
- **Outcome:** **No change needed (yet)** — Phase 1 audit and Phase 2 plan complete. No source file was modified. Stopped for review before Phase 3, as instructed.
- **Branch / base commit:** `staging` @ `d7b11ba`

---

## Verdict, up front

> **The brief's reframe is right, but the ground is further from "two built,
> one new" than it looks.** Daraja is genuinely built and live. **SMS is wired
> but cannot confirm anything and has no cashier UI**:
> `MPESA_SMS_PARSER_READY === false`, and the `listUnmatchedMpesaPayments`
> bridge method that Part 5/6 was meant to consume **has no caller in the
> renderer at all**. A till set to SMS mode today takes no M-Pesa payments.
>
> **The manual path already physically exists** — `PaymentModal` has a Manual
> Code tab — but phase-102 hid it behind `manualCodeSupported`, which *is* the
> `verifyReferenceNumbers` capability. So "manual" today means *"type a code
> and the provider verifies it against something real"*, not *"type a code and
> we trust you"*. **The new mode is not a new tab. It is a new trust level
> behind a tab that already exists** — which is exactly the distinction
> phase-102 was built to defend.
>
> **The unified record should be a new table.** The two existing tables are not
> two halves of one thing, and **neither is reliably linked to its sale**:
> `mpesa_transactions.order_local_id` is never once populated (§1, Gap 1).
>
> **One recommendation against the brief's framing** (§D3): manual should be a
> *fallback flag available alongside* a confirming mode, not a third exclusive
> mode. Made exclusive, it is the mode that always works, and configuration
> becomes the way back into phase-102's hole.

---

## 1. Audit

### What was examined

| Read in full | Why |
| --- | --- |
| `src/main/services/integrations/mpesa.ts` (94) | the `MpesaProvider` contract every mode implements |
| `src/main/services/mpesa-provider-factory.ts` (211) | mode selection + the two capability flags |
| `src/main/services/integrations/sms-mpesa-provider.ts` (216) | the only provider that verifies for real |
| `src/main/services/checkout.ts` §140-340 | the sale path and the phase-102 payment gate |
| `src/main/services/database.ts` — both M-Pesa tables + all 8 touchpoints | what each mode records today |
| `src/renderer/src/components/PaymentModal.tsx` (452) | where a cashier takes an M-Pesa payment |
| `src/main/lib/requireAdminPin.ts` (57), `ipcValidator.ts` §385-405, `checkoutMath.ts` §51-81 | the controls to reuse |
| `docs/phase-100.md`…`103.md` | what the SMS work actually delivered, and what phase-102 closed |

### Repo state

Branch `staging`, **tree not clean** — 40 entries: 19 modified tracked files,
21 untracked. The working tree carries the entire uncommitted stock-take
feature (phases 117–119) plus earlier uncommitted fiscal/Tremol work
(109–116): +1692/−150.

**Per Phase 0 this is a reportable stop condition, and it is not cosmetic.**
The uncommitted files overlap this change's path almost exactly —
`database.ts`, `index.ts`, `ipcValidator.ts`, `preload/*`, `AdminScreen.tsx`
are all already modified and all on the M-Pesa path. A revert of either piece
of work becomes a manual disentanglement. **Recommendation: commit the
stock-take work before Phase 3.** It is reviewed, typechecked and green.

### Prior art

`git log -n 6 -- checkout.ts mpesa-provider-factory.ts integrations/` returns
only broad commits (`feat: fiscalization v1 done`, `update`, `feat: created
POS`). **Git history carries no signal here** — the phases 100–103 that built
and reasoned about this code were never committed as discrete changes. The
`docs/phase-*.md` files are the real change log, and were read instead.

### How it currently works

**The provider seam.** `MpesaProvider` has three methods; each backend
implements all three, returning a clear *refusal* for what it cannot do rather
than throwing.

| Method | Daraja | SMS | Unconfigured |
| --- | --- | --- | --- |
| `initiateStkPush` | ✅ real | ❌ receive-only | ❌ |
| `verifyTransactionCode` | ❌ no receipt-lookup endpoint | ✅ against stored messages | ❌ |
| `queryStkPushStatus` | ✅ real | ❌ | ❌ |

`SmsMpesaProvider` also implements a **second, deliberately separate**
interface `MpesaSmsInboxReader` (`listRecentUnmatched`), with an explicit
comment on why it is *not* on `MpesaProvider`: two of three implementations
would have to stub it. **That precedent governs this change** — manual mode
needs no new method on the shared contract.

**`resolveMpesaProvider`** returns two flags whose distinction is load-bearing:

```ts
verifyReferenceNumbers  // can the provider settle whether this payment happened?
claimsStoredPayments    // does using this confirmation consume it?
```

| Provider | `verifyReferenceNumbers` | `claimsStoredPayments` |
| --- | --- | --- |
| Daraja | `false` | `false` |
| SMS | `true` | `true` |
| Mock (dev only) | `true` | `false` |
| Unconfigured | `true` (so its own refusal is what the cashier reads) | `false` |

**Mode config** is per-till, in the `integrations` table's `mpesa` row,
resolved **once at boot** ([index.ts:606-607](../src/main/index.ts#L606-L607)),
defaulting to `'daraja'`. `mpesaIntegrationConfigSchema` carries a `.refine`
making `smsInboxPath` mandatory when the method is `'sms'` — **the precedent
for "a mode may demand its own extra config"**. Boot-time resolution means a
mode change needs a restart.

**The sale path.** `runCheckout` resolves staff server-side, runs the payment
gate, then queues the order — and on an SMS till the payment claim and the
order insert are deliberately **one transaction**, with a comment stating that
splitting it either way has a failure that costs money.

### Dependencies found

- **Inbound (callers of the payment gate / provider):** `orders:checkout` IPC →
  `runCheckout`; `PaymentModal.tsx` → `onPaid(reference)`; `AdminScreen.tsx` →
  integration config; `MpesaLogsPage.tsx` → `listMpesaTransactions`.
- **Outbound:** Daraja HTTP API; the gammu inbox folder; `requireAdminPin` →
  `authenticateStaff`; `secretStore` for consumer secret and passkey.
- **String-based / indirect references (the ones that break silently):**
  - IPC channel names: `orders:checkout`, `mpesa:stk-push`, `mpesa:query-status`,
    `mpesa:log-transaction`, `integrations:mpesa-capabilities`,
    `integrations:set-config`.
  - Config **string values** `'daraja'` / `'sms'` — appear in
    `MpesaConfirmationMethod`, the zod enum, the factory branch, the boot
    coercion, **and as raw strings in `AdminScreen.tsx:218` and `:467`**.
    Extending the union means touching all five.
  - Column names in hand-written SQL across 8 `database.ts` sites.
  - `PaymentTab` union `'stk' | 'manual'` in `PaymentModal`.
  - `VITE_USE_MOCK_MPESA`, `MPESA_CONSUMER_KEY/SECRET/SHORTCODE/PASSKEY/ENVIRONMENT/CALLBACK_URL`.
  - `scripts/verify-no-mock-provider.cjs` greps the build output for
    `MockMpesaProvider` **by name**.

### What each mode records today — and three gaps

| | Daraja | SMS | Manual (proposed) |
| --- | --- | --- | --- |
| Records the *attempt* | ✅ | n/a | — |
| Records the *payment* | ✅ `status='success'` + receipt | ✅ the message | — |
| **Linked to the sale** | ❌ **never** | ✅ `matched_order_local_id` | — |
| **Who did it** | ❌ nothing | ✅ `approved_by_staff_id` | — |
| Amount type | INTEGER | REAL | — |
| Verification status | implicit in `status` | implicit in "a row exists" | must be **explicit** |

**Gap 1 — Daraja payments are never linked to their sale.**
`LogMpesaTransactionInput.orderLocalId` is optional and **never supplied
anywhere in the tree**: both call sites are in `PaymentModal` and both fire
*before* the order exists. `order_local_id` is `NULL` on every row ever
written. Today's audit trail cannot answer "which sale did this pay for?".

**Gap 2 — Daraja records no staff identity.** No column equivalent to SMS's
`approved_by_staff_id`.

**Gap 3 — verification status is implicit, and differently per mode.** Neither
table can express *"completed, explicitly unverified"* — precisely what manual
mode must record.

### Risks and constraints identified

**The phase-102 closure, cited exactly.** Its rule:

> **No M-Pesa sale reaches the ledger without a real confirmation, by any
> route.** […] goods handed over for a payment that never arrived are not
> [recoverable], so **every ambiguous case here stops the sale**.

The live hole: M-Pesa **defaulted to the mock**, which approves any code but
the literal `'INVALID'`. *"Open M-Pesa, tap Manual Code, type anything, and the
sale completes about nine times in ten."*

The guard, verbatim
([checkout.ts:272-292](../src/main/services/checkout.ts#L272-L292)):

```ts
if (input.paymentMethod === 'mpesa') {
  const reference = input.referenceNumber?.trim() ?? ''
  if (!reference) {
    return { success: false, error: UNCONFIRMED_MPESA_MESSAGE }
  }
  if (verifyReferenceNumbers) {
    const verification = await mpesaProvider.verifyTransactionCode({ transactionCode: reference, amount: total })
    if (!verification.success) return { success: false, error: verification.error ?? UNCONFIRMED_MPESA_MESSAGE }
    if (!verification.data?.verified) return { success: false, error: verification.data?.reason ?? UNCONFIRMED_MPESA_MESSAGE }
  } else if (!db.hasConfirmedStkPayment(reference)) {
    return { success: false, error: UNCONFIRMED_MPESA_MESSAGE }
  }
}
```

Six defences were installed; **manual mode touches five**:

| # | Guard | Manual mode's relationship |
| --- | --- | --- |
| 1 | the gate itself | **add a branch, never a bypass** |
| 2 | `verifyReferenceNumbers` is a factory capability, never derived at the call site | must stay **`false`** for manual — manual verifies nothing |
| 3 | `canCompleteSale` returns `false` for mpesa unconditionally | **must stay false** |
| 4 | Manual tab hidden unless `manualCodeSupported` | the flag's meaning must change carefully |
| 5 | mock cannot ship (3 barriers + build grep) | untouched |
| 6 | unconfigured till refuses, still takes cash | untouched |

**The honest statement, and the central risk of this whole change.** The gate
has exactly two outcomes today: confirmed, or refused. Manual adds a third —
*completed without confirmation* — and there is **no way to add it that is not,
in the narrow technical sense, a relaxation of phase-102's rule as written**.
Claiming otherwise would itself be the failure mode.

What can be preserved completely is phase-102's *purpose*: that nobody is ever
misled about whether a payment was confirmed. Phase-102 closed a hole where
**the system silently claimed verification it did not have**. Manual mode is a
hole an operator opens deliberately, by name, which the record permanently
describes as open. Those are different things — **but only if the design makes
them different**, which is the entire content of §D3 and §D4.

**Other risks:**

- **The SMS "cashier approves" UI does not exist** (§D1 relies on this).
  `listRecentUnmatched` + `toUnmatchedPayments` + the preload bridge are all
  built; **no renderer file calls any of them**, and
  `MPESA_SMS_PARSER_READY = false` means no message is recognised. Phase-103
  says so plainly: *"Part 4 done well means safe and wired, not working."*
  So manual entry is **not** a sibling of an existing approve flow — there is
  no flow to be a sibling of. Its UI is new work with no in-repo precedent.
- **Manual will be the only mode that works with no Daraja credentials, no
  modem and no internet.** That raises the stakes on it being hard to *select*,
  not merely hard to use.
- **Cross-boundary:** a new table is a schema change (additive,
  `CREATE TABLE IF NOT EXISTS`, no migration). No Shopify/eTIMS contract moves.
- **Test coverage is strong and must be treated as the spec:**
  `mpesaPaymentGate.test.ts` (475), `runCheckout.test.ts` (687),
  `mpesaProviderFactory.test.ts` (269), `smsMpesaProvider.test.ts` (318),
  `mpesaSmsClaim.test.ts` (209), `darajaMpesaProvider.test.ts` (467).
  Run with `npm test` (87 files / 1350 tests, green) and `npm run typecheck`.
- **No M-Pesa reconciliation view exists.** `reconciliation.test.ts` is *shift
  cash* reconciliation. `MpesaLogsPage` (170 lines) is the nearest thing.

---

## 2. Changes made

**No changes made.** This task was scoped as audit-and-plan with an explicit
stop before implementation. No source, test, config or schema file was
modified. The only files written are this report and `tracker/.gitignore`,
neither of which is committed.

The plan the audit produced follows.

### Open decisions, resolved against the code

**D1. Manual trust model → record-only-unverified. Feasible, with a caveat.**
Manual completes the sale, is recorded `manual_unverified`, and surfaces in a
reconciliation view for later confirmation against the M-Pesa statement. Every
mechanism exists. The caveat the audit adds: the reconciliation view is **new
UI with no precedent** and must be scoped as real work. *A record marked
"pending reconciliation" that no screen ever shows is not a control; it is a
silent `TRUE`.*

**D2. Unified record → a new `mpesa_payments` table.** Extending
`mpesa_transactions` fails on all three of its NOT NULL columns
(`checkout_request_id`, `merchant_request_id`, `phone_number`) — a manual or
SMS payment has none, so every one would need loosening, weakening the
constraints protecting the Daraja path. Extending `mpesa_sms_messages` fails on
`transaction_code UNIQUE`, the dedup key that stops one message being spent
twice. The two tables are not two halves of one thing: one is *an STK attempt
this till made*, the other *a message this till received*. Neither is *a
payment that settled a sale* — the record actually wanted, which exists for no
mode today.

| Column | Notes |
| --- | --- |
| `order_local_id` | **NOT NULL** — this table records payments that settled sales. Closes Gap 1 for all modes. |
| `mode` | `daraja \| sms \| manual` |
| `verification_status` | `confirmed \| matched \| manual_unverified` — **set server-side from the actual outcome** |
| `reference` | receipt number / transaction code / typed code |
| `amount` | **REAL** (matches cart totals and `mpesa_sms_messages`; `mpesa_transactions.amount` being INTEGER is a Daraja artefact) |
| `entered_by_staff_id` | NOT NULL, from server-side auth |
| `approved_by_staff_id` | nullable — the manager who authorised a manual entry |
| `reconciled_at`, `reconciled_by_staff_id`, `reconciliation_note` | nullable; the later-confirmation path |
| `source_transaction_id`, `source_sms_message_id` | nullable links to mode-specific evidence |
| `UNIQUE (mode, reference)` | dedup, following `transaction_code`'s precedent |

**D3. Mode selection → per-till config, but manual is a fallback flag, not a
third exclusive mode.** *This is a recommendation against the brief's framing
and the most consequential judgement in this audit.*

Per-till is right — it mirrors `confirmationMethod`, and a shop has one way of
taking M-Pesa, not a per-customer choice. But a third *exclusive* mode has a
predictable failure: manual always succeeds, with no credentials, no modem and
no internet. If it is selectable as the till's mode, the path of least
resistance for any shop with a flaky setup is to select it and never change
back — and **phase-102's hole reopens by configuration rather than by code**.

Proposed instead: `confirmationMethod` stays `'daraja' | 'sms'` (the
*confirming* modes) and a separate boolean `manualEntryEnabled`, default
`false`, permits manual **alongside** whichever confirming mode is set. A
manual payment is then always an exception against a till that has a working
confirming mode — which is what makes the reconciliation view meaningful. A
till where *every* payment is manual has no signal in it at all.

If review prefers three exclusive modes, that is a legitimate call — but it
should be made knowingly, and the reconciliation view becomes the only
remaining control.

**D4. Manual guard rails → all four, layered.**
1. **Format validated server-side** against an allowlist — `/^[A-Z0-9]{10}$/`
   in zod *and* re-checked in main. Rejects blanks, `AAA`, `1`, mashing.
2. **Amount is the cart total by construction** — no editable field to mistype,
   as `PaymentModal` already does.
3. **Manager PIN per manual payment**, via `requireAdminPin`. A cashier alone
   cannot complete an unverified M-Pesa sale. This is what keeps manual off the
   path of least resistance.
4. **Explicit unverified acknowledgement** — `confirm: z.literal(true)`, with
   UI stating in words that this records an **unverified** payment. Borrowed
   from the stock-take commit.

Plus: **`verifyReferenceNumbers` stays `false` for manual.** Manual must never
route through `verifyTransactionCode`, which would make it indistinguishable
from a verified payment at the gate.

### Planned file-by-file (Phase 3, not yet done)

| File | Planned change |
| --- | --- |
| `database.ts` | `SCHEMA.mpesaPayments` + index; row/input types; `recordMpesaPayment` (called **inside** the order transaction); `listMpesaPayments`, `listUnreconciledMpesaPayments`, `markMpesaPaymentReconciled`; `queueOrderRecordingManualPayment` mirroring `queueOrderClaimingSmsPayment` |
| `checkout.ts` | a third gate branch for manual; Daraja and SMS branches **byte-identical** |
| `mpesa-provider-factory.ts` | `manualEntryEnabled` in/out; **`verifyReferenceNumbers` unchanged for every mode** |
| `ipcValidator.ts` | `manualEntryEnabled` on the config schema; `manualMpesaPaymentSchema`; `reconcileMpesaPaymentSchema` |
| `index.ts` | extend `integrations:mpesa-capabilities`; new `mpesa:list-payments`, `mpesa:list-unreconciled`, `mpesa:reconcile` (PIN-gated) |
| `preload/index.ts`, `window.d.ts` | bridge methods |
| `PaymentModal.tsx` | manual tab with **visibly different copy and styling** for the unverified path, manager PIN, explicit acknowledgement |
| `AdminScreen.tsx` | `manualEntryEnabled` toggle with a plain-language warning; Reconciliation tab |
| `pages/MpesaReconciliationPage.tsx` | **new** |

### Deliberately NOT changing

- `canCompleteSale` stays `false` for mpesa (phase-102 guard 3).
- `hasConfirmedStkPayment` and the Daraja gate branch — untouched.
- The SMS claim transaction — untouched.
- `mpesa_transactions` / `mpesa_sms_messages` — no column, index or constraint
  changes. The new table references them.
- The mock's three barriers and the build grep.
- `MpesaProvider` gains no method (by §1's own stated reasoning).
- The SMS parser stays inert; making it work is its own phase.

---

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| *(none)* | — | No source file was modified in this task. |
| `tracker/2026-09-23-0736-mpesa-three-mode.md` | Added | This report. Not committed. |
| `tracker/.gitignore` | Added | Makes `tracker/` self-ignoring. Not committed. |

The table of files the *plan* would touch is in §2.

---

## 4. Possible impact

- **Direct:** none. No behaviour changed.
- **Indirect:** none.
- **Data / schema / contract:** none changed. The plan proposes one additive
  table (`CREATE TABLE IF NOT EXISTS`, no migration, no existing column moved).
- **Security posture:** **unchanged today.** The audit's finding is that the
  planned work *would* alter it: manual mode is a deliberate third outcome at a
  payment gate that currently has two, and §1 states that plainly rather than
  claiming the phase-102 rule survives untouched. The four layered guard rails
  in D4 and the fallback-not-mode recommendation in D3 exist to keep the
  *purpose* of that rule intact.
- **Idempotency / re-run safety:** this task wrote no state. The planned table
  uses `CREATE TABLE IF NOT EXISTS` and `UNIQUE (mode, reference)`; the planned
  manual write is inside the order transaction so a retry cannot leave a
  payment without a sale or a sale without a payment.
- **Residual risk:**
  - The `write`-side behaviour of a real Daraja or SMS till was **not exercised** —
    this was a read-only audit, and no live M-Pesa call was made.
  - `MPESA_SMS_PARSER_READY = false` means the SMS path's *end-to-end* behaviour
    has never been observed by anyone, so the audit's account of it is from code
    and docs, not from a working till.
  - The uncommitted working tree (§1) means the audit describes code that is not
    in any commit.

---

## 5. Verification

| Check | Result |
| --- | --- |
| `git status --short` | 40 entries, tree not clean — reported in §1, **not absorbed into this work** |
| `git check-ignore` / `git status` for `tracker/` | **verified** — appending to root `.gitignore` did not take effect, so `tracker/.gitignore` containing `*` was used instead (the fallback the protocol specifies). `git status --short` now lists nothing under `tracker/`. |
| `npm test` | **not re-run for this task.** Last run, at the end of the stock-take work: 87 files / 1350 tests passing. Nothing has changed since. |
| `npm run typecheck` | **not re-run** — same reason. |

No tests were added, because no code changed. The verification plan for Phase 3
is: all 1350 existing tests green with **`mpesaPaymentGate.test.ts`
unmodified** — *if that file needs editing to pass, the change has regressed
phase-102 and must be reworked* — plus a new `mpesaManualPayment.test.ts`
(real in-memory SQLite) asserting that a manual sale records
`manual_unverified` and never `confirmed`; that a renderer-supplied
`verification_status`, `enteredByStaffId` or `approvedByStaffId` is **ignored**;
that bad code formats, a missing manager PIN and a missing `confirm` are each
refused with no order and no payment row written; that the order and payment
row are one transaction; and that a manual payment leaves the unreconciled list
only via the PIN-gated reconcile path.

---

## 6. Rollback

For this task: delete `tracker/2026-09-23-0736-mpesa-three-mode.md`. Nothing
else was written, and nothing is committed.

For the planned change, rollback is additive by construction:

- **Config-level (instant, no deploy):** set `manualEntryEnabled` off. The gate
  reverts to exactly today's two branches.
- **Code-level:** revert the commit. The new table is left in place and ignored —
  `CREATE TABLE IF NOT EXISTS` means no migration to undo, and recorded rows
  survive for audit.
- **Precondition:** the stock-take work must be committed first (§1), or
  neither rollback is clean.

---

## 7. Observed but not changed

1. **`mpesa_transactions.order_local_id` is never populated** — Gap 1, §1.
   Every Daraja row has `NULL`. The planned table fixes this going forward;
   historical rows would not be backfilled.
2. **The Daraja double-spend residual.** `hasConfirmedStkPayment` is a
   read-only check with no claim, so one confirmed STK payment could settle two
   sales. **Out of scope, as instructed.** Noted because the planned
   `UNIQUE (mode, reference)` would make it *detectable after the fact*, not
   prevented.
3. **SMS mode is non-functional** — inert parser (`MPESA_SMS_PARSER_READY =
   false`) and no cashier UI; `listUnmatchedMpesaPayments` is a bridge method
   with no caller. Not fixed here; it is its own phase.
4. **`mpesa_transactions.amount` is INTEGER** while cart totals and SMS amounts
   are REAL. Left alone; the planned table uses REAL.
5. **Mode changes require a restart** — provider and both capability flags are
   resolved once at boot. Left alone.
6. **Working tree is not clean** (§1) — 19 modified, 21 untracked, overlapping
   this change's path. Recommend committing before Phase 3.
7. **Git history carries no signal for this area** — phases 100–103 were never
   committed as discrete changes, so `git log` explains nothing and
   `docs/phase-*.md` is the de-facto change log.

---

## STOP — three things need a decision before Phase 3

1. **§1, "the honest statement"** — manual mode is, narrowly, a third gate
   outcome that phase-102's rule as written does not admit. The design keeps
   its *purpose* intact but not its letter. Confirm that reading.
2. **D3** — manual as a **fallback flag** rather than a third exclusive mode.
   A departure from the brief's framing.
3. **§1, repo state** — commit the stock-take work first, so rollback stays clean.
