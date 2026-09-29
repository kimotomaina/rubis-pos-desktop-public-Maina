# Phase 184 — Fiscal session lock and error naming (Part 1, read-only)

- **Date:** 2026-09-29
- **Requested:** Part 1: for each of the four items from phase 183 §7, give the exact change, the file:line, the tests and the risk. No code, no device calls, then STOP.
- **Outcome:** Part 1 complete. All four items can be built as asked, with two conditions the audit turned up:
  - Items 2 and 4 are only safe once item 1 is in place. §5 says why and gives the order.
  - Item 2 needs one extra guard, or `'50'` would also make one of our own malformed requests retryable (§2.3).
- **Branch / base commit:** staging @ ddb6cbb (phase-183 report), tree clean.
- **Input from the till:** ReadStatus after the failure showed `Opened_Fiscal_Receipt=0`, all blocking bits 0, `CU_fiscalized=1`, `Paired_with_TIMS=1`. That points to phase-183 candidate B, two sequences overlapping.
- **Not received:** the brief's "Live 1 KSh retest result" line still reads `<paste>`, so this report does not use it.

### Correction to phase 183

§7 item 2 of phase 183 says STE2 `3d`–`3f` are unmapped. **That is wrong.** They are mapped today as decimal 61, 62 and 63 ([real-etims-provider.ts:433-438](../src/main/services/integrations/real-etims-provider.ts#L433-L438)). The unmapped STE2 command errors are **`31`, `32`, `33`, `35`, `36`, `37` and `38`**. Phase 183 is left as written, per the rule that earlier phases are never edited.

---

## 1. One lock around the device session

### Who talks to the device today

There is one provider instance ([fiscal-provider-factory.ts:70](../src/main/services/fiscal-provider-factory.ts#L70)), shared by every caller:

| Caller | Method | Where |
| --- | --- | --- |
| Checkout | `submitInvoice` | [checkout.ts:626](../src/main/services/checkout.ts#L626) |
| 30 s fiscal queue tick | `submitInvoice` (via `attemptFiscalRetry`) | [index.ts:997](../src/main/index.ts#L997), [fiscal-retry.ts:97](../src/main/services/fiscal-retry.ts#L97) |
| Manual resend, correct-PIN resend | `submitInvoice` (same path) | [index.ts:2616](../src/main/index.ts#L2616), [fiscal-retry.ts:196](../src/main/services/fiscal-retry.ts#L196) |
| 30 s status badge | `checkConnectivity` (`settings()` + `ReadStatus`) | [index.ts:1111](../src/main/index.ts#L1111) |
| Admin "Test connection" | `testConnection`, which also drops the cached handshake | [index.ts:1943](../src/main/index.ts#L1943) |
| App quit | `closeServerConnection` (`clientremove`), fire-and-forget | [index.ts:1132-1140](../src/main/index.ts#L1132-L1140) |
| Admin save | `reconfigure` (sync, sends nothing) | [index.ts:894](../src/main/index.ts#L894) |
| None in `src/` | `cancelInvoice` (credit note), public `readCUInvoiceNumber` | [real-etims-provider.ts:1149](../src/main/services/integrations/real-etims-provider.ts#L1149), [:1194](../src/main/services/integrations/real-etims-provider.ts#L1194) |

The only guard is the queue's `running` flag ([fiscal-engine.ts:119-128](../src/main/services/fiscal-engine.ts#L119-L128)), and that only stops the tick overlapping *itself*. Nothing stops checkout, the tick and resend from interleaving at every `await`.

### The change

`real-etims-provider.ts`, in the class fields ([:708-732](../src/main/services/integrations/real-etims-provider.ts#L708-L732)):
- Add one private promise chain, `deviceQueue`, set to `Promise.resolve()`.
- Add one private helper, `exclusive(task)`. It chains `task` after `deviceQueue`, then sets `deviceQueue` to that run with both outcomes swallowed, so a failed or thrown task never jams the chain, and returns the run. This is plain promises; no dependency is needed.

**Which methods take the lock.** Only the public entry points, and each one wraps its whole body:
- `submitInvoice` ([:871](../src/main/services/integrations/real-etims-provider.ts#L871))
- `cancelInvoice` ([:1149](../src/main/services/integrations/real-etims-provider.ts#L1149))
- `readCUInvoiceNumber` ([:1194](../src/main/services/integrations/real-etims-provider.ts#L1194))
- `testConnection` ([:792](../src/main/services/integrations/real-etims-provider.ts#L792))
- `checkConnectivity` ([:812](../src/main/services/integrations/real-etims-provider.ts#L812))
- `closeServerConnection` ([:1349](../src/main/services/integrations/real-etims-provider.ts#L1349))

**Which do not.** `rollback` (CancelReceipt), `verifyAlreadyFiled`, `sendReadCUinvoiceNumber`, `ensureSettings`, `ensureCUNumbers`, `readStatus` and `sendCommand` stay unlocked.
- They are private and only ever run inside a locked `submitInvoice` or connection check, so the lock already covers them.
- Locking them as well would **deadlock**, because the promise chain is not re-entrant: the inner call would wait for the outer one, which is waiting for it.
- So the brief's "CancelReceipt, ReadCUinvoiceNumber, verifyAlreadyFiled" are covered by `submitInvoice`'s lock, not by locks of their own.

**`getInvoiceDetails` and `reconfigure` stay outside.**
- `getInvoiceDetails` reads only the local database.
- `reconfigure` is synchronous and sends nothing. It only clears the cached handshake, and an in-flight sale never re-reads that except on a Code 53. See §7, item 5.

### Badge: joins the lock

The status badge's `settings()` + `ReadStatus` will join the lock, for three reasons:
1. **The vendor's own client never overlaps requests.** The SDK's `sendReq` uses a synchronous XHR (`req.open(verb, url, false)`, `fp_core.js:29-37`; SDK_RECON §2), so its designers never had two commands in flight. One rule, "one caller on the device at a time", is simpler to reason about than "one, except reads".
2. `checkConnectivity` can itself send `settings()` when the cached handshake has been cleared (after a Code 53 or an Admin save). That is not read-only, and it must not land mid-receipt.
3. **The cost is small.** A badge poll waits behind at most one sale. Each request is capped at 5 s ([http-client.ts:501-503](../src/main/services/integrations/http-client.ts#L501-L503)), and the badge only updates a status dot.

### Fairness and latency

- The lock is taken per `submitInvoice` call, not per queue tick. A checkout started during a queue drain runs after the queued sale that is in flight, not after the whole backlog, because the chain is FIFO and the tick submits one sale at a time.
- **Checkout latency:** a cashier's checkout can now wait for one in-flight queued sale to finish, normally a second or two. If the device hangs, the wait is bounded by the 5 s timeouts of that sale's remaining steps.

### Tests (`tests/realEtimsProvider.test.ts`, new `describe`)

1. **No interleaving.** Two `submitInvoice` calls start together against a mock whose `post` resolves out of order (deferred promises). The recorded `commandSequence` must hold sale 1's `ReadStatus … CloseReceipt, ReadDateTime` as one unbroken run before any of sale 2's commands.
   *Mutation:* remove the `exclusive` wrapper from `submitInvoice`. The sequences interleave and the test fails.
2. **The lock is released on failure.** Sale 1's `SellPLU` rejects and its HTTP post throws, yet sale 2 still completes.
   *Mutation:* chain `deviceQueue = run` without swallowing the error, and sale 2 rejects.
3. **The badge waits.** `checkConnectivity` called while a sale is mid-flight sends its `ReadStatus` only after that sale's `CloseReceipt`.
4. **Quit waits.** `closeServerConnection` called mid-sale sends `clientremove(who=me)` only after `CloseReceipt`.
5. **No deadlock.** The existing isRetry / `verifyAlreadyFiled` / rollback tests must still pass unchanged ([realEtimsProvider.test.ts ~1100-2240](../tests/realEtimsProvider.test.ts)). They would hang to Vitest's timeout if any private method took the lock.

### Risk

- A hung request holds every other caller for up to the 5 s timeout per step. This is bounded and not new: the device was already serial.
- The quit path is unchanged. Close stays fire-and-forget, so a sale in flight at quit can still leave a receipt open on the device. Item 4 recovers that on the next sale.

---

## 2. Map the unmapped STE2 codes; `0x32` retryable

### PDF source

§1.2.1, Table Errors, "Command errors" column, verbatim:

| Hex | Decimal the app sees | PDF text | Proposed `retryable` | Why |
| --- | --- | --- | --- | --- |
| 31 | 49 | Invalid command | false | The device does not know the command. That is a build or definitions problem, not something a retry fixes. |
| **32** | **50** | **Illegal command** | **true** | The PDF defines it as refused "depending on the current status of the CU" (§1.2.1): state, not data. The type doc already classes "an already-open receipt" as `technical` ([etims.ts:220-223](../src/main/services/integrations/etims.ts#L220-L223)). |
| 33 | 51 | Z daily report is not zero | false | This is a configuration-command condition, not expected on a sale, so a person should see it. |
| 35 | 53 | Input registers overflow | false | Device totals; needs a person. |
| 36 | 54 | Zero input registers | false | Closing an empty receipt. The app's own gate ([:1044](../src/main/services/integrations/real-etims-provider.ts#L1044)) should make this impossible, so seeing it means a build problem. |
| 37 | 55 | Unavailable transaction for correction | false | Correction (negative price) data. |
| 38 | 56 | Insufficient amount on hand | false | A cash-out condition this app never sends; needs a person. |

The PDF names these codes but gives no retry guidance. **Every `false` above is my judgement.** Only `0x32` is the brief's decision. Non-retryable codes keep today's `kind: 'data'` routing (§7, item 2).

### 2.1 The mapping change

[`mapFiscalDeviceError`](../src/main/services/integrations/real-etims-provider.ts#L421-L444) gets seven new `case` lines, with the messages taken verbatim from the PDF (without the trailing "!"). `'50'` returns `retryable: true` and all the others `false`.

From there the existing routing does the rest:
- [`classifyDeviceFailure`](../src/main/services/integrations/real-etims-provider.ts#L616-L630) gives `kind: 'technical'`.
- [`routeFiscalOutcome`](../src/main/services/fiscal-routing.ts#L58-L63) gives `waiting` + enqueue.
- The queue retries with its existing backoff and abandons the sale after its existing attempt limit (`recordFiscalQueueFailure`).
- The cashier sees the "sent automatically" notice ([fiscalNotice.ts:46-51](../src/renderer/src/lib/fiscalNotice.ts#L46-L51)).

### 2.2 Why the step that was refused matters for retry

| Refused at | What is left on the device | Is a retry safe? |
| --- | --- | --- |
| `ReadStatus` | Nothing opened. | Yes. |
| `OpenInvoice…` | Nothing opened by this sale. | Yes. On a retry, `verifyAlreadyFiled` ([:976-1014](../src/main/services/integrations/real-etims-provider.ts#L976-L1014)) asks `ReadCUinvoiceNumber` first, and only a device-named invoice number counts as filed. |
| `SellPLU…`, `ReadCurrentReceiptInfo` | This sale's receipt, which `rollback` cancels ([:1025](../src/main/services/integrations/real-etims-provider.ts#L1025), [:1038](../src/main/services/integrations/real-etims-provider.ts#L1038)). "Cancel all sales in the receipt and close it" (PDF §2.5.8). | Yes. Nothing was filed. |
| `CloseReceipt` | An ACK with an error means the command was not carried out (§1.2.1: "sent … when it is rejected"). The receipt is still open and `rollback` cancels it ([:1062](../src/main/services/integrations/real-etims-provider.ts#L1062)). | Yes. |

**Could this file anything twice?** Not on its own terms, because an Illegal refusal is never a filing. The danger is the one phase 183 described: **without item 1**, an Illegal refusal can be the *symptom* of another sequence's `CloseReceipt` having filed this sale's earlier `SellPLU` lines on *that* sale's invoice. Retrying this sale would then file those lines a second time. **So item 2 must never ship without item 1** (§5). With the lock in place that interleave cannot happen, and every row above holds.

**The lost-reply case is a different path and is unchanged.** If a reply times out after the device *did* close the receipt, that shows up as an HTTP failure, not as Code 40. It already goes to the queue, and on retry to `verifyAlreadyFiled`.

**The sale already flagged in phase 183 is not auto-retried.** New routing applies only to new outcomes. **Do not press Resend on it** until someone has checked that none of its lines appear on the invoice of the sale that filed next to it. The step that failed is unknown, and a manual resend would re-file any lines that were swept into another invoice.

### 2.3 Required guards the audit found

Two different error tables share one `code` string field, so these decimals collide today.

**a. The fallback path.** [`checkDeviceResponse`](../src/main/services/integrations/real-etims-provider.ts#L571-L581) sends any non-40 code that isn't in the server table through `mapFiscalDeviceError`.
- The SDK's own `Tremol.ServerErrorType` defines **50 `ClientArgDefMissing`, 51 `ClientAttrDefMissing`, 52 `ClientArgValueWrongFormat`, 53 `ClientSettingsNotInitialized`, 62 `ClientInvalidGetFormat`, 63 `ClientInvalidPostFormat`** (`Libs/JS/fp_core.js:547-552`). A real capture shows these arrive with `Source="Server"` ([tests/fixtures/wire/code63-invalidpost.xml](../tests/fixtures/wire/code63-invalidpost.xml)).
- With item 2.1 alone, a `<Res Code="50">` from our own malformed request would read as "Illegal command" and be **retried as if it were a device state**.
- **Change:** in that fallback branch ([:571](../src/main/services/integrations/real-etims-provider.ts#L571)), stop consulting `mapFiscalDeviceError`. Return the server's raw message, non-retryable, with `serverFailure` set as now, so the STE2 table is read only for Code 40.
- This also fixes today's mislabels: `52` now reads as "Syntax error" and `62` as "Item amount too large".

**b. The Code 53 retry.** [`sendCommand`](../src/main/services/integrations/real-etims-provider.ts#L1425) treats any `code === '53'` as "settings missing": it re-sends `settings()` and **repeats the command**.
- STE2 `0x35` (decimal 53, "Input registers overflow") matches that test today.
- **Change:** also require `first.serverFailure`. That is set only on the server-code path ([:523](../src/main/services/integrations/real-etims-provider.ts#L523)), never on Code 40.

### Tests

**Changed:**
- [realEtimsProvider.test.ts:205-227](../tests/realEtimsProvider.test.ts#L205-L227): the existing `it.each` title says "always non-retryable". Its rows stay as they are.
- A second `it.each` is added for 49, 51 and 53-56 (non-retryable) and for 50 (`retryable: true`).
- The `'99'` fallback test is unchanged.

**New:**
1. `SellPLU` answers `xmlCommandError(50, 'Illegal command')`. Expect `kind: 'technical'`, `retryable: true`, `CancelReceipt` sent, and `routeFiscalOutcome` giving `waiting` + enqueue.
2. An isRetry sale whose `OpenInvoice` answers STE2 `0x32` must send `ReadCUinvoiceNumber`. With no number returned, it ends as a retryable failure and is never reported as filed.
3. `<Res Code="50"><Err Source="Server" Type="ClientArgDefMissing">` gives `retryable: false`, and its reason does not contain "Illegal command".
4. STE2 `0x35` on `SellPLU` gives exactly one `settings()` GET (the session one) and one `SellPLUfromExtDB` post, with no repeat.

**Mutations:**
- Flip `'50'` to `retryable: false`: new tests 1 and 2 fail.
- Remove guard 2.3a: test 3 fails.
- Remove guard 2.3b: test 4 fails.

### Risk

- Retrying an Illegal refusal that is **persistent** (a receipt stuck open by another client) costs up to the queue's attempt limit, then the existing "abandoned" warning. Item 4 addresses stuck receipts.
- Relabelling the fallback path changes the text for server codes 50-52 and 62. No test asserts those texts (grep: only 19/30/31/53/63 are ever mocked).

---

## 3. Put the refused step into the stored reason

### Where the reason goes

`setOrderFiscalFailure` ([checkout.ts:654](../src/main/services/checkout.ts#L654), [fiscal-engine.ts:175](../src/main/services/fiscal-engine.ts#L175), [fiscal-retry.ts:211](../src/main/services/fiscal-retry.ts#L211)) stores it in `orders.fiscal_error_reason`, and the queue's `last_error` gets it too. It is then **shown verbatim** in two places:
- Needs Attention ([NeedsAttentionPage.tsx:192](../src/renderer/src/pages/NeedsAttentionPage.tsx#L192)).
- The cashier's "rejected" notice ([fiscalNotice.ts:61-64](../src/renderer/src/lib/fiscalNotice.ts#L61-L64)), whose copy rules are "plain language only, no device codes, no jargon" (its file doc).

### The change

In `classifyDeviceFailure` ([:616-630](../src/main/services/integrations/real-etims-provider.ts#L616-L630)), add one `step` parameter and append it to `reason` as a plain label with the command name in brackets. For example:

`Fiscal device error (Code 40, STE2=50): Illegal command. Refused while closing the invoice (CloseReceipt).`

This gives the person a plain step and gives support the exact command. It is passed at the six call sites:

| Line | Step label | Command |
| --- | --- | --- |
| [:924](../src/main/services/integrations/real-etims-provider.ts#L924) | opening the device session | `settings` |
| [:952](../src/main/services/integrations/real-etims-provider.ts#L952) | checking the device status | `ReadStatus` |
| [:1016](../src/main/services/integrations/real-etims-provider.ts#L1016) | opening the invoice | `OpenInvoiceWithFreeCustomerData` |
| [:1026](../src/main/services/integrations/real-etims-provider.ts#L1026) | adding item *n* of *m* | `SellPLUfromExtDB` / `SellPLUfromExtDB_HS` (the actual one, from `resolveSellCommand`) |
| [:1039](../src/main/services/integrations/real-etims-provider.ts#L1039) | reading the receipt totals | `ReadCurrentReceiptInfo` |
| [:1063](../src/main/services/integrations/real-etims-provider.ts#L1063) | closing the invoice | `CloseReceipt` |

**Not suffixed:**
- `DAILY_CLOSURE_BLOCK_REASON` is a device-wide condition written as finished cashier copy, and four tests pin it with `toBe` ([:1035](../tests/realEtimsProvider.test.ts#L1035), [:1984](../tests/realEtimsProvider.test.ts#L1984), [:2002](../tests/realEtimsProvider.test.ts#L2002), [:2056](../tests/realEtimsProvider.test.ts#L2056)). `classifyDeviceFailure` skips the suffix when `result.code` is `CODE_DAILY_CLOSURE_BLOCK`.
- Also left alone, because they don't go through `classifyDeviceFailure`: `UNVERIFIABLE_RETRY_REASON`, `NOT_CONFIGURED_REASON`, pre-send validation errors, and the two receipt-anomaly reasons, which already name their step.

The doc comment on `fiscalErrorReason` ([database.ts:237](../src/main/services/database.ts#L237)) says "Never a code", which has not been true since phase 69. Part 2 updates that comment to describe what is actually stored. No schema change is needed.

**Decision for you:** the label format above. Alternatives are the command name only, or the plain label only. I'd keep both.

### Tests

**New:**
- One test per call site: fail that step and expect `reason` to contain its label and command.
- For `SellPLU` specifically, expect "item 2 of 2" on a two-line sale whose second line is refused.

**Unchanged:**
- Every existing `toMatch` on reasons (29 in realEtimsProvider.test.ts) still passes, because the suffix is appended.
- The four daily-closure `toBe` assertions pass unchanged, which is what proves the exclusion works.

**Mutation:** drop `step` at the `CloseReceipt` call site, and its test fails.

### Risk

- Longer text on the cashier's notice. It is still one sentence.
- No secret can enter the reason: none of the six steps' results carry the password (`settings()`'s URL is never put into `error`; [http-client.ts:420-426](../src/main/services/integrations/http-client.ts#L420-L426)).

---

## 4. Before `OpenInvoice`: cancel an already-open receipt

### What the PDF says, verbatim

- §2.5.8 CancelReceipt: **"FPR operation: Available only if the receipt is not closed. Cancel all sales in the receipt and close it."**
- §2.2.1 ReadStatus, ST2 bit 1: "Opened Fiscal Receipt".

The PDF therefore **does** allow CancelReceipt in exactly the state `Opened_Fiscal_Receipt=1` reports. By the brief's rule, this can be built.

It is silent on two narrower points. **Flag both for VIL.** They don't block the build.
1. Whether the device ties a receipt to the client or session that opened it (ZFPLabServer can be shared by several clients, per ChangeLog 1.6.1).
2. Whether a receipt left open by a power cut (ST0 bit 1, "Power down in opened fiscal receipt") needs anything other than CancelReceipt.

### The change

In `submitInvoice`, between the ReadStatus success check and Step 3 ([:950-959](../src/main/services/integrations/real-etims-provider.ts#L950-L959)):
- If `statusResult.data?.Opened_Fiscal_Receipt === '1'`, log a warning naming the sale, `await this.rollback()` once, and continue to `OpenInvoice`.
- There is no loop. If the receipt is still open, `OpenInvoice` is refused and routed normally. That is retryable if it comes back as `0x32` (item 2), or it goes through the existing `STE1=0x34` cancel-and-retry-once ([:965-975](../src/main/services/integrations/real-etims-provider.ts#L965-L975)). So one attempt sends **at most two** CancelReceipts.
- `readStatus` already returns every parsed bit ([:1482](../src/main/services/integrations/real-etims-provider.ts#L1482)), so no extra command is needed.

### Why this cannot file twice, and when it could lose a sale

- CancelReceipt voids a receipt that was *not* closed, and only a closed receipt is filed. So it can never file anything.
- What it can do is destroy **someone else's in-progress receipt**.
  - Inside this app, item 1 makes that impossible: no other sequence can be mid-receipt while this one holds the lock.
  - **Outside this app** (the ZFPLab GUI, or any other software pointed at the same Control Unit), it would void that client's sale.
- **So item 4 must ship after item 1, and only once you confirm that nothing else uses this till's Control Unit.** The folders `NEXX\PointOfSale` and `NEXX\Messenger` on the dev PC suggest a previous POS existed. Check that it is gone from the pilot till.

### Tests

**New:**
1. ReadStatus mock returns `Opened_Fiscal_Receipt: '1'`. `commandSequence` must be `ReadStatus, CancelReceipt, OpenInvoiceWithFreeCustomerData, …, CloseReceipt, ReadDateTime`, and the sale is filed.
2. Same as test 1, but `OpenInvoice` then answers `STE1=0x34`. There is exactly one more CancelReceipt, then success, so the at-most-two cap holds.
3. `Opened_Fiscal_Receipt: '0'` or absent: no CancelReceipt before `OpenInvoice`.

**Unchanged:** every existing exact-sequence test, because the default mock ([realEtimsProvider.test.ts:142-145](../tests/realEtimsProvider.test.ts#L142-L145)) sends no `Opened_Fiscal_Receipt` bit.

**Mutations:**
- Invert the condition: tests 1 and 3 fail.
- Remove the `rollback()` call: test 1 fails.

### Risk

- It voids a receipt owned by another client if one exists (above).
- It has not been tried on a device.

---

## 5. Order and conditions for Part 2

1. **Item 1 first, on its own commit.** Items 2 and 4 are unsafe without it (§2.2, §4).
2. **Item 2 with its two guards (§2.3) in the same commit.** Without guard 2.3a, `'50'` becomes retryable for our own malformed requests too.
3. **Item 3.** It is independent, and it is what will name the refused step next time.
4. **Item 4 last**, and only after you confirm that no other client uses this Control Unit.

Each commit runs `npm run typecheck` and the fiscal test files, and gets the mutation checks listed above. Every changed assertion will be listed in the Part 2 report. No device calls.

## 6. Verification for this Part

- Read in full: `real-etims-provider.ts`, `etims.ts`, `fiscal-retry.ts`, `fiscal-engine.ts` (tick), the `checkout.ts` fiscal block, the `http-client.ts` request path, and `fiscalNotice.ts`. Also the index.ts call sites at 880-1000, 1090-1150 and 2596-2625, and Needs Attention's reason rendering.
- `grep`: every caller of the provider's public methods, and every construction of the provider (one). Every test that asserts a reason with `toBe` or `toMatch` (§3), and every test that mocks a non-40 `<Res Code>` (only 19, 30, 31, 53 and 63).
- PDF §1.2.1 Table Errors, §2.2.1, §2.5.7 and §2.5.8 (text extracted with pypdf). SDK `fp_core.js:529-564` (`Tremol.ServerErrorType`).
- Not run: tests or a build (nothing changed), and no device calls.

## 7. Observed but not changed

1. **A sale cut off mid-fiscalization is lost from view.**
   - The order row is written with `fiscal_status` NULL ([database.ts:1435](../src/main/services/database.ts#L1435)), and `setOrderFiscalFailure`/`setOrderFiscalInfo` run only after `submitInvoice` returns ([checkout.ts:626-658](../src/main/services/checkout.ts#L626-L658)).
   - If the app quits or crashes mid-sale (for example during an update install), the sale keeps `fiscal_status` NULL and gets no queue row. Nothing retries it, Needs Attention doesn't show it (that list needs `needs_fixing`/`waiting`), and the unfiled count doesn't count it.
   - Item 4 would cancel its device receipt on the next sale, which is correct because it was never filed, but the sale itself stays silently unfiled.
   - This is a Rule 3 gap, and it predates this phase.
2. **Non-retryable device refusals are all routed as `kind: 'data'`.** That includes those that are really device or build conditions (49, 51, 53, 54, 56). So Needs Attention says "flagged for correction" when the sale's data may be fine.
3. **`classifyDeviceFailure` routes any `code === '63'` to `system`** ([:625](../src/main/services/integrations/real-etims-provider.ts#L625)). That also catches STE2 `0x3f` (decimal 63, "Amount exceeds original invoice"), which is a data rejection. It can only happen on credit notes, which are not wired, so this is low impact today.
4. **Same-sale race.** `attemptFiscalRetry`'s "already fiscalized?" check ([fiscal-retry.ts:86](../src/main/services/fiscal-retry.ts#L86)) runs *before* the lock. A queue retry and a manual resend of the *same* sale can both pass it. With item 1 they reach the device one after the other rather than interleaved, and the second relies on the device's duplicate refusal plus `verifyAlreadyFiled`, which has never been verified on a device. It is no worse than today, but a re-check inside the lock would need database access in the provider.
5. **`reconfigure` mid-sale** clears the cached handshake. It sends nothing, but the in-flight sale's next Code 53 would re-handshake with the *new* settings.
6. **The phase-183 sale** is still `needs_fixing` with an unknown step (see the warning in §2.2 before resending it).

## 8. Rollback

Nothing to roll back. This Part changed no code; the only file added is this report.
