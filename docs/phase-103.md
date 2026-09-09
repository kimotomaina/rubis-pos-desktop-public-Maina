# Phase 103 — Part 4: the SMS M-Pesa provider, factory, and config

Wires the message-based confirmation method into the payment provider
selection, so a till can be configured to use it alongside Daraja and the
development mock.

**What this is not.** The parser is still the stand-in (Part 2/3, gated on real
sample messages). No message can be recognised yet, so no payment can be
confirmed on a message-based till, so no such sale can complete. Part 4 done
well means **safe and wired**, not working. The bar for working is a real
message on the real SIM appearing in the list and approving.

Both open items the audit raised were closed here rather than deferred:
a verified payment can no longer be spent twice (§3), and the inert parser is
visible to the cashier rather than only to a log file (§4).

---

## 1. The provider

`src/main/services/integrations/sms-mpesa-provider.ts`, implementing
`MpesaProvider` as **Daraja's mirror image**: Daraja can prompt for a payment
but cannot look a receipt up; this can look a receipt up but cannot prompt.
`initiateStkPush` and `queryStkPushStatus` refuse with a clear result rather
than throwing, exactly as `DarajaMpesaProvider.verifyTransactionCode` refuses.

`verifyTransactionCode` confirms only when **all three** hold:

| Check | Refusal, and why it is worded that way |
|---|---|
| the code is stored | *"That payment has not come through yet."* Not "wrong code" — the usual cause is a message still in flight, and calling it wrong sends the cashier to re-type one that was right |
| it is unspent | *"That payment was already used for another sale."* |
| the amount matches **exactly** | *"That payment is for a different amount."* Under and over alike |

Every ambiguous answer is a refusal with a reason. There is no maybe and no
override anywhere in the path.

### The exact-amount gate is enforced at verify time

No contract change was needed: `ManualCodeVerification` already carries
`amount`, and phase-102's gate already passes the cart total. The brief flagged
this as possibly missing; it was not.

**Amounts are compared as whole cents**, not as floats:

```ts
Math.round(left * 100) === Math.round(right * 100)
```

A naive `===` fails in the expensive direction — a payment of exactly the right
amount comparing unequal through nothing but binary representation, and a
customer who really did pay being turned away. There is a test for
`0.1 + 0.2` against `0.3`.

---

## 2. The list flow, kept out of the shared contract

`MpesaSmsInboxReader` is a separate one-method interface
(`listRecentUnmatched`), implemented only by the SMS provider. Listing received
messages is meaningless for Daraja and the mock, and widening `MpesaProvider`
with a method two of three implementations must stub is the wrong trade
(audit §1.3).

It is reached by its own `mpesa-sms:list-unmatched` IPC, which returns the
payments **and the reader's health sentence together**. An empty list is
otherwise ambiguous: "nobody has paid yet" and "nothing is being read at all"
look identical, and only one of them means wait.

`toUnmatchedPayments` reduces each row to what a till screen needs — code,
amount, payer label, time. The raw message text and its source file stay in the
database rather than travelling over IPC to be displayed nowhere.

Part 6 builds the UI on this.

---

## 3. A verified payment can no longer be spent twice

The audit found the "already used for another sale" branch would be
**unreachable in production**: nothing set `matched_order_local_id`, because
marking needs the order's id, which does not exist until after `queueOrder`.

That is not a fraud-requires-effort gap. The SMS flow **is** a cashier picking
from a list, so a payment that stays on the list after paying for a sale gets
picked again for the next one. Ordinary use, double credit. Shipping the
provider without it would also have meant shipping an untested safety path.

### The ordering, which is the whole fix

`queueOrderClaimingSmsPayment` queues the order and claims the payment **in one
transaction**:

```ts
const run = this.conn.transaction(() => {
  const queued = this.queueOrder(input)
  const info = claimStatement.run(/* ... */)
  if (info.changes === 0) throw new SmsPaymentAlreadyClaimedError()  // rolls the order back
  return queued
})
```

