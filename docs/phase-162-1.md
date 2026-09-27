# Phase 162-1 - Proving two retry properties of the STE1 = 0x3b change (tests and findings only)

- **Date:** 2026-09-27
- **Requested:** prove, with tests, (A) what actually happens when a STE1=59 block persists across an automatic retry and then clears, and (B) that nothing which runs after a successful `CloseReceipt` can turn a filed sale back into a retry candidate — plus resolve a contradiction in docs/phase-162 about whether `ReadDateTime` goes through `sendCommand`. No production code changes; if a test surfaced a problem, record it and propose (never build) the smallest fix.
- **Outcome:** Implemented (tests only). **Test A surfaced a real finding** - see Part A's "under an unrecognized/blank defVer" result and the proposed fix below. No production code was changed.
- **Branch / base commit:** staging @ e6597a9 (Phase 162 - name STE1=0x3b, the missing-daily-closure condition).

## What was examined

- `src/main/services/integrations/real-etims-provider.ts` - `submitInvoice`'s full seven-step sequence, `verifyAlreadyFiled` (all its branches, read in full), `checkDeviceResponse`'s STE1=59 branch (added in phase-162), `classifyDeviceFailure`, `ensureCUNumbers`, `sendCommand`'s Code-53 re-handshake-and-retry logic.
- `src/main/services/fiscal-routing.ts` - `routeFiscalOutcome`, to translate each outcome into the `fiscal_status`/enqueue decision a real till would actually see.
- `tests/realEtimsProvider.test.ts` - the existing `verifyAlreadyFiled`/duplicate-recovery tests (`describe('OpenInvoice duplicate-filing recovery via ReadCUinvoiceNumber ...')`) and the existing Code-53 re-handshake test (`'re-sends settings() and retries once when a command returns Code 53'`), to match established test style and mock shapes exactly.
- `tests/defVersionCompatibility.test.ts` - confirmed this project already has, and tests, the general "blank defVer + failed `ReadCUinvoiceNumber` probe → `'unverifiable'`" rule (`describe('BLANK defVer — the capability probe fails safe')`) for an unrelated original error code (Code 63/Server). This phase's Test A applies that SAME existing rule specifically to the STE1=59 case and traces its consequence.
- `docs/phase-162.md` - re-read in full to find and quote the exact contradiction Test B was asked to resolve.

## TEST A: retry while the device is still blocked

### Setup

Three sequential `submitInvoice` calls on one shared mock/provider (same `localId`, so `buildTraderSystemInvNum` yields the same `TraderSystemInvNum` across all three, mirroring a real queued retry): `OpenInvoiceWithFreeCustomerData` is blocked (`STE1=59`) on its first two calls and succeeds on the third; `ReadCUinvoiceNumber` (only ever called from inside `verifyAlreadyFiled`, only on a retry whose `OpenInvoice` failed) also returns `STE1=59` on the one call that reaches it - the realistic pairing for a device-wide, persistent block, not a coincidence chosen to be awkward.

### Attempt 1 (first attempt, `isRetry` unset)

`OpenInvoice` returns `STE1=59`. `checkDeviceResponse`'s phase-162 branch fires: `retryable: true`, `reason: DAILY_CLOSURE_BLOCK_REASON`. `classifyDeviceFailure`'s `if (result.retryable)` branch runs first, so this becomes `{ ok: false, kind: 'technical', retryable: true, reason: DAILY_CLOSURE_BLOCK_REASON }`. `routeFiscalOutcome` → `{ status: 'waiting', enqueue: true }`. Confirmed by test.

### Attempt 2 (`isRetry: true`, device still blocked) - the outcome DEPENDS on the connected server's `defVer`

`OpenInvoice` fails again (`STE1=59`, `serverFailure` unset - `checkDeviceResponse` only sets `serverFailure` for `Source="Server"` responses, never for a Code-40 device error). Because `request.isRetry` is true, `submitInvoice` calls `verifyAlreadyFiled(defVer, openResult, localId)` (`real-etims-provider.ts`, the `if (!openResult.success && request.isRetry)` block). Quoting its exact branches (`verifyAlreadyFiled`):

