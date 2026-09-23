# Phase 120 — AUDIT: M-Pesa three-mode payment (Daraja · SMS · manual entry)

**Date:** 2026-09-23 · **Branch:** `staging` · **Previous:** [Phase 119](./phase-119.md)

Read-only. **Nothing was changed** — no source, test, fixture, schema or
config, and no request was sent to Daraja, the modem or any live till.
Everything below is a citation into the tree or into the phase docs.

The goal being audited: make M-Pesa a payment method with **three selectable
modes per till** — Daraja STK push (built), SMS/Gammu (built, parked), and
**manual code entry (new)** — with all three recorded in one unified,
auditable transaction record.

The rule this feature lives or dies by, inherited from
[phase-102](./phase-102.md):

> **No M-Pesa sale reaches the ledger without a real confirmation, by any
> route.** Payment inverts the fiscal rule the rest of this codebase follows.
> An unfiled sale is recoverable; goods handed over for a payment that never
> arrived are not — so **every ambiguous case stops the sale**.

## Verdict, up front

> **The reframe is right — this is not three builds — but the ground is
> further from "two built, one new" than it looks.**
>
> Daraja is genuinely built and live. **SMS is wired but cannot confirm
> anything and has no cashier UI**: `MPESA_SMS_PARSER_READY === false`, and
> `listUnmatchedMpesaPayments` — the bridge method Part 5/6 was meant to
> consume — **has no caller in the renderer at all**. A till set to SMS mode
> today takes no M-Pesa payments.
>
> **The manual path already physically exists.** `PaymentModal` has a Manual
> Code tab; phase-102 hid it behind `manualCodeSupported`, which *is* the
> `verifyReferenceNumbers` capability. So "manual" today means *"type a code
> and the provider verifies it against something real"*. **The new mode is not
> a new tab — it is a new trust level behind a tab that already exists**, and
> that is precisely the distinction phase-102 was built to defend.
>
> **The unified record must be a new table.** The two existing tables are not
> two halves of one thing, and **neither is reliably linked to its sale**:
> `mpesa_transactions.order_local_id` is `NULL` on every row ever written (§3).
>
> **One recommendation against the brief's framing** (§7.3): manual should be a
> *fallback flag available alongside* a confirming mode, not a third exclusive
> mode. Made exclusive, it becomes the mode that always works — and
> configuration becomes the way back into phase-102's hole.

---

# PART 1 — Repo state and prior art

| | |
| --- | --- |
| Branch | `staging` |
| Tree | **not clean** — 40 entries (19 modified, 21 untracked) |
| Base commit | `d7b11ba feat: added gitignore` |

The working tree carries the entire uncommitted stock-take feature
(phases [117](./phase-117.md)–[119](./phase-119.md)) plus earlier uncommitted
fiscal/Tremol work (109–116): **+1692 / −150**.

**This is a finding, not an aside.** The uncommitted files overlap this
change's path almost exactly — `database.ts`, `index.ts`, `ipcValidator.ts`,
`preload/*` and `AdminScreen.tsx` are all already modified and all on the
M-Pesa path. A revert of either piece of work becomes a manual
disentanglement, and `git checkout` stops being a safety net.

**Recommendation: commit the stock-take work before implementing.** It is
reviewed, typechecked and green. Cheap now, expensive later.

**Prior art carries no signal here.** `git log -n 6` over `checkout.ts`,
`mpesa-provider-factory.ts` and `integrations/` returns only broad commits
(`feat: fiscalization v1 done`, `update`, `feat: created POS`). The phases
100–103 that built and reasoned about this code were never committed as
discrete changes — **`docs/phase-*.md` is the de-facto change log**, and was
read instead.

---

# PART 2 — The provider seam

## 2.1 `MpesaProvider` — the contract

[`integrations/mpesa.ts`](../src/main/services/integrations/mpesa.ts) is the
contract and nothing else; the mock was evicted from it in phase-102. Three
methods, and every backend implements all three — a method a backend cannot
perform returns a **clear refusal**, never a thrown error.

| Method | Daraja | SMS | Unconfigured |
| --- | --- | --- | --- |
| `initiateStkPush` | ✅ real | ❌ receive-only | ❌ refuses |
| `verifyTransactionCode` | ❌ no receipt-lookup endpoint | ✅ against stored messages | ❌ refuses |
| `queryStkPushStatus` | ✅ real | ❌ receive-only | ❌ refuses |

