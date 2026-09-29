# Phase 185 — A sale must never be lost if the app stops mid-filing (Part 1, read-only)

- **Date:** 2026-09-29
- **Requested:** Part 1, read-only:
  - trace the checkout write path;
  - list the queries that decide "unfiled", Needs Attention and the queue, and what each does with NULL;
  - count NULL rows in a copy of the dev database;
  - compare option A (status and queue row in the insert transaction) with option B (start-up sweep);
  - prove the queue can't pick up a sale checkout is filing;
  - confirm retries go through `verifyAlreadyFiled`.

  Then STOP.
- **Outcome:** Part 1 complete. I recommend A plus B, as you proposed, with three changes to the brief's assumptions (§0) and a different guard for item 5 (§5).
- **Branch / base commit:** staging @ ee40dfe, tree clean. No code changed. The only database touched was a read-only copy of the dev database, in the session scratchpad. No device calls.

---

## 0. Three premises that don't hold as written

1. **"On success the existing code marks it filed and removes the queue row; on failure the existing routing updates it." It doesn't, today.** Checkout never creates a fiscal queue row before `submitInvoice`, so its outcome branches don't expect one:
   - success calls only `setOrderFiscalInfo` ([checkout.ts:630-638](../src/main/services/checkout.ts#L630-L638)), which never touches `sync_queue`;
   - a retryable failure **inserts a new** queue row ([checkout.ts:657](../src/main/services/checkout.ts#L657));
   - a non-retryable failure leaves no row.

   So option A must change all three branches, plus the thrown-exception branch. Otherwise a filed sale keeps a live queue row, and a retryable failure ends up with two rows.
2. **The dev database can't answer item 3.** It holds **one** order (synced, `needs_fixing`) and **no** NULL rows (§3). The number that matters is on the till.
3. **There is no "dry-run" mode in the code.** The only split is the real provider versus the development mock (`fiscalModeStore.ts`). A mock-filed order is recognisable by its invoice number, `KRA-MOCK-…` ([mock-etims-provider.ts:69](../src/main/services/integrations/mock-etims-provider.ts#L69)). A NULL row carries no invoice number, so nothing on the row says which provider was running when it stalled.

Part 2 also has to edit files that earlier phases treated as tripwires: `checkout.ts`, `database.ts`, `fiscal-engine.ts` and `index.ts` (§4).

---

## 1. The checkout write path, end to end

| # | What | Where | Transaction |
| --- | --- | --- | --- |
| 1 | Payment gates (M-Pesa, card), no writes | [checkout.ts:440-522](../src/main/services/checkout.ts#L440-L522) | none |
| 2 | Order row inserted with `fiscal_status` left NULL (the INSERT names no fiscal column), plus the **Shopify** `sync_queue` row (`entity_type='order'`) | `queueOrder`, [database.ts:1434-1465](../src/main/services/database.ts#L1434-L1465) | **T1** |
| 2a | The three M-Pesa variants call `queueOrder` inside their own transaction, adding the payment row or claim | [database.ts:2820-2836](../src/main/services/database.ts#L2820-L2836) (SMS claim), [:2900-2905](../src/main/services/database.ts#L2900-L2905) (Daraja/SMS), [:2929-2935](../src/main/services/database.ts#L2929-L2935) (manual) | outer transaction; T1 nests as a savepoint |
| 2b | Checkout picks the path | [checkout.ts:575-591](../src/main/services/checkout.ts#L575-L591) | — |
| 3 | Background Shopify push, not awaited | [checkout.ts:593-603](../src/main/services/checkout.ts#L593-L603) | — |
| 4 | Fiscal request built | [checkout.ts:621](../src/main/services/checkout.ts#L621) | none |
| 5 | `fiscal_request_json` stored | [checkout.ts:624](../src/main/services/checkout.ts#L624) → [database.ts:1825-1829](../src/main/services/database.ts#L1825-L1829) | own statement |
| 6 | **`await submitInvoice`**, the device filing. **The gap starts at step 2.** | [checkout.ts:626](../src/main/services/checkout.ts#L626) | — |
| 7a | Success: `fiscal_status='fiscalized'` | [checkout.ts:630-638](../src/main/services/checkout.ts#L630-L638) → [database.ts:1743-1772](../src/main/services/database.ts#L1743-L1772) | own statement |
| 7b | Failure: `waiting` or `needs_fixing` | [checkout.ts:640-654](../src/main/services/checkout.ts#L640-L654) → [database.ts:1798-1810](../src/main/services/database.ts#L1798-L1810) | own statement |
| 7c | Retryable only: fiscal queue row inserted (`next_attempt_at = 0`), then the queue ticked | [checkout.ts:656-659](../src/main/services/checkout.ts#L656-L659) → [database.ts:1505-1513](../src/main/services/database.ts#L1505-L1513) | own statement, **not** the same one as 7b |
| 7d | Thrown exception: request stored if missing, `waiting` set, queued | [checkout.ts:661-685](../src/main/services/checkout.ts#L661-L685) | three separate statements |

**Where a stop loses the sale:**
- **Anywhere from step 2 to 7a/7b:** the order stays `fiscal_status` NULL with no fiscal queue row. That covers a quit, crash, update or power cut.
- **Between steps 2 and 5:** `fiscal_request_json` is NULL too.
- **Between 7b and 7c:** the order is `waiting` with no queue row. It shows in Needs Attention after 15 minutes, but nothing retries it by itself. This is a smaller second gap from the same cause: 7b and 7c aren't one transaction.

---

## 2. What decides "unfiled", Needs Attention and the queue

| Query | Where | Matches on | NULL row |
| --- | --- | --- | --- |
| `getUnfiledOrderCount` (the Rule-3 count) | [database.ts:2168-2175](../src/main/services/database.ts#L2168-L2175) | `fiscal_status IN ('waiting','needs_fixing') AND status != 'voided'` | **Not counted** |
| `getOrdersNeedingAttention` | [database.ts:2143-2157](../src/main/services/database.ts#L2143-L2157) | `needs_fixing`, or `waiting` older than 15 min, not voided | **Not shown** |
| `getPendingFiscalQueue` (what the queue retries) | [database.ts:1522-1533](../src/main/services/database.ts#L1522-L1533) | `sync_queue` rows with `entity_type='etims_invoice' AND next_attempt_at <= now`. It reads queue rows, not orders. | **Never picked up**: a NULL order has no row |
| `generateFiscalStatusByDay` (report) | [reports.ts:756-763](../src/main/services/reports.ts#L756-L763) | three explicit buckets | **In no bucket**: invisible in the fiscal report too |
| `shouldShowFiscalPendingSlip` (reprint) | [printer.ts:187-192](../src/main/services/printer.ts#L187-L192) | `!== 'fiscalized'` | Prints the "sale record" slip (correct: not a tax invoice) |
| `attemptFiscalRetry` (queue and resend gate) | [fiscal-retry.ts:75-97](../src/main/services/fiscal-retry.ts#L75-L97) | only `voided` and `fiscalized` short-circuit | Would file, if anything ever called it for this order |

So a NULL order is invisible to every surface that could get it filed or noticed. The only trace is the reprint slip.

---

## 3. NULL rows in the dev database (read-only copy)

The copy is `%APPDATA%\rubis-pos-desktop\rubis-pos.db` (167,936 bytes, last written 2026-09-28 07:44; no `-wal` file; app not running), taken into the scratchpad and opened with `sqlite3 …?mode=ro`.

| Query | Result |
| --- | --- |
| Orders in total | **1** (`synced`, `needs_fixing`) |
| `fiscal_status IS NULL AND status != 'voided'` | **0** |
| …with `fiscal_request_json` | 0 |
| Fiscal queue rows | 0 |
| Filed by the mock (`KRA-MOCK-…`) or the real provider | 0 and 0 (the one order was never filed) |

**Live versus mock:** the dev database can't show a difference because it has nothing to compare. The same query on a copy of the **till's** database is the one that matters, and it gates B (§4.2):

```sql
SELECT COUNT(*),
       SUM(fiscal_request_json IS NOT NULL),
       MIN(created_at),
       MAX(created_at)
FROM orders
WHERE fiscal_status IS NULL AND status != 'voided';
```

To take the copy, close RUBIS POS and copy `rubis-pos.db` with its `-wal` and `-shm` files. The `userData\backups\pre-update-*.sqlite` files are also safe copies, but they're older.

---

## 4. Options

### 4.1 Option A: status, request and queue row in the insert transaction

**The change:**
- **`database.ts`, `queueOrder`** ([:1410-1466](../src/main/services/database.ts#L1410-L1466)): `QueueOrderInput` gains one optional field, a function that builds the fiscal request from the new `localId`. It has to be a function because `TraderSystemInvNum` is built from `localId`, which only exists after the INSERT. Inside the existing transaction, after the order and Shopify rows:
  - `UPDATE orders SET fiscal_status='waiting', fiscal_request_json=?`
  - `INSERT` the fiscal queue row, which returns its id.

  All four insert paths pass through `queueOrder`, so all four get it, and still inside their outer transactions (§1, 2a).
- **`checkout.ts`**, the four outcome branches:

  | Branch | Change | Why |
  | --- | --- | --- |
  | 7a success | `setOrderFiscalInfo` becomes the existing `markFiscalQueueItemSynced(queueId, …)` ([database.ts:1547-1574](../src/main/services/database.ts#L1547-L1574)) | It already writes the filing and deletes the row in **one** transaction |
  | 7b/7c retryable | `setOrderFiscalFailure('waiting')` plus a new one-line `releaseFiscalQueueItem(queueId)` that sets `next_attempt_at = 0`, in one transaction, instead of inserting a second row | Keeps today's immediate retry (`onCheckoutMade`) and ends the 7b/7c gap |
  | 7b non-retryable | `setOrderFiscalFailure('needs_fixing')` plus the existing `removeFiscalQueueItem(queueId)` ([database.ts:1623-1625](../src/main/services/database.ts#L1623-L1625)), in one transaction | Same as today's queue reclassification ([fiscal-engine.ts:175-176](../src/main/services/fiscal-engine.ts#L175-L176)) |
  | 7d thrown | Same as retryable | — |

  The later `setOrderFiscalRequest` ([checkout.ts:624](../src/main/services/checkout.ts#L624), [:677](../src/main/services/checkout.ts#L677)) becomes redundant and is removed.
- **No schema change:** `fiscal_status` already allows `'waiting'` ([database.ts:560](../src/main/services/database.ts#L560)) and `sync_queue` already exists ([:572-582](../src/main/services/database.ts#L572-L582)).

**Cost:** about 40 lines across `database.ts` and `checkout.ts`, plus the item-5 guard (§5). Tests that count queue rows after a checkout need updating: `runCheckout`, `fiscalIntegration`, `database`, `orderHistory` and the M-Pesa and card files, 81 references in 13 files. Each changed assertion will be listed in Part 2.

**Visible effects:**
- For the few seconds a sale is being filed, it reads `waiting`, so the unfiled count can show +1 briefly.
- Needs Attention is unaffected (15-minute cutoff), and so is the receipt: it prints after checkout returns, when the status is final.

**What it closes:** from the moment the sale exists, it is `waiting`, queued and carries its exact request. A stop at any later point leaves it where the queue retries it and the count shows it.

### 4.2 Option B: the start-up sweep

**The change:** one database method, run in `index.ts` right after `db.init()` ([index.ts:484](../src/main/index.ts#L484)), next to `runPostUpdateCheck` ([:492](../src/main/index.ts#L492)). It must run **before** `fiscalEngine.start()` ([:1034](../src/main/index.ts#L1034)), whose first tick is immediate. For each order with `fiscal_status IS NULL AND status != 'voided'`, in one transaction:
- **With `fiscal_request_json`:** set `waiting` and insert a fiscal queue row (`next_attempt_at = 0`) from that stored request.
- **Without it:** set `needs_fixing`, `kind 'system'`, with a plain reason saying the sale was interrupted before it reached the tax device and must be checked by a person.

**Why the second case must not be refiled automatically:** the request can't be rebuilt faithfully. `payload_json` stores line items without `vatClass`, `hsCode`, `hsName` or the buyer's company name ([database.ts:1412-1432](../src/main/services/database.ts#L1412-L1432) against [checkout.ts:313-332](../src/main/services/checkout.ts#L313-L332)). A rebuilt request would file every line as class A, which is wrong for any non-A item. Making it visible is Rule 3; filing it with guessed data would break Rule 2.

**"Only once":**
- The sweep is idempotent by its own `WHERE`: a swept row is no longer NULL, so a second start touches nothing.
- With A in place, no new NULL rows can appear, so it is safe to run on every start. That is simpler and safer than a one-shot flag, because it also catches a database restored from an older backup. If you'd rather have a strict one-shot, a `settings` key does it.

**Cost:** one method, one call in `index.ts`, and tests.

**Before shipping B to the till,** run the §3 query on a copy of the till's database:
- Rows **with** a request will be **filed with KRA on the next start**, possibly days after the sale.
- If any of them are test or training sales from set-up, decide first. Voiding them before the update excludes them.

### 4.3 Recommendation

**A plus B, as you proposed.** A closes the gap for every future sale; B cleans up what's already stuck, never refiles a sale without its original request, and runs harmlessly afterwards. A alone would leave any existing NULL rows invisible for ever; B alone would still lose a sale between a crash and the next start, and couldn't recover a sale that stalled before step 5.

---

## 5. The queue must never pick up a sale checkout is filing

**Today, and the risk option A creates:** the queue retries every `etims_invoice` row whose `next_attempt_at <= now` ([database.ts:1525](../src/main/services/database.ts#L1525)). Its "already fiscalized?" check reads the order *before* the device lock ([fiscal-retry.ts:86](../src/main/services/fiscal-retry.ts#L86), phase 184 §7.4).

Under A, the row exists while checkout is still filing. A tick at that moment would pass the check (status `waiting`), then wait on the lock behind checkout and resubmit a sale checkout has just filed. The only thing stopping a second filing would then be the device refusing the duplicate `TraderSystemInvNum`, which has never been seen on a live device. **That is not a guarantee, so A needs a guard of its own.**

**Two candidate guards:**

| Guard | How it works | Weakness |
| --- | --- | --- |
| **Lease:** insert the row with `next_attempt_at = now + 15 min` (`STUCK_WAITING_THRESHOLD_MS`, [database.ts:996](../src/main/services/database.ts#L996)) | The queue can't select it until checkout must be long done | It depends on a time bound. One filing is bounded by the 5 s per-request timeout ([http-client.ts:48](../src/main/services/integrations/http-client.ts#L48), [:501-503](../src/main/services/integrations/http-client.ts#L501-L503)) times at most 2 × (lines + 10) requests, including Code 53 re-sends. That is about 5 min for 20 lines, but checkout can also wait behind one queued sale on the lock, so a 60-line basket under worst-case timeouts could pass 15 min. Manual resend doesn't read `next_attempt_at` at all. |
| **In-flight claim (recommended):** an in-memory set of `localId`s, owned by the fiscal engine. Checkout adds the id **synchronously, straight after the insert returns**, and removes it in a `finally` once the outcome is stored. The tick skips claimed ids before calling `attemptFiscalRetry` (no attempt counted, no backoff), and the resend handler refuses a claimed id. | No timing assumption. A crash empties the set, which is exactly when the queue *should* take over. | — |

**Why the claim closes the race, step by step:**
1. Insert and claim run in the same synchronous stretch of checkout: better-sqlite3 is synchronous, and there is no `await` between the insert ([checkout.ts:575-591](../src/main/services/checkout.ts#L575-L591)) and the claim. JavaScript runs one thing at a time, so no tick or IPC handler can run between them.
2. A tick that fetched its list **before** the insert can't contain the row. A tick that fetches **after** the insert sees it claimed and skips it.
3. By the time the claim is released, checkout has stored the outcome in the same transaction as the row's fate:
   - **success** means the row is deleted, so the queue never sees it again;
   - **non-retryable** means the row is deleted;
   - **retryable** means the row is due now, which is the intended hand-off, as today.
4. Manual resend is refused while the sale is claimed. After that, `attemptFiscalRetry` sees the final status: `fiscalized` short-circuits with no device call ([fiscal-retry.ts:86-95](../src/main/services/fiscal-retry.ts#L86-L95)).

**Where it lives:** the fiscal engine's handle ([fiscal-engine.ts:93-104](../src/main/services/fiscal-engine.ts#L93-L104)) gains `claim`, `release` and `isClaimed`; `tick` skips claimed ids at [:131](../src/main/services/fiscal-engine.ts#L131); checkout already holds `fiscalEngine` in its deps. That is three small touch points and no new table.

---

## 6. The queue's retry goes through `verifyAlreadyFiled`

The chain:
1. Queue tick: `attemptFiscalRetry` ([fiscal-engine.ts:139](../src/main/services/fiscal-engine.ts#L139)).
2. `submitInvoice({ ...request, isRetry: true })` ([fiscal-retry.ts:97](../src/main/services/fiscal-retry.ts#L97)). Manual resend uses the same function ([fiscal-retry.ts:196](../src/main/services/fiscal-retry.ts#L196)).
3. In the provider, if `OpenInvoice` is refused **and** `request.isRetry`, it calls `verifyAlreadyFiled` ([real-etims-provider.ts:1073-1074](../src/main/services/integrations/real-etims-provider.ts#L1073-L1074)), which sends `ReadCUinvoiceNumber`:
   - a device-named number means `already-filed`, and no SellPLU or CloseReceipt is sent;
   - an unverifiable answer means flagged for a person and never resent.

The request stored at insert carries `localId`, so the retry reuses the same `TraderSystemInvNum` (`INV-<localId>`, [real-etims-provider.ts:1651-1657](../src/main/services/integrations/real-etims-provider.ts#L1651-L1657)).

**Crash after the device filed but before the result was stored.** Recognising the sale depends on the device refusing the second `OpenInvoice` for a duplicate `TraderSystemInvNum`.
- The protocol PDF documents this: version 2509041522 "Added new command for request for original invoice number in case of open receipt rejection due to duplicate TRADER SYSTEM INVOICE NUMBER".
- **It has never been captured live** (VERIFY-ON-DEVICE at [real-etims-provider.ts](../src/main/services/integrations/real-etims-provider.ts), `verifyAlreadyFiled` doc).
- Part 2's test proves the app's side with a mock. Only a device can prove the device's side.

**⚠ `TraderSystemInvNum` is unique only within one database.** It is `INV-` plus the local order id. If the till's database was ever reset after live filing began, local ids restart at 1 and new sales reuse numbers already filed. The NSIS uninstaller wiped app data before phase 177's guard, so a reinstall would have done this.
- A new sale would be refused as a "duplicate".
- On its retry, `ReadCUinvoiceNumber` would name the **old** sale's invoice, and the new sale would be marked filed without ever being filed.
- A and B send more sales through the retry path, so this matters more after this phase.
- **Check before Part 2 ships:** was the till's database reset at any point after its first live filing? The lowest `local_id` compared with the date of the first filed invoice will show it.
- The fix, a per-install prefix, is out of scope here; see §7.

---

## 7. Observed but not changed

1. **`TraderSystemInvNum` isn't unique across database resets, or across tills sharing one CU** (§6). The multi-shop rollout will hit this for certain: every till starts at `INV-000000001`. It needs a per-till or per-install prefix inside the 15-character limit (for example a 3-character till code plus a 12-character counter), and a VIL answer on how the device scopes duplicate checks.
2. **`sync_queue` has no uniqueness on `(entity_type, entity_id)`** ([database.ts:572-583](../src/main/services/database.ts#L572-L583)). A manual resend that fails retryably inserts a second fiscal row for a sale that already has one ([fiscal-retry.ts:217](../src/main/services/fiscal-retry.ts#L217)). The tick handles the pair one after the other, and the second is skipped by the `fiscalized` check, so there is no double filing. It is still untidy, and under A every `waiting` sale already has a row. Part 2 could make resend reschedule the existing row instead.
3. **The retryable-failure write isn't atomic today** (step 7b, then 7c). A fixes it as part of the change.
4. The fiscal-status-by-day report puts NULL rows in no bucket (§2). After A and B there won't be any.

## 8. Verification (this Part)

- Read: `runCheckout` in full ([checkout.ts:336-716](../src/main/services/checkout.ts#L336-L716)); `queueOrder` and the three M-Pesa wrappers; `queueFiscalInvoice`; `getPendingFiscalQueue`; `markFiscalQueueItemSynced`; `recordFiscalQueueFailure`; `removeFiscalQueueItem`; `setOrderFiscalInfo`, `Failure` and `Request`; `getOrdersNeedingAttention`; `getUnfiledOrderCount`; the `sync_queue` schema; `fiscal-engine.ts`; `fiscal-retry.ts`; `generateFiscalStatusByDay`; `shouldShowFiscalPendingSlip`; `buildTraderSystemInvNum`; and index.ts's engine start and before-quit order.
- `grep` for every reader of `fiscal_status`, every caller of the four insert paths, and every test referencing the fiscal queue (81 references, 13 files).
- Dev database: copied and queried read-only (§3). The copy was deleted afterwards; the app's own file was never opened.
- Not run: tests or a build (nothing changed), and no device calls.

## 9. Rollback

Nothing to roll back. No code changed; the only file added is this report.

---

# Part 2 — Implementation

- **Date:** 2026-09-29
- **Commit:** `4d75f1d` on `staging`, not pushed.
- **Built as recommended in Part 1:** option A, the in-flight claim (§5) and option B, the start-up sweep. You said "proceed" after the recommendation.
- **One change from §4.1:** the retryable branch needs no `releaseFiscalQueueItem`. The row is inserted already due (`next_attempt_at = 0`), and nothing moves it while checkout holds the claim. So a retryable failure only writes the status.
- **Device calls:** none.

### What changed

| File | Change |
| --- | --- |
| `database.ts` | `QueueOrderInput.buildFiscalRequest(localId)` (optional). When given, `queueOrder` also writes `fiscal_status='waiting'`, `fiscal_request_json` and the due `etims_invoice` row **inside its existing transaction**, and returns `fiscalQueueId`. The three M-Pesa wrappers pass it through unchanged; their return type is now the named `QueuedOrder`. |
| `database.ts` | `settleCheckoutFiscalSuccess(localId, fiscalQueueId, invoice)` and `settleCheckoutFiscalFailure(localId, fiscalQueueId, status, …)`. Each writes the order's outcome and the row's fate **in one transaction**: success and `needs_fixing` delete the row, `waiting` keeps it. Keyed on `localId`, so a filing is recorded even if the row has gone (a void during filing). |
| `database.ts` | `sweepUnqueuedFiscalOrders()` and the two reason constants. Each NULL-status sale that isn't voided is handled as follows:<br>• **With a stored request:** set to `waiting`/`technical` and queued from that request.<br>• **Without one:** set to `needs_fixing`/`system`, "Ask support to check it", and never refiled.<br>It is idempotent by its `WHERE`. |
| `checkout.ts` | Checkout passes `buildFiscalRequest` into every insert.<br>• **Claim:** it claims the sale **before the first `await`** and releases it in a `finally`. The retry hand-off (`onCheckoutMade`) runs **after** the release.<br>• **Removed:** `setOrderFiscalRequest` and `queueFiscalInvoice`, which the insert now does. The thrown-exception branch no longer rebuilds or re-queues anything.<br>• **`CheckoutDb`:** four methods are replaced by the two `settle…` methods. |
| `fiscal-engine.ts` | `claim` / `release` / `isClaimed` over an in-memory `Set`. `tick` skips a claimed sale **before** `attemptFiscalRetry`, so no attempt is counted and no backoff applies. |
| `fiscal-retry.ts` | `FiscalResendDeps.isFiling`. `resendFiscalization` refuses a sale checkout is filing with `SALE_STILL_FILING_REASON`, with no device call and no write. `correctPinAndResend` checks it **before** rewriting the stored request. |
| `index.ts` | The sweep runs after `runPostUpdateCheck` and before the fiscal engine is created or started. Both resend handlers pass `isFiling: fiscalEngine.isClaimed`. |

**The claim can't be skipped:** there is no `await` between the insert and `claim`, only synchronous code (the fire-and-forget Shopify tick and a `getOrder`). JavaScript runs one thing at a time, so no fiscal tick or IPC handler can run in between.

### Every changed test (no assertion changed)

- **The six checkout fakes** (`runCheckout`, `fiscalIntegration`, `cardManualPayment`, `mpesaManualPayment`, `mpesaPaymentGate`, `mpesaPaymentsRecord`): `fiscalEngine: { onCheckoutMade }` gains `claim: vi.fn(), release: vi.fn()`. Without them, 62 tests failed on `claim is not a function`.
- **`runCheckout.test.ts`'s three hand-built `CheckoutDb` fakes** (lines ~168, ~596, ~631): the four removed methods are replaced by `settleCheckoutFiscalSuccess`/`Failure` bound to the real database.
- **No expected value changed.** Part 1 §4.1 expected about 81 queue-count references to need updating. None did: each outcome ends in the same state as before (success: no row; retryable: one due row with 0 attempts; refusal: no row). Only the moment the row is written moved.

### New tests (`tests/fiscalCheckoutDurability.test.ts`, 14)

| Area | Tests |
| --- | --- |
| **A** | A stop during the device call leaves the sale `waiting`, counted and queued, with the exact request in both the order and the row. The next start then files it once, with `isRetry: true`, so `verifyAlreadyFiled` applies. A manual M-Pesa sale gets the same treatment through its wrapper. |
| Outcomes | Success leaves no row. A retryable failure leaves exactly one due row with 0 attempts. A refusal leaves no row. A thrown exception leaves one row. A void during filing still records the filing. |
| Claim | A tick during checkout skips the sale: one device call, 0 attempts. The retryable hand-off tick isn't blocked by the claim. A resend and a PIN correction during checkout are refused, with no call, no write and no rewrite. |
| **B** | The sweep re-queues a stuck sale that has its request (payload verbatim, class-B line kept), flags one without a request, and leaves voided and filed sales alone. A second run changes nothing, and the sweep never touches a sale checkout queued. |

### Mutation checks (each applied, run, then the file restored)

| # | Mutation | Tests that failed |
| --- | --- | --- |
| M1 | `queueOrder` ignores `buildFiscalRequest` | 9 |
| M2 | `tick` doesn't skip a claimed sale | 1 (the tick-during-checkout test: two device calls) |
| M3 | checkout never claims | 3 |
| M4 | hand-off fired before the release | 1 |
| M5 | resend ignores `isFiling` | 2 |
| M6 | PIN correction ignores `isFiling` | 1 |
| M7 | `needs_fixing` keeps its row | 1 |
| M8 | success keeps its row | 1 |
| M9 | success skipped when the row is gone | 1 (void during filing) |
| M10 | sweep refiles a sale with no stored request | 2 |
| M11 | sweep includes voided sales | 1 |

`git diff --stat` was the same after all eleven as before them.

### Verification

- **Type check:** `npm run typecheck` (node and web) clean.
- **Tests:** `npx vitest run`, **152 files, 2,328 tests, all passing** (2,314 before, plus 14 new).
- **Build:** `npm run build` succeeds.
- **Tripwires unchanged:** `real-etims-provider.ts`, `fiscal-routing.ts`, `receiptLayout.ts`, `printer.ts` and `PosCheckoutPanel.tsx`.

### Before this reaches the till

**Run phase 187 first.** The sweep will **file every stuck sale that has a stored request on the first start**, possibly days after the sale (§4.2). If any of them are set-up or training sales, void them before installing. Phase 187's NULL-row count answers this, together with the database-reset check (§6).

### Rollback

- **Code:** `git revert 4d75f1d`. There is no schema change.
- **What a revert doesn't undo:** on a till that has already run this build, the sweep's writes stay. Each is a normal state (`waiting` with a row, or `needs_fixing`) that the older code handles.

### Observed but not changed (Part 2)

1. **A resend that fails retryably still inserts a second row** (§7.2). Under A every `waiting` sale already has one, so this now happens on every such resend rather than occasionally. It is still safe: the second row is short-circuited by the `fiscalized` check.
2. **If `buildFiscalRequest` threw inside the insert, the sale would not be recorded** and checkout would report a failure. Today it is a pure field mapping, but this tightens the old behaviour, where a throw there still completed the sale.
3. **`fiscalQueueId` is read with a cast** in `checkout.ts`. It is always set because checkout always passes the builder, and a runtime throw at that point would break Rule 4 after the sale is recorded, so the cast is the safer choice.
