# Phase 186 — Offline endurance, queue give-up limit and device session (Part 1, read-only)

- **Date:** 2026-09-29
- **Requested:** Part 1, read-only:
  - the fiscal queue's attempt limit, backoff and tick, and what "abandoned" does;
  - when a sale made at the start of a 24 h or 72 h outage is abandoned;
  - whether "unreachable" is distinguished from a real refusal;
  - how the device session is held;
  - the smallest change so unreachability never abandons a sale.

  Then STOP.
- **Outcome:** Part 1 complete. Two findings are worse than the brief assumes (§3). The proposed change is in §5.
- **Branch / base commit:** staging @ 999fb48, tree clean. No code changed, and no device, ZFPLabServer or Shopify calls.
- **Working assumptions (from the brief):** shops sell offline and file when the connection returns. The CU is at head office, so a shop without network can't reach it. ZFPLabServer runs on the till. The outage length (R8) is open, so 24 h and 72 h are used.

---

## 1. The queue's give-up machinery

| What | Value | Where |
| --- | --- | --- |
| Tick interval | 30 s, plus an immediate tick at start, after a checkout that queued, and on offline→online | [fiscal-engine.ts:114](../src/main/services/fiscal-engine.ts#L114), [index.ts:998](../src/main/index.ts#L998), [fiscal-engine.ts:195-216](../src/main/services/fiscal-engine.ts#L195-L216) |
| Attempt limit | `SYNC_MAX_ATTEMPTS = 10`; not overridden in `index.ts` (`createDatabase({ dbPath })`) | [database.ts:398](../src/main/services/database.ts#L398), [:1257](../src/main/services/database.ts#L1257), [index.ts:483](../src/main/index.ts#L483) |
| Backoff | `min(30 s × 2^(n−1), 30 min)`, where n = failed attempts so far | [database.ts:392-412](../src/main/services/database.ts#L392-L412) |
| Counting | Every **retryable** failed retry: `attempts + 1`, then `next_attempt_at = now + backoff(attempts)`. At `attempts >= 10` the row is abandoned. | `recordFiscalQueueFailure`, [database.ts:1591-1607](../src/main/services/database.ts#L1591-L1607), called from [fiscal-engine.ts:166-173](../src/main/services/fiscal-engine.ts#L166-L173) |
| Shared with Shopify | The same `maxAttempts` and `computeBackoffMs` drive the Shopify `order` queue (`recordQueueFailure`, [database.ts:~2040-2060](../src/main/services/database.ts#L2040-L2060)) | The Part 2 change must leave that queue alone |

**What "abandoned" does:**
- **The queue row** gets `last_error = 'ABANDONED after 10 attempts: …'` and `next_attempt_at = Number.MAX_SAFE_INTEGER` ([database.ts:1599-1600](../src/main/services/database.ts#L1599-L1600)). It is kept, but **never picked again**, even after the connection returns. `getPendingFiscalQueue` needs `next_attempt_at <= now` ([database.ts:1525](../src/main/services/database.ts#L1525)).
- **The order is untouched.** It stays `fiscal_status = 'waiting'` with whatever reason checkout stored at the first failure.
- **The unfiled count** still counts it ([database.ts:2171](../src/main/services/database.ts#L2171)).
- **Needs Attention** shows it, because it has been `waiting` for over 15 min ([database.ts:2151-2152](../src/main/services/database.ts#L2151-L2152)). The screen has no sign that it was abandoned: the reason shown is the order's, not the queue row's `last_error`.
- **The log** gets one `console.warn` line ([fiscal-engine.ts:170-172](../src/main/services/fiscal-engine.ts#L170-L172)), which a packaged till doesn't keep.
- **Only a person pressing Resend revives it** ([fiscal-retry.ts:159-227](../src/main/services/fiscal-retry.ts#L159-L227)). A resend that fails retryably inserts a *new* row; the abandoned one stays in the table for ever.

## 2. When a sale made at the start of an outage is abandoned

A sale at t = 0 fails at checkout (not counted), is queued with `next_attempt_at = 0`, and the immediate tick makes counted attempt 1.

| Counted attempt | At (s) | Backoff after it (s) |
| --- | --- | --- |
| 1 | 0 | 30 |
| 2 | 30 | 60 |
| 3 | 90 | 120 |
| 4 | 210 | 240 |
| 5 | 450 | 480 |
| 6 | 930 | 960 |
| 7 | 1,890 | 1,920 → capped at 1,800 |
| 8 | 3,690 | 1,800 |
| 9 | 5,490 | 1,800 |
| **10** | **7,290** | **abandoned** |

The sum is 30 + 60 + 120 + 240 + 480 + 960 + 1,800 × 3 = **7,290 s = 2 h 01 min 30 s**. Each wait can stretch by up to one 30 s tick, and each failing attempt takes up to about 10 s (§3), so in practice it is **about 2 h 00 min to 2 h 07 min**. The comment at [database.ts:988](../src/main/services/database.ts#L988) says "roughly 2.5 hours", which overstates it slightly.

| Outage | Sales abandoned (never retried when the connection returns) | Sales that file on their own |
| --- | --- | --- |
| **24 h** | every sale made in the **first ~22 h** | only the last ~2 h |
| **72 h** | every sale made in the **first ~70 h** | only the last ~2 h |

After an outage longer than about 2 hours, nearly every sale waits for someone to press Resend, one at a time. And this is the **better** of the two possible outcomes (§3).

## 3. Unreachable versus a real refusal

**The engine doesn't distinguish them.** It sees only `retryable` ([fiscal-engine.ts:166](../src/main/services/fiscal-engine.ts#L166)):
- every retryable failure counts towards the 10;
- every non-retryable one goes straight to `needs_fixing`.

That includes the state refusals the device answered: `STE2 0x32` Illegal command (phase 184), `STE1=52` opened receipt, and `STE1=59` daily-closure block.

**⚠ Worse: a transport failure is classified *non*-retryable.** "Unreachable" arrives in one of two forms:

| Form | Example | What happens today |
| --- | --- | --- |
| **ZFPLabServer answers with a server code** | Code 30 "ServSockConnectionFailed", 19, 31, 53 | `mapFiscalServerError` marks it retryable ([real-etims-provider.ts:372-401](../src/main/services/integrations/real-etims-provider.ts#L372-L401)): `waiting`, queued, and **abandoned after ~2 h** (§2). |
| **No `<Res>` at all:** connection refused, or our own 5 s request timeout fires first | `postXml`/`sendGet` catch the error and return `{ success: false, error }` with **no `code` and no `retryable`** ([http-client.ts:419-427](../src/main/services/integrations/http-client.ts#L419-L427), [:460-464](../src/main/services/integrations/http-client.ts#L460-L464)). `checkDeviceResponse` passes it straight through. `classifyDeviceFailure` then finds `retryable` falsy and returns **`retryable: false`**, `kind: 'data'`, or `'system'` at ReadStatus ([real-etims-provider.ts:640-669](../src/main/services/integrations/real-etims-provider.ts#L640-L669)). | **`needs_fixing` at checkout, never queued**: every outage sale waits for a person from the first minute. |

**Which form a CU outage produces is not known.** It depends on how fast ZFPLabServer gives up connecting to the CU at head office. `settings()` succeeds locally because it never contacts the device ([http-client.ts:272-276](../src/main/services/integrations/http-client.ts#L272-L276)); the first command that goes to the CU is ReadStatus.
- If the till's own link is down, the OS usually fails the connect at once. ZFPLab would then return Code 30 inside 5 s: first form.
- If the link is up but the path to head office drops packets, a TCP connect takes about 21 s on Windows. Our 5 s timeout ([http-client.ts:48](../src/main/services/integrations/http-client.ts#L48)) fires first: second form.

That can be measured on the till in two ways:
- **An offline test sale:** with the network cable pulled, ring up 1 KSh, then read the reason on Needs Attention (phase 184 now names the step).
- **Or with no sale:** Test Connection with the cable pulled. "Could not reach the fiscal server" means the second form; a device-hop failure means the first.

**No test covers this.** The "offline" integration tests make `submitInvoice` *throw* ([fiscalIntegration.test.ts:220-256](../tests/fiscalIntegration.test.ts#L220-L256)). The real provider never throws on a network error: it returns a result, which is the path described above. The one provider-level ECONNREFUSED test asserts only `ok: false` ([realEtimsProvider.test.ts:1745-1752](../tests/realEtimsProvider.test.ts#L1745-L1752)).

## 4. The device session (report only; no change until VIL answers question 10)

| What | Today | Where |
| --- | --- | --- |
| `settings()` | Sent **once per app run**, then cached. It is re-sent only after a Code 53, an Admin save (`reconfigure`), Test connection or `closeServerConnection`. | `ensureSettings`, [real-etims-provider.ts](../src/main/services/integrations/real-etims-provider.ts) (`settingsPromise`); `reconfigure` / `testConnection` / `closeServerConnection` |
| `keepPortOpen` | **Not sent** on the shipped path. With `FISCAL_SEND_KEEP_PORT_OPEN_ZERO=true` it sends `,keepPortOpen=0`, an experiment the vendor documents only for serial. The server keeps the value once set. | [http-client.ts:195-266](../src/main/services/integrations/http-client.ts#L195-L266) |
| `clientremove(who=me)` | **Only on quit**, fire-and-forget. Since phase 184 it runs after any sale in flight. | [index.ts:1132-1140](../src/main/index.ts#L1132-L1140) |
| Idle traffic | The status badge sends `ReadStatus` **every 30 s** whether or not anyone is selling, so the till talks to the CU around the clock. | [index.ts:1095-1119](../src/main/index.ts#L1095-L1119) |

**VIL's workflow** (`VIL G03 INTEGRATION WORKFLOW.pdf`) lists Steps 1-9 per invoice:
- Step 2: "SETTINGS — Establish Connection between the API and the CU device."
- Step 9: "CLOSESERVERCONNECTION — API close connection with the CU device. *** important to ensure that the connection is only active when in use."

**Differences from VIL's workflow:**
1. The app keeps the ZFPLab client session open for the whole run instead of opening and closing it around each invoice.
2. The 30 s badge poll keeps the CU busy while the till is idle. On a CU shared by every shop, that load grows with every till.

The code never says whether ZFPLabServer holds the **TCP** socket to the CU open between commands; that is internal to ZFPLabServer. This is VIL question 10, and nothing changes here until it's answered.

## 5. Proposed change: unreachability never abandons a sale

Two small parts. Both are needed, because part A alone would turn `needs_fixing` into the ~2 h abandonment, and part B alone would never see the transport case.

**A. The provider marks "not reached" and makes it retryable** (`real-etims-provider.ts`, `etims.ts`):
- `FiscalSubmitOutcome`'s failure branch gains one optional flag, `unreachable?: true` ([etims.ts:238-255](../src/main/services/integrations/etims.ts#L238-L255)).
- `classifyDeviceFailure` ([real-etims-provider.ts:640-669](../src/main/services/integrations/real-etims-provider.ts#L640-L669)) also receives `serverFailure` and `notReady`, and sets `unreachable: true, retryable: true, kind: 'technical'` when:
  - **no `<Res>` came back** (`code === undefined` and not a `notReady` status read, which *is* a device answer), or
  - **ZFPLab reported a server-side retryable code** (19/30/31/53, `serverFailure` set).
- **One exception, to keep "never file twice":** a transport failure **at `CloseReceipt`** stays as today, not retryable, for a person. A lost `CloseReceipt` reply is the one case where the device may already have filed the sale. Retrying it automatically would rely on the device refusing the duplicate `TraderSystemInvNum`, which has never been captured live (phase 185 §6). Server codes 19/30/31/53 at `CloseReceipt` mean ZFPLab never reached the device, so they stay retryable.
- **What stays exactly as today:** Code 40 refusals (including `0x32`, `STE1=52` and `59`), server codes 50-52/62/63, and `notReady`.

**B. The engine never counts an unreachable attempt, and keeps the queue in order** (`fiscal-engine.ts` `tick`, [:131-188](../src/main/services/fiscal-engine.ts#L131-L188)):
- On a failure with `unreachable`, **don't call `recordFiscalQueueFailure`** and **end this pass** (`break`). The row keeps its attempt count and its due time, and nothing later in the queue is tried in the same pass: it would fail the same way, and trying it could file sales out of order.
- The next tick, 30 s later, tries the oldest due row again. That is one quick failing request every 30 s while the device is away.
- When the device is back, the first tick files every due row oldest-first in one pass, one sale at a time through the phase-184 lock.
- **Real refusals** (retryable but not `unreachable`) keep `recordFiscalQueueFailure`, the existing limit of 10 and the backoff. **Non-retryable** failures keep going to `needs_fixing`.
- **No schema change**, nothing in `database.ts`, and **the Shopify queue is untouched**.

**Why not cap the backoff instead?** A cap keeps the attempt count, so a long outage still abandons unless the limit is removed for everything. It also lets sales file out of order after reconnection, because each row has its own due time.

**Cost:** about 25 lines across three files. The Part 2 tests you listed apply:
- a simulated 72 h outage leaves every sale `waiting`, all due, `attempts = 0`;
- all of them file in id order with no duplicates once the mock becomes reachable;
- a data refusal still ends in `needs_fixing`;
- a device-answered `0x32` still counts;
- a transport failure at `CloseReceipt` is still not retried;
- plus the provider-level transport → `unreachable` case the suite is missing (§3).

**Visible effects:**
- During an outage, sales read "Tax device unavailable. This sale will be sent automatically" ([fiscalNotice.ts:46-51](../src/renderer/src/lib/fiscalNotice.ts#L46-L51)) instead of today's "rejected… flagged for correction" in the transport case.
- Needs Attention still lists them after 15 min (`waiting`), and the unfiled count is correct throughout.

**Decision for you: the daily-closure block (`STE1=59`).** It is a device-answered, retryable state that can last a whole day or a weekend. Under the rule above it keeps the limit of 10, so it is abandoned after ~2 h. If you'd rather it waited like an outage, it can be marked `unreachable` too, a one-line addition. My view is that it should: it heals on its own once the closure is run, like an outage.

## 6. Verification (this Part)

- Read: `fiscal-engine.ts` (tick, triggers), `computeBackoffMs` and the constants, `recordFiscalQueueFailure`, `getPendingFiscalQueue`, `getOrdersNeedingAttention`, `getUnfiledOrderCount` and `resendFiscalization`. Also `postXml`/`sendGet`/`getSettings`/`closeDeviceConnection`/`buildSettingsCommand`, and `checkDeviceResponse`/`classifyDeviceFailure`/`mapFiscalServerError`.
- Also read: the index.ts engine wiring, badge and before-quit code, and every test that simulates a network error (§3).
- VIL manual text extracted with pypdf (Steps 1-9).
- Not run: tests or a build (nothing changed), and no device calls.

## 7. Observed but not changed

1. **Checkout is slow during an outage.** Each checkout makes its own first attempt, which in the timeout form costs about 5 s for `ReadCUnumbers` (tried again every sale while it keeps failing) plus about 5 s for `ReadStatus`. It can also wait behind the queue's attempt on the lock, so the cashier waits up to about 20 s per sale. A later change could skip the immediate attempt when the engine already knows the device is away.
2. **An abandoned row is invisible as abandoned.** Needs Attention shows the order's first-failure reason, not the queue's `ABANDONED` note. After part B this only concerns real refusals.
3. **A resend of an abandoned sale leaves the dead row behind** (phase 185 §7.2).
4. **The comment at [database.ts:988](../src/main/services/database.ts#L988)** says abandonment takes about 2.5 h; it is about 2 h (§2).

## 8. Rollback

Nothing to roll back. No code changed; the only file added is this report.

---

# Part 2 — Implementation

- **Date:** 2026-09-29
- **Commit:** `2555486` on `staging`, on top of phase 185 Part 2 (`4d75f1d`). Not pushed.
- **Built as proposed in §5.** You chose the recommended answer to the one decision: **the missing daily closure (`STE1=59`) counts as unreachable**.
- **Device calls:** none.

### What changed

| File | Change |
| --- | --- |
| `etims.ts` | The failure branch of `FiscalSubmitOutcome` gains `unreachable?: true`, documented. |
| `real-etims-provider.ts` | `classifyDeviceFailure` also reads `serverFailure` and `notReady`. It returns `{ retryable: true, kind: 'technical', unreachable: true }` when:<br>• no `<Res>` came back (`code` undefined and not a `notReady` read);<br>• ZFPLabServer reported a retryable server code (`serverFailure` set: 19/30/31/53);<br>• the device answered `STE1=59`.<br>The one exception, a lost reply (no `<Res>`) at `CloseReceipt`, keeps today's non-retryable routing. |
| `fiscal-engine.ts` | `tick`: on an `unreachable` failure, **no `recordFiscalQueueFailure` and `break`**. One log line per pass. The file doc now says so. |

**Left exactly as today:**
- Code 40 refusals, including `0x32` (retryable, counted).
- `STE1=52` (opened receipt).
- Server codes 50-52, 62 and 63.
- `notReady`.
- The not-configured short-circuit (retryable, counted).
- The Shopify queue, the schema and `database.ts`.

### Every changed test

**None.** All 2,328 existing tests passed unchanged after the provider and engine edits. None of them asserts the full shape of an outcome the new flag appears on.

### New tests (`tests/fiscalOfflineEndurance.test.ts`, 14)

**Provider** (real provider, mocked transport):
- **Unreachable:** connection refused at `ReadStatus`, our own timeout at `OpenInvoice`, Code 30 at `OpenInvoice`, Code 30 at `CloseReceipt` and Code 19 at a sell command are all `unreachable`, retryable and `technical`. `STE1=59` is `unreachable` too, with its cashier reason unchanged.
- **Not unreachable:**
  - a lost `CloseReceipt` reply: not retryable (the device may already have filed);
  - `0x32`: retryable, not unreachable;
  - a wrong client PIN: `data`/`wrong-pin`;
  - "not fiscalized": `system`.

**Engine** (real engine, real database, real provider):
- **A 72-hour outage:**
  - Five sales are made at checkout while the device is refused.
  - Then the engine runs **8,640 passes**, 30 s of simulated time each.
  - Every sale is still `waiting`, due, at 0 attempts with no error, and all are counted as unfiled.
  - The device returns, and one pass files all five **in id order** (the `TraderSystemInvNum` sequence on `OpenInvoice`), each once, with five distinct invoice numbers and no rows left.
- **While unreachable,** one pass tries only the oldest sale.
- **Real refusals keep their routing:**
  - A data refusal on retry still ends in `needs_fixing` and leaves the queue.
  - A device-answered `0x32` still counts: ten of them abandon the row (`ABANDONED…`), as before.

### Mutation checks (each applied, run, then the file restored)

| # | Mutation | Tests that failed |
| --- | --- | --- |
| N1 | a missing `<Res>` is not unreachable | 3 (including the 72-hour run) |
| N2 | a server code is not unreachable | 3 |
| N3 | a lost `CloseReceipt` reply treated as unreachable | 1 |
| N4 | `STE1=59` counted | 1 |
| N5 | a `notReady` read treated as unreachable | 1 |
| N6 | the pass keeps going after an unreachable failure | 1 |
| N7 | the engine counts unreachable failures | 2 |

`git diff --stat` was clean after all seven.

### Verification

- **Type check:** `npm run typecheck` clean.
- **Tests:** `npx vitest run`, **153 files, 2,342 tests, all passing.**
- **Build:** `npm run build` succeeds.
- **Tripwires unchanged:** `receiptLayout.ts`, `printer.ts`, the renderer components, `fiscal-routing.ts`, `checkout.ts` and `database.ts`.

### What this changes on the till

- **During an outage of any length**, every sale made or queued stays `waiting`, never abandoned. The engine sends one quick request every 30 s until the device answers.
- **When the device answers again**, the queue files everything oldest-first in one pass.
- **Needs Attention** still lists each sale after 15 minutes, and the unfiled count is right throughout.
- **A wrong TCP password (Code 31)** now also waits instead of being abandoned after about 2 h. It shows in Needs Attention and heals once the password is fixed.
- **The shop still has to measure which form an outage takes** (§3: an offline test sale, or Test Connection with the cable out). Both forms are now handled the same way.

### Rollback

`git revert 2555486`. There is no schema or data change.

### Observed but not changed (Part 2)

1. **A retry whose `OpenInvoice` itself times out**, on a server with the old definitions, is still flagged `unverifiable`:
   - `verifyAlreadyFiled` treats a missing `<Res>` as "the device may have seen it".
   - It only happens if an outage starts between `ReadStatus` and `OpenInvoice`, and flagging is the safe side.
   - Changing it would touch the Rule-1 recovery logic, so it is left alone.
2. **The Code 53 re-send path** (`sendCommand`: `settings()` fails again after a 53) returns a bare `code '53'` without the settings failure's classification, so it still ends in `needs_fixing`.
   - It needs ZFPLabServer itself to go down between two calls; `settings()` never contacts the device.
   - A one-line fix (return the settings result as-is) would also change `verifyAlreadyFiled`'s `deviceNeverSawIt`, so it is deferred.
3. **Checkout during an outage still makes its own first attempt** (§7.1), up to about 10-20 s per sale in the timeout form. Skipping it when the engine already knows the device is away is a separate change.
