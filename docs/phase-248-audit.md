# Phase 248 audit — split payments on one sale (read-only)

- **Date:** 2026-10-06, Nairobi
- **Asked by the owner:** audit, from the code, how a sale could be paid with more than one method (the example: KSh 1,500 paid 500 by M-Pesa STK push and 1,000 by a typed M-Pesa code), and stop for rulings. One sale, one fiscal invoice, one receipt; only the payment becomes a list.
- **Type:** read-only. No code, test or data was changed for this audit. No device command, no Shopify call and nothing on the live till. The only network reads were two public shopify.dev reference pages.
- **Numbering:** `phase-247.md` is taken (the Admin screens scroll), so this report is `phase-248-audit.md`.
- **Before it:** phase 246-2 (Open Shift M-Pesa balance blank) is committed as `9f204d2`.
- **Line numbers** are at commit `9f204d2`.

---

## Headline findings

1. **Today a payment is one method for the whole total.** It is fixed at five points:
   - the checkout request (`paymentMethod`, `tenderedAmount`, `changeDue`, `referenceNumber`);
   - the order row;
   - the order payload sent to Shopify and used for the receipt;
   - the `mpesa_payments` row, whose `amount` is always the sale total;
   - the M-Pesa screen, which pushes STK for the full total and completes the sale the moment it is confirmed.
2. **The fiscal device is told nothing about payment.** This holds in the code, in the KE command set and in the VIL workflow. P8 is confirmed. The protocol PDF's generic sample transaction calls a payment command (35h) "obligatory", but the KE command list has no such command. A split therefore needs no declaration and cannot be given one.
3. **Shopify's `orderCreate` (2026-07) takes a list of transactions,** each with its own amount and gateway. The till sends no transactions today: it sends `financialStatus: PAID` and puts the payment in the order note.
4. **Three assumptions in the order do not match the code:**
   - **Amounts are stored as `REAL`, not integer cents.** The code rounds to cents with `roundMoney`.
   - **The server has no repeat-submit protection.** Only the screen blocks a second tap. The order id is made in the main process for each call, and nothing in `orders` is unique per attempt.
   - **"A code is used once" holds for manual codes only.** A Daraja STK confirmation can be accepted again today (a known residual, phase 120 §10.2).
5. **More code reads `orders.payment_method` than P6 lists.** Shift close, corrections, sale moves, merges, Open Shift's earlier-sales check and the shift-window status all do. Fiscal Reconciliation does not, so it needs no change.

---

## Part 1. How payment works today

### 1. Cart and checkout

