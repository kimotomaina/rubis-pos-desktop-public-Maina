# Phase 162 - Name the fiscal device's "missing daily Z report" condition (STE1 = 0x3b) correctly

- **Date:** 2026-09-26
- **Requested:** decode `STE1 = 0x3b` (59 decimal, "24 hours block, missing Z report") explicitly in `checkDeviceResponse`, instead of letting it fall through to `STE2`'s unrelated command-errors table, without changing any command sent, argument, sequence, or filed data. Based on docs/phase-159 B1.5 and its proposed build 6.
- **Outcome:** Implemented.
- **Branch / base commit:** staging @ a96e1a3 (Phase 161-1 - fail-closed live-fiscal-mode discount safeguard).

## STEP 0: AUDIT

### What was examined

- `src/main/services/integrations/real-etims-provider.ts` - `checkDeviceResponse` (response parsing), `classifyDeviceFailure` (the `submitInvoice`-facing outcome builder), `mapFiscalDeviceError` (the `STE2` command-errors table), `submitInvoice` itself (the seven-step workflow, its rollback calls, and the `verifyAlreadyFiled` retry-recovery path).
- `src/main/services/fiscal-retry.ts` - `attemptFiscalRetry`/`resendFiscalization` (how a queued or manual resend re-enters `submitInvoice`, always with `isRetry: true`).
- `src/main/services/fiscal-routing.ts` - `routeFiscalOutcome` (how `retryable` becomes a `fiscal_status` and an enqueue decision).
- `src/main/services/integrations/etims.ts` - `FiscalFailureKind`/`FiscalSubmitOutcome` types, `dataIssue`'s doc comment.
- `docs/phase-159.md` Part B1.5 and Part B3 build 6 - the audit and the proposed build this phase implements.
- `docs/KNOWN_GAPS.md`'s "Fiscal device daily closure" entry - the gap this phase updates.
- `tests/realEtimsProvider.test.ts` - the existing STE1/STE2 tripwire tests (Code 40 wire-shape helper `xmlCommandError`, the STE1=52 open-receipt tests, the STE2=59 wrong-PIN tests) to match established test style and confirm nothing there needed to change.

### How it currently works

`RealFiscalizationProvider.submitInvoice` runs seven steps against the local ZFPLabServer: `settings()` (once per session), `ReadStatus`, `OpenInvoiceWithFreeCustomerData`, `SellPLUfromExtDB`/`_HS` per line, `ReadCurrentReceiptInfo`, `CloseReceipt`, `ReadDateTime`. Every command (except the best-effort `ReadDateTime`) goes through `sendCommand` → `checkDeviceResponse`, which turns the raw `<Res Code>` envelope into a `DeviceResult` carrying `code`/`retryable`.

Before this change, `checkDeviceResponse`'s `Code 40` ("command error") branch (`real-etims-provider.ts:522-565` pre-change) named exactly one `STE1` value: `52` (hex `0x34`, "Opened fiscal receipt", cancel-and-retry-once). Any other `STE1`, including `59` (hex `0x3b`), fell straight through to `STE2`'s lookup table (`mapFiscalDeviceError`). Since `STE2 = '59'` happens to mean "Wrong client PIN" in that table, a device genuinely blocked pending its daily Z-report closure (a device-wide, unrelated condition) could surface to a cashier as a PIN problem - a misleading reason for the actual cause, and (before this phase) potentially tagged `dataIssue: 'wrong-pin'` by `classifyDeviceFailure` if the real device happens to pair `STE1=59` with `STE2=59` (unverified - see Residual risk below).

### Dependencies found

- **Inbound (callers of `checkDeviceResponse`):** only `RealFiscalizationProvider`'s own `sendCommand`/`ensureSettings`, both inside this same file. No other module calls it.
- **Inbound (callers of `classifyDeviceFailure`):** every non-success branch of `submitInvoice` (`ensureSettings`, `readStatus`, `OpenInvoice`, each `SellPLU` call, `ReadCurrentReceiptInfo`, `CloseReceipt`) - all in this same file.
- **Outbound:** `checkDeviceResponse` depends on `parseXmlResponse` (`xml-utils.ts`) for the `data.STE1`/`data.STE2`/`data.errSource`/`data.code`/`data.Message` fields it reads; confirmed field names directly in `xml-utils.ts:136-183`.
- **String-based / indirect references:** none. `STE1`/`STE2` are plain object keys populated by regex matches on the `<Err ... STE1="..." STE2="...">` attributes - no route names, DI tokens, or config keys involved.
- **Downstream of the outcome:** `classifyDeviceFailure`'s return flows into `fiscal-routing.ts`'s `routeFiscalOutcome` (maps `retryable` to `'waiting'`/enqueue) and, for a resend, `fiscal-retry.ts`'s `resendFiscalization`/`buildFiscalResendResult`. Neither needed a change - both already act purely on `retryable`/`kind`/`dataIssue`, generically.

