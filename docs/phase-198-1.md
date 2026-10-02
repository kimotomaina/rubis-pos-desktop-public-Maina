# Phase 198-1 — close-out: VAT table reconciliation, resend print, customer slip stamp

- **Date:** 2026-10-02
- **Requested:** Step 1: net fallback table and a VAT reconcile; Step 2: print the fiscal slip when a manual resend files a sale; Step 3: a write-once `customer_slip_printed_at` that decides the Enjoy slip's DUPLICATE stamp.
- **Outcome:** Built, verified and committed. Golden changes: the two `filedNoGroups` rows and, with option B, the two `discounted` VAT rows (section 2). Typecheck clean; vitest **175 files, 2738 tests, all passing**; `npm run build` passes with the no-mock check. `check:fit` not run; no device calls.
- **Branch / base commit:** staging, on top of 4d47669 (phase 198).

## 1. What changed

| Area | Change |
| --- | --- |
| Fallback table | `groupsFromItems` now builds **net** amounts: A = amount x 100/116, B = x 100/108, C, D, E unchanged, `round2` as before ([vatClass.ts](../src/main/lib/vatClass.ts) `grossToNet`, `netGroupTotals`; [receiptLayout.ts](../src/main/lib/receiptLayout.ts)). The whole-receipt fallback (`{ A: rawSubtotal }`) is converted the same way. A 1,650.00 sale now prints `A 16% 1,422.41 227.59 1,650.00`. |
| Reconcile | `reconcileVatGroups(groups, tillTotals)` in [vatReconcile.ts](../src/main/lib/vatReconcile.ts) returns `{ consistent, diff, groupVat, tillVat }`. Group VAT is each class's net amount x its statutory rate, `round2`, summed; compared with the till's `vatIncluded`; tolerance **0.05**, inclusive. A sale holding a class D amount cannot be compared (D has no fixed rate) and is reported consistent, not guessed. |
| Slip | Reconcile runs **only when stored device groups exist**. If they disagree, the table prints the device figures and one line under them, `Device figures. Till VAT: 8.28.`, and a warn is logged with the order id. A table built from the lines never reconciles and never prints the line. |
| Needs Attention | New section "VAT figures to reconcile" (order, staff, device VAT, till VAT; no action button). Worked out when asked from the stored groups ([vat-reconcile.ts](../src/main/services/vat-reconcile.ts), `fiscal:vat-mismatches`), so it changes if the reading changes. |
| Mock | Returns `vatGroups` under the net reading: 51.72 for a 60.00 class A sale. **A modelling choice so dev slips reconcile, not device evidence.** |
| Resend print | `resendFiscalization` takes an optional `onFiled(localId)` (called after a filing is stored, never awaited, a throw is logged and ignored); `index.ts` wires it to the same `printLateFiledSlip` the fiscal engine's `onFiled` uses, for both "Resend" and "Correct PIN and resend". The `receipt_printed_at` guard keeps it to one print; a second resend short-circuits as already filed and prints nothing. |
| Customer slip stamp | Column `customer_slip_printed_at` (write-once `COALESCE`, migration in `migrateOrdersReceiptColumns`). Set when the Enjoy slip physically reaches paper, automatic or manual; a PDF result, a failure or a fiscal-only print never sets it. The slip is stamped DUPLICATE only when the column was already set at the time of printing. The rules live in [slip-records.ts](../src/main/services/slip-records.ts) (`slipStamps`, `recordSlipOutcome`), which the `receipt:print` handler now calls. |

This replaces phase 198's rule that the Enjoy slip is DUPLICATE on any manual print; the flag in 198 section 7 about that is closed.

## 2. Goldens

**Approved, applied:** `tests/fixtures/receipt-class-a-golden.json` (the rows `tests/vatClassReceiptReports.test.ts` compares), two lines, `filedNoGroups@48` and `@32`:

```
@@ -613 +613 @@
-        "text": "A 16% 1,650.00 264.00 1,914.00",
+        "text": "A 16% 1,422.41 227.59 1,650.00",
@@ -828 +828 @@
-        "text": "A 16% 1,650.00 264.00 1,914.00",
+        "text": "A 16% 1,422.41 227.59 1,650.00",
```

At 32 columns the row did not wrap (the same single line). Nothing else in those two layouts changed.

