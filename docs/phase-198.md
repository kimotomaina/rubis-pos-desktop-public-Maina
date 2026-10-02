# Phase 198 — Two slips at checkout: the KRA fiscal slip, then the Enjoy customer slip

- **Date:** 2026-10-02
- **Requested:** after a sale, print the KRA fiscal-side slip, cut, then a separate Enjoy customer slip, cut. Store the trader invoice number where the provider sends it. Print a later-filed sale's fiscal slip once. Reprints cover both slips.
- **Outcome:** Implemented. Typecheck clean; full suite **172 files, 2695 tests passing** (166 and 2601 before); `npm run build` passes with the no-mock check. `check:fit` was not run, as agreed. **Nothing was sent to the live control unit.**
- **Branch / base commit:** staging @ 28dfe67 (version 2.1.5). Committed locally with this report, not pushed. **The 2.1.5 installer built earlier does not contain 197-1 or this phase.**

## 0. What you decided, and where it landed

| Decision | Where |
| --- | --- |
| Keep `buildReceiptLayout`, labels stay "FISCAL RECEIPT" / "DUPLICATE" | Name, gate and labels untouched. Only the "Invoice No" row changed (item 2 below). |
| Enjoy slip wording, exactly, in one constants object | `ENJOY_SLIP_TEXT` in [enjoySlip.ts](../src/main/lib/enjoySlip.ts) |
| Trader number in a new write-once column, written where the provider sends OpenInvoice | `fiscal_trader_inv_num`, recorded by a callback (section 3) |
| Fiscal slip prints "Invoice No" (stored trader number) and, separately, "CU Invoice No" | [receiptLayout.ts](../src/main/lib/receiptLayout.ts) |
| Older orders omit "Invoice No", never recomputed | Same row, behind `traderInvNum` |
| Mock provider supplies serial and holds the banner | [mock-etims-provider.ts](../src/main/services/integrations/mock-etims-provider.ts); the URL part is not done, see section 7 |
| Print order, independent failure, no auto retry, toast on failure | `printOrderSlips` in [printer.ts](../src/main/services/printer.ts) |
| Order History reprints both as DUPLICATE and logs `receipt_reprints` | `receipt:print` handler in [index.ts](../src/main/index.ts) |
| Later filing prints the fiscal slip once; if it cannot print, flag it in Needs Attention, no retry | [late-filed-slip.ts](../src/main/services/late-filed-slip.ts), fiscal engine callback, Needs Attention page |

## 1. Audit (what mattered)

- **Existing tests that pin the "Invoice No" row:** two, not one. `tests/receiptLayout.test.ts:135` (phase 171, found before building) and the phase 194 golden test `tests/vatClassReceiptReports.test.ts` (8 golden layouts), found when the suite ran. Both use a filed order with no stored trader number, which under your rule has no "Invoice No" row.
- **Writers of `fiscal_status = 'fiscalized'`:** one SQL function, `setOrderFiscalInfo`, reached from three paths: checkout's first filing (`settleCheckoutFiscalSuccess`), the fiscal engine's queued retry (`markFiscalQueueItemSynced`) and the manual resend (`resendFiscalization`). Hooking inside the function would also fire on checkout's first filing, where the renderer's automatic print already runs, and print twice. By your rule (more than one writer) the hook is on the **engine path only**; see section 7 for the resend gap.
- **Where the trader number is built:** inside the provider at send time. `fiscal_request_json` is written earlier, in the database, before the provider is involved, so the number cannot be stored "in the same place" without a callback. The provider has no database access, so the callback follows the existing `lookupInvoice` pattern.

## 2. Changes

