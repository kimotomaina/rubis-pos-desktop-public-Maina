# Phase 208 — the guards: stopped before the commit (draft written, parked in a stash)

- **Date:** 2026-10-03
- **Requested:** one narrow phase, one commit: remove the recovery path; classify a retry's `OpenInvoice` rejection like a first attempt; guard B in the provider; guard E in the one write path; QR captured when present and warned when absent; tests as listed, with realEtimsProvider.test.ts:1123 as the only existing assertion that may change.
- **Outcome:** **Blocked, not committed.** The source change is written, typechecks, and behaves as specified (section 2). But **it breaks 82 existing tests in 10 files**, and the brief allows one assertion to change. Eleven of the 82 pin the recovery that you told me to remove. The other **71 fail because guard B, as worded ("all digits"), rejects the `KRA-0001`-style invoice numbers that the tests' shared `CloseReceipt` fixtures return through the real provider.** I have changed no test, and I am not going to widen the brief's one exception myself. The draft is parked: `git stash list` shows `stash@{0}: phase-208 draft`. The working tree is clean at `4c6561b`.
- **Branch / base commit:** staging @ `4c6561b` (phase 207), tree clean.

## 1. The measurement

The full suite against the draft: **184 files, 2947 tests: 82 failed, 2865 passed.** To separate the two causes I ran the ten affected files again with guard B's check turned off (restored afterwards): **11 failed**. So:

| Cause | Tests | Where |
| --- | --- | --- |
| **Recovery removed or a retry classified like a first attempt** (these pin the old behaviour) | **11** | `realEtimsProvider.test.ts` 7, `defVersionCompatibility.test.ts` 3, `fiscalResend.test.ts` 1 |
| **Guard B, "all digits", meets `KRA-0001`-style fixture numbers** | **71** | `realEtimsProvider.test.ts` 32, `vatClassFiscal.test.ts` 18, `vatClassSync.test.ts` 5, `traderInvNum.test.ts` 5, `vatClassReceiptReports.test.ts` 4, `defVersionCompatibility.test.ts` 3, `fiscalIntegration.test.ts` 2, `fiscalOfflineEndurance.test.ts` 1, `tremolConformance.test.ts` 1 |

**The 11 recovery tests** (by name; the first is the one you named):
- `realEtimsProvider.test.ts`: "on a RETRY, when the device reports the invoice as already filed, recovers as fiscalized WITHOUT resending…" (the :1100 block, which contains :1123); "on a RETRY, when the device does NOT know this invoice either…"; "on a RETRY whose OpenInvoice is refused with STE2 0x32, asks ReadCUinvoiceNumber first…" (phase 184); "TEST A … blank defVer, OpenInvoice blocked but ReadCUinvoiceNumber fails with Code 63"; "TEST A … blank defVer, block clears, device ALREADY HAS the sale on file"; "TEST A … under the newer definitions: recovers automatically, exactly one Close…"; "provider logging … routes the duplicate-filing recovery through the injected logger".
- `defVersionCompatibility.test.ts`: "flags when ReadCUinvoiceNumber is refused…"; "still recovers normally when the device does name an invoice number"; "NEW defs … still recovers an already-filed sale through ReadCUinvoiceNumber".
- `fiscalResend.test.ts`: "resend goes through Part B recovery: OpenInvoice rejected, device reports already filed → fiscalized without a second filing".

**Why the 71 fail.** They are not testing guard B. They run a normal sale through the real provider, and the shared mock in `realEtimsProvider.test.ts:156` (and a handful of copies elsewhere) answers `CloseReceipt` with `InvoiceNum: 'KRA-0001'`. That string is not digits, so the guard turns every one of those sales into a refusal. Examples in the list: "drives the workflow in order", "ReadStatus gate", "device session lock", "tremolConformance: the happy-path run posts only contract-defined commands", the phase 198 `traderInvNum` body-unchanged tests (my own), `vatClassReceiptReports` (a golden-style receipt test), and the offline-endurance run. **Inference** (not measured): changing the shared fixture value to a valid 19-digit number fixes most of the 71 with no assertion change, and the tests that compare against the literal `'KRA-0001'` would need that literal updated. I have not done it.

## 2. What the draft does (verified against the spec)

