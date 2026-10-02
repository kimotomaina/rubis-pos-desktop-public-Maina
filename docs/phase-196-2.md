# Phase 196 Part 2 — "Print ETR copy at the fiscal device": audit and build

- **Date:** 2026-10-02
- **Requested:** [phase-196.md](phase-196.md) option B/C follow-up: build an action that sends `InfoLastReceiptDuplicate` (0x3A) once, only when the CU's last receipt is provably this sale's. `ReadOrStoreInvoiceCopy` is not implemented. Skip `check:fit`. Stop before the live send.
- **Outcome:** **Built. Not sent to the live CU.** Typecheck clean; full suite 161 files, 2538 tests passing (158 files, 2489 tests before this phase: 3 new files, 49 new tests); `npm run build` passes including the no-mock-provider check. `check:fit` was not run, as instructed.
- **Branch / base commit:** staging @ d46c26d (version 2.1.4), tree clean at the start apart from the untracked `docs/phase-196.md`. Not committed, not pushed, not deployed.

## 1. Audit

Four decisions were approved after the Step 0 audit: (1) `ReadLastAndTotalReceiptNum` replaces `ReadCUinvoiceNumber` as the device-side check; (2) a post-send read of the last number, recorded in the audit table; (3) the contract cannot prove "issues no new document", and the live test is the proof; (4) `isBusy` and an open-receipt read are added to the provider.