| File | Change |
| --- | --- |
| [enjoySlip.ts](../src/main/lib/enjoySlip.ts) (new) | `buildEnjoySlip`, `ENJOY_SLIP_TEXT`. Reads only the sale's own fields; never the CU number, serial, QR or VAT groups. |
| [receiptLayout.ts](../src/main/lib/receiptLayout.ts) | `traderInvNum` on the order; the filed-slip "Invoice No" row prints it and is omitted when absent (a sale not yet filed still prints "Sale No"); `decorate` hook on the settings, applied last; four helpers (`ln`, `rule`, `keyValueLines`, `wrappedLines`) exported for the Enjoy slip. |
| [receiptTotals.ts](../src/main/lib/receiptTotals.ts) | `discountAmount` exported (one word), so the Enjoy slip does not copy the discount rule a third time. |
| [printer.ts](../src/main/services/printer.ts) | `renderEntries` extracted from `renderReceipt` (same calls, same cut); `renderEnjoySlip`, `printOrderSlips`, `kraNoteFor`, `attachCustomerSlipResult`, `physicallyPrintedSlips`; new fields on `PrinterSettings`, `ReceiptOrder`, `ReceiptPrintResult`. |
| [pdf-receipt.ts](../src/main/services/pdf-receipt.ts) | Passes `decorate`, so a mock PDF carries the banner too. |
| [database.ts](../src/main/services/database.ts) | Columns `fiscal_trader_inv_num`, `fiscal_slip_unprinted_at` (migration added to `migrateOrdersReceiptColumns`); table `receipt_reprints` (append-only); `recordTraderInvNum`, `markFiscalSlipUnprinted`, `getUnprintedFiscalSlips`, `recordReceiptReprint`, `listReceiptReprints`; `markReceiptPrinted` also clears the unprinted flag; the two order selects return the new columns. |
| [etims.ts](../src/main/services/integrations/etims.ts) | `TraderInvNumRecorder` type; optional `decorateFiscalSlip` on the provider contract (absent on the real provider). |
| [real-etims-provider.ts](../src/main/services/integrations/real-etims-provider.ts) | Section 3. |
| [mock-etims-provider.ts](../src/main/services/integrations/mock-etims-provider.ts) | Banner (`MOCK_SLIP_BANNER`, the only place the text lives), `decorateFiscalSlip`, serial `MOCK-CU-0000001`, calls the same recorder with the same value as the real provider. |
| [fiscal-provider-factory.ts](../src/main/services/fiscal-provider-factory.ts) | Hands the recorder to the mock. |
| [fiscal-engine.ts](../src/main/services/fiscal-engine.ts) | Optional `onFiled(localId)` after a queued filing is stored; a throw is logged and ignored. Absent in the existing tests, so they pass unmodified. |
| [late-filed-slip.ts](../src/main/services/late-filed-slip.ts) (new) | The decision, in its own module so it is testable: print once if `receipt_printed_at` is empty; mark it when it reached paper; otherwise flag and stop. Never throws. |
| [index.ts](../src/main/index.ts) | The `receipt:print` body moved, unchanged, into `printSlipsForOrder` (shared with the late print); handler prints both slips, logs reprints, folds the customer slip's outcome into the result; recorder passed to the provider; decorator wired from the provider; engine `onFiled`; IPC `fiscal:unprinted-slips`. |
| [ipcValidator.ts](../src/main/lib/ipcValidator.ts), preload `index.ts`, `window.d.ts` | `staffId` and `fiscalOnly` on the print request; `getUnprintedFiscalSlips`. |
| [autoPrintToast.ts](../src/renderer/src/lib/autoPrintToast.ts), [App.tsx](../src/renderer/src/App.tsx) | "Customer slip did not print. Reprint it from Order History." (automatic print toast and the Order History print); Order History passes the signed-in cashier. |
| [NeedsAttentionPage.tsx](../src/renderer/src/pages/NeedsAttentionPage.tsx) | Section "Tax invoices not printed" with a "Print tax invoice" button per sale (fiscal slip only). |
| [verify-no-mock-provider.cjs](../scripts/verify-no-mock-provider.cjs) | The banner text added to the forbidden list for `out/main`. |