Five files, `+133 -222` (in the stash; the diff is also saved at `scratchpad/phase208_draft.diff`):
- **`real-etims-provider.ts`:** `verifyAlreadyFiled`, its verdict type, its `resolveDuplicateRecoverySupport` import and the "already-filed" `ok: true` return are gone. A retry's `OpenInvoice` rejection goes through `classifyDeviceFailure` like a first attempt; a retryable one stays waiting; a final one on a retry returns `UNVERIFIABLE_RETRY_REASON`, `kind: 'system'`, `retryable: false`. `isAcceptableCuInvoiceNumber` (guard B: non-empty, digits only, last nine not all zeros) refuses a `CloseReceipt` number with the same reason, after the existing best-effort `CancelReceipt`; its comment states the nine-digit tail is **inferred from two samples** with `VERIFY-ON-DEVICE`. A valid number with no QR is still fiscalized and logged at warn with the sale id, with a `VERIFY-ON-DEVICE` note. `FiscalEndpointPaths.readCUinvoiceNumber`, the contract, and the manual `readCUInvoiceNumber()` method are untouched (the method's doc now says nothing automatic calls it).
- **`database.ts` (`setOrderFiscalInfo`, the one write path):** refuses, with nothing written, a CU number another order already holds (`SELECT … WHERE fiscal_invoice_number = ? AND local_id <> ?`, using the existing index) and returns `false`. `markFiscalQueueItemSynced` and `settleCheckoutFiscalSuccess` route a refusal to `needs_fixing` with the phase 111 message and delete the fiscal row, in the same transaction.
- **`checkout.ts`, `fiscal-engine.ts`, `fiscal-retry.ts`:** act on that `false`: the checkout receipt does not claim a number, the engine does not call the late-filed print, the resend returns a failure and does not call `onFiled`. Their interfaces take `boolean | void`, so the tripwire tests' fakes need no change.
- **Not touched, as instructed:** layout, `receiptFiscalBlock`, `shouldMarkReceiptPrinted`, `kraNoteFor`, the late-filed slip, the ETR copy, guard G, the till code, the `0x32` classification, notice wording, the lock, the journal lookup.

**One interpretation, to confirm:** a retry's final refusal that carries a data issue the till can fix (the wrong-buyer-PIN route, phase 78) keeps its own classification rather than the phase 111 message, because the correct-PIN-and-resend flow depends on it and the brief did not mention it. Say if you want the message there too.

**Typecheck:** clean. **A scratch replay (7 tests, run and then removed; saved at `scratchpad/zz_phase208_scratch.test.ts`) passed**: a retry refused with STE2 `0x32` twice sends no `ReadCUinvoiceNumber`, no `SellPLU`, no `CloseReceipt`, and is retryable (waiting); a final refusal on a retry returns the phase 111 message with the last command being `OpenInvoice`; `0110605040000000000`, `''`, `KRA-0001` and a string with a letter are each refused; `0110605040001000809` is accepted; a valid number with no QR is fiscalized and warned.

**Not yet written** (waiting on the ruling): the real-bytes replay test file as listed, the guard E database tests, the QR-warning test, and the three mutation checks (recovery put back, guard B returning true for zeros, guard E not checking).

## 3. The standing tripwires

Of the tripwire files you have named in earlier phases, **none of `fiscalEngine`, `fiscalRouting`, `mpesaPaymentGate`, or the 164/165/171 layout tests is among the 82.** The ones that are: `fiscalIntegration.test.ts` (2), `fiscalOfflineEndurance.test.ts` (1), `tremolConformance.test.ts` (1), `vatClassReceiptReports.test.ts` (4), `vatClassSync.test.ts` (5), `vatClassFiscal.test.ts` (18), `traderInvNum.test.ts` (5), `defVersionCompatibility.test.ts` (6), `fiscalResend.test.ts` (1), `realEtimsProvider.test.ts` (39). Counts are of failing tests in each file under the draft.

## 4. Options

1. **(Recommended)** Authorise updating existing tests as follows, each with an old/new note in the file: the shared `CloseReceipt` fixture number becomes a valid 19-digit value (and the literal in any assertion that compares it), and the 11 recovery tests are rewritten or replaced by the replay tests in the brief. That touches existing tests in 10 files but changes no behaviour assertion apart from the 11. Then I finish the tests and mutation checks and commit as one phase.
2. Relax guard B so the existing fixtures pass: drop "all digits" and keep "non-empty, last nine characters not all zeros". The 71 would then be expected to pass untouched (**Inference**, not measured), but a non-digit string would be accepted, which your test list says must be refused.
3. Split it: land guard E, the QR warning and the retry classification now (they break only the 11 recovery tests), and guard B in its own phase with the fixture change.

## 5. Decisions needed

1. Which option in section 4, and, for option 1, that the 11 recovery tests may be rewritten or removed (their names are in section 1).
2. Confirm the wrong-PIN exception in section 2.
3. `resolveDuplicateRecoverySupport` and `DuplicateRecoverySupport` in `http-client.ts` are now unused by `src/`; `defVersionCompatibility.test.ts` still tests them. Leave them (the draft does) or remove them in a later phase?

## 6. Rollback

Nothing is committed for the guards. The draft is in `stash@{0}`; `git stash drop` discards it, `git stash pop` brings it back. This document is the only file added.