Splitting them fails expensively in either direction:

- **queue then claim** — a failure in between leaves a completed sale whose
  payment still reads as available, free for the next cashier to spend again.
- **claim then queue** — a failure in between consumes a real payment for a
  sale that never existed.

One transaction makes both true or neither. The rollback is asserted, not
assumed: on a refused claim, the order count is unchanged **and** so is the
sync-queue count, so nothing is left half-written.

**The claim is the gate, not bookkeeping after one.** `verifyTransactionCode`
ran before an `await`, and two checkouts can interleave there. The conditional
`UPDATE` is what actually settles who gets the payment:

```sql
WHERE transaction_code = ? COLLATE NOCASE
  AND (matched_order_local_id IS NULL OR matched_order_local_id = ?)
```

**Idempotent** by that second clause: re-running for the same sale re-claims
cleanly, so a retry can neither double-mark nor un-mark. A claim for a
*different* sale fails.

### Which tills claim

A second capability, `claimsStoredPayments`, set by the factory — `true` only
for SMS. It answers a different question from `verifyReferenceNumbers`: that one
is "did this payment happen", this one is "does using it consume it". Conflating
them would either leave a real payment re-spendable or try to consume a Daraja
STK record that has no such notion. There is a test that a till with
`claimsStoredPayments: false` marks nothing.

---

## 4. The inert parser is visible to the cashier

`parseMpesaPaymentSms` exists and returns `null` for everything, beside
`MPESA_SMS_PARSER_READY = false`. Both are heavily documented as the Part 2/3
injection point: finishing the parser is a change to that function's body and
that constant, with no rewiring.

Returning `null` is the safe direction — no message reaches the table, so no
sale completes on a message-based till.

**But safe is not the same as visible.** A startup warning is invisible to the
person at the counter, and the symptom they would otherwise see is an empty
payment list and a conclusion that the modem is broken. So `parserReady` joins
phase-101's health status, and `describeInboxHealth` reports it:

> M-Pesa payments by message are not ready on this till yet, so a payment cannot
> be confirmed here. Take payment another way.

It is checked **before** the quiet state deliberately: with no working parser it
makes no difference whether messages are arriving, and "nothing has come in for
a while" would send someone to check a modem that is fine. There is a test for
exactly that ordering.

The startup warning is there too, for whoever reads logs.

---

## 5. Config, and the wipe it prevents

`confirmationMethod` (`'daraja' | 'sms'`, defaulting to `'daraja'`) and
`smsInboxPath` on the existing `mpesa` integrations row. No new provider name,
no new table, no vault — a folder path is not a credential.

`mpesaIntegrationConfigSchema` is applied by `integrations:set-config` exactly
as `etimsIntegrationConfigSchema` already is, so the main process does not trust
a renderer-sent path. `smsInboxPath` is required when, and only when, the method
is `sms`: otherwise a till selects a method it cannot perform, and the symptom is
payments that never appear.

**The wipe hazard.** `setIntegrationConfig` replaces the whole row. The Admin
screen was saving four Daraja fields, so with these two stored beside them, an
admin updating Daraja credentials would have **silently switched a message-based
till back to Daraja and erased its folder** — a payment-method change nobody
asked for, discovered only when payments stopped confirming.

So the thin Admin UI is not polish here, it is the fix: the method selector and
the folder field are loaded on mount and sent on every save, so neither can be
clobbered. The reverse is safe too — the Daraja fields keep their own state and
are always sent, so switching a till to messages and back does not lose
credentials.

Both controls are in plain language: *"How payments are confirmed"* with
*"Send a payment request to the customer"* / *"Read the payment message on this
till"*, and *"Where payment messages arrive"*. No provider names, no jargon.

---

## 6. The reader's lifecycle

`createMpesaSmsInbox` is constructed **only** when the method is `sms`, pointed
at the configured folder, and started beside the other long-running services. A
Daraja or mock till gets `null` and spins no folder poller — a timer doing
nothing every three seconds forever.