## 3. The provider change (tripwire file): exact lines

Changes to [real-etims-provider.ts](../src/main/services/integrations/real-etims-provider.ts), as `git diff -U0` reports them (new-file line numbers). Nothing else in the file moved.

| Lines | Change |
| --- | --- |
| 60-61 | `TraderInvNumRecorder` added to the existing `./etims.js` type import |
| 737-738 | option `recordTraderInvNum?: TraderInvNumRecorder` (with its doc line) |
| 792 | field `private readonly recordTraderInvNum?` |
| 826 | constructor: `this.recordTraderInvNum = options.recordTraderInvNum` |
| 1096-1101 | Step 3 send: endpoint and arguments built **once** (`openEndpoint`, `openArgs`), `this.recordTraderNumber(request.localId, openArgs.TraderSystemInvNum)`, then the send. Was 1091-1095, which built both inline. |
| 1107 | the retry after a rolled-back open receipt reuses `openEndpoint` and `openArgs`. Was 1101-1105. |
| 1818-1837 | new private `recordTraderNumber`: skips a request with no local id or a provider with no recorder; wraps the call in `try/catch`, logs at `warn`, never throws. |

- **Recorded before the send, same value the retry uses.** The number is a pure function of the local id, so recording before a send that then fails stores the right value, and the retry writes nothing new (the column is write-once with `COALESCE`). The comment on `recordTraderNumber` says so.
- **The device call is unaffected by a failed record:** a test makes the recorder throw; the sale files and the posted body is unchanged.
- **Byte identity.** Before editing, I captured every OpenInvoice body the old code posted: local ids 1, 42 and 123456789 and a request with no local id (uuid fallback), each with and without the rolled-back retry: 12 posted bodies. All 12 are exactly the body below with the trader number swapped. [traderInvNum.test.ts](../tests/traderInvNum.test.ts) holds that body as a written-out literal and asserts equality for ids 1, 42 and 123456789 (send and retry), and for the uuid fallback; it also asserts the retry posts the same bytes and path as the first send.

```
<Command Name="OpenInvoiceWithFreeCustomerData"><Args><Arg Name="CompanyName" Value=""/><Arg Name="ClientPINnum" Value=""/><Arg Name="HeadQuarters" Value=""/><Arg Name="Address" Value=""/><Arg Name="PostalCodeAndCity" Value=""/><Arg Name="ExemptionNum" Value=""/><Arg Name="TraderSystemInvNum" Value="INV-000000042"/></Args></Command>
```

- **Not stored when nothing is sent:** a device that is not set up posts nothing and records nothing (tested), so the slip omits the line.

## 4. How printing behaves now

- **At checkout (automatic print):** fiscal-side slip (a filed sale, or the "sale record" for a pending one), cut; then the Enjoy slip, cut. Two separate printer jobs (two RAW jobs on a Windows queue). Each succeeds or fails on its own; neither retries. A failed customer slip gives the toast above; a failed fiscal slip keeps the existing message.
- **The KRA line on the Enjoy slip follows what happened, not what was intended:** "printed separately" only when the fiscal slip physically reached paper; "will follow" and "Please keep this receipt." for a sale not yet filed on the real provider; nothing otherwise (for example when the fiscal slip fell back to a PDF).
- **Order History:** reprints both. The fiscal slip is stamped DUPLICATE by the existing rule (`receipt_printed_at`); the Enjoy slip is stamped DUPLICATE on any manual print (see section 7). A row per slip that reached paper goes into `receipt_reprints` (order, slip, staff, time).
- **Later filing (queue only):** when the fiscal engine files a queued sale, its fiscal slip prints once as the ORIGINAL, unless `receipt_printed_at` is already set. The customer slip is not reprinted. If the slip does not reach paper (printer off, PDF fallback, error), `fiscal_slip_unprinted_at` is set and the sale appears under "Tax invoices not printed" in Needs Attention with a **Print tax invoice** button (fiscal slip only; printing it clears the flag). Nothing retries.