**Applied, option B (approved):** the `discounted` scenario in `tests/vatClassReceiptReports.test.ts` now sets `vatGroups: { A: '1280.17' }` (the net of 1,485.00; it had inherited the undiscounted sale's `1422.41` from the base order). Golden change, `discounted@48` and `@32`, the VAT row only:

```
@@ -2282 +2282 @@
-        "text": "A 16% 1,422.41 227.59 1,650.00",
+        "text": "A 16% 1,280.17 204.83 1,485.00",
@@ -2502 +2502 @@
-        "text": "A 16% 1,422.41 227.59 1,650.00",
+        "text": "A 16% 1,280.17 204.83 1,485.00",
```

No "Device figures" line appears, since the stored group now agrees with the till's VAT (204.83). Nothing else in the golden changed: the test compares every entry of all twelve layouts and passes.

**Flagged, left as is:** the `discounted` fixture's own subtotal arithmetic is a pre-existing inconsistency (1,650 minus 20 is 1,630, not the stored total of 1,485). The existing "receipt totals do not reconcile" warning reports it whenever that golden is built. It was not introduced by this phase and is not fixed here.

## 3. Tests

- **New: 3 files, 43 tests, 101 `expect()` calls** (every one listed in the appendix): `vatReconcile.test.ts` (24 tests, 54 expects), `resendPrint.test.ts` (10, 28), `customerSlipStamp.test.ts` (9, 19), plus a helper `tests/helpers/recordingPrinter.ts`.
  - **Net helpers and reconcile:** A and B conversion, C/D/E unchanged, per-class totals with a blank class as A; consistent, gross-reading mismatch (9.60 against 8.28), the tolerance edge (8.33 and 8.23 agree; 8.34 and 8.22 do not), C/E zero VAT, class D uncomparable, garbage amounts.
  - **Slip:** no extra line and no warn when consistent; device figures plus `Device figures. Till VAT: 8.28.` directly under the row and before the rule, one warn naming the order; the note wraps at 32 columns with both figures still printed; no note and no warn for a table built from the lines; the 1,650.00 fallback row; the mixed A/C/E fallback; never a gross larger than the sale.
  - **Mock and list:** 51.72 for 60.00; per-class groups; a mock slip that reconciles; the Needs Attention rows (both VAT figures, an agreeing sale left out, no groups or unfiled left out, a bad row skipped, follows the stored groups).
  - **Resend:** files and prints once as ORIGINAL; a second resend prints nothing (submit and callback each called once); held to one print by `receipt_printed_at` even if the callback runs again; no print when the slip already went out; printer unavailable and printing that throws both set `fiscal_slip_unprinted_at` as the engine path does, with one attempt; a resend that fails prints nothing and flags nothing; "Correct PIN and resend" prints through the same decision; a throwing callback does not fail the resend; works with no callback.
  - **Stamp:** automatic success then manual reprint is DUPLICATE; automatic customer slip fails, the manual print is not DUPLICATE and the next is; a PDF fallback (printer out) and a PDF result do not set the column; a fiscal-only print does not; write-once; the fiscal-side stamp stays on its own record; an older database gains the column.
- **Changed existing `expect()`: none.** The only existing-test changes are the two golden rows above (JSON, not an `expect`). Not changed: the 164, 165 and 171 tests (the existing fallback test `falls back to computing class A from the lines` still passes, since the gross 1,650.00 stays in its row), the tripwires, `fiscalResend.test.ts`, `fiscalEngine.test.ts`, `etims.test.ts`.
- **Mutation checks, all restored:**
  - Reconcile always consistent: **6 tests failed** (the gross mismatch, the tolerance edge, the printed note, its 32-column wrap, and two Needs Attention list tests).
  - Fallback back to gross (`grossToNet` returns the gross for A and B): **13 failed**: the two `filedNoGroups` goldens, the two `discounted` goldens (failing at that point, before option B), the three `grossToNet` tests, three fallback-table tests and three mock tests.
  - Stamp rule: always true, **3 failed**; always false, **2 failed**; column also set for a PDF or failed customer result, **3 failed**; column also set by a fiscal-only print, **1 failed**.

## 4. Verification

- `npm run typecheck`: clean. `npx vitest run`: 175 files, 2738 tests, **all passed**. `npm run build`: exit 0, "neither mock provider is in out/main".
- **Hands-on, built demo app** (throwaway profile, no fiscal device, mock printer, real provider so the sale is pending): the automatic print printed the sale record and the Enjoy slip with no DUPLICATE and set `customer_slip_printed_at`; the reprint through `receipt:print` printed the Enjoy slip between two `*** DUPLICATE ***` lines; a second reprint did the same; `receipt_reprints` held one fiscal and one enjoy row per reprint, with the cashier's id. This exercises the `index.ts` handler wiring. The resend callback, the filed-sale slip and the reconcile note are covered by the tests above, not by this run (no device to file against).
- **Not run:** `check:fit`; a real printer; a real control unit.

## 5. Flags

- **`reports.ts` `deriveGroupVat` reads the same stored figure as gross** (`amount x 16/116`), while the receipt table and the new reconcile read it as net. One of the two is wrong; the live test decides. Not touched in this phase, as asked. The reports and the new Needs Attention list can therefore disagree about the same sale.
- **The reconcile only protects device figures.** A sale whose groups were never stored uses the fallback table, which is the till's own arithmetic, and so is never checked.
- **Needs Attention "VAT figures to reconcile" reads every filed order with stored groups each time the page loads.** Fine for one shop; it will want a date window or a stored flag as order counts grow.
- **A sale with a class D amount is never flagged**, because there is no rate to compare with.
- **The mock's net reading is a modelling choice.** If the live test shows the device returns gross, the mock, the goldens, the table and the reconcile all move together.
- **Resend print is not awaited**, like the engine's: the resend returns before the slip prints, and a failure shows only in Needs Attention under "Tax invoices not printed".
- **`tsconfig.node.tsbuildinfo`** was rewritten by the type check and restored.

## 6. Rollback

`git revert` the phase 198-1 commit. The new column stays in an upgraded database, unused; no data is migrated or deleted. The golden JSON goes back to its earlier rows with the revert.

## Appendix: every added `expect()` (101)

**tests/vatReconcile.test.ts**

```
  41  expect(grossToNet('A', 1650)).toBe(1422.41)
  42  expect(grossToNet('A', 60)).toBe(51.72)
  43  expect(grossToNet('A', 116)).toBe(100)
  47  expect(grossToNet('B', 108)).toBe(100)
  48  expect(grossToNet('B', 100)).toBe(92.59)
  52  expect(grossToNet('C', 2.5)).toBe(2.5)
  53  expect(grossToNet('D', 7.77)).toBe(7.77)
  54  expect(grossToNet('E', 1)).toBe(1)
  66  expect(totals).toEqual({ A: 100, B: 100, C: 1, D: 0, E: 2.5 })
  74  expect(result).toEqual({ consistent: true, diff: 0, groupVat: 8.28, tillVat: 8.28 })
  80  expect(result.consistent).toBe(false)
  81  expect(result.diff).toBe(1.32)
  82  expect(result.groupVat).toBe(9.6)
  83  expect(result.tillVat).toBe(8.28)
  87  expect(VAT_RECONCILE_TOLERANCE).toBe(0.05)
  88  expect(reconcileVatGroups({ A: '51.72' }, { vatIncluded: 8.33 }).consistent).toBe(true)
  89  expect(reconcileVatGroups({ A: '51.72' }, { vatIncluded: 8.34 }).consistent).toBe(false)
  90  expect(reconcileVatGroups({ A: '51.72' }, { vatIncluded: 8.23 }).consistent).toBe(true)
  91  expect(reconcileVatGroups({ A: '51.72' }, { vatIncluded: 8.22 }).consistent).toBe(false)
  95  expect(reconcileVatGroups({ A: '86.21', C: '1.00', E: '2.50' }, { vatIncluded: 13.79 }).consistent).toBe(true)
  96  expect(reconcileVatGroups({ B: '100.00' }, { vatIncluded: 8 }).consistent).toBe(true)
 102  expect(result.consistent).toBe(true)
 103  expect(result.diff).toBe(0)
 107  expect(reconcileVatGroups({ A: 'abc' }, { vatIncluded: 0 }).consistent).toBe(true)
 117  expect(out).toContain('A 16% 51.72 8.28 60.00')
 118  expect(out.some((l) => l.startsWith('Device figures'))).toBe(false)
 119  expect(logger.warn).not.toHaveBeenCalled()
 128  expect(row).toBeGreaterThan(-1)
 129  expect(out[row + 1]).toBe('Device figures. Till VAT: 8.28.')
 130  expect(out[row + 2]).toBe('-'.repeat(48))
 131  expect(out).toContain('VAT                                         8.28')
 132  expect(logger.warn).toHaveBeenCalledTimes(1)
 133  expect(String(logger.warn.mock.calls[0][0])).toContain('Order 7')
 139  expect(out.join(' ')).toContain('Device figures. Till VAT: 8.28.')
 140  expect(out).toContain('A 16% 60.00 9.60 69.60')
 152  expect(out.some((l) => l.startsWith('Device figures'))).toBe(false)
 153  expect(logger.warn).not.toHaveBeenCalled()
 159  expect(out).toContain('A 16% 1,422.41 227.59 1,650.00')
 174  expect(out).toContain('A 16% 86.21 13.79 100.00')
 175  expect(out).toContain('C 0% 1.00 0.00 1.00')
 176  expect(out).toContain('E 0% 2.50 0.00 2.50')
 182  expect(out).toContain('A 16% 51.72 8.28 60.00')
 183  expect(out.some((l) => l.includes('69.60'))).toBe(false)
 196  expect(outcome.ok && outcome.data.vatGroups).toEqual({ A: '51.72' })
 207  expect(outcome.ok && outcome.data.vatGroups).toEqual({ A: '86.21', C: '1.00' })
 219  expect(out).toContain('A 16% 51.72 8.28 60.00')
 220  expect(out.some((l) => l.startsWith('Device figures'))).toBe(false)
 221  expect(logger.warn).not.toHaveBeenCalled()
 240  expect(rows.map((r) => r.local_id)).toEqual([disagrees])
 241  expect(rows[0]).toMatchObject({ group_vat: 9.6, till_vat: 8.28, diff: 1.32, total: 60, staff_name: 'Mary Wanjiku' })
 242  expect(rows.some((r) => r.local_id === agrees)).toBe(false)
 251  expect(db.getFiscalisedOrdersWithVatGroups()).toEqual([])
 261  expect(result.map((r) => r.local_id)).toEqual([disagrees])
 269  expect(findVatMismatches(db.getFiscalisedOrdersWithVatGroups(), 0.16)).toEqual([])
```
54 expects.

**tests/resendPrint.test.ts**

```
  63  expect(outcome.ok).toBe(true)
  64  expect(onFiled).toHaveBeenCalledWith(localId)
  65  expect(printFiscalSlip).toHaveBeenCalledTimes(1)
  66  expect((printFiscalSlip.mock.calls[0] as unknown[])[0]).toMatchObject({ local_id: localId, fiscal_status: 'fiscalized', fiscal_invoice_number: '0123456789012345678' })
  67  expect(db.hasReceiptPrinted(localId)).toBe(true)
  81  expect(second.ok).toBe(true)
  82  expect(submitInvoice).toHaveBeenCalledTimes(1)
  83  expect(onFiled).toHaveBeenCalledTimes(1)
  84  expect(printFiscalSlip).toHaveBeenCalledTimes(1)
  97  expect(printFiscalSlip).toHaveBeenCalledTimes(1)
 110  expect(printFiscalSlip).not.toHaveBeenCalled()
 111  expect(db.getUnprintedFiscalSlips()).toEqual([])
 123  expect(printFiscalSlip).toHaveBeenCalledTimes(1)
 124  expect(db.hasReceiptPrinted(localId)).toBe(false)
 125  expect(db.getOrder(localId)?.fiscal_slip_unprinted_at).toBeTruthy()
 126  expect(db.getUnprintedFiscalSlips().map((row) => row.local_id)).toEqual([localId])
 140  expect(outcome.ok).toBe(true)
 141  expect(db.getUnprintedFiscalSlips().map((row) => row.local_id)).toEqual([localId])
 155  expect(outcome.ok).toBe(false)
 156  expect(onFiled).not.toHaveBeenCalled()
 157  expect(printFiscalSlip).not.toHaveBeenCalled()
 158  expect(db.getOrder(localId)?.fiscal_slip_unprinted_at ?? null).toBeNull()
 159  expect(db.getUnprintedFiscalSlips()).toEqual([])
 174  expect(outcome.ok).toBe(true)
 175  expect(db.getOrder(localId)?.fiscal_status).toBe('fiscalized')
 187  expect(printFiscalSlip).toHaveBeenCalledTimes(1)
 188  expect(db.hasReceiptPrinted(localId)).toBe(true)
 198  expect(outcome.ok).toBe(true)
```
28 expects.

**tests/customerSlipStamp.test.ts**

```
  69  expect(customerIsDuplicate(first.jobs, 1)).toBe(false)
  70  expect(first.jobs[1].lines[0]).toBe('E N J O Y')
  71  expect(customerIsDuplicate(second.jobs, 1)).toBe(true)
  72  expect(db.getOrder(localId)?.customer_slip_printed_at).toBeTruthy()
  83  expect(db.getOrder(localId)?.customer_slip_printed_at ?? null).toBeNull()
  87  expect(manual.jobs[1].lines[0]).toBe('E N J O Y')
  88  expect(customerIsDuplicate(manual.jobs, 1)).toBe(false)
  89  expect(customerIsDuplicate(next.jobs, 1)).toBe(true)
  99  expect(printed.fiscal?.success && printed.fiscal.data?.mode).toBe('pdf')
 100  expect(db.getOrder(localId)?.customer_slip_printed_at ?? null).toBeNull()
 114  expect(db.getOrder(localId)?.customer_slip_printed_at ?? null).toBeNull()
 123  expect(db.getOrder(localId)?.customer_slip_printed_at ?? null).toBeNull()
 134  expect(db.getOrder(localId)?.customer_slip_printed_at).toBe(first)
 144  expect(customerIsDuplicate(only.jobs, 1)).toBe(false)
 155  expect(second.jobs[0].lines[0]).not.toBe('*** DUPLICATE ***')
 156  expect(db.hasReceiptPrinted(localId)).toBe(false)
 183  expect(db.getOrder(1)?.total).toBe(60)
 184  expect(db.getOrder(1)?.customer_slip_printed_at ?? null).toBeNull()
 186  expect(db.getOrder(1)?.customer_slip_printed_at).toBeTruthy()
```
19 expects.
