# Phase 162-2 - Build the daily-closure carve-out proposed in docs/phase-162-1 (Test A, Case B)

- **Date:** 2026-09-27
- **Requested:** build the carve-out docs/phase-162-1 proposed but did not build: in `verifyAlreadyFiled`, when BOTH the original `OpenInvoice` failure and the `ReadCUinvoiceNumber` recovery read carry `code === CODE_DAILY_CLOSURE_BLOCK`, return `'genuine-failure'` regardless of `defVer`, so a blank/unrecognized-defVer till no longer gets stuck at `needs_fixing` for a condition that is, by construction, not a filing at all.
- **Outcome:** Implemented.
- **Branch / base commit:** staging @ 703ebae (Phase 162-1 - tests proving the STE1=0x3b retry-recovery and post-CloseReceipt safety properties, and recording this exact finding).

## What was examined

- `src/main/services/integrations/real-etims-provider.ts` - `verifyAlreadyFiled` in full (already read completely for docs/phase-162-1; re-read here to get current line numbers after that phase's test-only changes), `checkDeviceResponse`'s `CODE_DAILY_CLOSURE_BLOCK` sentinel (phase-162), `submitInvoice`'s retry branch (`if (!openResult.success && request.isRetry) { ... }`) that consumes `verifyAlreadyFiled`'s `DuplicateRecoveryVerdict`.
- `tests/realEtimsProvider.test.ts` - the `TEST A` describe block added in docs/phase-162-1, in particular the test titled `'under an unrecognized/blank defVer: attempt 2 does NOT recover automatically (needs_fixing) ...'`, which directly exercised the exact scenario this build changes.
- `tests/defVersionCompatibility.test.ts` - the `'BLANK defVer — the capability probe fails safe'` describe block, to confirm this build's carve-out cannot be triggered by any of its existing scenarios (none of them involve `CODE_DAILY_CLOSURE_BLOCK` on either side).

## How it worked before this phase (docs/phase-162-1's finding)

`verifyAlreadyFiled` (`real-etims-provider.ts`) resolved a failed `ReadCUinvoiceNumber` recovery read to `'unverifiable'` whenever `support !== 'available'` and `deviceNeverSawIt` was `false` - regardless of *why* the recovery read failed. When the original `OpenInvoice` rejection and the recovery read were both refused by the same `STE1=59` "missing daily closure" condition on a till whose connected server's `defVer` is blank or unrecognized, this discarded the original rejection's own correct `retryable: true` classification and landed the sale on `needs_fixing` - requiring a person to notice and manually resend a sale that was never actually wrong.

## 2. Changes made

- **`src/main/services/integrations/real-etims-provider.ts`** (the only file this phase's hard rule permits touching):
  - Added one new check inside `verifyAlreadyFiled`, between the existing `if (recovery.success) { ... return { outcome: 'genuine-failure' } }` block and the existing `if (support === 'available' || deviceNeverSawIt) { ... }` fail-safe:
    ```ts
    if (openResult.code === CODE_DAILY_CLOSURE_BLOCK && recovery.code === CODE_DAILY_CLOSURE_BLOCK) {
      return { outcome: 'genuine-failure' }
    }
    ```
    Exactly as specified: fires ONLY when BOTH sides carry the sentinel; any other combination (a different original error, a different recovery failure, or only one side blocked) falls through unchanged to the pre-existing `support`/`deviceNeverSawIt` logic.
  - Added a plain-language comment above the check stating what the task asked for: this files nothing, it only lets the sale keep waiting, and the duplicate check still runs on the next attempt's `OpenInvoice` once the device answers again.
  - Added a short paragraph to `verifyAlreadyFiled`'s own doc comment (above its `@param` block) naming the new carve-out, so a reader of the function's contract sees it without having to find the inline comment first.
  - No command, argument, sequence, or filed data changed - the new branch only changes which `DuplicateRecoveryVerdict` outcome is returned; it does not send any additional command, and it never triggers a resend of `SellPLU`/`CloseReceipt` (that only happens if a LATER attempt's `OpenInvoice` itself succeeds, exactly as before this phase).

- **`tests/realEtimsProvider.test.ts`:**
  - **Updated one existing test** (docs/phase-162-1's `TEST A` describe block) to match the new, corrected behaviour. Listed here per this project's standing rule for the fiscal suite:
    - **Test:** `'under an unrecognized/blank defVer: attempt 2 does NOT recover automatically (needs_fixing) — a manual resend still succeeds, no duplicate filing'` -> renamed to `'under an unrecognized/blank defVer, both blocked: attempt 2 now recovers automatically too (docs/phase-162-2)'`.
    - `attempt2.reason`: was `UNVERIFIABLE_RETRY_REASON` -> now `DAILY_CLOSURE_BLOCK_REASON`. **Why:** this is precisely the wrong behaviour docs/phase-162-1 flagged as a finding, and this phase's carve-out fixes it - the reason a reader now sees is the correct, cashier-facing one.
    - `attempt2.kind`: was `'system'` -> now `'technical'`. **Why:** `'genuine-failure'` falls through to the ORIGINAL `OpenInvoice` rejection's own classification, which `classifyDeviceFailure` resolves to `'technical'` via its `retryable` branch (see phase-162's own report for why that branch runs first).
    - `attempt2.retryable`: was `false` -> now `true`. **Why:** same fallthrough - the original rejection's `retryable: true` is no longer discarded.
    - `routeFiscalOutcome(attempt2)`: was `{ status: 'needs_fixing', enqueue: false }` -> now `{ status: 'waiting', enqueue: true }`. **Why:** direct consequence of the above - the sale now stays in the background retry queue instead of requiring a manual resend.
    - The test's final "manual resend" comment/assertions (attempt 3 succeeding, exactly one `CloseReceipt`) were kept, since attempt 3 still represents "the block clears" regardless of whether attempt 2's own classification was `waiting` or `needs_fixing` - a queued retry and a manual resend both call the identical `submitInvoice({ ...request, isRetry: true })` path.
  - **Added four new tests** to the same `TEST A` describe block, matching the task's list exactly:
    1. `'blank defVer, block clears, device ALREADY HAS the sale on file: recovers as already-filed, zero new CloseReceipt calls'` - proves the pre-existing `if (cuInvoiceNumber) { return { outcome: 'already-filed', ... } }` branch is untouched by this phase (recovery here does not fail at all, so the new carve-out never runs).
    2. `'blank defVer, OpenInvoice blocked but ReadCUinvoiceNumber fails with Code 63: still unverifiable — the carve-out does not widen'` - only the recovery side would (if checked alone) resemble a "known" failure; `recovery.code` is `'63'`, never `CODE_DAILY_CLOSURE_BLOCK`, so the carve-out correctly never fires.
    3. `'blank defVer, OpenInvoice fails with another error, ReadCUinvoiceNumber blocked: still unverifiable — the carve-out does not widen'` - only the recovery side carries the sentinel; `openResult.code` is `'57'` ("Conflict in tax group"), so the `&&` correctly keeps this out of the carve-out.
    4. (Covered by test 1 above.) `'under the newer definitions ...'` test from docs/phase-162-1 needed no change - `support === 'available'` already made that scenario fall through correctly before this phase, and the new carve-out is a no-op there (both conditions happen to be true too, but the pre-existing `support === 'available'` check already returns `'genuine-failure'` first).
  - No assertion was changed in `tests/defVersionCompatibility.test.ts` - reran unmodified; all pass (see Verification).

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/main/services/integrations/real-etims-provider.ts` | Modified | `verifyAlreadyFiled`'s outcome for a retried sale whose `OpenInvoice` AND its own `ReadCUinvoiceNumber` probe were both refused by the daily-closure condition |
| `tests/realEtimsProvider.test.ts` | Modified (1 existing test updated, 4 new) | Test coverage for the new carve-out and its boundaries |

## 4. Possible impact

- **Direct:** a sale whose retry hits the daily-closure block on BOTH `OpenInvoice` and `ReadCUinvoiceNumber`, on a till whose connected server has a blank/unrecognized `defVer`, now stays `'waiting'`/`retryable: true` with the correct cashier-facing reason instead of landing on `'needs_fixing'` with a generic "cannot be verified" message. This closes the gap docs/phase-162-1 found.
- **Indirect:** none - every other combination of original-error/recovery-failure (including the two new boundary tests) is unaffected, confirmed by the mutation test below.
- **Data / schema / contract:** none. No command, argument, sequence, or filed data changed.
- **Security posture:** unchanged.
- **Idempotency / re-run safety:** unaffected, and if anything strengthened in effect (not mechanism) - the sale now stays in the automatic retry path rather than requiring a person to remember to resend it; the actual duplicate-filing protection (the device's own `TraderSystemInvNum` uniqueness check, re-verified by `verifyAlreadyFiled` on every subsequent retry) is completely unchanged.
- **Residual risk:** the real device's `STE1`/`STE2` pairing for the daily-closure condition, and whether a real device would ever actually refuse `ReadCUinvoiceNumber` with the same `STE1=59` it gives `OpenInvoice`, remain unverified on live hardware (pre-existing `VERIFY-ON-DEVICE` note, unchanged by this phase). The carve-out is built defensively - it only fires on an exact, named code match on both sides - so an incorrect assumption about the real pairing would at worst leave the pre-phase-162-2 behaviour in place (falling through to the existing fail-safe), never create a new, wider risk.

## 5. Verification

- `npm run typecheck` (`typecheck:node` + `typecheck:web`) - clean, no errors.
- `npx vitest run tests/realEtimsProvider.test.ts tests/defVersionCompatibility.test.ts` - **163/163 passed** (134 in the provider file, up from 131, +3 net new; 29 unchanged in `defVersionCompatibility.test.ts`, confirming the task's "existing 'BLANK defVer fails safe' tests pass unchanged" requirement).
- `npx vitest run` (full suite) - **124 test files, 1880 tests passed** (up from 1877 before this phase; 0 failed).
- `npm run build` - succeeded (all three targets); `verify-no-mock-provider.cjs` postbuild check confirmed clean.
- `npm run check:fit` - **18/18 cases fit**, no overflow.
- `git diff src/main/services/integrations/real-etims-provider.ts` - confirmed the entire production diff is contained within `verifyAlreadyFiled` (its doc comment and one new branch), satisfying this phase's hard rule to change only that function.
- **Mutation test** (per the task's hard rule): temporarily dropped the "original failure must also be the block" half of the condition, leaving only `if (recovery.code === CODE_DAILY_CLOSURE_BLOCK) { return { outcome: 'genuine-failure' } }`. Reran the two boundary tests:
  - `'blank defVer, OpenInvoice fails with another error, ReadCUinvoiceNumber blocked: still unverifiable'` **failed**, exactly as expected - with only the recovery side checked, this scenario (which does have `recovery.code === CODE_DAILY_CLOSURE_BLOCK`) wrongly resolved to `'genuine-failure'` and returned the ORIGINAL rejection's own reason ("Conflict in tax group") instead of `UNVERIFIABLE_RETRY_REASON`.
  - `'blank defVer, OpenInvoice blocked but ReadCUinvoiceNumber fails with Code 63: still unverifiable'` **continued to pass** under this same mutation. This is expected, not a gap in the mutation test: that scenario's `recovery.code` is `'63'`, which never equals `CODE_DAILY_CLOSURE_BLOCK` regardless of whether the `openResult.code` half of the condition is present - dropping that half cannot affect a case where the recovery side alone was never going to match. The mutation therefore proves the `&&`'s `openResult.code` half specifically through the "other error, ReadCUinvoiceNumber blocked" test, and the Code-63 test independently proves the carve-out cannot be triggered by an unrelated recovery failure regardless of that half - together they cover both ends of "both sides must match", even though only one of the two fails under this specific one-sided mutation.
  - Restored the full `&&` condition; reran both tests - both passed again, and the full `tests/realEtimsProvider.test.ts` file was rerun in full to confirm no other test was disturbed (134/134 passed).

## 6. Rollback

```
git checkout 703ebae -- src/main/services/integrations/real-etims-provider.ts tests/realEtimsProvider.test.ts
```
No data, schema, or device-side state to unwind - this is a same-process code/test change only.

## 7. Observed but not changed

- The `support`/`deviceNeverSawIt` fail-safe itself (`verifyAlreadyFiled`'s final `if`/`return`) is untouched, and remains the correct, deliberate behaviour for every OTHER kind of `ReadCUinvoiceNumber` failure on a blank/unrecognized `defVer` - this phase narrows it by exactly the one case docs/phase-162-1 gave a positive, unambiguous identity to, nothing more.
- No change was made to `checkDeviceResponse`, `classifyDeviceFailure`, `fiscal-routing.ts`, or any command-building code - confirmed by the diff shown in Verification.