- **`InfoLastReceiptDuplicate`:** identical in both definition versions: no arguments, empty response, "Informs about the issued document" ([tremol-contract.json:4092-4097](../tests/fixtures/tremol-contract.json#L4092-L4097), [tremol-old-contract.json:239-244](../tests/fixtures/tremol-old-contract.json#L239-L244)). Vendor protocol §2.5.9 lists it with the receipt operations, input n/a, output `ACK`, not with the §2.6 register reads that cause "no device activity". Nothing says it opens or closes a receipt. Nothing says it prints, or that it issues no new document.
- **`ReadCUinvoiceNumber` was not usable for the guard:** it answers only a duplicate-`TraderSystemInvNum` rejection ([tremol-contract.json:2305-2329](../tests/fixtures/tremol-contract.json#L2305-L2329)), and the till's ZFPLabServer returns the older `2204120945` definitions that do not declare it ([phase-189.md:59](phase-189.md)).
- **`ReadLastAndTotalReceiptNum` (0x71):** no arguments, returns `LastCUInvoiceNum[19]` ("last number of invoice according the middleware, CU, internal invoice counter", protocol §2.6.5). Declared in both versions. Not called anywhere in `src/` before this phase.
- **Order columns:** `fiscal_invoice_number TEXT`, `fiscal_status` with the value `'fiscalized'` (not "filed"), `fiscal_cu_serial TEXT` ([database.ts:603-613](../src/main/services/database.ts#L603-L613)).
- **Provider seam:** `exclusive()` queues every device call ([real-etims-provider.ts:830](../src/main/services/integrations/real-etims-provider.ts#L830)); the interface had three methods and two implementers.
- **Handler pattern:** the existing `fiscal:*` handlers take no manager PIN; the Admin handlers extend `managerAuthzSchema` and call `requireAdminPin` ([requireAdminPin.ts:43](../src/main/lib/requireAdminPin.ts#L43)). The new handler follows the Admin pattern, as the brief required.
- **Open-receipt state:** the app tracked none; the only source is the device's `Opened_Fiscal_Receipt` bit in `ReadStatus` (byte 2, bit 1), which `readStatus()` ignored.
- **The CU is at head office,** so any paper from this command comes out there ([phase-196.md](phase-196.md) §1).

## 2. Changes

| File | Change |
| --- | --- |
| `src/main/lib/duplicatePrintGuard.ts` (new) | Pure `canPrintDuplicate`. Allowed only when the order is `fiscalized`, nothing else is using the device, no receipt is open, and both numbers are non-empty and equal after `trim()` (case is not folded). Checks in that order, so an unfiled order gets the not-filed sentence whatever the device says. |
| `src/main/services/integrations/etims.ts` | Added `DuplicatePrintDeviceState`, `DuplicatePrintVerdict`, `DuplicatePrintGate`, `DuplicatePrintOutcome` and `printLastReceiptDuplicate(gate)` on `FiscalizationProvider`. |
| `src/main/services/integrations/real-etims-provider.ts` | Two endpoint paths (default `''`). `exclusive()` now counts pending calls. `printLastReceiptDuplicate`: refuses without posting when another call holds the device; otherwise, inside one `exclusive()` section, `ReadStatus`, `ReadLastAndTotalReceiptNum`, the gate, `InfoLastReceiptDuplicate` once, `ReadLastAndTotalReceiptNum` again. The send is posted directly, bypassing `sendCommand`'s Code 53 re-send, so it can never be posted twice. A changed last number after the send is logged as an error. |
| `src/main/services/integrations/mock-etims-provider.ts` | Same method; the mock's "last receipt" is the last invoice it issued; logs `mock: duplicate print`. |
| `src/main/services/fiscal-duplicate-print.ts` (new) | `printFiscalDuplicate(deps, orderId, staffId)`: loads the order, refuses an unfiled order before any device call, builds the gate, calls the provider, writes exactly one audit row whatever the outcome. The audit write never throws. It never writes the order's fiscal columns, `sync_queue` or the fiscal queue. |
| `src/main/services/database.ts` | Table `fiscal_duplicate_prints` (`order_id`, `staff_id`, `requested_at`, `device_last_cu_inv`, `device_last_cu_inv_after`, `result` in `sent`/`refused`/`error`, `error`), `recordFiscalDuplicatePrint` (insert) and `listFiscalDuplicatePrints` (read). `CREATE TABLE IF NOT EXISTS`, so it is safe to re-run and needs no migration. |
| `src/main/lib/ipcValidator.ts`, `src/main/index.ts` | `printFiscalDuplicateSchema` (`managerAuthzSchema` + `orderId`) and the `fiscal:print-duplicate` handler: `guardCheckFitSending`, validate, `requireAdminPin`, then the service with the manager's id as `staff_id`. |
| `src/preload/index.ts`, `src/preload/window.d.ts` | `printFiscalDuplicate(orderId, managerId, managerPin)`. |
| `src/renderer/src/lib/etrCopy.ts` (new) | `getEtrCopyEligibility`: only the newest filed order (by filing time, then local id) is enabled; others carry the reason. |
| `src/renderer/src/components/OrderHistory.tsx`, `App.tsx` | Button "Print ETR copy (prints at the fiscal device, not this till)" beside Print Receipt, disabled with the reason as small text; manager PIN via the existing `requestManagerPin`; toasts: success "Sent to the fiscal device. Check the device's printer.", a warning if the last number changed, and the refusal sentence verbatim. |
| `tests/fiscalIntegration.test.ts`, `tests/orderHistoryPagination.test.ts` | One fixture line each so they still typecheck (`printLastReceiptDuplicate: vi.fn()`, `requestManagerPin: vi.fn()`). No `expect()` was changed. |

## 3. Affected files and functionality

| File | Functionality affected |
| --- | --- |
| `real-etims-provider.ts` | Every device-facing call now passes through a counter in `exclusive()`. The chaining is otherwise unchanged. |
| `etims.ts`, `mock-etims-provider.ts` | A new required interface method; no existing method changed. |
| `database.ts` | One new table and two methods; no existing column or query changed. |
| `OrderHistory.tsx` | One new button per row and a new required prop. Print Receipt and Retry Sync are unchanged. |

## 4. Possible impact

- **Direct:** a manager can now ask the CU for a duplicate of its last receipt from Order History. Nothing happens until a person presses it.
- **Indirect:** the pending-call counter is also incremented by the 30 s connectivity badge poll, so the button can answer "The till is still sending a sale to the fiscal device" for about a second while the badge reads `ReadStatus`. That sentence is then misleading, but harmless: try again.
- **Data / schema / contract:** one new table, additive. No existing table, column or IPC channel changed.
- **Security posture:** the new channel needs a re-verified admin PIN, checked in the main process; the password is never logged (a test captures every console and logger line with debug logging on).
- **Idempotency / re-run safety:** the device command is posted at most once per press and never retried. The table creation is `IF NOT EXISTS`. A double-click sends two requests; the second finds the first's work finished and, if the device last number is unchanged, would print a second duplicate. The button does not guard against that.
- **Residual risk:** unverified on a device. **VERIFY-ON-DEVICE:** that `InfoLastReceiptDuplicate` prints, what it prints and where; that it issues no new document; that `LastCUInvoiceNum` equals the `InvoiceNum` `CloseReceipt` returned (if not, the gate always refuses); that the live ZFPLabServer routes the command.

## 5. Verification

- `npm run typecheck`: exit 0.
- `npx vitest run`: **161 files, 2538 tests passed.** The standing tripwires (`fiscalEngine`, `fiscalRouting`, `mpesaPaymentGate`) are in that run and were not modified.
- `npm run build`: exit 0; "neither mock provider is in out/main".
- **New tests (49):** `duplicatePrintGuard.test.ts` (18), `etrCopy.test.ts` (5), `fiscalDuplicatePrint.test.ts` (26).
- **Mutation check:** the guard forced to `return { allowed: true }`: **20 tests failed**, all 16 refusal cases in `duplicatePrintGuard.test.ts` plus, in `fiscalDuplicatePrint.test.ts`, "refuses, without queueing or posting anything, while another call is using the device", "refuses an unfiled order without calling the device…", "refuses when the device last number differs…" and the end-to-end "one InfoLastReceiptDuplicate when numbers match, none when they differ". Restored; the file was byte-identical to the backup and all 49 passed again.
- **Added `expect()` calls:** 16 in `duplicatePrintGuard.test.ts`, 10 in `etrCopy.test.ts`, 69 in `fiscalDuplicatePrint.test.ts`. Changed or removed `expect()` calls in existing tests: none.
- **Not covered:** the `fiscal:print-duplicate` handler's own wiring (schema, PIN check) has no unit test, the same as every other handler in `index.ts`; its logic lives in the tested service. No test renders the new button's click path through the PIN modal. `check:fit` was not run.

## 6. Rollback

`git checkout -- src tests` for the twelve modified files, then delete `duplicatePrintGuard.ts`, `fiscal-duplicate-print.ts`, `etrCopy.ts`, the three new test files and `docs/phase-196-2.md`. The `fiscal_duplicate_prints` table may remain in a database that already ran this build; nothing reads it and it is harmless.

## 7. Observed but not changed

- The first live send is a separate approved step: one 1 KSh class A sale, then the button once, with someone at head office watching the CU. Record: did paper come out, what it says, how long it took, `ReadStatus` before and after, and the audit row. Only then decide whether the feature ships or is removed.
- A failed PIN check or an invalid request writes no audit row (there is no authorised actor to record). Every outcome after that does.
- The eligibility hint looks only at the 50 orders Order History loads.
- `fiscal:resend` and `fiscal:correct-pin-and-resend` take no manager PIN, unlike this action.
- Order History still labels the fiscal line `Fiscal Inv:` while the printed receipt says `CU Invoice No:` (phase 164).
- `docs/POC_AS_BUILT_ASSESSMENT.md` is stale on printing: the till does print automatically after checkout (phase 165).
- The audit table is append-only by convention (one insert path), not by database triggers, so that the data-reset script is unaffected.
