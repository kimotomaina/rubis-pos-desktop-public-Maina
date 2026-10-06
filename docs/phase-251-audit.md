# Phase 251 audit: the Daraja gate (read-only)

- **Date:** 2026-10-06
- **Asked by the owner:** the 21:10 rulings, §2. Phase 248 found that a Daraja STK confirmation can be used again on a later sale and that the gate checks no amount. Ruling D5 says fix both; audit first.
- **Status:** audit only. No code, test or data change. No call to Safaricom; nothing sent to the device or Shopify. The 1606 copy was read through a temp copy; its three files are unchanged (SHA-256 before and after: `a3def016…`, `ee714dc4…`, `9bef3d97…`).

## Summary

1. **Daraja has never confirmed a payment on the live till, and as configured it cannot.** The copy's M-Pesa setting is `daraja` (sandbox) with the manual fallback on. No consumer key is set in the till's settings or in the `.env` an installer from this repo carries, so the till runs the "not set up" provider. All 103 M-Pesa sales are manual entries. The 5 STK attempts on record are refusals, made before any request reached Safaricom. **The reuse and the missing amount check cannot happen on the live till today.** This phase protects the day Daraja is switched on.
2. **Safaricom's amount is not read anywhere in the till.** The status query the till uses reads `ResultCode`, `ResultDesc` and `MpesaReceiptNumber`, and no amount. The amount stored with an STK attempt is the one the screen sends.
3. **The Daraja documentation did not load.** Every page on developer.safaricom.co.ke came back as a script shell with no API content (details in Part 1 §4). Point 4 stops there, as instructed. G3 cannot use Safaricom's amount. The smallest honest alternative is proposed below and needs your ruling (D1).
4. **Two findings beyond G1 to G3, both in the Daraja gate:**
   - **F1:** the screen can write a "success" STK record itself, which the gate then accepts.
   - **F2:** a sale whose total has cents can never complete by Daraja, although the customer has been charged.

   Both are in D2 and D3.

## Part 1. How Daraja works in the till today

### 1. Which M-Pesa route the live till uses (the 1606 copy, read-only)

| Table | Count |
| --- | --- |
| `mpesa_payments` by mode | **manual 103** (all `manual_unverified`, 62,825.09); daraja 0; sms 0 |
| `mpesa_transactions` by status | **failed 5**; pending 0; success 0 |
| `mpesa_sms_messages` | 0 |
| Orders by method | mpesa 103, cash 74, card 3 |

**The till's M-Pesa setting** (the `integrations` row `mpesa`, secrets not printed):
- `confirmationMethod: daraja`, `environment: sandbox`, `manualEntryEnabled: true`;
- `consumerKey` empty, `shortcode` empty, no `callbackUrl`.

