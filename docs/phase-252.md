# Phase 252 — Split payments (off by default)

- **Date:** 2026-10-06
- **Asked by the owner:** the 21:35 go. Build split payments from the phase 248 plan (Part 3), with the 20:15 rulings D1, D2, D6 and D7, and S1 to S10. One sale, one fiscal invoice, one receipt; the payment becomes a list.
- **Status:** built and tested in one commit. **Off by default**: with the setting off the till behaves exactly as before. D8 (does a split need declaring to the device) is still **Being confirmed** (owner Paul, VIL to answer in writing); the owner switches the setting on. No version bump, no installer.

## The rule this phase keeps: the sale is completed only after every payment is recorded

1. **Each payment first.** The cashier records the payments one by one. Each goes through the screen a sale paid that way uses, and must succeed there before it is added: cash typed, the card reference typed and ticked, the M-Pesa code accepted, or the STK push confirmed.
2. **Complete sale** becomes active only when the recorded payments add up exactly to the total, in whole cents.
3. **One checkout.** Complete sale sends one checkout with the full list. The main process checks the list again, then runs each payment through today's gate. In **one transaction** it writes:
   - the order and every payment (`order_payments`);
   - every `mpesa_payments` row;
   - the trader number;
   - the Shopify queue row and the fiscal queue row.

   Then it makes one fiscal call, as today.
4. **Nothing on refusal.** If anything is refused, nothing is written in any table (tested by counting every table and the trader sequence before and after). The cashier fixes the payment or cancels.

## What was built