## 5. Existing tests

- **Existing `expect()` changed: zero.** Two **fixture** lines added, each `traderInvNum: 'INV-000000042'`:
  - `tests/receiptLayout.test.ts`, in `BASE_ORDER` (the one you approved).
  - `tests/vatClassReceiptReports.test.ts`, in the shared order fixture. **This one was not on your list and is not a 164, 165 or 171 test**; it is the phase 194 golden test ("an all-class-A receipt prints exactly what it printed before"), whose 8 golden layouts failed for the same reason. The same one-line fixture fix keeps the golden file untouched, and the test now proves what it always claimed. Say so if you wanted me to stop instead.
- **Stale fixture, left as agreed:** both fixtures still carry a trader-style value (`INV-000000042`) in `fiscalInvoiceNumber`. A real CU number is 19 digits.
- The 164, 165 and 171 tests, the tripwires (`fiscalEngine`, `fiscalRouting`, `mpesaPaymentGate`) and `autoPrintToast.test.ts` ran unmodified.

## 6. Verification

- `npm run typecheck`: clean. `npx vitest run`: **172 files, 2695 tests passed**. `npm run build`: exit 0, "neither mock provider is in out/main"; the banner text is not in `out/main` either.
- **New tests: 94 tests, 176 `expect()` calls, in 6 files:** `traderInvNum` (22), `enjoySlip` (22), `orderSlips` (26), `lateFiledSlip` (17), `mockBannerScope` (3), `customerSlipToast` (4). They cover: the slip's exact layout (golden, 48 columns), never wider than 42/32 columns, every "must never carry" item, the wording coming from one object (changing it changes the slip), the Invoice No rule, two-job order and cuts, independent failure and no retry, the Windows route sending two jobs, the KRA line truth table, duplicate stamps, the banner (top and bottom, one line, double width at 48 and bold where it cannot fit, not on the Enjoy slip, not without the decorator), the engine callback, the print-once guard, the unprinted list, the append-only reprint log, and an older database upgrading. The grep test asserts the banner text appears under `src/` only in `mock-etims-provider.ts`.
- **Mutation checks, all restored afterwards:**
  - `buildEnjoySlip` made to print the CU invoice number: **7 tests failed** (golden layout, the four "never carry" tests, the 32-column width test, and the `printOrderSlips` no-fiscal-numbers test).
  - Recorder moved to after the send: 1 test failed (`runs before the OpenInvoice send`).
  - Recorder given a value other than the one posted: 8 failed.
- **Hands-on, built demo app** (throwaway profile, Shopify blanked, no fiscal device, mock printer; real provider, so a sale is pending). Cash sale, 100 tendered, then a reprint through the real `receipt:print` IPC with a staff id. Database after checkout: `fiscal_status` waiting, nothing printed against the sale. After the reprint: `receipt_reprints` = `[[1,"fiscal",1],[1,"enjoy",1]]`. Printer output (the mock sink prints text only, with no alignment or cut marks; the two blocks are the two jobs):

