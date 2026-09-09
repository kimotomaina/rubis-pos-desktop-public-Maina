# Phase 102 — Closing the M-Pesa no-verification hole

Closes the money hole the phase-100 audit named as §0. Independent of the
SMS work: it needs no modem and no real samples, and it protects every till
running today.

**The rule this enforces:** no M-Pesa sale reaches the ledger without a real
confirmation, by any route. Payment inverts the fiscal rule the rest of this
codebase follows. An unfiled sale is recoverable, so fiscalization never
blocks the till; goods handed over for a payment that never arrived are not,
so **every ambiguous case here stops the sale**.

---

## 1. What the hole actually was

The phase-100 audit described it as "a cashier types any string into the
M-Pesa reference field and the sale completes". **That was wrong, and the
read-only audit for this phase proved it wrong.** The reference field is
rendered only for `card` ([CheckoutModal.tsx:222-243](../src/renderer/src/components/CheckoutModal.tsx#L222-L243)),
its Complete Sale button only for cash and card ([:282-291](../src/renderer/src/components/CheckoutModal.tsx#L282-L291)),
and `PosCheckoutPanel` has no reference field at all. That route was
**latent**, not live.

The live hole was worse, and it was a disease this project had already cured
once:

```ts
const rawMockMpesa = (process.env.VITE_USE_MOCK_MPESA || 'true').trim().toLowerCase()
```

**M-Pesa defaulted to the mock.** The line directly below it defaulted eTIMS
to real, deliberately, in phase-89/92 — so that a till installed without a
`.env` could not silently mock. M-Pesa never got that treatment. And
`MockMpesaProvider.verifyTransactionCode` approves any code except the
literal string `'INVALID'`, minus a 10% random failure.

So on a till installed with no `.env`: **open M-Pesa, tap Manual Code, type
anything, and the sale completes about nine times in ten.** That is the
payment-side twin of the `KRA-MOCK-` fake-receipt breach, same root cause
(the mock ships and is the default), same class of consequence.

Underneath it, two more gaps:

- **Daraja tills verified nothing in the main process.** `checkout.ts:202`
  gated on `mockMpesaEnabled &&`, so with the real provider selected the
  reference was never checked at all — and `checkoutRequestSchema` accepts
  any `referenceNumber` string over IPC.
- **`canCompleteSale` treated a non-blank string as sufficient** for M-Pesa:
  a loaded gun waiting for any future screen to render a reference field.

---

## 2. What was changed

| # | Change | File |
|---|---|---|
| 1 | capability flag replaces the mock-mode gate | `checkout.ts` |
| 2 | mock split out, packaged build refuses it, build guard extended | `mock-mpesa-provider.ts`, `mpesa-provider-factory.ts`, `verify-no-mock-provider.cjs` |
| 3 | real main-side confirmation for Daraja tills | `database.ts`, `checkout.ts` |
| 4 | `canCompleteSale` never enables M-Pesa | `checkoutMath.ts` |
| 5 | Manual Code tab hidden where it cannot work | `PaymentModal.tsx`, new capabilities IPC |

### 2.1 A capability, not a mode

`RunCheckoutDeps.mockMpesaEnabled` is now `verifyReferenceNumbers`, supplied
by `resolveMpesaProvider` and never derived at the call site. Reading it as
"is this the mock" is precisely what let an unverified sale through.

| Provider | `verifyReferenceNumbers` | How payment is proven |
|---|---|---|
| SMS (next phase) | `true` | a matched confirmation message |
| Mock (dev only) | `true` | it fabricates, which is why it may not ship |
| Daraja | `false` | this till's own record of Daraja's STK responses |
| Not configured | `true` | nothing — it refuses, and says so plainly |

### 2.2 The gate

```ts
if (input.paymentMethod === 'mpesa') {
  const reference = input.referenceNumber?.trim() ?? ''
  if (!reference) return { success: false, error: UNCONFIRMED_MPESA_MESSAGE }

  if (verifyReferenceNumbers) {
    // the provider settles it
  } else if (!db.hasConfirmedStkPayment(reference)) {
    return { success: false, error: UNCONFIRMED_MPESA_MESSAGE }
  }
}
```

Note what moved: the old gate ran **only if a reference was present**, so an
M-Pesa sale with no reference at all sailed through. Now the absence of a
reference is itself a refusal.

### 2.3 Daraja proves payment from records main wrote itself

Daraja has no receipt-lookup endpoint, so a reference cannot be checked
against Safaricom at checkout time. But it can be checked against what this
process already wrote down: `mpesa:query-status` persists `status` and
`mpesa_receipt_number` straight from Daraja's own status response
([main/index.ts:959-978](../src/main/index.ts#L959-L978)).

`hasConfirmedStkPayment(reference)` matches against exactly that. It is a
real confirmation, sourced from Safaricom, rather than trust in a string the
renderer sent — which honours this codebase's own principle that the main
process must not trust a value because a screen validated it.

It accepts the `checkout_request_id` as well as the receipt number, because
`PaymentModal` falls back to the request id when a successful status query
carries no receipt ([PaymentModal.tsx:139](../src/renderer/src/components/PaymentModal.tsx#L139)).
Missing that would have failed every Daraja sale where Daraja returned no
receipt number.

### 2.4 The mock cannot reach a real till

Three independent barriers, mirroring `resolveFiscalizationProvider`:

1. **The default flipped** to `'false'`. A till with no `.env` gets the real
   integration.
2. **`resolveMpesaProvider` refuses the mock when `app.isPackaged`**, whatever
   the config says, and logs why.
3. **The build fails** if `MockMpesaProvider` reaches `out/main`.

Barrier 3 is the one that does not depend on anyone remembering, so it was
tested for real rather than assumed — see §4.

`MockMpesaProvider` was moved out of `mpesa.ts` into its own file for the
same reason `MockFiscalizationProvider` left `etims.ts` in phase-90: a module
every caller imports cannot also hold a class that must never ship. `mpesa.ts`
is now the contract and nothing else.

### 2.5 An unconfigured till refuses instead of crashing

`DarajaMpesaProvider` throws when credentials are missing. Flipping the
default to real would therefore have crashed every till without Daraja
credentials at start-up, including every developer's.

So the factory checks first and substitutes `UnconfiguredMpesaProvider`,
which refuses all three calls with:

> M-Pesa has not been set up on this till yet. Take payment another way, or
> ask an administrator to finish the setup.

The till still opens and still takes cash. It confirms nothing, so no M-Pesa
sale can complete against it — the correct answer for a till that cannot
check whether a payment happened. Same shape as phase-92's not-configured
fiscal backstop.

This also removed an unchecked cast: `config:test-mpesa` did
`(mpesaProvider as DarajaMpesaProvider).testCredentials()`, which would now
call a method that is not there. It branches on what was actually built.

### 2.6 No open door beside the gate

`canCompleteSale` returns `false` for `mpesa` unconditionally. A typed string
is not evidence that anyone paid. Cash and card are untouched: card is the
cashier's record of a payment the terminal already took, so there is nothing
for this till to confirm.

And the Manual Code tab is hidden unless the till can actually verify a code.
A new `integrations:mpesa-capabilities` IPC reports `manualCodeSupported`.
On a Daraja till the tab could only ever dead-end on the stub's error, and a
route that looks like a way to complete a sale but is not is exactly what
sends a cashier hunting for a way around the gate. It **fails closed**: the
state starts `false`, so a lost reply hides the tab rather than offering one
that does not work.

---

## 3. Every route, and how each is now gated

| Route | Before | After |
|---|---|---|
| STK Push → poller `onSuccess` → `onPaid` | real on Daraja, fabricated on mock | **unchanged on Daraja**, and re-checked in main against the STK record. Mock cannot ship |
| Manual Code tab | **fabricated on mock (the live hole)**; dead end on Daraja | hidden unless the provider can verify; verified for real by the SMS provider |
| Reference field + Complete Sale | not rendered for M-Pesa, but `canCompleteSale` allowed it | `canCompleteSale` refuses M-Pesa outright |
| `orders:checkout` IPC directly | **no verification on a Daraja till** | blocked unless a confirmation exists in main's own records |
| No reference at all | gate skipped entirely | refused |

---

## 4. Proof

### The build guard fails, it does not warn

Asserted by running it, not by reading it. `MockMpesaProvider` was appended
to the built bundle and the guard run:

```
✖ A mock provider reached the production bundle:
    out\main\index.js contains "MockMpesaProvider"

  A shipped mock can print a fiscal receipt for a sale that was never filed,
  or confirm an M-Pesa payment that never happened.

EXIT CODE: 1
```

The bundle was then restored and re-verified clean (exit 0). A real
`npm run build` passes the guard: `✓ Confirmed: neither mock provider is in
out/main.`

### Daraja is provably unchanged

The regression that matters most, because the danger in "verify everything"
is making every real Daraja sale fail:

- **A Daraja STK sale completes end to end** — an STK push logged and
  confirmed exactly as the IPC handlers do it, then checkout, then an order
  in the ledger. Tested for both a receipt number and the request-id
  fallback.
- **The Daraja provider is never asked to verify a code**, so its stub can
  never turn a good sale into a failure.
- A push logged but **never confirmed** is blocked; one Daraja reported
  **failed** is blocked.
- `resolveMpesaProvider` constructs `DarajaMpesaProvider` with the same
  options as the ternary it replaced.

### Cash and card

Both complete exactly as before, asserted directly. A card sale completes on
its reference with `verifyReferenceNumbers: true` set, proving the gate does
not reach it.

### Tests

```
tests/mpesaPaymentGate.test.ts       19   the gate, per route
tests/mpesaProviderFactory.test.ts    7   provider selection and the mock fence
tests/runCheckout.test.ts            (updated)
tests/checkout.test.ts               (updated)
```

Two existing tests asserted the old unsafe behaviour and were rewritten, with
a comment saying so rather than being quietly deleted:

- `runCheckout`'s *"the M-Pesa manual code check is skipped (and checkout
  proceeds) when mockMpesaEnabled is false"* — that sentence **was** the
  loophole. It now asserts the sale is blocked.
- `canCompleteSale`'s *"mpesa: enabled once a reference number is entered"*
  now asserts the opposite, for three different reference shapes.

```
npx vitest run     81 files, 1209 tests, 0 failures   (was 79 / 1182)
npm run typecheck  node + web, exit 0
npm run build      guard passes
```

---

## 5. The gate blocks on every ambiguous case

| Case | Outcome |
|---|---|
| no reference | **blocked** |
| whitespace-only reference | **blocked** |
| typed reference, provider cannot verify | **blocked** |
| provider says not verified | **blocked**, with the provider's reason |
| provider could not be reached | **blocked** — an unanswered question is not a yes |
| STK push logged but pending | **blocked** |
| STK push failed | **blocked** |
| M-Pesa not configured | **blocked**, told plainly |
| reply from the capabilities IPC lost | tab hidden, so no dead-end route |

The cashier is never left with a disabled button and no reason. Every refusal
carries one sentence saying what is wrong and what to do:

> This M-Pesa payment has not been confirmed yet. Wait for the payment to
> come through, then complete the sale.

---

## 6. Residual gap, named not fixed

**A confirmed STK payment can be cited by more than one sale.**
`mpesa_transactions` has an `order_local_id` column that nothing sets, so
there is no "already spent" mark on a Daraja confirmation. Two sales quoting
the same receipt number would both pass `hasConfirmedStkPayment`.

This is a different and smaller hole than the one closed here — it requires
deliberate reuse of a genuine confirmation, not the invention of a fake one —
and closing it means marking a transaction consumed, which touches the Daraja
path. Flagged rather than folded in silently.

The SMS method does not share this gap: `mpesa_sms_messages` carries
`matched_order_local_id`, and phase-101 already excludes matched messages
from the list a cashier picks from.

---

## 7. Note for the record

The phase-100 audit asserted a code fact that was not true, and the read-only
audit for this phase caught it — the second time in this project that
pattern has held. The hole that was actually there was worse than the one
described, and was the same failure mode already fixed once for
fiscalization. Both the correction and the original claim are left visible
above rather than tidied away.

Stopping here for review, per the brief.
