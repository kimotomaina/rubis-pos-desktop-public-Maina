# Phase 218 — "unverified" becomes "Manual verification" (wording only)

- **Date:** 2026-10-04
- **Requested:** wherever a person reads "Unverified" about an M-Pesa payment, it reads "Manual verification" (or "manually verified"). Stored values, behaviour and layout are not touched.
- **Outcome:** done. Typecheck clean; full suite **195 files, 3227 tests, all passing** (194 and 3220 before: +1 file, +7 tests); `npm run build` passes with the no-mock check. **Not measured:** layout (`check:fit` is not run, by the owner's standing rule from today).
- **Branch / base:** staging on `bf6925f`.

## 1. Audit: every hit for "unverified" in `src/` (any case)

51 lines in 9 files. **Six are text a person reads; the rest are code or data and stay.**

**Shown to a person (changed):**

| Where | Old | New |
| --- | --- | --- |
| [PaymentModal.tsx:591](../src/renderer/src/components/PaymentModal.tsx#L591) (the Daraja-mode tab) | `Unverified` | `Manual verification` |
| [AdminScreen.tsx:2071](../src/renderer/src/components/AdminScreen.tsx#L2071) (`aria-label`) | `Allow recording unverified M-Pesa payments` | `Allow recording manually verified M-Pesa payments` |
| [AdminScreen.tsx:2074](../src/renderer/src/components/AdminScreen.tsx#L2074) (the tick-box label, Integrations > M-Pesa) | `Allow recording unverified M-Pesa payments` | `Allow recording manually verified M-Pesa payments` |
| [AdminScreen.tsx:2078](../src/renderer/src/components/AdminScreen.tsx#L2078) (its help text) | `Nothing checks that the payment really happened. Needs a manager's PIN; stays unverified until matched to the statement.` | `Nothing checks that the payment really happened. Checked by the cashier on the customer's phone; approved by the manager at End of Day.` |
| [ipcValidator.ts:85](../src/main/lib/ipcValidator.ts#L85) (an error the cashier can see) | `An unverified M-Pesa payment must be explicitly confirmed` | `A manually verified M-Pesa payment must be explicitly confirmed` |
| [checkout.ts:129](../src/main/services/checkout.ts#L129) (`MPESA_MANUAL_NOT_ENABLED_MESSAGE`) | `Recording an unverified M-Pesa payment is not switched on for this till. Ask an administrator to enable it in Admin > Integrations.` | `Recording a manually verified M-Pesa payment is not switched on for this till. Ask an administrator to enable it in Admin > Integrations.` |

The help text keeps its first sentence and its meaning: nothing checks the payment with Safaricom. The old second sentence said "Needs a manager's PIN", which has been untrue since phase 150 (step 3) removed the per-sale manager PIN; the new one says what happens now, in the words you gave.

**Code or data (unchanged):**
- `manual_unverified`, the stored `verification_status` value: its type, the table's `CHECK` constraint, the queries and the checkout's write (`database.ts`, `checkout.ts`);
- `confirmUnverified` (the IPC field, `database.ts`, `ipcValidator.ts`, `PaymentModal.tsx`, `index.ts`) and `acknowledgedUnverified`;
- the Daraja tab's internal id `'unverified'` (`PaymentTab`, `setTab`) and the identifiers `unverifiedCode`, `handleUnverifiedContinue`;
- comments and doc comments that describe the stored value (`database.ts`, `checkout.ts`, `mpesa-provider-factory.ts`, `index.ts`, `MpesaReconciliationPage.tsx`, `CardEntryPanel.tsx`). Three comments in `PaymentModal.tsx` that name the *tab* by its label now say "Manual verification".

**What the grep did not find, so nothing changed:** End of Day, the reconciliation and logs pages, receipts and slips, reports and CSV headers contain no "unverified" text at all in this build (checked in `src/`; the receipt layouts and the Enjoy slip are also checked by the new test). There is no "status chip" that uses the word, so no "Manual" chip was needed.

## 2. Things I left alone and that you may want to look at

- The Daraja-mode tab's panel still opens with **"This records a payment nobody has confirmed."** and then "Use this only when the customer has paid but the confirmation has not reached this till. The sale will complete and be listed for a manager to check against the M-Pesa statement later." Neither contains the word, so by the audit rule they stay. They still read correctly under the new tab name; say if you want them rewritten in the same "checked by the cashier..." wording.
- **Width, not measured:** the tab label grew from 10 characters to 19 in a fixed-width spot (one of two equal tabs in the 35% checkout panel, `text-base font-semibold`). By arithmetic it fits (about 180 px of roughly 215 px), but it was **not measured**. No other label is longer than the one it replaced in a fixed-width spot (the tick-box label wraps in a full-width row).

## 3. Tests

- **Existing tests that asserted on the old display text:** only [paymentModal.test.ts](../tests/paymentModal.test.ts), four lines, text only:

  | Line | Old | New |
  | --- | --- | --- |
  | 81 | `not.toContain('Unverified')` | `not.toContain('Manual verification')` |
  | 86 | test name `STK + Unverified tabs...` | `STK + Manual verification tabs...` |
  | 91 | `toContain('Unverified')` | `toContain('Manual verification')` |
  | 279 | `button('Unverified').click()` | `button('Manual verification').click()` |

- **Tests asserting on `manual_unverified` as a stored value: none changed**, and none failed (`mpesaManualPayment.test.ts`, `mpesaPaymentsRecord.test.ts`, `reportsDatabase.test.ts`, `reportsExport.test.ts`, `endOfDayReport.test.ts` and the others still pass untouched).
- **New: [manualVerificationWording.test.ts](../tests/manualVerificationWording.test.ts) (7 tests).**
  - It parses every `.ts`/`.tsx` file under `src/` and checks every JSX text, string literal and template literal (comments are not code): none that contains "unverified" may remain, after setting aside the stored value `manual_unverified` wherever it appears (a type, a `CHECK`, a query); the only string with the word that may remain is the tab's internal id `'unverified'`. It also checks that the stored value, its `CHECK` constraint and the tab id are still there, and that the six new strings are.
  - It builds the fiscal slip, the sale record and the Enjoy slip of a manual M-Pesa sale at 48, 42 and 32 columns and finds no "unverified" in any line.
  - It reads the built renderer bundle (`out/renderer`) and finds no capitalised word "Unverified" and no "unverified" followed by a word, and finds "Manual verification". It is skipped when the bundle is older than the renderer source, so a stale build cannot give a false result; it ran here, after `npm run build`.
  - Mutation check: putting `Unverified` back on the tab fails the first test. Restored.
- **M-Pesa tripwires, run unmodified except for the four text lines above:** `mpesaPaymentGate` 24, `mpesaManualPayment` 28, `mpesaPaymentsRecord` 7, `paymentModal` 15 (four text lines edited, count unchanged). No test in the other three was edited and no logic assertion was touched; `mpesaPaymentGate`, `mpesaManualPayment` and `paymentModal` have the same counts as in the phase 217 tripwire run.

## 4. Not in scope, not done

The stored value, the column and type names, the IPC channel and field names, function names, test ids, and every rule (the gate, the attestation, the duplicate-code check, End of Day approval) are exactly as they were. Renaming the stored value needs a migration and is a separate phase.

## 5. Affected files, impact, rollback

- **Changed:** `PaymentModal.tsx`, `AdminScreen.tsx`, `ipcValidator.ts`, `checkout.ts` (text only), `tests/paymentModal.test.ts` (text only). **Added:** `tests/manualVerificationWording.test.ts`, this document.
- **Impact:** what a person reads on one tab, one Admin setting and two error messages. No behaviour, data or layout code.
- **Rollback:** revert this commit.