```
[rubis-pos] MOCK PRINT — Order #1
RUBIS
------------------------------------------------
SALE RECORD
NOT A TAX INVOICE
Tax invoice to follow
------------------------------------------------
Sale No:                                       1
Date:                           02/10/2026 21:07
Cashier:                                   Admin
------------------------------------------------
ITEM                        QTY   PRICE   AMOUNT
------------------------------------------------
Kabras Milk 500ml
1 x 65.00 65.00 A
------------------------------------------------
TOTAL EXCL. VAT                            56.03
VAT                                         8.97
TOTAL KSH                                  65.00
------------------------------------------------
PAID BY CASH                               65.00
Tendered:                                 100.00
Change:                                    35.00
------------------------------------------------
Thank you for shopping at Enjoy!
A = VAT 16%. Prices include VAT.
[rubis-pos] MOCK PRINT — Enjoy slip, order #1
E N J O Y
------------------------------------------------
02 Oct 2026 21:07               Served by: Admin
------------------------------------------------
KABRAS MILK 500ML              1 x 65.00   65.00
------------------------------------------------
TOTAL                                  KSh 65.00
Paid by cash                          KSh 100.00
Change                                 KSh 35.00
------------------------------------------------
Thanks for stopping by!
We hope you enjoyed your visit.
See you again soon.
Your KRA tax invoice will follow.
Please keep this receipt.
```

  The reprint of the same sale printed the same sale record, then the Enjoy slip between `*** DUPLICATE ***` lines (the sale record is not stamped, because it was never a printed fiscal receipt; that is the existing rule). The demo profile has no location name or address set, so those lines are omitted, as designed; there is no "Receipt" line either, because a provider with no device sends nothing and so stores nothing.

- **Filed sale and duplicate reprint (mock provider).** The mock provider cannot run inside a built app: its dev-only import is removed by the bundler in every build, including a development-mode one, which is the guarantee the no-mock check protects. So this output comes from the real components in a scratch test (real in-memory database, the real mock provider writing the trader number through the same recorder, the real `printOrderSlips` and mock-printer sink, then deleted). It is **not** the `index.ts` handler.

```
===== FILED SALE, AUTOMATIC PRINT AFTER CHECKOUT =====
[rubis-pos] MOCK PRINT — Order #1
************************************************
TEST. NOT A TAX INVOICE.
************************************************
ENJOY
Rubis Energy Kenya PLC
Waiyaki Way, Nairobi
Tel 0700 000 000
PIN: P051XXXXXXXX
------------------------------------------------
FISCAL RECEIPT
ORIGINAL
------------------------------------------------
Invoice No:                        INV-000000001
Date:                           27/09/2026 18:58
Cashier:                            Mary Wanjiku
------------------------------------------------
ITEM                        QTY   PRICE   AMOUNT
------------------------------------------------
RUBIS Mug (Small)
1 x 60.00 60.00 A
------------------------------------------------
TOTAL EXCL. VAT                            51.72
VAT                                         8.28
TOTAL KSH                                  60.00
------------------------------------------------
PAID BY CASH                               60.00
Tendered:                                 100.00
Change:                                    40.00
------------------------------------------------
VAT RATE TAXABLE VAT GROSS
------------------------------------------------
A 16% 60.00 9.60 69.60
------------------------------------------------
CONTROL UNIT INFO
CU Date/Time:                27-09-2026 18:58:41
CU Serial No:                    MOCK-CU-0000001
CU Invoice No:                 KRA-MOCK-9F3C2A17
[QR: W1FSIENPREVdOktSQS1NT0NLLTlGM0MyQTE3]
Scan to verify this receipt with KRA
------------------------------------------------
Thank you for shopping at Enjoy!
A = VAT 16%. Prices include VAT.
************************************************
TEST. NOT A TAX INVOICE.
************************************************
[rubis-pos] MOCK PRINT — Enjoy slip, order #1
E N J O Y
Enjoy Westlands
Waiyaki Way, Nairobi
------------------------------------------------
27 Sep 2026 18:58                Served by: Mary
Receipt INV-000000001
------------------------------------------------
RUBIS MUG                      1 x 60.00   60.00
------------------------------------------------
TOTAL                                  KSh 60.00
Paid by cash                          KSh 100.00
Change                                 KSh 40.00
------------------------------------------------
Thanks for stopping by!
We hope you enjoyed your visit.
See you again soon.
Your KRA tax invoice is printed separately.
===== SAME SALE, REPRINTED FROM ORDER HISTORY =====
[rubis-pos] MOCK PRINT — Order #1
************************************************
TEST. NOT A TAX INVOICE.
************************************************
*** DUPLICATE ***
ENJOY
... (the same slip, with "*** DUPLICATE ***" under FISCAL RECEIPT and above the banner at the bottom) ...
[rubis-pos] MOCK PRINT — Enjoy slip, order #1
*** DUPLICATE ***
E N J O Y
Enjoy Westlands
Waiyaki Way, Nairobi
------------------------------------------------
27 Sep 2026 18:58                Served by: Mary
Receipt INV-000000001
------------------------------------------------
RUBIS MUG                      1 x 60.00   60.00
------------------------------------------------
TOTAL                                  KSh 60.00
Paid by cash                          KSh 100.00
Change                                 KSh 40.00
------------------------------------------------
Thanks for stopping by!
We hope you enjoyed your visit.
See you again soon.
Your KRA tax invoice is printed separately.
*** DUPLICATE ***
```

  The database after those two prints held the trader number `INV-000000001` and `receipt_printed_at` set.
