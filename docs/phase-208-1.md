# Phase 208-1 — the guards, finished under the ruling of 2026-10-03

- **Date:** 2026-10-03
- **Follows:** [phase-208.md](phase-208.md), the blocked report. That file is left as written; this one records the completion.
- **Branch / base:** staging on `cfdcbc6`. The draft came back from `stash@{0}` with `git stash pop`.
- **Outcome:** done, one commit. Full suite **186 files, 2970 tests, all passing**; typecheck clean; `npm run build` passes and the postbuild prints `Confirmed: neither mock provider is in out/main.`

## 1. What the ruling changed in the draft

**Decision 1, option 2.** Guard B is `isAcceptableCuInvoiceNumber` in `real-etims-provider.ts`: **non-empty, and the last nine characters are not all zeros.** "All digits" is gone. The function's comment gives the reason: the device has already filed the sale when `CloseReceipt` answers, so refusing a number it really issued would record a filed sale as not filed and invite a second filing. The nine-character tail is still inferred from two samples and is marked `VERIFY-ON-DEVICE`.

**Measured, not inferred:** with the relaxed guard and no test touched, the full suite had **11 failures and 2936 passes**. The 11 are exactly the recovery tests listed below; the 71 fixture-driven tests pass untouched.

**Decision 2.** A retry's final refusal that carries a data issue the till can fix (wrong buyer PIN) keeps its own classification. Pinned by one test (row 2 below).

**Decision 3.** `resolveDuplicateRecoverySupport` and `DuplicateRecoverySupport` are left in `http-client.ts`. `docs/KNOWN_GAPS.md` has a new entry saying so. A grep of `src/` and `tests/` finds no caller and no test reference to either.

**Small addition, not in the draft:** two comments in `etims.ts` still named the removed `verifyAlreadyFiled`; reworded. Comments only.

## 2. The 11 recovery tests, each rewritten with an old/new note in the file

| # | File / old name | Replaced by |
| --- | --- | --- |
| 1 | `realEtimsProvider.test.ts` "on a RETRY, when the device reports the invoice as already filed, recovers as fiscalized WITHOUT resending…" | "on a RETRY refused as final, never asks ReadCUinvoiceNumber and never reports the sale as filed": not ok, phase 111 message, `system`, not retryable, no `ReadCUinvoiceNumber`, `SellPLU`, `CloseReceipt` |
| 2 | same file, "on a RETRY, when the device does NOT know this invoice either…" | "on a RETRY, a wrong buyer PIN keeps its own data classification, not the flag message": `kind: 'data'`, reason names the wrong PIN, not the phase 111 message, no `ReadCUinvoiceNumber`. **This is the wrong-PIN pin of decision 2.** |
| 3 | same file, "on a RETRY whose OpenInvoice is refused with STE2 0x32, asks ReadCUinvoiceNumber first…" (phase 184) | same test, `ReadCUinvoiceNumber` now asserted **absent**; still retryable, no `SellPLU`, no `CloseReceipt` |
| 4 | same file, "TEST A … blank defVer, OpenInvoice blocked but ReadCUinvoiceNumber fails with Code 63" | "blank defVer, OpenInvoice blocked on a retry: stays waiting, ReadCUinvoiceNumber is never sent": the block is retryable, so `waiting` |
| 5 | same file, "TEST A … blank defVer, block clears, device ALREADY HAS the sale on file" | "blank defVer, block clears, then a final refusal: flagged, never recovered as filed, zero CloseReceipt calls" |
| 6 | same file, "TEST A … under the newer definitions: recovers automatically, exactly one Close…" | same test, one assertion changed: `ReadCUinvoiceNumber` count 1 to 0. Attempt 2 still waits, attempt 3 still files once. |
| 7 | same file, "provider logging … routes the duplicate-filing recovery through the injected logger" | "routes the flag for a retry refused as final through the injected logger, with the sale localId": `logger.warn` carries `Sale 43` and `NOT resent` |
| 8 | `defVersionCompatibility.test.ts` "flags when ReadCUinvoiceNumber is refused…" | "flags a final refusal on a retry without sending ReadCUinvoiceNumber, whatever it would answer" |
| 9 | same file, "still recovers normally when the device does name an invoice number" | "does not recover from an invoice number the device would name: the sale is flagged" |
| 10 | same file, "NEW defs … still recovers an already-filed sale through ReadCUinvoiceNumber" | "no longer recovers through ReadCUinvoiceNumber: a final refusal on a retry is flagged" |
| 11 | `fiscalResend.test.ts` "resend goes through Part B recovery…" | "resend never recovers from ReadCUinvoiceNumber: a final OpenInvoice refusal is flagged, not recorded as filed": outcome not ok, order `needs_fixing`, no invoice number stored |