### Risks and constraints identified

- Cross-boundary contract: none. This is a same-process response-parsing change; no wire command, argument, or sequence changes.
- Test coverage: `tests/realEtimsProvider.test.ts` already has dedicated STE1=52 and STE2=59 tripwire tests (see the task's own hard rule to list any changed assertion by name - **none were changed**, only new tests added; see Verification).
- Load-bearing oddity: `classifyDeviceFailure`'s `retryable` check runs *before* its `dataIssue: 'wrong-pin'` tagging (`real-etims-provider.ts`, `classifyDeviceFailure`) - this ordering is what makes "never tag `wrong-pin`" fall out automatically from setting `retryable: true`, with no extra guard needed. Confirmed by reading the function body, not assumed.

### STEP 0a - At which of the seven `submitInvoice` steps can `STE1 = 0x3b` arrive, and could a receipt be left open?

`checkDeviceResponse` is a single shared parser called by every command `sendCommand` sends - it does not know or care which step it is being called for, so `STE1 = 0x3b` can in principle arrive on the response to *any* command, including `settings()` and `ReadDateTime`. The task's own audit item scoped this to five steps; for each:

| Step | Command | Receipt state if it fails here | Left open? |
| --- | --- | --- | --- |
| 2 | `ReadStatus` | No receipt has been opened yet (this runs before `OpenInvoice`). | No - nothing to leave open. |
| 3 | `OpenInvoiceWithFreeCustomerData` | The open itself was rejected - no receipt exists on the device from this attempt. | No. `submitInvoice` does not call `rollback()` on an `OpenInvoice` failure (`real-etims-provider.ts`, after the `isRetry`/`verifyAlreadyFiled` block) - correctly, since there is nothing to cancel. |
| 4 | `SellPLUfromExtDB`/`_HS` | Receipt is open (from step 3). | No - `submitInvoice` calls `await this.rollback()` (sends `CancelReceipt`) unconditionally before returning on a `SellPLU` failure, regardless of what error code caused it. |
| 5 | `ReadCurrentReceiptInfo` | Receipt is open, items sold. | No - same unconditional `rollback()` before returning. |
| 6 | `CloseReceipt` | Receipt is open, items sold, close itself rejected. | No - same unconditional `rollback()` before returning. |

`rollback()`'s `CancelReceipt` is itself best-effort (its own result is only logged, never checked) - that is a pre-existing characteristic of the rollback mechanism for *every* mid-receipt failure today (any `STE2` code, not just `59`), not something this phase introduces or changes.

### STEP 0b - What would an automatic retry do, and can it ever produce a second fiscal document?

**Conclusion: never**, for all five steps. Two independent guards already in the code establish this, quoted below:

1. **A fiscal document is only ever produced by a successful `CloseReceipt`.** `submitInvoice` only ever returns `invoiceNumber` (the sale's proof of filing) from the block starting at:
   ```
   const invoiceNumber = extractInvoiceNumberFromXml(closeResult.data ?? {})
   ```
   (immediately after Step 6's `closeResult.success` check). Every one of the five steps in the table above, when it fails with `STE1 = 0x3b`, fails *before or at* `CloseReceipt` - so the attempt that returns the `0x3b` failure to the caller categorically cannot be the attempt that filed the sale. A retry of that same failed attempt starts the whole sequence over; it can only add a *new* successful `CloseReceipt` later (filing the sale exactly once, whenever it finally succeeds), never a duplicate of one that already happened, because none happened.

2. **`verifyAlreadyFiled` guards every subsequent retry's `OpenInvoice`, independent of why the previous attempt failed.** `submitInvoice`'s retry branch:
   ```ts
   if (!openResult.success && request.isRetry) {
     const verdict = await this.verifyAlreadyFiled(defVer, openResult, request.localId)
     if (verdict.outcome === 'already-filed') { ... return { ok: true, ... } }
     if (verdict.outcome === 'unverifiable') { ... return { ok: false, ..., retryable: false } }
   }
   ```
   fires whenever a retried sale's `OpenInvoice` is rejected, for *any* reason - not keyed to a particular error code. It calls `ReadCUinvoiceNumber` (keyed on the sale's stable `TraderSystemInvNum`, built once per sale by `buildTraderSystemInvNum` from `localId`) before ever concluding the sale still needs filing. If the device holds no record under that number - which is guaranteed here, since guard 1 already established no `CloseReceipt` ever succeeded for a `0x3b`-failed attempt - `verifyAlreadyFiled` reports `'genuine-failure'` and the retry is routed normally (queued again if still blocked). This is the pre-existing Rule 1 protection (docs/phase-75) that already covers *every* retry of *every* kind of prior failure; it needed no change for this phase.

Because a `0x3b`-blocked device refuses commands device-wide rather than selectively completing part of the sequence and only failing later, every retry either (a) hits the same block again at whichever step and fails again with no document created, or (b) the block clears and the retry proceeds through the full seven-step sequence exactly once, filing exactly one document. Either way, no path produces two.

### STEP 0c - How are `STE1` values represented, and is `0x3b = 59`?

Confirmed directly: `parseXmlResponse` (`xml-utils.ts:149-152`) reads `STE1` as the raw hex string from the `<Err ... STE1="...">` attribute; `checkDeviceResponse` then does `parseInt(ste1Hex, 16)` to get the decimal value used in comparisons - the same pattern the existing `STE1_OPENED_FISCAL_RECEIPT = 52` constant already documents for hex `0x34`. `parseInt('3b', 16) === 59` - confirmed by running it, and by the new tests below, which build the hex via `(59).toString(16) === '3b'` and assert the resulting decimal comparison fires.

## 2. Changes made

- **`src/main/services/integrations/real-etims-provider.ts`:**
  - Added `STE1_DAILY_CLOSURE_BLOCK = 59`, `CODE_DAILY_CLOSURE_BLOCK = 'dailyClosureBlock'`, and the exported `DAILY_CLOSURE_BLOCK_REASON` cashier-facing string constant, placed alongside the existing `STE1_OPENED_FISCAL_RECEIPT`/`CODE_OPENED_FISCAL_RECEIPT` pair they mirror.
  - In `checkDeviceResponse`'s `Code 40` branch, added a new `if (ste1 === STE1_DAILY_CLOSURE_BLOCK)` check immediately after the existing `STE1 = 52` check and before the `STE2` lookup - fires on `STE1` alone, never reading or branching on `STE2`'s value. Returns `retryable: true` and the plain cashier reason.
  - No change to `classifyDeviceFailure`: its existing `if (result.retryable) { return { ..., kind: 'technical', retryable: true } }` branch already runs before the `dataIssue: 'wrong-pin'` tagging further down, so setting `retryable: true` in `checkDeviceResponse` automatically produces `kind: 'technical'` and never tags `dataIssue` - confirmed by the mutation test (see Verification), not assumed. Updated its doc comment only, to name the new case.
  - Updated `checkDeviceResponse`'s own doc comment to describe the new branch in its resolution order.
  - No new logging call added: the existing unconditional `console.warn` at the top of the `Code 40` branch already logs `STE1`/`STE2` in both hex and decimal (plus `FPLibErrorCode`) for every Code 40 occurrence, including this new case, with no password anywhere in it - satisfying the task's logging requirement via the existing pattern rather than a duplicate log line.
- **`tests/realEtimsProvider.test.ts`:** added one new `describe` block (15 new tests: 5 steps x {`STE2=59`, `STE2=64`, `STE2` absent}), each asserting the exact cashier reason, `kind: 'technical'`, `retryable: true`, and `dataIssue` left `undefined`. No existing test's assertions were changed.
- **`docs/KNOWN_GAPS.md`:** updated the "Fiscal device daily closure" entry with an "Update (docs/phase-162)" paragraph describing the new classification, and revised its "Blast radius" line. The entry's "still open" and `VERIFY-ON-DEVICE` points (whether/when `DailyReport` itself should ever be sent, and the real `STE1`/`STE2` pairing) are preserved - this phase does not touch either.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/main/services/integrations/real-etims-provider.ts` | Modified | `checkDeviceResponse`'s Code-40 STE1 branching; the cashier-facing reason and retry classification for a `STE1=59` device response, at any of the seven `submitInvoice` steps |
| `tests/realEtimsProvider.test.ts` | Modified (additions only) | Test coverage for the new `STE1=59` branch |
| `docs/KNOWN_GAPS.md` | Modified | Documentation of the daily-closure gap - narrows what's still open |

## 4. Possible impact

- **Direct:** a real device response carrying `STE1 = 59` (0x3b) now produces the plain reason "The fiscal device needs its daily closure before it can file sales. The sale is saved and will be filed once the closure is done. Call support.", classified `kind: 'technical'`, `retryable: true` - queued as `'waiting'` and retried automatically in the background (`fiscal-routing.ts`'s existing `retryable → enqueue` mapping), rather than surfacing as "Wrong client PIN" or another STE2 business rejection and being marked `'needs_fixing'`.
- **Indirect:** any UI or report that reads `fiscal_status`/`fiscal_error_reason` for a sale that previously hit this misclassification will now show `'waiting'` and the new plain reason instead of `'needs_fixing'` and a PIN-shaped message. No other STE2 code's behaviour changes - confirmed by the existing STE1=52 and STE2=59 tests still passing unmodified.
- **Data / schema / contract:** none. No command, argument, or sequence sent to the device changed.
- **Security posture:** unchanged.
- **Idempotency / re-run safety:** unaffected - this is a pure response-classification change; the existing duplicate-filing guards (`verifyAlreadyFiled`, `TraderSystemInvNum` stability) are untouched and were traced in 0b to remain sufficient.
- **Residual risk:** the real device's `STE1`/`STE2` pairing for this condition has never been observed live (`docs/KNOWN_GAPS.md`'s pre-existing `VERIFY-ON-DEVICE` note, unchanged by this phase) - the new branch is deliberately built to not depend on that pairing at all, so this residual risk does not threaten correctness, only that the exact cashier wording (agreed here, not KRA-specified) may need revision once a real response is captured.

## 5. Verification

- `npm run typecheck` (`typecheck:node` + `typecheck:web`) - clean, no errors.
- `npx vitest run tests/realEtimsProvider.test.ts` - 124/124 passed (109 pre-existing + 15 new).
- `npx vitest run` (full suite) - **124 test files, 1870 tests passed** (up from 1855 before this phase, +15 new; 0 failed).
- `npm run build` - succeeded (`electron-vite build`, all three targets: main/preload/renderer); `verify-no-mock-provider.cjs` postbuild check confirmed clean.
- `npm run check:fit` - **18/18 cases fit**, no overflow.
- **Mutation test** (per the task's hard rule): temporarily removed the new `if (ste1 === STE1_DAILY_CLOSURE_BLOCK)` branch and reran `tests/realEtimsProvider.test.ts`. Result: **exactly the 15 new tests failed** (109 unrelated tests still passed - confirmed blast radius), and the `STE2=59` case's failure message showed the old, misleading behaviour returning verbatim: `"Fiscal device error (Code 40, STE2=59): Wrong client PIN"` instead of the daily-closure reason. Restored the branch; reran - 124/124 passed again. This confirms the new tests are not vacuous and genuinely exercise the fix.
- No existing assertion in `tests/realEtimsProvider.test.ts` was changed - only new tests were added, so there is nothing to list under the task's "any EXISTING assertion changed" rule.

## 6. Rollback

Revert the three changed files to their prior state (`a96e1a3`):
```
git checkout a96e1a3 -- src/main/services/integrations/real-etims-provider.ts tests/realEtimsProvider.test.ts docs/KNOWN_GAPS.md
```
No data, schema, or device-side state to unwind - this is a same-process code/doc/test change only.

## 7. Observed but not changed

- `checkDeviceResponse` is called for *every* command, including `settings()` and `ReadDateTime` - so `STE1 = 0x3b` could in principle also arrive on those two, outside the five steps this phase's audit (and the task brief) scoped to. The new branch is unconditional inside the shared `Code 40` handling, so it already covers those two as well; no separate code path was needed, and no separate test was added for them since they were outside the requested scope.
- `rollback()`'s `CancelReceipt` result is never checked for success - a pre-existing, generic characteristic of every mid-receipt failure recovery (not specific to `STE1=59`), already flagged implicitly by the file's own comments. Left unchanged, as this phase's hard rules forbid touching the command sequence.
- The daily closure itself (`DailyReport` and its read-only companions) remains entirely unwired, per `docs/KNOWN_GAPS.md` - this phase only names the *symptom* of its absence more accurately; the decision of when/whether to send `DailyReport` remains explicitly a VIL/TSL decision, unchanged from docs/phase-157's framing.