```ts
const support = resolveDuplicateRecoverySupport(defVer)
const deviceNeverSawIt = Boolean(openResult.serverFailure)   // false — a Code 40 device error, not a server failure

if (support === 'absent') { ... }                             // not reached — defVer is not the old one here

const recovery = await this.sendReadCUinvoiceNumber()          // returns STE1=59, success: false
const cuInvoiceNumber = recovery.success ? recovery.data?.CU_InvoiceNumber : undefined
if (cuInvoiceNumber) { return { outcome: 'already-filed', cuInvoiceNumber } }   // not reached — recovery.success is false

if (recovery.success) { ... return { outcome: 'genuine-failure' } }            // not reached — recovery.success is false

if (support === 'available' || deviceNeverSawIt) {
  return { outcome: 'genuine-failure' }
}
return { outcome: 'unverifiable', reason: recovery.error ?? 'ReadCUinvoiceNumber failed' }
```

**Case A - `defVer = '2509041522'` (`EXPECTED_DEF_VERSION`, `resolveDuplicateRecoverySupport` → `'available'`).** The last `if` is true (`support === 'available'`, regardless of `deviceNeverSawIt`), so the outcome is `'genuine-failure'`. `submitInvoice`'s retry block only returns early for `'already-filed'` or `'unverifiable'` - `'genuine-failure'` falls through to `if (!openResult.success) { return classifyDeviceFailure(openResult, ...) }`, using the **original** `OpenInvoice` rejection. Since that original result still carries `retryable: true` and the daily-closure reason, the final outcome is **identical in shape to attempt 1**: `{ ok: false, kind: 'technical', retryable: true, reason: DAILY_CLOSURE_BLOCK_REASON }` → `routeFiscalOutcome` → `{ status: 'waiting', enqueue: true }`. **The sale recovers automatically** - it stays queued and will be retried again by the background drain. Confirmed by test (`'under the newer definitions ... recovers automatically'`).

**Case B - blank/unrecognized `defVer`** (`resolveDuplicateRecoverySupport` → `'unknown'`). The last `if` is now false (`support !== 'available'` and `deviceNeverSawIt` is false), so the function falls to its final line: `{ outcome: 'unverifiable', reason: recovery.error ?? '...' }`. `submitInvoice` DOES return early for this outcome:
```ts
if (verdict.outcome === 'unverifiable') {
  ...
  return { ok: false, reason: UNVERIFIABLE_RETRY_REASON, kind: 'system', retryable: false }
}
```
This **discards** the original `OpenInvoice` failure's own `retryable: true` and its daily-closure reason. The result is `{ ok: false, kind: 'system', retryable: false, reason: UNVERIFIABLE_RETRY_REASON }` → `routeFiscalOutcome` → **`{ status: 'needs_fixing', enqueue: false }`**. Confirmed by test (`'under an unrecognized/blank defVer ... does NOT recover automatically'`).

**Plain answer: it depends on the connected server's `defVer`.** With the newer, expected definitions (`'available'` support) the sale recovers automatically exactly as intended. With a blank or unrecognized `defVer` (`'unknown'` support - a real, captured state per `DefVersionStatus`'s own doc, not a hypothetical), **attempt 2 stops at `needs_fixing`**, with a generic reason (`UNVERIFIABLE_RETRY_REASON`, which says nothing about a daily closure) instead of the correct one, and `retryable: false` - the background queue will not try again on its own; a person must notice the Needs Attention entry and manually resend.