`SmsMpesaProvider` also implements a **second, deliberately separate**
interface, `MpesaSmsInboxReader` (`listRecentUnmatched`), with an explicit
comment on why it is *not* on `MpesaProvider`
([sms-mpesa-provider.ts:48-59](../src/main/services/integrations/sms-mpesa-provider.ts#L48-L59)):
listing received messages is meaningless for Daraja and the mock, and widening
the shared contract with a method two of three implementations would stub is
the wrong trade.

**That precedent governs this change.** Manual mode needs **no new method on
`MpesaProvider`** — it needs a capability flag and a recording path.

## 2.2 `resolveMpesaProvider` — the factory

[`mpesa-provider-factory.ts`](../src/main/services/mpesa-provider-factory.ts),
one function, fully tested (`mpesaProviderFactory.test.ts`, 269 lines).
Resolution order: mock (dev-only, triple-barriered) → `'sms'` →
Daraja-configured → `UnconfiguredMpesaProvider`.

It returns **two capability flags whose distinction is load-bearing**:

```ts
verifyReferenceNumbers  // can the provider settle whether this payment happened?
claimsStoredPayments    // does using this confirmation consume it?
```

| Provider | `verifyReferenceNumbers` | `claimsStoredPayments` |
| --- | --- | --- |
| Daraja | `false` | `false` |
| SMS | `true` | `true` |
| Mock (dev only) | `true` | `false` |
| Unconfigured | `true` — so its own refusal is what the cashier reads | `false` |

`MpesaConfirmationMethod = 'daraja' | 'sms'`
([:39](../src/main/services/mpesa-provider-factory.ts#L39)) is the type a third
mode would extend.

## 2.3 How the mode is configured

Per-till, in the `integrations` table's `mpesa` row (plaintext; the consumer
secret and passkey live in the OS vault). Resolved **once at boot**
([index.ts:606-607](../src/main/index.ts#L606-L607)):

```ts
const mpesaConfirmationMethod: MpesaConfirmationMethod =
  mpesaConfig.confirmationMethod === 'sms' ? 'sms' : 'daraja'
```

Defaults to Daraja, so a till never told otherwise keeps what it had.
Validated by `mpesaIntegrationConfigSchema`
([ipcValidator.ts:389-405](../src/main/lib/ipcValidator.ts#L389-L405)), which
carries a `.refine` making `smsInboxPath` mandatory when the method is `'sms'`
— **the precedent for "a mode may demand its own extra config"**. Edited from
Admin > Integrations behind `requireAdminPin`.

**Boot-time resolution is a design constraint:** the provider and both flags
are captured at start-up, so a mode change requires a restart today.

## 2.4 String-based references that a symbol search misses

Extending the mode union touches more than the type:

- The literal values `'daraja'` / `'sms'` appear in the type, the zod enum, the
  factory branch, the boot coercion, **and as raw strings in
  `AdminScreen.tsx:218` and `:467`** — five places, only three of which a
  rename would catch.
- IPC channel names: `orders:checkout`, `mpesa:stk-push`, `mpesa:query-status`,
  `mpesa:log-transaction`, `integrations:mpesa-capabilities`,
  `integrations:set-config`.
- `PaymentTab` union `'stk' | 'manual'` in `PaymentModal`.
- Column names in hand-written SQL across eight `database.ts` sites.
- `scripts/verify-no-mock-provider.cjs` greps the build output for
  `MockMpesaProvider` **by name**.

---

# PART 3 — What each mode records today

## 3.1 `mpesa_transactions` — Daraja's STK attempts

[database.ts:373-385](../src/main/services/database.ts#L373-L385): `id`,
`order_local_id`, `checkout_request_id` (NOT NULL), `merchant_request_id`
(NOT NULL), `phone_number` (NOT NULL), `amount` (**INTEGER**), `status`
(`pending|success|failed`), `mpesa_receipt_number`, `created_at`, `updated_at`.

| Touchpoint | What |
| --- | --- |
| `logMpesaTransaction` ([:1755](../src/main/services/database.ts#L1755)) | INSERT — called **only from the renderer**: `PaymentModal.tsx:140` (failed attempt), `:203` (accepted push) |
| `updateMpesaTransactionStatus` ([:1963](../src/main/services/database.ts#L1963)) | UPDATE from a Daraja status query |
| `listMpesaTransactions` ([:1856](../src/main/services/database.ts#L1856)) | read — the M-Pesa Logs screen |
| `hasConfirmedStkPayment` ([:1939](../src/main/services/database.ts#L1939)) | **the Daraja payment gate** |

## 3.2 `mpesa_sms_messages` — messages received

[database.ts:401-417](../src/main/services/database.ts#L401-L417):
`transaction_code` (**NOT NULL UNIQUE** — the dedup key, and the table's whole
point), `amount` (**REAL**), `payer_name`, `payer_alias`, `masked_phone`,
`account_reference`, `occurred_at`, `source_file`, `raw_text` (verbatim),
`matched_order_local_id`, `approved_by_staff_id`, `approved_at`, `created_at`.

Written by the inbox reader; spent by `queueOrderClaimingSmsPayment`
([:1886](../src/main/services/database.ts#L1886)).

## 3.3 🚩 Three gaps

| | Daraja | SMS | Manual (proposed) |
| --- | --- | --- | --- |
| Records the *attempt* | ✅ | n/a | — |
| Records the *payment* | ✅ `status='success'` + receipt | ✅ the message | — |
| **Linked to the sale** | ❌ **never** | ✅ `matched_order_local_id` | — |
| **Who did it** | ❌ nothing | ✅ `approved_by_staff_id` | — |
| Amount type | INTEGER | REAL | — |
| Verification status | implicit in `status` | implicit in "a row exists" | must be **explicit** |

**Gap 1 — Daraja payments are never linked to their sale.**
`LogMpesaTransactionInput.orderLocalId` is optional and, across the whole tree,
**is never supplied**: both call sites are in `PaymentModal`, and both fire
*before* the order exists. `order_local_id` is `NULL` on every row ever
written. Today's audit trail cannot answer *"which sale did this pay for?"*.

**Gap 2 — Daraja records no staff identity.** No column equivalent to SMS's
`approved_by_staff_id`.

**Gap 3 — verification status is implicit, and differently per mode.** For
Daraja it is `status='success'`; for SMS it is "a row exists and the amount
matched". **Neither can express "completed, explicitly unverified"** — which is
exactly what manual mode must record.

## 3.4 The unified record must be a **new table**

Extending `mpesa_transactions` fails on all three of its NOT NULL columns
(`checkout_request_id`, `merchant_request_id`, `phone_number`) — a manual or
SMS payment has none of them, so every one would need loosening, **weakening
the constraints that protect the Daraja path**. Extending `mpesa_sms_messages`
fails on `transaction_code UNIQUE`, the dedup key that stops one message being
spent twice.

The two tables are **not two halves of one thing**. One is *an STK attempt this
till made*; the other is *a message this till received*. Neither is *a payment
that settled a sale* — the record actually wanted, and one that exists for no
mode today.

---

# PART 4 — The sale path

`runCheckout` ([checkout.ts:217](../src/main/services/checkout.ts#L217)),
reached via `orders:checkout` through `checkoutRequestSchema`.

1. `db.getStaffById(input.staffId)` — **staff resolved server-side**
   ([:244](../src/main/services/checkout.ts#L244)).
2. **The payment gate** ([:272-292](../src/main/services/checkout.ts#L272-L292)) — §5.
3. `queueOrder`, or `queueOrderClaimingSmsPayment` on an SMS till.
4. Shopify sync tick, then fiscalization (which never blocks).

**Where manual mode hooks:** the gate at step 2, and a recording write
alongside step 3.

**An ordering constraint that must be inherited.** On the SMS path the claim
and the order insert are deliberately **one transaction**, with a comment
stating why ([checkout.ts:311-328](../src/main/services/checkout.ts#L311-L328)):
queue-then-claim can leave a completed sale whose payment still reads as
available; claim-then-queue can consume a real payment for a sale that never
existed. A manual payment record has the same property and must be written the
same way.

The renderer reaches the gate only through `PaymentModal`'s `onPaid(reference)`
— never through the Complete Sale button, because `canCompleteSale` returns
`false` for `mpesa` unconditionally
([checkoutMath.ts:77-79](../src/renderer/src/lib/checkoutMath.ts#L77-L79)).

---

# PART 5 — 🚩 The phase-102 closure, cited exactly

[phase-102](./phase-102.md). The live hole was that M-Pesa **defaulted to the
mock**, and `MockMpesaProvider.verifyTransactionCode` approves any code except
the literal `'INVALID'`:

> On a till installed with no `.env`: **open M-Pesa, tap Manual Code, type
> anything, and the sale completes about nine times in ten.**

The guard that closed it, verbatim
([checkout.ts:272-292](../src/main/services/checkout.ts#L272-L292)):

```ts
if (input.paymentMethod === 'mpesa') {
  const reference = input.referenceNumber?.trim() ?? ''
  if (!reference) {
    return { success: false, error: UNCONFIRMED_MPESA_MESSAGE }
  }

  if (verifyReferenceNumbers) {
    const verification = await mpesaProvider.verifyTransactionCode({
      transactionCode: reference,
      amount: total
    })
    if (!verification.success) {
      return { success: false, error: verification.error ?? UNCONFIRMED_MPESA_MESSAGE }
    }
    if (!verification.data?.verified) {
      return { success: false, error: verification.data?.reason ?? UNCONFIRMED_MPESA_MESSAGE }
    }
  } else if (!db.hasConfirmedStkPayment(reference)) {
    return { success: false, error: UNCONFIRMED_MPESA_MESSAGE }
  }
}
```

Six defences were installed. **Manual mode touches five:**

| # | Guard | Where | Manual mode's relationship |
| --- | --- | --- | --- |
| 1 | the gate itself | [checkout.ts:272-292](../src/main/services/checkout.ts#L272-L292) | **add a branch, never a bypass** |
| 2 | `verifyReferenceNumbers` is a factory capability, never derived at the call site | [checkout.ts:140-151](../src/main/services/checkout.ts#L140-L151) | must stay **`false`** for manual — manual verifies nothing |
| 3 | `canCompleteSale` returns `false` for mpesa unconditionally | [checkoutMath.ts:77-79](../src/renderer/src/lib/checkoutMath.ts#L77-L79) | **must stay false** |
| 4 | Manual tab hidden unless `manualCodeSupported` | [PaymentModal.tsx:101-118](../src/renderer/src/components/PaymentModal.tsx#L101-L118), [index.ts:1036-1040](../src/main/index.ts#L1036-L1040) | the flag's meaning must change carefully |
| 5 | mock cannot ship — 3 barriers + a build grep | factory, `verify-no-mock-provider.cjs` | untouched |
| 6 | unconfigured till refuses and still takes cash | `UnconfiguredMpesaProvider` | untouched |

## The honest statement, and the central risk

This gate has exactly two outcomes today: **confirmed**, or **refused**. Manual
mode adds a third — *completed without confirmation* — and **there is no way to
add it that is not, in the narrow technical sense, a relaxation of phase-102's
rule as written.**

Claiming otherwise would itself be the failure mode.

What *can* be preserved completely is phase-102's **purpose**: that nobody is
ever misled about whether a payment was confirmed. Phase-102 closed a hole
where **the system silently claimed verification it did not have**. Manual mode
is a hole an operator opens deliberately, by name, and which the record
permanently describes as open.

Those are different things — **but only if the design makes them different**,
which is the entire content of §7.3 and §7.4.

---

# PART 6 — Controls to reuse

## 6.1 Manager PIN
`requireAdminPin(db, managerId, managerPin)`
([requireAdminPin.ts:43](../src/main/lib/requireAdminPin.ts#L43)) — re-verified
in the main process, requires `role === 'admin'`, returns one generic error.
13 call sites; payload shape `managerAuthzSchema`. Its own doc comment states
why it exists: `contextBridge` exposes `window.api` globally, so **a
renderer-side modal is not a gate**.

## 6.2 Staff identity
`runCheckout` resolves the cashier server-side from `input.staffId`
([checkout.ts:244](../src/main/services/checkout.ts#L244)); the SMS claim
records `approved_by_staff_id` from `staff.id`, never from the payload
([checkout.ts:331](../src/main/services/checkout.ts#L331)). Both apply
directly.

## 6.3 🚩 The SMS "cashier approves" UI — **does not exist**

The audit's most consequential correction to the brief.

| Piece | State |
| --- | --- |
| `SmsMpesaProvider.listRecentUnmatched()` + `toUnmatchedPayments()` | built |
| `listUnmatchedMpesaPayments` in the preload bridge | built |
| **A renderer that calls it** | **none** — grep over `src/renderer/` returns nothing |
| The SMS parser | **inert** — `MPESA_SMS_PARSER_READY = false` ([mpesaSms.ts:68](../src/main/lib/mpesaSms.ts#L68)) |

[Phase-103](./phase-103.md) says so plainly: *"Part 4 done well means **safe and
wired, not working**."*

So **manual entry is not a sibling of an existing approve flow — there is no
flow to be a sibling of.** Its UI is new work with no in-repo precedent, and
the only reference implementation for the "take a payment, attribute it to a
cashier, spend it once" shape is the *server-side* logic in
`queueOrderClaimingSmsPayment`.

A practical consequence that raises the stakes: **manual will be the only
M-Pesa mode that works on a till with no Daraja credentials, no modem and no
internet.**

## 6.4 Guard-rail precedents available

- `mpesaIntegrationConfigSchema`'s `.refine` — a mode demanding extra config.
- `confirm: z.literal(true)` on the stock-take commit — an action that cannot
  fire as a side effect.
- `transaction_code UNIQUE` — dedup in the database, not in memory a restart
  would empty.
- `amountsMatchExactly` compares whole cents, server-side
  ([sms-mpesa-provider.ts:96](../src/main/services/integrations/sms-mpesa-provider.ts#L96)).

## 6.5 Tests on the payment path

| File | Lines | Covers |
| --- | --- | --- |
| `mpesaPaymentGate.test.ts` | 475 | **the phase-102 gate** — the regression suite this change must not break |
| `runCheckout.test.ts` | 687 | the sale path end to end |
| `mpesaProviderFactory.test.ts` | 269 | provider selection + capability flags |
| `smsMpesaProvider.test.ts` | 318 | SMS verification refusals |
| `mpesaSmsClaim.test.ts` | 209 | the spend-once claim |
| `darajaMpesaProvider.test.ts` | 467 | Daraja transport |
| `mpesa.test.ts`, `mpesaSmsMessages.test.ts` | 281 | contract + storage |

Run: `npm test` (87 files / 1350 tests, currently green) and
`npm run typecheck`. Real-SQLite precedent for payment tests:
`mpesaSmsClaim.test.ts`, `reconciliation.test.ts`.

**Note:** `reconciliation.test.ts` is *shift cash* reconciliation. There is **no
M-Pesa statement-reconciliation view** in the app; `MpesaLogsPage` (170 lines)
is the nearest thing.

---

# PART 7 — Open decisions, resolved against the code

## 7.1 Manual trust model → **record-only-unverified. Feasible, with a caveat.**

Manual completes the sale, is recorded `manual_unverified`, and surfaces in a
reconciliation view for later confirmation against the M-Pesa statement. Every
mechanism needed already exists.

The caveat: the reconciliation view is **new UI with no precedent** (§6.3) and
must be scoped as real work, not a list someone adds later. *A record marked
"pending reconciliation" that no screen ever shows is not a control; it is a
silent `TRUE`.*

## 7.2 Unified record → **a new `mpesa_payments` table**

Per §3.4. Proposed shape:

| Column | Notes |
| --- | --- |
| `order_local_id` | **NOT NULL** — this table records payments that *settled sales*; an attempt is not a payment. Closes Gap 1 for all three modes. |
| `mode` | `daraja \| sms \| manual` |
| `verification_status` | `confirmed \| matched \| manual_unverified` — **set server-side from the actual outcome, never from the payload** |
| `reference` | receipt number / transaction code / typed code |
| `amount` | **REAL** — matches cart totals and `mpesa_sms_messages`; `mpesa_transactions.amount` being INTEGER is a Daraja artefact |
| `entered_by_staff_id` | NOT NULL, from server-side auth |
| `approved_by_staff_id` | nullable — the manager who authorised a manual entry |
| `reconciled_at`, `reconciled_by_staff_id`, `reconciliation_note` | nullable; the later-confirmation path |
| `source_transaction_id`, `source_sms_message_id` | nullable links to the mode-specific evidence |
| `UNIQUE (mode, reference)` | dedup, following `transaction_code`'s precedent |

Additive: both existing tables and every existing gate stay exactly as they
are. That matters on a payments path.

## 7.3 🚩 Mode selection → **per-till config, but manual is a fallback flag, not a third exclusive mode**

**This is a recommendation against the brief's framing, and the most
consequential judgement in this audit.**

Per-till config is right — it mirrors `confirmationMethod`, and a shop has one
way of taking M-Pesa, not a choice the cashier makes per customer. But making
manual a *third exclusive mode* has a predictable failure:

> Manual is the only mode that works with no Daraja credentials, no modem and
> no internet. It always succeeds. If it is selectable as *the till's mode*,
> the path of least resistance for any shop with a flaky setup is to set it
> and never change back — and **phase-102's hole reopens by configuration
> rather than by code**.

Recommended instead:

- `confirmationMethod` stays `'daraja' | 'sms'` — the *confirming* modes.
- A **separate** boolean `manualEntryEnabled`, default `false`, permits manual
  **alongside** whichever confirming mode is set.
- A manual payment is then always visible as an **exception** against a till
  that has a working confirming mode — which is what makes the reconciliation
  view meaningful. A till where *every* payment is manual has no signal in it
  at all.

If review prefers three exclusive modes, that is a legitimate call — but it
should be made knowingly, and the reconciliation view becomes the only
remaining control.

## 7.4 Manual guard rails → **all four, layered**

1. **Format validated server-side against an allowlist** — Safaricom codes are
   10 uppercase alphanumerics: `/^[A-Z0-9]{10}$/` in the zod schema **and**
   re-checked in main. Rejects blanks, `AAA`, `1`, keyboard mashing.
2. **Amount is the cart total by construction** — no editable amount field to
   mistype, as `PaymentModal` already does for STK.
3. **Manager PIN per manual payment**, via `requireAdminPin`. A cashier alone
   cannot complete an unverified M-Pesa sale. This is the control that keeps
   manual off the path of least resistance.
4. **Explicit unverified acknowledgement** — a `confirm: z.literal(true)`, with
   the UI saying in words that this records an **unverified** payment.
   Borrowed from the stock-take commit.

Plus, non-negotiably: **`verifyReferenceNumbers` stays `false` for manual.**
Routing manual through `verifyTransactionCode` would make a manual payment
indistinguishable from a verified one at the gate — the exact regression
phase-102 exists to prevent.

---

# PART 8 — Security-by-design requirements

Every one of these is a server-side control; none may be satisfied in the
renderer.

| Requirement | How |
| --- | --- |
| Manual code never trusted as-is | allowlist regex in the zod schema **and** re-checked in main (§7.4.1) |
| Manual never completes as "verified" | `verifyReferenceNumbers` stays `false`; the manual branch never calls `verifyTransactionCode` |
| `verification_status` set from the actual outcome | derived in `checkout.ts` from which gate branch ran — **never read from the payload**. A compromised renderer must not be able to mark a manual payment `confirmed`. |
| `entered_by` / `approved_by` from server-side auth | `staff.id` from `db.getStaffById`, and the `managerId` whose PIN `requireAdminPin` just verified — never payload fields |
| Amount matching enforced server-side | `amountsMatchExactly` (whole cents) where the mode supports it; the cart total by construction otherwise |
| Every transaction recorded with its true status | the new table's `verification_status`, NOT NULL — **the audit trail is the control** |

---

# PART 9 — Plan (Phase 2)

## Files that would change

| File | Change |
| --- | --- |
| [database.ts](../src/main/services/database.ts) | `SCHEMA.mpesaPayments` + index; row/input types; `recordMpesaPayment` (called **inside** the order transaction); `listMpesaPayments`, `listUnreconciledMpesaPayments`, `markMpesaPaymentReconciled`; `queueOrderRecordingManualPayment` mirroring `queueOrderClaimingSmsPayment` |
| [checkout.ts](../src/main/services/checkout.ts) | a third gate branch for manual; the Daraja and SMS branches stay **byte-identical** |
| [mpesa-provider-factory.ts](../src/main/services/mpesa-provider-factory.ts) | `manualEntryEnabled` in/out; **`verifyReferenceNumbers` unchanged for every mode** |
| [ipcValidator.ts](../src/main/lib/ipcValidator.ts) | `manualEntryEnabled` on the config schema; `manualMpesaPaymentSchema`; `reconcileMpesaPaymentSchema` |
| [index.ts](../src/main/index.ts) | extend `integrations:mpesa-capabilities`; new `mpesa:list-payments`, `mpesa:list-unreconciled`, `mpesa:reconcile` (PIN-gated) |
| [preload/index.ts](../src/preload/index.ts), [window.d.ts](../src/preload/window.d.ts) | bridge methods |
| [PaymentModal.tsx](../src/renderer/src/components/PaymentModal.tsx) | manual tab with **visibly different copy and styling** for the unverified path; manager PIN; explicit acknowledgement |
| [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) | `manualEntryEnabled` toggle with a plain-language warning; a Reconciliation tab |
| `pages/MpesaReconciliationPage.tsx` | **new** |

## Deliberately NOT changing

- `canCompleteSale` stays `false` for mpesa (phase-102 guard 3).
- `hasConfirmedStkPayment` and the Daraja gate branch — untouched.
- The SMS claim transaction — untouched.
- `mpesa_transactions` / `mpesa_sms_messages` — no column, index or constraint
  changes. The new table references them.
- The mock's three barriers and the build grep.
- `MpesaProvider` gains no method (§2.1's own reasoning).
- The SMS parser stays inert — making it work is its own phase.

## Verification

All 1350 existing tests green with **`mpesaPaymentGate.test.ts` unmodified** —
*if that file needs editing to pass, the change has regressed phase-102 and
must be reworked.* Plus a new `mpesaManualPayment.test.ts` (real in-memory
SQLite) proving:

- a manual sale records `manual_unverified`, never `confirmed`;
- a renderer-supplied `verification_status` is **ignored**;
- a renderer-supplied `enteredByStaffId` / `approvedByStaffId` is **ignored**;
- bad code formats refused — blank, `AAA`, lowercase, 9 and 11 characters;
- no manager PIN → refused, **no order written and no payment row**;
- `confirm` absent or false → refused;
- the order and the payment row are one transaction — neither exists without
  the other;
- manual disabled in config → the gate refuses exactly as it does today;
- a manual payment appears in the unreconciled list and leaves it only via the
  PIN-gated reconcile path.

And `mpesaPaymentsRecord.test.ts`: all three modes write one row each with the
right `mode` / `verification_status`, and `order_local_id` populated.

## Rollback

Additive by construction — a new table, a branch reached only when
`manualEntryEnabled` is on, new IPC channels, one new page.

- **Config-level, instant, no deploy:** turn `manualEntryEnabled` off. The gate
  reverts to exactly today's two branches.
- **Code-level:** revert the commit. The new table is left in place and ignored
  — `CREATE TABLE IF NOT EXISTS` means no migration to undo, and the recorded
  rows survive for audit.
- **Precondition:** the stock-take work must be committed first (Part 1), or
  neither rollback is clean.

---

# PART 10 — Observed but not changed

1. **`mpesa_transactions.order_local_id` is never populated** (§3.3, Gap 1).
   The new table fixes this going forward; historical rows are not backfilled.
2. **The Daraja double-spend residual.** `hasConfirmedStkPayment` is a
   read-only check with no claim, so one confirmed STK payment could settle two
   sales. **Out of scope, as instructed.** Noted because the proposed
   `UNIQUE (mode, reference)` would make it *detectable after the fact*, not
   prevented.
3. **SMS mode is non-functional** — inert parser, no cashier UI (§6.3). Its own
   phase.
4. **`mpesa_transactions.amount` is INTEGER** while cart totals and SMS amounts
   are REAL. Left alone; the new table uses REAL.
5. **Mode changes require a restart** — provider and both flags resolve once at
   boot (§2.3).
6. **The working tree is not clean** (Part 1) — 19 modified, 21 untracked,
   overlapping this change's path.
7. **Git history carries no signal for this area** — phases 100–103 were never
   committed discretely, so `docs/phase-*.md` is the de-facto change log.

---

## What was NOT changed

No source, test, fixture, config, schema or document other than this file. No
live M-Pesa call was made.

## STOP for review — three decisions needed

1. **§5, "the honest statement"** — manual mode is, narrowly, a third gate
   outcome that phase-102's rule as written does not admit. The design keeps
   its *purpose* intact but not its letter. Confirm that reading.
2. **§7.3** — manual as a **fallback flag** rather than a third exclusive mode.
   A deliberate departure from the brief's framing.
3. **Part 1** — commit the stock-take work first, so rollback stays clean.