- **Not run:** `check:fit`; a real thermal printer; a real control unit; the late-filing print end to end (the fiscal engine callback and the print decision are each tested, but nothing here filed a queued sale on a device).

## 7. Observed, flagged, or decided by me

- **The mock QR is not a URL.** You asked for the mock to supply a URL. `tests/etims.test.ts:31` asserts that the mock's `qrCode` is base64 that decodes to text containing `[QR CODE]`, so changing it would change an existing `expect()`. I left it: the dev slip's QR line prints that base64 text. Your call whether to allow that one assertion to change.
- **Manual resend gap.** A sale filed by "Resend" in Needs Attention is not covered: no fiscal slip is printed and nothing is flagged. Only the fiscal engine's queued filing is hooked (section 1). The Order History button still prints it.
- **The customer slip has no record of being printed**, so "DUPLICATE" on it means "a manual print". If the automatic customer slip failed and a cashier prints from Order History, that first customer slip is stamped DUPLICATE. A write-once "customer slip printed" column would fix it; I did not add a column you did not ask for.
- **Reading of the wording.** "Please keep this receipt." is printed only in the "will follow" case, as it follows that sentence in your text. Item names print in capitals (as in your `<ITEM NAME>`). For a cash sale "Paid by cash" shows the amount tendered, with Change below it, so the arithmetic reads; other tenders show the total.
- **Customer slip has no PDF fallback.** When the printer is out, the fiscal slip still falls back to a saved PDF and the customer slip fails with its toast.
- **Behaviour change on old sales:** a reprint of any sale filed before this phase no longer prints an "Invoice No" row (it printed the CU number there before); its "CU Invoice No" row is unchanged. This is your "older orders omit it" rule, stated here because it shows up on the next reprint.
- **A stored trader number does not mean the sale was filed.** It is recorded before the send, so a sale whose send failed already has one, and its customer slip prints a "Receipt" line while its tax invoice "will follow". The retry sends the same number.
- **`receipt_reprints.staff_id` comes from the renderer's signed-in cashier**, passed in the print request. It is a log value, not an authorisation check; a reprint needs no PIN, as before.
- **The unprinted-slip list is not in the unfiled-sales badge count.** It shows only inside Needs Attention.
- **Mock slips are marked on the PDF fallback too** (the decorator is passed to both renderers).
- **Narrow printers:** at 42 and 32 columns the banner cannot fit on one line at double width, so it prints bold on one line instead. On 32 columns the date and "Served by" fall onto two lines.
- **`tsconfig.node.tsbuildinfo`** (tracked) was rewritten by the type check; I restored it.
- **Question for VIL, to add to the list:** the sample invoice header reads "TAX INVOICE" while its annotation reads "FISCAL RECEIPT". Which is required? Until answered the label stays "FISCAL RECEIPT".

## 8. Rollback

`git revert` the phase 198 commit. The new columns and table are additive and stay in an upgraded database, unused. Orders keep their stored trader numbers, which nothing else reads. Nothing is migrated or deleted.