This is not a bug phase-162 introduced into `verifyAlreadyFiled` itself - the "blank defVer + failed `ReadCUinvoiceNumber` probe → `'unverifiable'`" rule already exists and is already tested for an unrelated original error (`tests/defVersionCompatibility.test.ts`'s `'flags when ReadCUinvoiceNumber is refused ...'`, Code 63). What phase-162 changed is that `OpenInvoice`'s own STE1=59 rejection is now correctly `retryable: true` on a first attempt - so this pre-existing `verifyAlreadyFiled` rule now has a real, adverse effect on a case it previously would have handled no differently (before phase-162, a STE1=59 rejection was ALSO non-retryable via the STE2 fallback table, so this exact scenario would have landed on `needs_fixing` either way; the difference is that today a person would be told the WRONG reason - "Wrong client PIN" or another STE2 message - whereas the underlying stop-at-needs_fixing behaviour on a blank/unknown defVer is pre-existing, not new).

### Proposed fix (NOT built, per this phase's hard rule)

In `verifyAlreadyFiled`, before falling through to the generic `'unverifiable'` return, add one more condition: when the recovery command's own failure carries `code === CODE_DAILY_CLOSURE_BLOCK` (i.e. `ReadCUinvoiceNumber` itself was refused by the exact same STE1=59 condition, not a genuine "old server doesn't know this command" ambiguity), return `'genuine-failure'` regardless of `support`:

```ts
// Proposed, not built:
if (recovery.code === CODE_DAILY_CLOSURE_BLOCK) {
  return { outcome: 'genuine-failure' }
}
if (support === 'available' || deviceNeverSawIt) {
  return { outcome: 'genuine-failure' }
}
return { outcome: 'unverifiable', reason: recovery.error ?? 'ReadCUinvoiceNumber failed' }
```

**Why this is safe under the existing invariant ("only failures proven not to have filed are retryable")**: the `'unknown'`-support fail-safe exists because an unrecognized server MIGHT be running the old definitions, which don't declare `ReadCUinvoiceNumber` at all - so a refusal MIGHT mean "this command doesn't exist here" rather than "the device has no record", and the app cannot tell those apart. A `STE1=59` response is a different kind of signal entirely: it is `checkDeviceResponse`'s own explicit, unambiguous decode of the FD-errors byte (not a guess, not a fallback), and it means "the device refuses to process fiscal commands until its daily closure" - a condition that is orthogonal to whether the server declares `ReadCUinvoiceNumber`. Critically, a device that is refusing commands device-wide **cannot have filed anything** in the same breath it refuses to answer - phase-162's own Step 0b already established that a fiscal document is only ever produced by a successful `CloseReceipt`, and this proposed carve-out does not change that: it only lets the ORIGINAL `OpenInvoice` rejection's own (already-correct) `retryable: true` classification stand, exactly as already happens for the `'available'`-support case today. It narrows the fail-safe by exactly one case that phase-162 gave a positive, unambiguous identity to - it does not weaken the fail-safe for any other kind of `ReadCUinvoiceNumber` failure (a genuine Code 63 "invalid POST", a transport drop that isn't already caught by `deviceNeverSawIt`, etc. all keep going to `'unverifiable'` exactly as before).

## TEST B: nothing after a successful `CloseReceipt` can mark a filed sale for retry

### `ReadDateTime` failing (STE1=59, another STE2 error, and a transport timeout)

`submitInvoice`'s Step 7 (`real-etims-provider.ts`):
```ts
const dateTimeResult = await this.sendCommand(this.endpoints.readDateTime, 'ReadDateTime', {})
const deviceDateTime = dateTimeResult.success
  ? (dateTimeResult.data?.DateTime ?? dateTimeResult.data?.dateTime)
  : undefined
...
return { ok: true, data: { invoiceNumber, ... , fiscalizedAt: deviceDateTime ?? new Date().toISOString(), fiscalizedAtSource: deviceDateTime ? 'device' : 'local-fallback', ... } }
```
There is no failure branch at all for `dateTimeResult` - `.success` is only ever read to pick between the device's timestamp and a local fallback. All three tested failure shapes (`STE1=59`, `STE2=64` "HS code is not valid", and a rejected promise simulating a timeout) produced `ok: true` with the invoice number from `CloseReceipt` intact, `fiscalizedAtSource: 'local-fallback'`, and `routeFiscalOutcome` → `{ status: 'fiscalized', enqueue: false }` - confirmed by three tests (`it.each`).

### `ReadCUnumbers` - resolving "if it runs after the close"

It does not, and cannot in the current sequence. `ensureCUNumbers()` is called once, near Step 1/2 (`real-etims-provider.ts`, right after `settings()` and before `ReadStatus`) - session-cached, read at most once per provider instance, never re-invoked later in the same `submitInvoice` call. A dedicated test confirms this ordering directly (`sequence.indexOf('ReadCUnumbers') < sequence.indexOf('CloseReceipt')`, called exactly once). There is no "ReadCUnumbers after the close" scenario to test because the command sequence never puts it there.

### Resolving docs/phase-162's contradiction

docs/phase-162.md's "How it currently works" section stated:

> Every command (except the best-effort `ReadDateTime`) goes through `sendCommand` → `checkDeviceResponse`

Its own §7 ("Observed but not changed") stated the opposite:

> `checkDeviceResponse` is called for *every* command, including `settings()` and `ReadDateTime`

**The second statement is correct; the first was wrong.** Quoting the code directly (`real-etims-provider.ts`, Step 7): `this.sendCommand(this.endpoints.readDateTime, 'ReadDateTime', {})` - the exact same private helper every other step calls (compare Step 6: `this.sendCommand(this.endpoints.closeReceipt, 'CloseReceipt', {})`). This is proven here with a behavioural test, not just re-read: `sendCommand` has one piece of logic no other code path implements - on a `Code 53` ("client settings missing") response it clears the cached `settings()` handshake, re-runs it, and retries the SAME command once. A command that bypassed `sendCommand` could not exhibit this. The added test drives `ReadDateTime`'s first call to `Code 53` and confirms: `ReadDateTime` is posted exactly twice, and `settings()` (the mocked `get`) is called exactly twice (the initial handshake plus the Code-53 recovery) - identical to the pre-existing test proving the same behaviour for `ReadStatus`. "Best-effort" describes `submitInvoice` never adding a failure branch after Step 7 (proven by the `it.each` above), not that `ReadDateTime`'s response skips parsing. docs/phase-162.md itself is left unedited (this project's phase reports are a point-in-time log); this report is the correction of record for that line.

## 2. Changes made

- **`tests/realEtimsProvider.test.ts`:** added two new `describe` blocks (`TEST A`, 2 tests; `TEST B`, 5 tests: 3 `it.each` + 2 direct) and three new imports (`DAILY_CLOSURE_BLOCK_REASON`, `UNVERIFIABLE_RETRY_REASON` from `real-etims-provider.js`; `routeFiscalOutcome` from `fiscal-routing.js`). No existing test's assertions were changed.
- **No production code changed** - `git diff --stat` on `src/` shows nothing for this phase (confirmed below).

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| `tests/realEtimsProvider.test.ts` | Modified (additions only) | Test coverage proving the STE1=59 retry-recovery and post-`CloseReceipt` safety properties; no production behaviour affected |
| `docs/phase-162-1.md` | Added | This report |

## 4. Possible impact

- **Direct:** none on production behaviour - no production file changed.
- **Indirect:** none.
- **Data / schema / contract:** none.
- **Security posture:** unchanged.
- **Idempotency / re-run safety:** unaffected.
- **Residual risk:** the Test A "Case B" finding (blank/unrecognized `defVer` stops an automatic recovery at `needs_fixing`) is a real, live gap for any till whose connected ZFPLabServer does not echo the expected `defVer` and hits a genuine daily-closure block on a retry - it is recorded here with a proposed fix but **not built**, per this phase's explicit instruction to stop after finding a problem.

## 5. Verification

- `npm run typecheck` (`typecheck:node` + `typecheck:web`) - clean, no errors.
- `npx vitest run tests/realEtimsProvider.test.ts` - **131/131 passed** (124 pre-existing + 7 new: 2 for Test A, 5 for Test B).
- `npx vitest run` (full suite) - **124 test files, 1877 tests passed** (up from 1870 before this phase, +7 new; 0 failed).
- `git diff --stat src/main/services/integrations/real-etims-provider.ts` after all work - **empty**: production code is unchanged from `e6597a9`, confirming this phase's "tests and findings only" rule was kept.
- **Mutation test for Test B** (per the task's hard rule): temporarily added `if (!dateTimeResult.success) { return classifyDeviceFailure(dateTimeResult, 'Failed to read the device date/time') }` right after Step 7's `sendCommand` call - a plausible-looking but wrong "fix" that would make a `ReadDateTime` failure abort an already-filed sale. Reran `tests/realEtimsProvider.test.ts -t "TEST B"`: **exactly the 3 `it.each` cases failed** (`expected false to be true`, i.e. `result.ok` was `false`) - the other 2 Test B tests (the Code-53 proof and the `ReadCUnumbers`-ordering proof), which do not depend on `ReadDateTime`'s failure being ignored, still passed, confirming the blast radius was exactly as expected. Reverted the mutation; reran the full file - 131/131 passed again.
- No existing assertion anywhere in the repository was changed - only new tests were added.

## 6. Rollback

```
git checkout e6597a9 -- tests/realEtimsProvider.test.ts
```
No production code, data, schema, or device-side state to unwind.

## 7. Observed but not changed

- The Test A "Case B" finding (proposed fix above) - explicitly not built, per this phase's own instruction.
- `verifyAlreadyFiled`'s `'unverifiable'` fallback for a blank/unrecognized `defVer` is a pre-existing, deliberate design (`tests/defVersionCompatibility.test.ts`'s `describe('BLANK defVer — the capability probe fails safe')`), not something introduced by phase-162 or this phase - left entirely as-is, since only the ONE new carve-out proposed above was in scope for this finding.
- docs/phase-162.md is left unedited; this report stands as the correction for its "How it currently works" line, per this project's point-in-time report convention.