**Why Daraja cannot run there:**
- **Where the till reads its settings:** a packaged till loads only the `.env` beside the app ([index.ts:26-28](../src/main/index.ts#L26-L28)). The consumer key comes from the till's settings or that file ([index.ts:922](../src/main/index.ts#L922)).
- **What the repo's `.env` holds:** `MPESA_SHORTCODE` and `MPESA_ENVIRONMENT`, but no `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET` or `MPESA_PASSKEY`. These are names only; no value was printed.
- **The provider that results:** with no key, `isDarajaConfigured` is false ([mpesa-provider-factory.ts:105-109](../src/main/services/mpesa-provider-factory.ts#L105-L109)). The till therefore runs `UnconfiguredMpesaProvider` ([mpesa-provider-factory.ts:281-294](../src/main/services/mpesa-provider-factory.ts#L281-L294)), which refuses every push with "M-Pesa has not been set up on this till yet…".

**The 5 failed rows** (27 Sep, two; 2 Oct, three):
- each has a `failed-…` placeholder id and an empty merchant id;
- that is what the screen logs when a push is refused before Safaricom issues an id ([PaymentModal.tsx:239-251](../src/renderer/src/components/PaymentModal.tsx#L239-L251)).

The copy cannot say which refusal text the cashier saw.

**Not verified:**
- the `.env` inside the installed till (I read the repo's);
- the till's credential vault.

The consumer key is not a vault field, so the vault cannot make Daraja work on its own.

### 2. The STK flow

1. **The push.** The screen asks the main process to push through `integrations:mpesa-stk-push` ([index.ts:1574-1578](../src/main/index.ts#L1574-L1578)), with the phone and `amount: total` from the screen ([PaymentModal.tsx:297-302](../src/renderer/src/components/PaymentModal.tsx#L297-L302)). The handler passes the request straight to the provider with no schema. The provider posts to `/mpesa/stkpush/v1/processrequest` ([daraja-mpesa-provider.ts:35](../src/main/services/integrations/daraja-mpesa-provider.ts#L35), [185-201](../src/main/services/integrations/daraja-mpesa-provider.ts#L185-L201)), with `Amount: Math.round(request.amount)` ([192](../src/main/services/integrations/daraja-mpesa-provider.ts#L192)).
2. **The log.** On acceptance, the **screen** logs the attempt through `mpesa:log-transaction`: Safaricom's two ids, the phone, `amount: total` and `status: 'pending'` ([PaymentModal.tsx:304-310](../src/renderer/src/components/PaymentModal.tsx#L304-L310); handler [index.ts:1661-1677](../src/main/index.ts#L1661-L1677)).
3. **How success is learnt: a status query only.** The screen polls `mpesa:query-status` every 5 s for up to 90 s ([mpesaPaymentPoller.ts:15](../src/renderer/src/lib/mpesaPaymentPoller.ts#L15), [23](../src/renderer/src/lib/mpesaPaymentPoller.ts#L23), [97-110](../src/renderer/src/lib/mpesaPaymentPoller.ts#L97-L110)). The main process calls `/mpesa/stkpushquery/v1/query` ([daraja-mpesa-provider.ts:263-305](../src/main/services/integrations/daraja-mpesa-provider.ts#L263-L305)). On a final answer it writes the status and receipt number to the logged row ([index.ts:1711-1722](../src/main/index.ts#L1711-L1722), [database.ts:6166-6177](../src/main/services/database.ts#L6166-L6177)). The M-Pesa Logs screen (Reports) can run the same query by hand: "Check Status" ([MpesaLogsPage.tsx:74](../src/renderer/src/pages/MpesaLogsPage.tsx#L74), [172](../src/renderer/src/pages/MpesaLogsPage.tsx#L172)).
4. **Nobody receives a callback.** The till runs no HTTP server: no `createServer`, `listen(` or express in `src/main`. The `CallBackURL` sent is the till's setting, else `MPESA_CALLBACK_URL`, else the placeholder `https://example.com/callback` ([daraja-mpesa-provider.ts:73](../src/main/services/integrations/daraja-mpesa-provider.ts#L73), [160](../src/main/services/integrations/daraja-mpesa-provider.ts#L160); [index.ts:927](../src/main/index.ts#L927)). The copy sets none, and the repo's `.env` has no `MPESA_CALLBACK_URL`. See Observed, item 1.
5. **The sale.** On success, the screen calls `onPaid(receiptNumber ?? checkoutRequestId)` ([PaymentModal.tsx:268-270](../src/renderer/src/components/PaymentModal.tsx#L268-L270)). That becomes the sale's `referenceNumber` ([PosCheckoutPanel.tsx:209-221](../src/renderer/src/components/PosCheckoutPanel.tsx#L209-L221)).
6. **The gate.** For Daraja, it asks only whether that reference matches a `success` row's receipt number or checkout id ([checkout.ts:553-556](../src/main/services/checkout.ts#L553-L556); [database.ts:6142-6152](../src/main/services/database.ts#L6142-L6152)).
7. **The write.** `queueOrderRecordingMpesaPayment` writes the order and an `mpesa_payments` row with `amount: total` in one transaction ([checkout.ts:662-663](../src/main/services/checkout.ts#L662-L663); [database.ts:5595-5606](../src/main/services/database.ts#L5595-L5606)).

There is no `await` between the Daraja gate and the write, so on one till the check and the write cannot be interleaved by another checkout. The SMS check is the only wait before the write.

### 3. What is stored from Safaricom's reply

**`mpesa_transactions`** ([database.ts:1386-1397](../src/main/services/database.ts#L1386-L1397)):

| Field | Source |
| --- | --- |
| `checkout_request_id` | Safaricom's push reply (`CheckoutRequestID`), **passed through the screen** |
| `merchant_request_id` | Safaricom's push reply (`MerchantRequestID`), passed through the screen |
| `phone_number` | the screen |
| `amount` (`INTEGER`) | **the screen** (`total`), not what was sent to Safaricom (`Math.round(total)`) |
| `status` | `pending` from the screen, then the main process from Safaricom's query (`ResultCode`) |
| `mpesa_receipt_number` | the main process, from Safaricom's query reply (`MpesaReceiptNumber`) |
| `order_local_id` | never written ([database.ts:1518-1519](../src/main/services/database.ts#L1518-L1519)) |

**`mpesa_payments`** for a Daraja sale:
- **`reference`:** the string the screen sent as the sale's reference;
- **`amount`:** the sale total;
- **`source_transaction_id`:** the column exists ([database.ts:1550](../src/main/services/database.ts#L1550)) but is never written; it is NULL on all 103 rows of the copy.

**F1, the screen can write a "success" row.**
- `mpesaLogTransactionSchema` accepts `status: 'pending' | 'success' | 'failed'` ([ipcValidator.ts:400](../src/main/lib/ipcValidator.ts#L400)).
- `logMpesaTransaction` stores whatever status it is given ([database.ts:5375-5389](../src/main/services/database.ts#L5375-L5389)).
- So a request to `mpesa:log-transaction` with `status: 'success'` and any checkout id makes `hasConfirmedStkPayment` true for that id, with no word from Safaricom.
- No screen sends `'success'` today: [PaymentModal.tsx:246](../src/renderer/src/components/PaymentModal.tsx#L246) and [309](../src/renderer/src/components/PaymentModal.tsx#L309) send failed and pending. But the gate's doc says it must not trust "a string the renderer sent" ([database.ts:6132-6133](../src/main/services/database.ts#L6132-L6133)), and here it does.

**F2, a total with cents can never complete by Daraja.**
- The log schema requires `amount` to be a whole number ([ipcValidator.ts:399](../src/main/lib/ipcValidator.ts#L399)). For a total such as 250.50 the log is refused.
- The screen ignores the refusal ([PaymentModal.tsx:304-311](../src/renderer/src/components/PaymentModal.tsx#L304-L311)) and polls anyway.
- The status update then matches no row, so `success` is never stored, and the gate refuses the sale as "not confirmed yet" ([checkout.ts:99-100](../src/main/services/checkout.ts#L99-L100)).
- Meanwhile Safaricom was asked to charge 251 and the customer paid it.
- 2 of the copy's 180 orders have cents, 1 of them M-Pesa (manual).

### 4. Where Safaricom's own amount and receipt number can be read

**In the code:**
- The till reads `MpesaReceiptNumber` from the status query reply ([daraja-mpesa-provider.ts:288-290](../src/main/services/integrations/daraja-mpesa-provider.ts#L288-L290)).
- It reads **no amount** from any Safaricom reply. The push reply fields it reads are `MerchantRequestID`, `CheckoutRequestID`, `ResponseCode`, `ResponseDescription` and `CustomerMessage` ([217-221](../src/main/services/integrations/daraja-mpesa-provider.ts#L217-L221)).
- The code itself allows that a successful query may carry no receipt number. The screen then falls back to the checkout id ([PaymentModal.tsx:270](../src/renderer/src/components/PaymentModal.tsx#L270); [database.ts:6135-6137](../src/main/services/database.ts#L6135-L6137)).
- A callback, which is the other place a result could arrive, is never received (§2 point 4).

**In the official documentation (checked 2026-10-06, 21:14 Nairobi, 18:14 UTC):**

| Page | Result |
| --- | --- |
| `https://developer.safaricom.co.ke/APIs/MpesaExpressSimulate` | HTTP 408, timed out |
| `https://developer.safaricom.co.ke/APIs/MpesaExpressQuery`, `…/APIs` | HTTP 404 |
| `https://developer.safaricom.co.ke/apis/MpesaExpressSimulate` | HTTP 200, 70,489 bytes: navigation and "Daraja 3.0 is a web platform that offers access to Safaricom and M-PESA APIs that creates a bridge for payment integration to web and mobile apps." No API fields. |
| `https://developer.safaricom.co.ke/apis/MpesaExpressQuery` | HTTP 200, 70,477 bytes: the same shell, no API fields |
| `https://developer.safaricom.co.ke/faqs`, `…/apis` | HTTP 200, no `MpesaReceiptNumber`, `CallbackMetadata` or `ResultDesc` in the page |
| The 32 script files the page loads | contain the Simulate form's code (it builds a query with `CheckoutRequestID` for `mpesa/stkpushquery/v1/query`) but not the documentation text. The text is fetched at run time from the portal's GraphQL service, which I did not call. |

**This is not in the official documentation as I could read it.** The pages did not show the reply fields, so I cannot say from Safaricom's own page whether the query reply carries an amount. Point 4 stops here. I have not answered from memory.

### 5. Reuse on the copy

- Daraja references on more than one order: **0** (there are no Daraja payments).
- Any `mpesa_payments` reference on more than one order, any mode: **0**.
- M-Pesa orders sharing an `orders.reference_number`: **0**.
- M-Pesa orders with no `mpesa_payments` row: **0**. `mpesa_payments.amount` that differs from its order's total: **0**.

## Part 2. The proposed fix, confirmed or corrected from the code

| # | Rule | From the code |
| --- | --- | --- |
| G1 | A Daraja confirmation is used once, refused at the gate and again inside the write | **Confirmed, with two corrections.** (a) **Both identifiers.** One STK payment has two: the receipt number and the checkout id, and the gate accepts either ([database.ts:6148](../src/main/services/database.ts#L6148)). A rule on "the reference" alone would let a payment be used once by its receipt number and once by its checkout id. The rule must be on the STK record: find the `success` row by either identifier, then refuse if **either** of its identifiers is in `mpesa_payments` in any mode, the way the manual check works today ([database.ts:5664-5671](../src/main/services/database.ts#L5664-L5671)). (b) **Inside the write.** Today a repeat is silent (`ON CONFLICT … DO NOTHING`, [database.ts:5568](../src/main/services/database.ts#L5568)), so the second sale completes **with no payment row at all** (pinned by [mpesaPaymentsRecord.test.ts:235-262](../tests/mpesaPaymentsRecord.test.ts#L235-L262)). Proposed: write the STK row's id into the unused `source_transaction_id`, with a partial unique index `WHERE source_transaction_id IS NOT NULL`. One STK payment can then settle one sale whatever reference string was sent, enforced by the database. The Daraja path refuses on a conflict and rolls the order back, as manual does ([database.ts:5625-5645](../src/main/services/database.ts#L5625-L5645)). The copy has no non-NULL value, so the index adds cleanly. |
| G2 | A repeat of the same checkout is still answered | **Holds.** The 249 look-up runs at [checkout.ts:443-446](../src/main/services/checkout.ts#L443-L446), before the gate at [508](../src/main/services/checkout.ts#L508), so a repeat with the same key returns its first sale before G1 is asked. Inside the write, `queueOrder` answers `existing` first, and the wrapper returns before any payment write ([database.ts:5600-5602](../src/main/services/database.ts#L5600-L5602)). The new G1 check must sit **after** that return, as in the manual wrapper ([5631-5635](../src/main/services/database.ts#L5631-L5635)). The repeat then never reaches the index. |
| G3 | The amount is checked using Safaricom's amount only | **Cannot be met as written.** The till reads no amount from Safaricom (Part 1 §4), and the documentation could not be read to say whether one is offered. **The smallest honest behaviour (D1):** the **main process** records the amount **it sent** in the push (`Math.round(total)`) on the STK row, at push time, from its own request, not from the screen. The gate then refuses a sale whose `Math.round(total)` differs. This is "the amount Safaricom was asked to charge, and confirmed as paid", **not** "Safaricom's amount", and the doc and the messages would say so. It also ends F2, because the screen no longer logs the accepted push. |
| G4 | What the cashier sees | See below. |
| G5 | Not changed | **Confirmed possible:** the manual and SMS gates ([checkout.ts:514-552](../src/main/services/checkout.ts#L514-L552)), the 249 key, the fiscal code, shifts and reports. The plan touches none of them. |

**G4, what the cashier sees (proposed wording):**
- **Used before:** "This M-Pesa payment was already used for sale #N. Nothing new was received. Ask the customer for a new payment, or take payment another way."
  - Nothing is written.
  - **Where the money shows:** in sale #N, which it already paid for.
- **A different amount:** "This M-Pesa payment was for KES X, but the sale is KES Y. Start a new M-Pesa request for KES Y. The payment received stays in M-Pesa Logs as confirmed and not used by any sale."
  - Nothing is written.
  - **Where the money shows:** M-Pesa Logs (Reports), which lists every STK row with its status ([ReportsPage.tsx:1081](../src/renderer/src/pages/ReportsPage.tsx#L1081)). The row reads `success`, but **nothing on that screen says "not used by any sale"** today. Adding that marker is D5.
- **How often a cashier would meet these:** I found no screen where a cashier can pick an earlier Daraja confirmation. Each push gets a fresh checkout id, and M-Pesa Logs only checks status. So in normal use these refusals come from a request the payment screen did not make, or a screen fault. Not verified: whether the cart can change while the M-Pesa modal waits.

## Part 3. The plan (not built)

### Changes, file by file

| File | Change |
| --- | --- |
| `integrations/mpesa.ts`, `daraja-mpesa-provider.ts` | `StkPushResult` gains `amountRequested`: the exact `Amount` the provider sent. |
| `main/index.ts` | **`integrations:mpesa-stk-push`:** validate the request with a schema. On acceptance, the main process logs the `pending` STK row itself, with Safaricom's ids and `amountRequested`. **`mpesa:log-transaction`:** failed attempts only. |
| `ipcValidator.ts` | **The log schema:** `status` accepts only `'failed'` (F1). **New:** `mpesaStkPushSchema`. |
| `database.ts` | **The lookup:** `confirmedStkPayment(reference)` returns the `success` row (id, both identifiers, amount) instead of a boolean. **The index:** a partial unique index on `mpesa_payments.source_transaction_id`, check-then-add. **The write:** `insertMpesaPayment` writes `source_transaction_id`. In `queueOrderRecordingMpesaPayment`, a `daraja` payment is checked inside the transaction (either identifier already used, any mode) after the `existing` return, and inserted with no `DO NOTHING`; a conflict rolls the order back and returns `null`. The SMS and mock path through the same wrapper keeps today's behaviour. |
| `checkout.ts` | **The Daraja branch:** read the row; refuse if already used (naming the sale); refuse if `Math.round(total)` differs from the row's amount; the settlement carries the row's id. Handle a `null` from the write with the same "used" message. |
| `PaymentModal.tsx` | **Logging:** stop logging the accepted push, because the main process does it. Keep the failed-attempt log. |
| `preload/index.ts`, `window.d.ts` | **Types only:** the result's new field. |

### Existing tests that change

| Test | OLD | NEW |
| --- | --- | --- |
| [mpesaPaymentsRecord.test.ts:235-262](../tests/mpesaPaymentsRecord.test.ts#L235-L262) "lets a second Daraja sale on one reference complete" | second sale completes; 2 orders, 1 payment row | second sale refused; 1 order, 1 payment row |
| [mpesaPaymentGate.test.ts:210-222](../tests/mpesaPaymentGate.test.ts#L210-L222) and the other direct `logMpesaTransaction` setups (`checkoutKey`, `mpesaManualPayment`, `mpesaPaymentsRecord`) | log the amount freely | log an amount equal to the sale's rounded total, or the test says why not |
| [paymentModal.test.ts:206-226](../tests/paymentModal.test.ts#L206-L226) | expects the modal to log the accepted push | expects no log call on acceptance; the failed-attempt log unchanged |
| Any test sending `status: 'success'` through the log schema | accepted | refused (found at build time; none found in this audit) |

### Tests (real `:memory:` SQLite)

1. **Used on a second sale:** a confirmation used on a second sale is refused, by its receipt number and by its checkout id. Nothing is written: no order, no payment row, no fiscal queue row.
2. **The same checkout repeated:** it is still answered with its first sale, and nothing is written.
3. **A different amount:** STK row 400, sale 500, refused and nothing written.
4. **The right amount:** accepted, and the payment row carries `source_transaction_id`.
5. **A total with cents:** a sale of 250.50 against an STK row of 251 is accepted (F2).
6. **F1:** `status: 'success'` through the log schema is refused.
7. **Unchanged:** manual entry and SMS behave as before. The existing manual and SMS gate suites pass unchanged.

### Mutation checks

1. **Reuse at the gate:** the gate's "already used" check removed. Test 1 must fail.
2. **Reuse inside the write:** the in-transaction check and the index removed, with the gate stubbed to pass (the case of two submits passing the gate together). Test 1's in-write variant must fail.
3. **The amount check on the screen's figure:** the gate compares with `input.tenderedAmount` instead of the STK row. Test 3 must fail.
4. **The 249 repeat refused:** the G1 check moved before the `existing` return. Test 2 must fail.

### Rollback

Revert the commit.
- **The index stays,** harmless; its rows hold one STK id each.
- **The `source_transaction_id` values stay,** unread by the old code.
- **STK rows logged by the main process** look like the rows the screen logged before.
- **Nothing to undo in the data.**

## Decisions for you

| # | Question | Recommendation |
| --- | --- | --- |
| D1 | G3: Safaricom's amount cannot be read. Accept "the amount the main process asked Safaricom to charge, confirmed as paid" in its place? The alternative is a callback receiver, which needs a public HTTPS address a desktop till does not have: a server, a separate project. | **Accept**, named honestly in the doc and messages. Building a callback receiver is a separate decision. |
| D2 | F1: refuse `status: 'success'` from the screen | **Yes, in the same phase.** It is the gate's own hole, and no screen sends it. |
| D3 | F2 and rounding: Safaricom is asked for `Math.round(total)`. Compare the rounded total (a sale of 250.50 paid with 251 completes), or refuse Daraja for totals with cents? | **Compare the rounded total**, because that is what the customer was asked to pay. The sale and its payment row keep 250.50, as today. |
| D4 | Urgency: Daraja cannot run on the live till today | **No hurry.** Build it before Daraja is ever switched on, and do not switch it on before. To make the till's setting say what it does, it could be set to `manual`; that is a till change for you, not me. |
| D5 | M-Pesa Logs marking a `success` row "not used by any sale" | **Yes, small, in the same phase.** Otherwise money refused for a different amount is visible only as a plain `success` row. |
| D6 | The reference stored for a Daraja sale: what the screen sent, or the receipt number from the STK row when there is one | **The receipt number from the row** (the checkout id when none). It is then the till's own record, not the screen's string. |

## Observed but not changed

1. **The placeholder callback address.** With no callback URL set, a real push names `https://example.com/callback` ([daraja-mpesa-provider.ts:73](../src/main/services/integrations/daraja-mpesa-provider.ts#L73)). In production, Safaricom would post each result, with the customer's phone and payment, to a domain nobody here controls. Worth refusing a production push when no callback URL is set, before Daraja goes live.
2. **The push handler has no schema** ([index.ts:1574-1578](../src/main/index.ts#L1574-L1578)), unlike its neighbours. It is in the plan above, because the amount now matters.
3. **The manual cross-mode check matches one string** ([database.ts:5664-5671](../src/main/services/database.ts#L5664-L5671)). A Daraja sale recorded under its checkout id does not stop the same payment's receipt number being typed in manually. G5 keeps the manual gate unchanged; D6 narrows this, and the rest is for a later phase.
4. **`mpesa_transactions.order_local_id` is still never written** (phase 120 Part 10 item 1). `source_transaction_id` gives the link from the other side.
5. **`mpesa_transactions.amount` is `INTEGER`** (phase 120 Part 10 item 4). It is right for the amount sent, which is whole.
6. **The till's setting says `daraja` while the till takes M-Pesa manually.** Cashiers may see an STK tab that can only fail.

## Not verified

- **The installed till's own `.env` and credential vault** (§1). I read the repo's `.env` and the copy's settings.
- **Daraja's reply fields** from Safaricom's own pages (§4): the pages did not load their content.
- **Whether an STK payment is always for exactly the amount requested.** This is the premise of D1. It is not in any document I could read.
- **Whether the cart can change while the M-Pesa modal waits.**
- **Which refusal text the cashier saw** for the 5 failed attempts.