| # | Rule | Where |
| --- | --- | --- |
| S1 | **The payments, checked in whole cents.** At most 4 and at least 2. Methods: cash, M-Pesa, card. Cash at most once and last; only cash gives change. No M-Pesa or card payment above what is still due when it is taken. The payments add up to the total exactly. No M-Pesa code on two payments. | `checkSplitPayments`, [checkout.ts:246](../src/main/services/checkout.ts#L246), the control. The screen applies the same rules to its buttons ([splitPayments.ts](../src/renderer/src/lib/splitPayments.ts)) |
| S2 | **The `order_payments` table.** Append-only (no update, no delete), `UNIQUE (order_local_id, leg_no)`, written in the sale's transaction. A sale paid one way writes one payment too. `orders.payment_method` is the method for one payment, `split` for more. | Table [database.ts:1303](../src/main/services/database.ts#L1303), created at [2318](../src/main/services/database.ts#L2318). Written by `queueOrder` ([2447](../src/main/services/database.ts#L2447), [2510](../src/main/services/database.ts#L2510)). One payment for a sale paid one way: `paymentsOfSale` ([1206](../src/main/services/database.ts#L1206)) and `singlePayment` ([checkout.ts:746](../src/main/services/checkout.ts#L746)) |
| S3 | **The 250 reader reads `order_payments` first.** It falls back to one payment from the order for an older sale. Still one query (a `LEFT JOIN`). | `paymentLegsFor`, [database.ts:3206](../src/main/services/database.ts#L3206) |
| S4 | **Each M-Pesa payment goes through today's gate unchanged,** once per payment, with the payment's amount where today it uses the total. A typed code takes the amount the cashier typed. One `mpesa_payments` row per M-Pesa payment, with that amount. A sale paid one way by a typed code records its total, as today. | `gateMpesaPayment` ([checkout.ts:515](../src/main/services/checkout.ts#L515)) and `gateCardPayment` ([622](../src/main/services/checkout.ts#L622)): the inline gates moved into functions word for word. `gateSplitPayments` ([684](../src/main/services/checkout.ts#L684)). The write: `queueOrderRecordingPayments`, [database.ts:5780](../src/main/services/database.ts#L5780) |
| S5 | **Hold is refused once any payment is recorded.** | The split panel sets the existing payment-in-progress flag (`'split'`), [SplitPaymentPanel.tsx](../src/renderer/src/components/SplitPaymentPanel.tsx) |
| S6 | **The receipt.** One receipt. Each payment prints its own block: two lines for M-Pesa and card (label and amount, then the reference), and Tendered and Change only under cash. The Enjoy slip has one line per payment. **A sale paid one way prints exactly as before**: the golden receipt tests are unchanged. | [receiptLayout.ts:499](../src/main/lib/receiptLayout.ts#L499), [enjoySlip.ts:136](../src/main/lib/enjoySlip.ts#L136). The payments come from the split sale's payload ([index.ts:3207](../src/main/index.ts#L3207)) |
| S7 | **Shopify.** One paid order as today. The payments go in the note and as tags (`pay:mpesa`, `pay:cash`, `pay:card`). No `transactions`. A sale paid one way keeps exactly its note and tags. | [orders.ts:72](../src/main/services/orders.ts#L72), [130](../src/main/services/orders.ts#L130) |
| S8 | **The displays** show a split as `split: mpesa 500.00 + cash 1000.00` (`describePayment`, [paymentLegs.ts:58](../src/main/lib/paymentLegs.ts#L58)). A sale paid one way shows its method, as before. | Invoice list: [index.ts:4052](../src/main/index.ts#L4052), shown by `ReportsPage`. Move a sale: [database.ts:4928](../src/main/services/database.ts#L4928). CSV: [reportsExport.ts:124](../src/main/services/reportsExport.ts#L124); its M-Pesa code and mode columns list each M-Pesa payment, joined with `+`, so a sale with one is as before |
| S9 | **One setting,** `split_payments_enabled` in `app_configurations`, off unless it is exactly `'true'`. It is changed only in Admin, through `config:set`, which re-checks the admin PIN. The main process reads it for each checkout, so no restart is needed. The till screen reads it when its payment panel opens. With it off, the "Split payment" button never shows, and a split sent anyway is refused with nothing written. `runCheckout` treats a missing value as off. | Key [checkout.ts:180](../src/main/services/checkout.ts#L180). Read at [index.ts:1500](../src/main/index.ts#L1500). Admin, System tab, "Split Payments" ([AdminScreen.tsx:691](../src/renderer/src/components/AdminScreen.tsx#L691), [1538](../src/renderer/src/components/AdminScreen.tsx#L1538)). Till button at [PosCheckoutPanel.tsx:517](../src/renderer/src/components/PosCheckoutPanel.tsx#L517) |
| S10 | **Not changed** | See below |

**The request.**
- **The schema:** `paymentMethod` may be `split`, with `payments` ([ipcValidator.ts:66](../src/main/lib/ipcValidator.ts#L66), [146](../src/main/lib/ipcValidator.ts#L146)).
- **Each payment carries:**
  - an M-Pesa payment: its code, or its manual entry;
  - a card payment: its PDQ entry;
  - the cash payment: what was handed over.

  These are in exactly the shapes a sale paid one way uses.
- **Stripping:** the handler strips each manual code and card entry into the gate's own approval, as it does for one payment ([index.ts:1478](../src/main/index.ts#L1478)).
- **Payments without `split`:** a request that carries payments without saying `split` is refused.

**The till screen.**
- **The panel** ([SplitPaymentPanel.tsx](../src/renderer/src/components/SplitPaymentPanel.tsx)):
  - shows the payments, what is still due, `+ Cash`, `+ M-Pesa`, `+ Card`, and Complete sale;
  - an M-Pesa or card payment asks for its amount first: up to what is due, and for the first payment one cent less, since a sale paid whole one way is not a split;
  - it then opens the same M-Pesa screen (`PaymentModal`) or card screen (`CardEntryPanel`) a sale paid one way uses, with "Record payment" on the button;
  - backing out of that screen adds nothing;
  - cash is offered only after a first payment and covers the rest;
  - a recorded payment can be removed.
- **Where the button sits:** "Split payment" shows under the three method buttons, on the cash screen only, so no payment in progress is dropped by opening it.
- **The tendered amount and change** the screen sends are its own figures. The main process works both out again from the payments, and stores those.

**The fiscal request is not changed for any sale paid one way.**
- **For a split sale,** its unread `paymentMethod` field says `split`, and `amountTendered` holds everything handed over.
- **Nothing is sent to the device about payment, as before:** no provider reads either field (phase 248 Part 1 §3).

**The gates answer at once, as before.** Moving the gates into functions could have added an `await` between a manual or Daraja gate and its write. That would let another checkout on the till run in between. The full suite caught it: `fiscalCheckoutDurability` expects the fiscal call to start with no wait for a manual sale. The gates now return a promise only on the provider's branch (the SMS reader), exactly where the inline gate awaited.

## Not changed (S10)

- **Not touched:** the fiscal code and the fiscal request's shape, trader numbering, the 249 key, shifts, auto-assign, merges, the override, the Reports cards and Fiscal Reconciliation.
- **The Daraja and manual gates:** their own checks are unchanged. Daraja is untouched (ruling of 21:35; `docs/phase-251-audit.md`).
- **`orders.total`:** unchanged.

## Tests

[splitPayments.test.ts](../tests/splitPayments.test.ts): 33 tests, on real `:memory:` SQLite, with a real file for the migration.

- **The example.** A sale of 1,500 paid 500 by STK and 1,000 by a typed code. The STK leg is the happy path: a confirmed STK record, as the mock provider leaves one. It gives:
  - one order, `split`;
  - two payments: Daraja 500, manual 1,000;
  - two `mpesa_payments` rows of 500 and 1,000;
  - one trader number and one fiscal call;
  - the reader gives both payments.
- **Change.**
  - 500 by code, then 1,000 cash with 1,200 handed over: change 200, on the cash payment only. The order holds 1,700 handed over and 200 change.
  - 500 card plus 1,000 cash.
- **Refused, nothing written in any table** (every table counted, and the trader sequence):
  - the payments not adding up;
  - an M-Pesa or card payment above what is due;
  - two cash payments;
  - cash not last;
  - five payments;
  - the same M-Pesa code on two payments;
  - an M-Pesa payment its gate refuses (an STK reference never confirmed);
  - a split while the setting is off, and with the setting left out;
  - a code already recorded on an earlier sale;
  - payments sent without `split`.
- **A repeat submit with the same checkout key:** one order, one set of payments, one trader number and one fiscal call. Every table is unchanged by the repeat.
- **A sale paid one way:** writes one payment for its total, and its payload has no payments list. A typed-code sale records its total, as before.
- **Every reader, for a split sale** of 2,000 (1,000 by code, 300 card, 700 cash with 1,000 handed over) in an open shift:
  - the Z report, the End of Day, the sales summary and the daily summary;
  - closing the shift: expected cash, M-Pesa and card, with no difference;
  - the move: the preview shows `split: mpesa 1000.00 + card 300.00 + cash 700.00` and the receiving shift's figures; the ledger row holds 700, 1,000 and 300; the Z report after the move;
  - the merge preview;
  - the CSV.

  All equal the sum of the payments.
- **The per-shift approval** lists the manual payment (1,000), not the whole sale.
- **Shopify:** one paid order, no `transactions`, the payments in the note, tags `pay:mpesa` and `pay:cash`. A sale paid one way keeps its note and tags.
- **The receipt** at 48, 42 and 32 columns:
  - every line fits;
  - each payment prints its own block, in order;
  - Tendered appears once, under cash.

  The Enjoy slip lists each payment.
- **The IPC schema** takes `split` with each kind of payment.
- **The migration** run twice changes nothing. The payments refuse update, delete and a second payment number 1.

[splitPaymentsUi.test.ts](../tests/splitPaymentsUi.test.ts): 11 tests, real mount.
- **The setting:** off (no row, or anything but `true`) shows no button; on shows it.
- **A full flow:**
  - a card payment through the card screen, then cash for the rest;
  - Complete sale stays inactive until the payments add up;
  - one checkout carries both payments, with change on the cash only.
- **A payment is added only when its screen succeeds:** backing out adds nothing.
- **The amounts:** the first payment cannot be the whole total.
- **Removing** a payment.
- **Hold** is refused once a payment is recorded.
- **The arithmetic in cents.**

**Old sales unchanged: the 250 golden rerun on the 1606 copy.**
- **Method:** on a temp copy, opened with the 252 code, which adds the empty table.
- **Result:** every figure identical, the CSV byte-identical, and the copy's files unchanged (SHA-256 `a3def016…`, `ee714dc4…`, `9bef3d97…`).
- **The repair rehearsal:** 8 of 8.

### Mutation checks (each restored; files compared byte for byte afterwards)

| # | Mutation | Failing tests |
| --- | --- | --- |
| 1 | A sale saved when the payments do not add up (the final sum check removed, and a cash payment above the rest let through) | 1: "the payments do not add up" |
| 2 | The reader ignores `order_payments` | 6: the example, and every reader test (Z, End of Day and summaries; close; move; merge; CSV) |
| 3 | Change worked out on a non-cash payment (an M-Pesa payment given the cash change) | 2: the example and the cash-change test |
| 4 | A second fiscal invoice on a repeat submit (both checkout-key answers removed) | 8: the split repeat, and all seven 249 repeat tests |
| 5 | A split accepted while the setting is off | 2: setting off, and setting left out |
| 6 | The same M-Pesa code accepted on two payments (the check removed, and the write's refusal of a repeated manual code) | 1: "the same M-Pesa code on two payments" |

## Existing tests changed (each with a note in the file)

| Test | OLD | NEW |
| --- | --- | --- |
| `runCheckout.test.ts` (three hand-built fake databases) | the fake slice `runCheckout` uses | the split write (`queueOrderRecordingPayments`) added to it |
| `tests/helpers/paymentLegs.ts` | order rows typed as one method | typed as the order row's own type, which can say `split`; no fake serves a split sale |
| `paymentLegs.test.ts`, the static pin | no `payment_method ===` in `database.ts`; three column reads | the only comparisons are with `'split'`, in the reader and in the Move a sale text; the reader's query reads the column too. Still no figure is worked out from it anywhere but the reader |
| `paymentLegs.test.ts`, the night sales | shift 3 was closed at the real time | closed at 18:00 Nairobi on 6 Oct. **A phase 250 defect:** from 21:10 Nairobi the real-time close fell after the night sales, and two tests failed on the 250 commit as well (checked with the changes stashed) |
| `rehearsal/paymentLegsGolden.test.ts` | collected at the real time | collected at the instant the golden files were written (20:34:55 Nairobi). **The same phase 250 defect:** closing the copy's open shift stamps it with the clock, so after 21:10 the close took in the three night sales the harness adds. The fixed harness passes on the 250 commit (checked with the changes stashed) and on this phase. The 250 comparisons ran at 20:49 and 20:56, before 21:10, so their result stands |
| `rehearsal/paulCopy.test.ts` | the table counts of the copy before and after the repair | plus `order_payments: 0`: opening the copy adds the table, empty; the repair writes no payment |

## Rollback

**Reverting this commit is safe only while no split sale exists.**
- **Before any split sale:** revert the commit. The `order_payments` table and its rows stay, unread by the old code; sales paid one way read exactly as they did.
- **Once a split sale exists:** the reader must stay. Without it, that sale's `orders.payment_method` is `split`, and it counts in no method total (cash, M-Pesa or card), though still in revenue. Before reverting, check with `SELECT COUNT(*) FROM orders WHERE payment_method = 'split'`.
- **Switching the setting off** stops new split sales at once and needs no revert.

## Not built

- **D3 (20:15):** a Checks line for M-Pesa payments no sale used. It was not part of this go.
- **The Daraja fixes** (`docs/phase-251-audit.md`): parked until Daraja is switched on.
- **The M-Pesa gates:** unchanged, by the ruling.

## Observed but not changed

- **A confirmed STK payment can be left out of the split.** A cashier can remove it, or cancel the split, after the customer paid it. The money stays in M-Pesa Logs as `success` with no sale, and nothing marks it unused. This is the same as cancelling an STK sale today, and is the case D3 and 251's D5 would cover.
- **Cart changes after a payment is recorded** are not locked. What is due follows the new total, and Complete sale stays inactive until the payments add up again. The main process refuses any mismatch.
- **A total with cents and Daraja.** An STK payment of a split is pushed for its whole-shilling amount (`Math.round`, phase 251 F2). With Daraja not live this cannot happen, and it is in 251's list.

## Not verified

- **The screen layout is not measured:** no `check:fit`, by the standing rule.
  - **With the setting off:** the screen is unchanged.
  - **With it on:** the "Split payment" line adds about one text row to the checkout panel, and the split panel itself has not been measured against the 1366x768 box.
- **Never run on the live till:** nothing was sent to the device, Shopify or Safaricom.
- **D8:** whether KRA or VIL expects a split declared. The setting stays off until VIL answers in writing.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 236 files passed, 2 skipped (the copy rehearsals); 3,878 tests passed, 10 skipped. The tenth is the bundle-wording check, which skips itself while the build is older than the sources; it passed after the build |
| Golden on the 1606 copy (temp copy) | identical figures, byte-identical CSV, copy unchanged |
| Repair rehearsal on the 1606 copy | 8 of 8 |
| Mutation checks | 6 of 6 caught, every file restored byte for byte |
| `npm run build` | passed, `verify-no-mock-provider` confirmed |
| Installer | not built |