Not touched, though stale in its wording: `realEtimsProvider.test.ts` "on a RETRY under the new defs, when ReadCUinvoiceNumber itself errors, the ORIGINAL OpenInvoice rejection is still reported". It still passes (a wrong-PIN retry keeps its data classification) and does not pin the removed behaviour.

## 3. Tests added

**`tests/phase208RetryReplay.test.ts`** (15 tests). The replay uses the device frames recorded in the fiscal server's log in [phase-206.md](phase-206.md) section 1b: `06 96 30 32 39 34 0A` and `06 98 30 32 39 3A 0A` (STE1 `30`, STE2 `32`), and the `ReadCUinvoiceNumber` reply `0110605040000000000`. **The frame bytes and the reply are real. The XML envelope around them is the shape recorded in phase 183 and `fiscalDuplicatePrint.test.ts`, not a capture of the app's own copy. Inference.**
- A first attempt and a retry, both refused `0x32`: both retryable, `waiting`, `ReadCUinvoiceNumber` / `SellPLU` / `CloseReceipt` never sent, the last command is `OpenInvoice`.
- The retry returns nothing containing `0110605040000000000`.
- A retry refused as final: phase 111 message, `system`, not retryable, `needs_fixing`, never enqueued. A first attempt refused the same way keeps its own classification.
- Guard B, as a table: `0110605040001000809` accepted, `KRA-0001` accepted, **a string with a letter accepted** (comment in the file gives the reason), `0110605040000000000` refused, nine zeros refused, `''` refused. Through the provider: a zero-counter `CloseReceipt` number is flagged and not enqueued; `…1000809` is accepted unchanged. **An empty `InvoiceNum` never reaches guard B**: the provider's earlier "no InvoiceNum" check refuses it with its own message, so that test asserts not ok, not retryable, not enqueued.
- QR: a valid number with no QR is fiscalized with an empty QR and `logger.warn` carries `Sale 77` and `no QR code`; with a QR, no warning.

**`tests/fiscalNumberUniqueness.test.ts`** (8 tests, real in-memory database). `setOrderFiscalInfo` refuses a number another order holds, returns `false`, writes nothing, leaves the holder untouched; accepts a fresh number; accepts a repeat write for the order that already holds it. `settleCheckoutFiscalSuccess`, `markFiscalQueueItemSynced` and `resendFiscalization` each route a duplicate to `needs_fixing` with the phase 111 message, delete the fiscal row, and (resend) do not call `onFiled`.

## 4. The three mutation checks (each run, then the file restored and its hash compared)

| Mutation | Result |
| --- | --- |
| **1. Recovery put back** (a retry sends `ReadCUinvoiceNumber` and returns the number it names) | **15 tests fail**: all 11 rewritten tests (rows 1 to 11), 3 of the new replay tests, and the existing old-defs "never asks for ReadCUinvoiceNumber" test. File restored, hash identical. |
| **2. Guard B returns true for a zero tail** | **3 tests fail**: the two zero-tail table rows and the provider test for a zero-counter `CloseReceipt`. Restored, hash identical. |
| **3. Guard E not checking** (`if (false && holder)`) | **4 tests fail**: the refusal test and the three caller tests. Restored, hash identical. |

## 5. Not covered by a test

- The `=== false` branches in `checkout.ts` (`runCheckout`) and `fiscal-engine.ts` that stop a receipt claiming a number and stop the late-filed print. They are small and typechecked, and the `false` they react to is tested at the database; no test drives them. **Not verified by a test.**
- A real `CloseReceipt` reply has never been captured, so the QR-present shape and the number's structure are unconfirmed. Marked `VERIFY-ON-DEVICE` in the code.

## 6. Rollback

One commit; `git revert` it. Nothing outside `src/`, `tests/` and `docs/` changed, and no device command was sent.
