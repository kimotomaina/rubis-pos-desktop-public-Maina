# Phase 250 — One reader of payment legs (no change in figures)

- **Date:** 2026-10-06
- **Asked by the owner:** the 20:40 go. Every place that turns a sale into cash, M-Pesa or card figures gets them from one function. Every sale is one method today, so every figure must come out exactly the same. No new table; no split is possible after this phase.
- **Status:** built and tested in one commit. No version bump, no installer.

## The reader

**[`RubisDatabase.paymentLegsFor(orderIds)`](../src/main/services/database.ts#L3104)** is the one function:
- **The query:** one query for the whole list, `… WHERE local_id IN (SELECT value FROM json_each(?))`, never one per sale; no query for an empty list.
- **The legs:** one leg per sale, `{ orderId, method: orders.payment_method, amount: orders.total, voided }`. A voided sale keeps its leg, flagged, so each reader still decides about voided sales exactly as it did.
- **The return:** a `Map` of order id to its legs (a list, ready for the split phase, which will read `order_payments` first). A sale that does not exist has no entry.

Two small helpers sit on top of it. Neither reads the database:
- **[`methodTotalOf`](../src/main/lib/paymentLegs.ts)** adds the legs of a list of sales paid by one method, in the order the sales are given. It lives in a small pure module with the `PaymentLeg` type, so the reports and the window status need no value import from the database module.
- **[`paidByMethod`](../src/main/services/database.ts#L3122)** (private) is `paymentLegsFor` plus `methodTotalOf`, for the database's own readers.

**No arithmetic changed; only where the method and the amount come from.** Each reader keeps its own list of sales, its own voided rule, its own rounding and its own loop. The legs are added in the same order as the sales were, so every sum is the same floating-point sum as before, digit for digit, not only to the cent.

## Every reader moved (the audit's Part 1 §5, rows 1 to 12)

| # | Reader | Where now | Before |
| --- | --- | --- | --- |
| 1 | `sumByPaymentMethod` (Z report, daily summary, End of Day overall and per cashier, Sales Summary) | [reports.ts:223](../src/main/services/reports.ts#L223); callers [387](../src/main/services/reports.ts#L387) (Z), [603](../src/main/services/reports.ts#L603) (daily), [869](../src/main/services/reports.ts#L869) and [900](../src/main/services/reports.ts#L900) (End of Day), [1330](../src/main/services/reports.ts#L1330) (Sales Summary) | `order.payment_method`, `order.total` |
| 2 | `adjustmentFields` (the Z report's sales at close) | [reports.ts:530-531](../src/main/services/reports.ts#L530-L531) | the live order's and the ledger join's `payment_method` |
| 3 | `closeShift` (expected cash, M-Pesa and card) | [database.ts:4589](../src/main/services/database.ts#L4589) | `counted.filter(order.payment_method === …)` |
| 4 | `workedFiguresNow` (a closed shift's figures now) | [database.ts:4456](../src/main/services/database.ts#L4456) | same |
| 5 | `recordAdjustment` (the ledger's cash, M-Pesa and card totals) | [database.ts:4480](../src/main/services/database.ts#L4480); its query no longer selects `payment_method` | `sale.payment_method` |
| 6 | `addShiftCorrection` | [database.ts:5213](../src/main/services/database.ts#L5213) | `counted.filter(…)` |
| 7 | `previewSaleMove` (the cash and M-Pesa the sale takes) | [database.ts:4826](../src/main/services/database.ts#L4826) | `order.payment_method === 'cash' ? order.total : 0` |
| 8 | `previewShiftMerge` | [database.ts:4977](../src/main/services/database.ts#L4977) | `sales.filter(…)` |
| 9 | `totalOfSales` (Open Shift's earlier sales) | [database.ts:1156](../src/main/services/database.ts#L1156), fed at [4285](../src/main/services/database.ts#L4285) | `sale.payment_method` |
| 10 | The shift-window status (earlier sales shown to Open Shift) | [shift-window-status.ts:73](../src/main/services/shift-window-status.ts#L73); `paymentLegsFor` added to its database slice ([23](../src/main/services/shift-window-status.ts#L23)) | `sale.payment_method` |
| 11 | The orders CSV, "Payment method" column | [reportsExport.ts:60](../src/main/services/reportsExport.ts#L60), [121](../src/main/services/reportsExport.ts#L121) | `order.payment_method` |
| 12 | `listUnattachedSales`, the source of rows 9 and 10 | unchanged; its rows are now read for their ids, and their legs come from the reader | — |

**Not moved, by the ruling:**
- **Display only:** receipts, reprint, the Shopify note, the invoice list and the Move a sale form's text. `previewSaleMove` still returns `paymentMethod` from the order for that text.
- **Already reading `mpesa_payments`:** `sumMpesaByMode` and the per-shift approval.
- **Fiscal Reconciliation:** not touched.
- **`listAdjustmentSales`** still selects `payment_method` in its join, now unread by the reports. It is left for the split phase, which will remove it with the type.

## Proof on real data: the 1606 copy

[tests/rehearsal/paymentLegsGolden.test.ts](../tests/rehearsal/paymentLegsGolden.test.ts) runs only with `RUBIS_COPY_DIR` and `RUBIS_GOLDEN_DIR` set. It copies the three files to a temp folder first. The golden files hold real sales, so they stay in the session's scratchpad and are never in the repository.

**Before any code change, it wrote:**

| Group | Figures |
| --- | --- |
| Every shift (8) | the Z report, the End of Day, the Sales Summary for the shift's scope, the worked figures now |
| Every day with sales (6) | the Sales Summary, the daily summary, the End of Day |
| Previews | every sale moved to every shift: 1,440 move previews; every pair of shifts: 56 merge previews |
| Orders CSV | the whole range |

**Then, on the temp copy, it wrote to it:**
- it closed the open shift, with M-Pesa and card counted;
- it added three sales with no shift in the night of 6 Oct, a window with no shift;
- it read the window status's earlier-sales figures and opened a shift over them;
- it ran the 5 Oct repair (a move and a correction), and kept the ledger rows it wrote.

**After the change:**
- every figure is **identical**: the comparison is exact equality of the figures, so to the last digit, which is stronger than to the cent;
- the orders CSV is **byte-identical**;
- the copy's three files are unchanged (SHA-256 before and after);
- the existing rehearsal still passes, 8 of 8.

Nothing in the golden run was an error: 0 errors in every group.

**The writes ran under the old code too** (added 2026-10-06 21:10, on the owner's question). The golden files were written by this same test, so the close, the three sales, the window status, the opening and the 5 Oct repair ran on a fresh temp copy under the old code before they were written. The order, from the session record:
1. **20:32:07:** the 249-1 commit. The tree held no phase 250 change.
2. **20:34:41:** the test file was written. It was never edited after this.
3. **20:34:55:** the golden files were written under the old code (`RUBIS_GOLDEN_WRITE=1`).
4. **20:35:12:** a second run under the old code, comparing, was identical. This shows the run gives the same figures each time.
5. **20:36:** the first phase 250 code change.
6. **20:49 and 20:56:** the comparisons under the new code were identical.

The "after" figures were therefore compared with "before" figures from the same scripted steps.

## Tests

[paymentLegs.test.ts](../tests/paymentLegs.test.ts), 17 tests on a real `:memory:` SQLite. The data is a mixed set: cash, M-Pesa and card sales in three shifts, one of them voided, and three sales with no shift in a window with no shift.

- **`paymentLegsFor`:**
  - one leg per sale with its method and total, the voided one flagged;
  - nothing for no sales, and no query;
  - no entry for a sale that does not exist;
  - one query for ten sales.
- **Each moved reader gives the figures the old code gave** (worked out by hand), **and follows the legs.** With the legs relabelled through `paymentLegsFor` alone (cash read as card, card as cash), its figures move with them. A reader that reads `orders.payment_method` itself would not move. One test each:

  | Reader | The figure it checks |
  | --- | --- |
  | Z report | totals by method |
  | Sales Summary and daily summary | totals by method |
  | End of Day | overall and per cashier |
  | `closeShift` | expected cash, M-Pesa and card |
  | `workedFiguresNow` | moving an M-Pesa sale, so the shift's own figures are isolated |
  | `previewSaleMove` | the sale that moves |
  | `previewShiftMerge` | the receiving shift's figures |
  | The ledger and the Z report's sales at close | after a move |
  | `addShiftCorrection` | the expected cash it stores |
  | The CSV | the payment method column |
  | The window status | the earlier sales |
  | Opening a shift over earlier sales | the float and the M-Pesa opening |

- **A static pin:**
  - `reports.ts`, `reportsExport.ts` and `shift-window-status.ts` do not contain `payment_method` at all;
  - in `database.ts` no `payment_method ===` remains, and the only field reads left are the reader's own, the ledger join's and the Move a sale preview's text.

### Mutation checks (each restored; the file compared byte for byte afterwards)

| # | Mutation | Failing tests |
| --- | --- | --- |
| 1a | `closeShift` put back on `orders.payment_method` | 2: its follow-the-legs test, the static pin |
| 1b | The window status put back on the sales' `payment_method` | 2: its follow-the-legs test, the static pin |
| 2 | `paymentLegsFor` gives card the amount 0 | 18, across the card close, corrections, ledger and Z tests (`shiftCardClose`) and every reader test here |
| 3 | `paymentLegsFor` drops the voided flag | 1: the leg of a voided sale |
| 4 | The CSV built from the old column | 2: the CSV test, the static pin |

## Existing tests changed (each with a note in the file)

These tests drive the readers with hand-made fake databases, which now also serve the legs, through one helper, [tests/helpers/paymentLegs.ts](../tests/helpers/paymentLegs.ts) (`legsOf(rows)`). It builds the legs the way the reader does, from the same rows the fake already serves. No assertion changed.

| Test | Change |
| --- | --- |
| `reports`, `reportsExport`, `vatClassReceiptReports`, `traderNumberFromLocation`, `shiftCapture`, `shiftMpesaBalances` (Z fakes) | `paymentLegsFor: legsOf(…)` added to the fake |
| `pastShift`, `shiftZReport`, `shiftCorrections` (Z fakes with no sales) | `paymentLegsFor: () => new Map()` |
| `adminShiftWindows`, `oneShiftPerWindowUi`, `shiftCaptureUi` (window-status stubs) | the reader added to the stub; `shiftCaptureUi`'s builds legs from its own sales |
| `shifts`, `shiftCorrections`, `shiftMpesaBalances`, `shiftCapture` (mocked SQL connection) | the shift's order rows are served to the leg query too (`serveShiftOrders`) |
| `reports`, `shifts`, `shiftCorrections`, `shiftMpesaBalances` (order factories) | **OLD:** every order made had local id 1. **NEW:** each gets its own id, as real orders do, because the readers now find how a sale was paid by its id. |

## Rollback

Revert the commit. No table, column or stored figure was added or changed; the readers go back to reading the column.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 234 files passed, 2 skipped (the two copy rehearsals); 3,835 tests passed, 9 skipped |
| Golden on the 1606 copy | identical figures, byte-identical CSV, copy unchanged |
| Rehearsal on the 1606 copy | 8 of 8 |
| `npm run build` | passed, `verify-no-mock-provider` confirmed |
| Installer | not built |