| What | Where |
| --- | --- |
| Method chosen: three toggles, Cash, M-Pesa, Card; one method per sale | [PosCheckoutPanel.tsx:103](../src/renderer/src/components/PosCheckoutPanel.tsx#L103) (`useState<QuickPaymentMethod>('cash')`), toggles 416-461 |
| Cash: tendered typed on the numpad, change worked out in the screen | [PosCheckoutPanel.tsx:169-170](../src/renderer/src/components/PosCheckoutPanel.tsx#L169-L170); `calculateChange` [checkoutMath.ts:41-44](../src/renderer/src/lib/checkoutMath.ts#L41-L44); Complete enabled when tendered ≥ total, `canCompleteSale` [checkoutMath.ts:68-81](../src/renderer/src/lib/checkoutMath.ts#L68-L81) |
| Cash sale sent | [PosCheckoutPanel.tsx:193-203](../src/renderer/src/components/PosCheckoutPanel.tsx#L193-L203): `paymentMethod: 'cash', tenderedAmount, changeDue` |
| M-Pesa sale sent: **automatically, when the payment is confirmed** | [PosCheckoutPanel.tsx:209-221](../src/renderer/src/components/PosCheckoutPanel.tsx#L209-L221): `tenderedAmount: cartTotal, changeDue: 0, referenceNumber`; fired by `onPaid` from the STK poller, [PaymentModal.tsx:266-269](../src/renderer/src/components/PaymentModal.tsx#L266-L269) |
| Card sale sent | [PosCheckoutPanel.tsx:231-243](../src/renderer/src/components/PosCheckoutPanel.tsx#L231-L243): `tenderedAmount: cartTotal, changeDue: 0`, `cardManual` |
| Request schema: one method | [ipcValidator.ts:46-114](../src/main/lib/ipcValidator.ts#L46-L114): `paymentMethod: z.enum(['cash','mpesa','card'])` (50), `tenderedAmount` (51), `changeDue` (52), `referenceNumber` (53), `mpesaManual` (80-89), `cardManual` (104-113) |
| Total | computed in the screen (`getTotal`, [cartStore.ts:300](../src/renderer/src/stores/cartStore.ts#L300)) and sent; the main process takes `total` from the request ([checkout.ts:386](../src/main/services/checkout.ts#L386)) |
| Order row | `orders.payment_method`, `tendered_amount`, `change_due`, `reference_number`, all `REAL`/`TEXT` with no CHECK on the method ([database.ts:1155-1184](../src/main/services/database.ts#L1155-L1184)); written by `queueOrder` ([database.ts:2327-2405](../src/main/services/database.ts#L2327-L2405), INSERT at 2354) |
| Order payload | `payload_json` carries `paymentMethod`, `tenderedAmount`, `changeDue`, `referenceNumber` ([database.ts:2329-2350](../src/main/services/database.ts#L2329-L2350)). The same payload is copied into the Shopify `sync_queue` row at insert ([database.ts:2379-2387](../src/main/services/database.ts#L2379-L2387)) |
| Card on the server | the gate takes the reference from `cardApproval` only; tendered and change are **derived**, total and 0 ([checkout.ts:518-530](../src/main/services/checkout.ts#L518-L530), [545-547](../src/main/services/checkout.ts#L545-L547)). There is no card ledger table; the order row is the record |
| `mpesa_payments` | **one row per M-Pesa sale**, `order_local_id NOT NULL`, `amount REAL`, `UNIQUE (mode, reference)` ([database.ts:1503-1519](../src/main/services/database.ts#L1503-L1519)); written in the order's transaction by `insertMpesaPayment` ([database.ts:5475-5492](../src/main/services/database.ts#L5475-L5492)) through three wrappers: SMS claim (5422), confirmed (5508), manual (5537) |
| Amounts | `REAL` everywhere; money is rounded with `roundMoney` (`Math.round(x*100)/100`, [database.ts:1118-1120](../src/main/services/database.ts#L1118-L1120)); SMS compares with `amountsMatchExactly` ([sms-mpesa-provider.ts:96](../src/main/services/integrations/sms-mpesa-provider.ts#L96)). **Not integer cents.** |

### 2. The payment gate, and every place that takes the M-Pesa amount to be the sale total

The gate is [checkout.ts:448-498](../src/main/services/checkout.ts#L448-L498). It has three branches.

| Branch | What it checks | Amount |
| --- | --- | --- |
| Manual code (`manualApproval`) | manual entry enabled (455); code shape `^[A-Z0-9]{10}$` (458); cashier's attestation (461); **the code not recorded before in any mode** (`hasRecordedMpesaPayment`, 468; [database.ts:5574-5581](../src/main/services/database.ts#L5574-L5581)); a duplicate refused again inside the write (`queueOrderRecordingManualPayment` returns null, [checkout.ts:591-595](../src/main/services/checkout.ts#L591-L595)) | **No amount is typed or checked.** The row is written with `amount: total` (475) |
| SMS reader / mock (`verifyReferenceNumbers`) | the provider matches the code to a received message **and its amount**: `verifyTransactionCode({ transactionCode, amount: total })` (482-485); a different amount is refused ([sms-mpesa-provider.ts:165-168](../src/main/services/integrations/sms-mpesa-provider.ts#L165-L168): "That payment is for a different amount…"); the message is spent in the order's transaction (`queueOrderClaimingSmsPayment`, [database.ts:5422-5456](../src/main/services/database.ts#L5422-L5456)) | `total`, exact |
| Daraja (otherwise) | `hasConfirmedStkPayment(reference)`: an `mpesa_transactions` row with `status = 'success'` and that receipt number or checkout id ([database.ts:6052-6061](../src/main/services/database.ts#L6052-L6061)) | **No amount check.** The row is written with `amount: total` (496). A confirmation already used is **not refused**: `insertMpesaPayment` is `ON CONFLICT DO NOTHING` for this mode ([database.ts:5459-5474](../src/main/services/database.ts#L5459-L5474), the residual of phase 120 §10.2) |

Every place that sets an M-Pesa amount to the sale total:

- **STK push:** for the cart total ([PaymentModal.tsx:299](../src/renderer/src/components/PaymentModal.tsx#L299), `amount: total`), and the attempt is logged with the same figure (308, 245). The amount on screen is fixed to the total ([PaymentModal.tsx:634-637](../src/renderer/src/components/PaymentModal.tsx#L634-L637), "Amount (fixed to the cart total)"). The file says it outright: "The M-Pesa amount always equals the cart `total`… so 'amount must exactly match the cart total' holds by construction" (152-155).
- **The three `mpesa_payments` amounts:** [checkout.ts:475](../src/main/services/checkout.ts#L475), [492](../src/main/services/checkout.ts#L492), [496](../src/main/services/checkout.ts#L496).
- **The SMS amount check** (482-485).
- **The renderer's M-Pesa tendered amount:** set to the total ([PosCheckoutPanel.tsx:214-215](../src/renderer/src/components/PosCheckoutPanel.tsx#L214-L215)).
- **Phase 221's description of expected M-Pesa:** "`expectedMpesa = mpesa_opening_balance + sum(total of the shift's non-voided orders with payment_method = 'mpesa')`… equal to the manual + Daraja split" ([phase-221.md:167](phase-221.md)). That equality holds only because each M-Pesa sale's one payment equals its total.

### 3. The fiscal request

**From the code:**
- The request object carries `paymentMethod` and `amountTendered` ([checkout.ts:329-330](../src/main/services/checkout.ts#L329-L330); declared optional in [etims.ts:79-82](../src/main/services/integrations/etims.ts#L79-L82)) and is stored in `orders.fiscal_request_json`.
- **No provider reads either field.** A search of `src/main` for `paymentMethod` and `amountTendered` finds no use in `real-etims-provider.ts` or `mock-etims-provider.ts`.
- The command sequence is `OpenInvoiceWithFreeCustomerData`, `SellPLUfromExtDB`/`_HS` per line, `ReadCurrentReceiptInfo`, `CloseReceipt`, `ReadDateTime` ([real-etims-provider.ts:23-34](../src/main/services/integrations/real-etims-provider.ts#L23-L34)).
- `CloseReceipt` is sent with an empty body: `this.sendCommand(this.endpoints.closeReceipt, 'CloseReceipt', {})` ([real-etims-provider.ts:1201](../src/main/services/integrations/real-etims-provider.ts#L1201)).
- Phase 183 recorded the same: "No payment or discount command exists. `Subtotal` is never sent, and `CloseReceipt` takes no payment argument" ([phase-183.md:90](phase-183.md)).

**From the protocol PDF** (`protocol_description_KE_CU_2509041522.pdf`, text extracted with `pdftotext`):
- §2.5.7: "**Command: 38h / 8 - Close fiscal receipt** — input: n. a. — output: `<InvoiceNum[19]<;><QRcode[128]>` — FPR operation: Closes the opened fiscal receipt and returns receipt info. … `zfpdef: CloseReceipt()`."
- §2.5, "Receipt operations commands", lists 30h (open sales receipt, invoice, credit note, debit note), 31h (sell, sell with HS code), 2Ch (open, sell and close), 33h (Subtotal), 38h (close), 39h (cancel) and 3Ah (duplicate). **There is no 35h (payment) command in the KE command set.** None of the 124 `zfpdef:` entries is a payment.
- **The PDF contradicts itself.** §3.2 "SAMPLE SALE TRANSACTION OF CU" says: "a procedure, which consists of several commands, of which obligatory are: initiation of customer fiscal receipt (command 30h), sale registration (command 31h or 32h), payment (command 35h) and finalization of the fiscal receipt (command 38h)". It also says "payment (command 35h) - contains information about the amount due and type of payment, which may cover partially or in full the grand total amount due as well as a parameter for calculation of change due". It describes a payment number "0 … IN CASH" (§2.1). `SDK_RECON.md` §7.2 reads this sample as the generic one: "it references commands `35h`/`36h` (payment / VAT account) that are not in the KE receipt flow we use… Treat it as shape, not as the KE recipe."

**From the VIL workflow** (`VIL G03 INTEGRATION WORKFLOW.pdf`; my copy has no " 1" in its name):
- "HIGH LEVEL PROCESS WORKFLOW … 2. The following fields will be sent to the Control Unit for Validation". The list is: user's PIN, time and date, tax invoice serial number, buyer's PIN, invoice type, item HS code, item unit of measure, item VAT rate, unit price, "Tax invoice total gross amount", "Tax invoice total tax amount", "Tax invoice total net amount", and RIN for credit notes.
- **None of these is a payment type or a payment amount.**
- "STEP 7: CLOSE RECEIPT … Resulting details are CU invoice number and also the TIMS QR code."

**Verdict:**
- The till sends no tender to the device today. The KE command set this device runs has no command that could carry one.
- **Whether KRA expects a split payment to be declared is not in the vendor documentation.** The documents only describe a generic payment command the KE set does not have.
- I stopped on this point. No command was sent.

### 4. The Shopify order

**Today** ([orders.ts:105-122](../src/main/services/orders.ts#L105-L122), API version `2026-07`, [shopify.ts:19](../src/main/services/shopify.ts#L19)):
- `financialStatus: 'PAID'`, `fulfillmentStatus: 'FULFILLED'`, `tags: [location tag]`.
- **No `transactions`**, so no gateway and no amount per payment.
- The payment is a sentence in `note`: "payment: cash (tendered X, change Y)" or "payment: mpesa (ref …)" (105-108).
- The payload is the one stored at sale time, so an offline sale carries its payment when the queue replays.

**shopify.dev, checked 2026-10-06** (public reference pages, read only):
- [`OrderCreateOrderInput` (2026-07)](https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/OrderCreateOrderInput):
  - `transactions`: `[OrderCreateOrderTransactionInput!]`, "The payment transactions to create for the order."
  - `financialStatus`: "If not specified, then this will be derived through the given transactions. Note that it's possible to specify a status that doesn't match the given transactions and it will persist, but if an operation later occurs on the order, the status may then be recalculated to match the current state of transactions."
- [`OrderCreateOrderTransactionInput` (2026-07)](https://shopify.dev/docs/api/admin-graphql/2026-07/input-objects/OrderCreateOrderTransactionInput):
  - `amountSet: MoneyBagInput!` ("The amount of the transaction.");
  - `gateway: String` ("The name of the gateway the transaction was issued through.");
  - `kind` (default `SALE`), `status` (default `SUCCESS`), `authorizationCode`, `processedAt`, `locationId`.
- **So one order can carry several transactions, each with its own amount and gateway.**
- **Not documented on those pages:**
  - a limit on the number of transactions;
  - what Shopify does when the transactions do not add up to the order total;
  - whether any free-text gateway name ("M-Pesa", "Cash") is accepted as is.
- **Not tried:** no order was created.

### 5. Every reader of the payment method

| # | Reader | Where | Reads | Split impact |
| --- | --- | --- | --- | --- |
| 1 | `sumByPaymentMethod`, the one shared method-sum of the reports | [reports.ts:220-229](../src/main/services/reports.ts#L220-L229) | `orders.payment_method` × `orders.total` | **Must read legs.** Callers below |
| 1a | Z report | [reports.ts:383](../src/main/services/reports.ts#L383) (`generateZReport`, 369) | via 1 | via 1 |
| 1b | Daily summary | [reports.ts:597](../src/main/services/reports.ts#L597) | via 1 | via 1 |
| 1c | End of Day body (day and per-shift), overall and per cashier | [reports.ts:863](../src/main/services/reports.ts#L863), [894](../src/main/services/reports.ts#L894) (`buildEndOfDayReport`, 861) | via 1 | via 1 |
| 1d | Sales Summary | [reports.ts:1324](../src/main/services/reports.ts#L1324) | via 1 | via 1 |
| 2 | M-Pesa manual / Daraja split | `sumMpesaByMode`, [reports.ts:244-253](../src/main/services/reports.ts#L244-L253); fed by `getMpesaPaymentsForShift` ([database.ts:5675](../src/main/services/database.ts#L5675)) | `mpesa_payments.amount` | Already per payment row; right once each leg writes its own amount |
| 3 | Z adjustment blocks (sales joining or leaving) | `adjustmentFields`, [reports.ts:514-517](../src/main/services/reports.ts#L514-L517) | method and total per sale | Must read legs |
| 4 | Shift close: expected cash, M-Pesa, card | `closeShift`, [database.ts:4503](../src/main/services/database.ts#L4503), [4515](../src/main/services/database.ts#L4515) | method × total | Must read legs |
| 5 | Figures now, for corrections | `workedFiguresNow`, [database.ts:4366](../src/main/services/database.ts#L4366) | method × total | Must read legs |
| 6 | Adjustment ledger snapshot (move, join) | `recordAdjustment`, [database.ts:4388-4393](../src/main/services/database.ts#L4388-L4393) | method × total | Must read legs |
| 7 | Correction | `addShiftCorrection`, [database.ts:5128](../src/main/services/database.ts#L5128) | method × total | Must read legs |
| 8 | Move a sale preview | `previewSaleMove`, [database.ts:4720](../src/main/services/database.ts#L4720), [4740-4741](../src/main/services/database.ts#L4740-L4741) (`cash = method === 'cash' ? total : 0`) | method × total | Must read legs; the form shows the method ([MoveSaleForm.tsx:193](../src/renderer/src/components/MoveSaleForm.tsx#L193)) |
| 9 | Merge preview | `previewShiftMerge`, [database.ts:4891](../src/main/services/database.ts#L4891) | method × total | Must read legs |
| 10 | Open Shift, earlier sales (S6) | `totalOfSales`, [database.ts:1126-1130](../src/main/services/database.ts#L1126-L1130), from `listUnattachedSales` ([4557](../src/main/services/database.ts#L4557)) | method × total | Must read legs |
| 11 | Shift-window status | [shift-window-status.ts:72](../src/main/services/shift-window-status.ts#L72) | method × total | Must read legs |
| 12 | Orders CSV export | `buildOrdersCsv`, [reportsExport.ts:119](../src/main/services/reportsExport.ts#L119) | method column | Show `split`, or the legs |
| 13 | Invoice list (Reports, Detail) | [ReportsPage.tsx:804](../src/renderer/src/pages/ReportsPage.tsx#L804) | method text | Display only |
| 14 | Receipt (standard layout) | [receiptLayout.ts:492-500](../src/main/lib/receiptLayout.ts#L492-L500) | payload method, tendered, change, reference | One payment block; must list legs |
| 15 | Receipt (Enjoy slip) | [enjoySlip.ts:136-139](../src/main/lib/enjoySlip.ts#L136-L139) | payload | Same |
| 16 | Reprint | [index.ts:3184-3190](../src/main/index.ts#L3184-L3190) (from `payload_json`) | payload | Same as 14/15 |
| 17 | Shopify note | [orders.ts:105-108](../src/main/services/orders.ts#L105-L108) | payload | See the decision on Shopify |
| 18 | Per-shift approval | `approveShiftMpesa` and `generateShiftEndOfDay` work on `mpesa_payments` ids ([database.ts:5777-5778](../src/main/services/database.ts#L5777-L5778)) | payment rows | **Already per leg**, once each manual leg has its own row |
| 19 | Fiscal Reconciliation | `generateFiscalReconciliation`, [reports.ts:1661](../src/main/services/reports.ts#L1661) | charged vs device total; **no payment method** | **No change** |
| 20 | Auto-assign, merges themselves, the override (244) | change `orders.shift_id` only | no method | No change; their previews are rows 8 and 9 |
| 21 | Held sales (217) | hold refused while a payment is on screen: `HOLD_PAYMENT_REASON` ([heldSale.ts:58](../src/renderer/src/lib/heldSale.ts#L58)), set by [PaymentModal.tsx:189](../src/renderer/src/components/PaymentModal.tsx#L189) and [CardEntryPanel.tsx:47](../src/renderer/src/components/CardEntryPanel.tsx#L47) | screen state | Must also refuse once any leg is confirmed |

## Part 2. Edge cases

| # | Case | Today | Verdict and proposed handling |
| --- | --- | --- | --- |
| 1 | STK 500 confirmed, then the manual 1,000 is wrong | A confirmed STK payment with no sale stays in `mpesa_transactions` as `success`. **Nothing marks it unmatched.** It shows only in M-Pesa Logs (the latest 50). On a Daraja till it can still be used by a later sale, because the gate checks the reference only ([database.ts:6052-6061](../src/main/services/database.ts#L6052-L6061)). On an SMS till the received message stays unmatched and is listed by `listUnmatchedMpesaSmsMessages` ([database.ts:5373](../src/main/services/database.ts#L5373)) for the cashier to pick. | Your handling stands: the sale stays open, 1,000 still due; re-enter, change method or cancel. **"Listed as unmatched in End of Day" does not exist today.** It would be new: a read of STK successes and unmatched SMS messages that no order used, by shift. Recommend adding it in the same phase, read-only, as a Checks line. No automatic reversal. |
| 2 | Cancel part-way | Nothing is written until checkout, and the checkout is one transaction ([database.ts:2359-2401](../src/main/services/database.ts#L2359-L2401)) | Holds by design. Confirmed legs as case 1. |
| 3 | Hold with a leg confirmed | Hold refused while the M-Pesa or card panel shows a payment in progress (row 21). "In progress" is screen state only. | **Agree: refused.** Make "a confirmed leg" part of the reason, so a hold is refused after the STK modal has closed. |
| 4 | A cent off | Amounts are `REAL`, rounded to cents; there is no integer-cents column | Compare in cents (`Math.round(x*100)`) when checking that the legs add up and that balance due is 0. Store legs as `REAL` rounded to cents, like everything else. |
| 5 | 600 sent on a 500 STK leg | **Cannot happen on STK.** The till sets the STK amount ([PaymentModal.tsx:299](../src/renderer/src/components/PaymentModal.tsx#L299)); the customer accepts or rejects it. It can happen when the customer pays by Till or Paybill and the code is typed, because **a manual code has no amount today** (`amount: total`, [checkout.ts:475](../src/main/services/checkout.ts#L475)). SMS refuses a different amount. | The manual leg's amount is typed by the cashier from the customer's message. It is checked at approval against the statement, as today. A leg above the amount still due is refused (no change from M-Pesa). A Daraja leg should check that the confirmed STK amount equals the leg; today the gate checks no amount. See "not verified" on the source of that amount. |
| 6 | One code on two legs or two sales | Manual: refused across modes (row 2 of Part 1 §2). SMS: the message is spent once. **Daraja: accepted again** (phase 120 §10.2). | P4 "once only" for Daraja is a **change to the gate**, not "unchanged". It would also check `mpesa_payments` for the reference, as manual does, and refuse within the request for legs. Decision below. |
| 7 | Discount | A live till refuses any discount before payment ([index.ts:1420-1430](../src/main/index.ts#L1420-L1430)) | Legs add up to the total after discount. Nothing else. |
| 8 | Moved or merged sale | A move or merge changes `orders.shift_id` only; legs keyed by order move with it | **But the previews and ledgers read the method** (Part 1 §5 rows 6-9). They must read legs, or the shift figures go wrong for a split sale. |
| 9 | Credit note | The till issues none: void is disabled, "A filed sale needs a credit note" ([voids.ts:21-22](../src/main/services/voids.ts#L21-L22)). The fiscal provider has a credit-note path (`OpenCreditNoteWithFreeCustomerData`, [real-etims-provider.ts:1303-1332](../src/main/services/integrations/real-etims-provider.ts#L1303-L1332)), which carries no payment either. | Out of scope. A refund of a split sale would need refund legs (which leg is refunded, to whom) and a Shopify refund; nothing fiscal. |
| 10 | Offline sale | The payload, with the payment, is copied into `sync_queue` at insert ([database.ts:2379-2387](../src/main/services/database.ts#L2379-L2387)) | Put the legs in the payload at insert; the queue replays them. |
| 11 | Double tap | Only the screen blocks it (`checkoutStatus === 'submitting'`, [cartStore.ts:308](../src/renderer/src/stores/cartStore.ts#L308)). The UUID is made in the main process per call ([checkout.ts:533](../src/main/services/checkout.ts#L533)), and `orders` has no unique key per attempt. **Two IPC calls would make two orders, two trader numbers and two fiscal invoices.** For M-Pesa, manual and SMS refuse the second, but Daraja does not. | Your "existing order idempotency" does not exist on the server. Recommend a screen-made attempt key, sent with the request and stored with a unique index. A repeat returns the first result and writes nothing. That is a small change to checkout, separate from legs, worth its own commit. |
| 12 | Receipt | One payment block, from the payload (Part 1 §5 rows 14-16) | One receipt. Under TOTAL, one line per leg, then Tendered and Change only with a cash leg. **Width:** "M-PESA (MANUAL) QAB45GH6IJ 1,000.00" is 35 characters, over the 32-column width ([receiptLayout.ts:151](../src/main/lib/receiptLayout.ts#L151)). Recommend two lines per non-cash leg: "M-PESA (MANUAL)   1,000.00", then "  Ref QAB45GH6IJ". |
| 13 | Old sales | Have no legs | Read as one leg from `payment_method` and `total` through the one shared reader; every report reads the same as now. |
| 14 | A manual leg rejected at approval | An entry left out is recorded with its reason in `mpesa_day_exclusions`. The payment row and the sale are untouched; the entry stays pending as carry-over for later shifts ([phase-246.md](phase-246.md)). | Per leg already: approval works on payment ids, so a rejected leg is left out and the confirmed STK leg is unaffected. |

## Part 3. The smallest plan (not built)

**Order of work:** two commits, then the legs.
1. **The attempt key (edge case 11).** Small, and valuable with or without splits.
2. **The shared leg reader and the move of every reader onto it,** with single-method sales only. Every report must read exactly as before; this commit proves the reader on today's data.
3. **Legs at checkout.**

### Changes, file by file

| File | Change |
| --- | --- |
| `database.ts` | **Table:** `order_payments` (id, order_local_id, leg_no, method, mpesa_mode, amount, reference, tendered, change_due, created_at), `UNIQUE (order_local_id, leg_no)`, append-only triggers like the shift ledgers. The migration checks before it adds. **Writing legs:** `queueOrder` writes the legs in its transaction; the three M-Pesa wrappers take a list of settlements, one `mpesa_payments` row per M-Pesa leg with the leg amount. **Reading legs:** new `paymentLegsFor(orderIds)` returns the stored legs, or one leg built from `payment_method` and `total` for an older sale. Rows 4-11 of Part 1 §5 use it. `payment_method` is set to `split` for more than one leg; the `PaymentMethod` type widens. |
| `reports.ts` | `sumByPaymentMethod` and `adjustmentFields` read legs. Nothing else. |
| `shift-window-status.ts`, `reportsExport.ts` | read legs |
| `checkout.ts` | The request carries `payments: [...]`. The main process refuses (nothing written) when: there are more than 4 legs; there is more than one cash leg; cash is not last; a non-cash leg is above what is still due; the legs do not add up to the total in cents; or the same reference appears twice. The gate runs once per M-Pesa leg with the leg amount; card per leg as today. Change is worked out on the cash leg only. One `queueOrder…` call writes the order, all legs and every `mpesa_payments` row; the fiscal request is built and sent once, as today. |
| `ipcValidator.ts` | `payments` array schema; the single-method fields kept for one release so an old renderer still works, mapped to one leg |
| `orders.ts` | the payment note lists the legs (fallback); transactions per your ruling |
| `receiptLayout.ts`, `enjoySlip.ts`, `index.ts` reprint | one line per leg |
| `PosCheckoutPanel.tsx`, `PaymentModal.tsx`, `CardEntryPanel.tsx`, `checkoutMath.ts`, `cartStore.ts` | **Panel:** an "amount due" and a list of legs; Complete disabled until the amount due is 0. **M-Pesa:** the modal takes the leg amount instead of the total, and adds a leg instead of completing the sale. **Hold:** refused with any confirmed leg. |
| `MoveSaleForm.tsx`, `ReportsPage.tsx` | show `split` with the leg methods |

**Tests that will change:**
- **`mpesa_payments.amount` equal to the total:** tests that assert it, for example `tests/shiftApproval.test.ts`.
- **Receipt:** the golden receipts, `tests/receiptLayout.test.ts` and `tests/fixtures/receipt-class-a-golden.json`, for the payment block, only where the layout of a single-method sale changes. Recommend none changes.
- **Shopify note:** the note text in the order-input tests.
- **`payment_method` and `paymentMethod`:** 30 and 65 test files mention these. Most stay as they are, because a single-method sale writes the same row. Which assertions change is found at build time; each gets an old/new note.

### What is not changed

The fiscal code and the fiscal request, trader invoice numbering, shift windows, auto-assign, merges, the override, Shift History's pager, the Reports cards, the per-shift approval logic, the SMS and manual gates' own checks (they run per leg), and `orders.total`.

### Tests (real `:memory:` SQLite)

- 500 STK plus 1,000 manual: one order, two legs, two `mpesa_payments` rows (500 Daraja, 1,000 manual), one fiscal call.
- 500 M-Pesa plus 1,000 cash, tendered 1,200: change 200, on the cash leg only.
- Legs not adding up, a non-cash leg above the amount due, two cash legs, cash not last, five legs: each refused, and no row in any table.
- A failed M-Pesa leg at the gate: nothing written.
- A repeat submit with the same attempt key: one order, one set of legs, one fiscal call, one trader number.
- Each report and figure in Part 1 §5 rows 1-11 equals the sum of the legs for a split sale.
- An old single-method sale reads the same in every report: golden figures before and after.
- The migration run twice changes nothing; a database made old is brought forward.
- The same M-Pesa code on two legs, or on a leg and an earlier sale, is refused.

### Mutation checks

- a sale saved when the legs do not add up;
- a report reading `orders.payment_method` instead of the legs;
- change worked out on a non-cash leg;
- a second fiscal invoice on a repeat submit;
- the same M-Pesa code accepted twice.

### Rollback

Revert the commits. The `order_payments` table and any `split` rows stay. A split sale written before the revert would read through the old code as method `split`: counted in no method total, but still in revenue. That is why the reader commit must land and be checked before any split is allowed, and why reverting after splits exist needs the reader kept.

---

## Decisions for the owner

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | P1: at most 4 legs, cash at most once and last; M-Pesa and card may repeat | **Agree.** Store the M-Pesa mode (Daraja, SMS, manual) on the leg from the gate branch, never from the screen, as `mpesa_payments` does now; the cashier picks only "M-Pesa" and the route. |
| D2 | Shopify | **Phase 1: the fallback.** Keep one paid order with no transactions, and list the legs in the note and as tags (`pay:mpesa`, `pay:cash`). Shopify's order total and status do not change, and no new Shopify behaviour is introduced. Transactions per leg (`amountSet`, `gateway`) are documented, but how Shopify treats them on a pre-paid order is not; try them later on one test order with your go. |
| D3 | Edge case 1: a confirmed STK leg on a cancelled sale | Agree on no automatic reversal. **Add an "unconfirmed / unused M-Pesa payments" line to Checks:** STK successes and SMS messages no order used, per shift. It does not exist today. |
| D4 | Edge case 5: overpayment | STK cannot be overpaid. For a typed code, the cashier enters the amount from the customer's message; above the amount due is refused (no change from M-Pesa); approval checks it against the statement. |
| D5 | P4 "a code is used once" for Daraja | This changes today's Daraja gate (phase 120 §10.2 residual). **Recommend doing it:** a split makes reusing a confirmation easier to slip into. But it is your call, because it changes the gate. |
| D6 | Receipt layout | Two lines per non-cash leg (label and amount, then the reference), so 32-column printers do not wrap. Tendered and Change only with a cash leg. A single-method sale prints exactly as today. |
| D7 | Repeat-submit key (edge case 11) | **Build it first, on its own.** It closes a gap that exists today for every method except manual and SMS M-Pesa. |
| D8 | Fiscal | Unchanged. The KE command set has no payment command; whether KRA expects a split declared is not in the vendor documentation. If you want certainty, ask VIL in writing; nothing sent to the device. |

## Observed but not changed

- **No amount check on Daraja:** the gate never compares the confirmed STK amount with the sale ([database.ts:6052-6061](../src/main/services/database.ts#L6052-L6061)). A confirmation for a smaller push, made before the cart grew, would pass today.
- **STK amounts in the log come from the screen:** the STK attempt is logged by the renderer with `amount: total` ([PaymentModal.tsx:304-310](../src/renderer/src/components/PaymentModal.tsx#L304-L310)), so `mpesa_transactions.amount` is the screen's figure, not Safaricom's.
- **The PDF contradicts itself:** `protocol_description_KE_CU_2509041522.pdf` §3.2 calls payment command 35h obligatory, while its own KE command list has none.

## Not verified

- **Where a Daraja STK amount could be read from Safaricom's own reply.** Whether the status response the till stores carries the amount was not checked against a real reply.
- **Shopify with transactions:** how it treats `transactions` on an order created as `PAID`, a total the transactions do not match, and free-text gateway names. Nothing was sent.
- **KRA and splits:** whether KRA or VIL expects any declaration of a split. Not in the documents; not asked.
- **The receipt width:** taken from the code (48, 42, 32 columns); not printed.
- **The count of tests that change:** an estimate from a text search.