`mpesa-sms:list-unmatched` checks the same thing and refuses on a till that does
not confirm payments this way.

---

## 7. Daraja is unchanged

Asserted, not assumed:

- With `confirmationMethod: 'daraja'`, the factory returns
  `DarajaMpesaProvider` with `verifyReferenceNumbers: false` and
  `claimsStoredPayments: false`.
- With **no method configured at all**, the same — a till that has never been
  told otherwise keeps the behaviour it had.
- Phase-102's whole gate suite still passes untouched, including the
  end-to-end STK regression.
- The `isPackaged` mock fence still outranks everything: a packaged build never
  fabricates a confirmation, whatever method is configured.
- `npm run build` passes the guard: *"neither mock provider is in out/main."*

---

## 8. Tests

```
tests/smsMpesaProvider.test.ts   20   the provider: exact amount, every refusal, receive-only
tests/mpesaSmsClaim.test.ts       8   the atomic claim: rollback, idempotence, isolation
tests/mpesaPaymentGate.test.ts   24   the sale path, now including the claim (was 19)
tests/mpesaProviderFactory.test.ts 14 selection, the mock fence, the Daraja regression (was 7)
tests/ipcValidator.test.ts       94   the config schema (6 new)
tests/mpesaSmsInbox.test.ts      16   health, including not-ready ahead of quiet (was 14)
```

Worth calling out:

- **Exact amount** — under, over, one cent short, and the floating-point case
  that must *not* be refused.
- **Double-spend, end to end** — two checkouts against one payment: the first
  completes, the second is refused in plain words, and exactly one order
  exists.
- **Atomic rollback** — a refused claim leaves neither an order nor a
  sync-queue entry.
- **Amount enforced before anything is spent** — a mismatched sale is refused
  *and* the payment stays available for the sale it actually paid for.
- **Not-ready ahead of quiet**, so nobody is sent to check a working modem.

```
npx vitest run     83 files, 1257 tests, 0 failures   (was 81 / 1209)
npm run typecheck  node + web, exit 0
npm run build      mock guard passes
```

---

## 9. The gate blocks on every ambiguous verify

| Case | Outcome |
|---|---|
| code not stored | **blocked** — "has not come through yet" |
| amount differs, under or over | **blocked**, no override |
| payment already used by another sale | **blocked**, and no order written |
| claimed by another sale between check and claim | **blocked**, order rolled back |
| blank code | **blocked** |
| no message store to read | **blocked** — provider refuses everything |
| parser not ready (today) | **blocked** — nothing is ever stored to confirm against |
| folder missing or unreadable | **blocked**, and the cashier is told |

---

## 10. Still verify with a real modem and real samples

Unchanged from phase-101, and now the limiting factor:

| # | Item | Why it cannot be settled here |
|---|---|---|
| 1 | **The parser itself** | the format changed in March 2026; the one real sample shows a different field order from every published example, and a Till receipt differs again from a Paybill one |
| 2 | Multipart reassembly — one file or several | never observed on this hardware |
| 3 | Whether all parts share a timestamp and sender | the grouping assumption |
| 4 | The encoding gammu actually writes | depends on `InboxFormat` |
| 5 | **The notification SIM is the one in the modem** | physical; nothing arrives at all otherwise |
| 6 | A real payment appearing in the list and approving | the actual bar for "working" |

The single most valuable action remains one real M-Pesa payment to the SIM, with
the raw inbox files copied out untouched. That settles 2-4 and gives the parser
its ground truth.

---

## 11. Residual gap carried forward

Phase-102's Daraja gap is unchanged: a confirmed STK payment can be cited by
more than one sale, because `mpesa_transactions.order_local_id` is never set.
The SMS path no longer shares it — that is what §3 closed.

Closing the Daraja one would mean the same treatment: claim the STK record in
the same transaction as the order. It is smaller (it needs deliberate reuse of a
genuine confirmation, not an ordinary mistake) and it touches the Daraja path,
so it stays flagged rather than folded in here.

Stopping for review, per the brief.
