# Phase 221 — audit: shifts for past periods, M-Pesa balances on shifts, one screen for every report

- **Date:** 2026-10-05
- **Requested:** read-only audit and design proposal. Change nothing, report, stop. No `check:fit`.
- **Outcome:** nothing in `src/`, `tests/` or the database was changed. This document is the only file added. The scratch script and the database copy are in the session scratchpad, not in the repo.
- **Headline answers:** (5) every report reads the sales already on the till, with one exception: **M-Pesa Logs reads the STK-push request log, not sales**. (A3) There is **no pay-out or cash-drop feature**. (A4) Shifts are **not sent anywhere**. (A2) Nothing in the code **requires an open shift** to sell, which is how unattached sales arise.
- **The brief was cut off.** It ends mid-sentence in Part D item 1 ("…for the Z report, the PDF the receipt fallback already"). Part D below is built from the text that arrived plus what the code shows; if the missing text said something else, say so.
- **What the evidence is.** The "live" database is a **copy of this dev PC's** `rubis-pos.db` (+`-wal`, `-shm`), taken 2026-10-05 13:47 and read with Python's `sqlite3` and the app's own functions through `vite-node`; the live file was never opened. The phase 206 copy no longer exists. This dev PC holds **2 test sales and 0 shifts**, so the live results are real but thin. Where a report needs shifts, voids and M-Pesa to show anything, I also ran the same functions against an **in-memory fixture** (clearly labelled "fixture" below); those numbers are invented, the code that produced them is not.
- **Repo state:** main @ `1ea9059`, tree clean before this file.

## Part A. What exists

### A1. Shifts

`shifts` table ([database.ts:834](../src/main/services/database.ts#L834); row type [database.ts:304](../src/main/services/database.ts#L304)):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | |
| `staff_id` | INTEGER NOT NULL | who opened it |
| `clock_in` | TEXT NOT NULL | ISO instant, set to `new Date().toISOString()` at open |
| `clock_out` | TEXT | NULL while open |
| `starting_cash` | REAL NOT NULL DEFAULT 0 | |
| `expected_cash` | REAL | set at close |
| `ending_cash` | REAL | counted, set at close |
| `discrepancy` | REAL | `ending_cash − expected_cash` |
| `status` | TEXT NOT NULL DEFAULT `'open'` | CHECK `open`/`closed` |
| `shift_type` | TEXT, CHECK `day`/`night` | added by phase 199 ([migrateShiftsColumns, database.ts:667](../src/main/services/database.ts#L667)); NULL on older shifts |

That is all of it: **no `kind`, no created-by or reason, no M-Pesa field, no period other than `clock_in`/`clock_out`**. No index. The "only one open shift" rule lives in code (`openShift` throws "A shift is already open", [database.ts:3543](../src/main/services/database.ts#L3543)), not in a constraint.

- **`openShift(staffId, startingCash, shiftType)`** ([database.ts:3535](../src/main/services/database.ts#L3535)): refuses if any shift is open; stamps `clock_in` with now; inserts `status='open'`. IPC `shifts:open` ([index.ts:3389](../src/main/index.ts#L3389)), validated by `shiftOpenSchema` (staffId int, startingCash finite number, shiftType optional). **No manager PIN.** Any logged-in admin account on the Admin screen can open and close a shift.
- **`closeShift(shiftId, endingCash)`** ([database.ts:3575](../src/main/services/database.ts#L3575)): refuses a missing or already-closed shift; `expectedCash = starting_cash + sum(total of this shift's orders where payment_method = 'cash' and status != 'voided')`; `discrepancy = endingCash − expectedCash`; one `UPDATE shifts SET clock_out, expected_cash, ending_cash, discrepancy, status='closed'`. It runs through `closeShiftUnlessHeld` ([held-sales.ts](../src/main/services/held-sales.ts)), which refuses while a sale is held (phase 217). Not in a transaction: one read, one UPDATE.
- **`getOrdersForShift(shiftId)`** ([database.ts:2874](../src/main/services/database.ts#L2874)): `SELECT … FROM orders WHERE shift_id = ? ORDER BY created_at ASC`. **Every status is returned, voided included**; callers filter.
- Also: `getOpenShift`, `getShiftById`, `listShifts(limit, offset)` (newest id first), `countShifts`.

### A2. How `orders.shift_id` is set; unattached sales

- `orders.shift_id INTEGER` is **nullable** ([database.ts:783](../src/main/services/database.ts#L783)); no foreign key, no default.
- Checkout reads `db.getOpenShift()` once and passes `shiftId: openShift?.id` ([checkout.ts:532](../src/main/services/checkout.ts#L532), [:548](../src/main/services/checkout.ts#L548)); the insert is [database.ts:1831](../src/main/services/database.ts#L1831) (`… shift_id) VALUES (…, ?)`). With no open shift the value is `undefined` and the column stays NULL.
- **Nothing refuses a sale when no shift is open.** I searched `src/` for a refusal ("no open shift", "open a shift", "without a shift") and the checkout panel for any shift check: none. So a till left with no open shift sells normally, and every such sale has `shift_id IS NULL`. That is the situation Part B closes.
- The three order writers (`queueOrder`, `queueOrderRecordingManualPayment`, `queueOrderRecordingMpesaPayment`) are called only from [checkout.ts:592-604](../src/main/services/checkout.ts#L592); all take the same `shiftId`.
- **Voided orders keep their `shift_id`.** (Fixture: the voided 300 stayed on shift 1.)

**Count of sales with `shift_id IS NULL`, by Nairobi day** (query: `SELECT … FROM orders WHERE shift_id IS NULL`, grouped with the app's own `localDayOf`):

| Source | Nairobi day | Sales | Total | First sale (UTC) | Last sale (UTC) |
| --- | --- | --- | --- | --- | --- |
| **Live copy (dev PC)** | 2026-10-03 | **2** | 91.00 | 2026-10-02T21:37:08.330Z | 2026-10-03T00:48:03.119Z |

The copy holds 2 orders in all, 0 voided, **both with no shift**, and `shifts` is empty. The first is the 1.00 test sale from phase 206 (00:37 Nairobi); a 90.00 cash sale follows at 03:48 Nairobi. Note the first UTC time is 21:37 on 2026-10-02: grouped by UTC day this would have read as 2026-10-02 and 2026-10-03, by Nairobi day it is one day. (Fixture, for the shape with real gaps: 2026-10-02, 2 counted sales, 350.00, plus 1 voided; 2026-10-03, 1 sale, 80.00, a sale at 00:30 Nairobi.)

### A3. `generateZReport`

[reports.ts:250](../src/main/services/reports.ts#L250). Exactly:
- **Orders counted:** `db.getOrdersForShift(shiftId)` (so **by `shift_id`, not by time**) then `excludeVoided` (drops `status = 'voided'`). Revenue, order count, VAT and per-method totals come from that set; per-method is by the order's single `payment_method` (`cash`/`mpesa`/`card`).
- **M-Pesa split:** `getMpesaPaymentsForShift` (join `mpesa_payments` to `orders` on `shift_id`), voided excluded, summed by `mode` into `manual` and `daraja`; `sms` mode is ignored by the sum. Checkout writes a payment's `amount` equal to the order total ([checkout.ts:475](../src/main/services/checkout.ts#L475)), so the split adds up to the M-Pesa total.
- **Expected cash:** for a **closed** shift with a stored `expected_cash`, the stored value; otherwise `starting_cash + cash sales` (open shift, live). `endingCash` and `discrepancy` are the stored values (NULL while open).
- **Pay-outs / cash drops: no.** I searched `src/` for pay-out, paid-out, cash-drop, petty and float. The only hits are comments about the opening "float". Nothing reduces expected cash except voiding a sale. A manager who takes cash out of the drawer mid-shift (banking, a supplier) shows as a shortage today.
- Fixture result (shift 1: float 1000; sales cash 500, a cash 300 later voided, manual M-Pesa 200, Daraja 400, card 150; counted 1480): `closeShift` returned `expectedCash 1500, discrepancy −20`; the Z report shows `orderCount 4` (void excluded), `totalRevenue 1250`, `totalsByMethod cash 500 / mpesa 600 / card 150`, `mpesaByMode manual 200 / daraja 400`, `vatIncluded 172.41`. Shift 2 (open) shows `expectedCash 620` (500 + 120) with `endingCash` and `discrepancy` null.
- The Z report has **no M-Pesa expected or difference**, only the split.
- Printed on paper by `renderZReport` ([printer.ts:462](../src/main/services/printer.ts#L462)); the on-screen modal ([ZReportModal.tsx](../src/renderer/src/components/ZReportModal.tsx)) is a **separate hand-written copy** of the same lines.

### A4. Do shifts leave the till?

**No.** `shift` does not appear in `shopify-types.ts`, `orders.ts`, `sync-engine.ts`, or anything under `integrations/`; the sync payload (`OfflineOrderPayload`) carries no shift id. `shift_id` is read only by `database.ts`, `reports.ts` and `reportsExport.ts` (the orders CSV has a "Shift id" column). The only mention of Flient in the repo is in audit documents ([phase-157](phase-157.md), [phase-175](phase-175.md), [phase-207](phase-207.md)): the wider back-office platform, with no code on the till that talks to it about shifts. Whatever Flient or Shopify holds today about a shift, the till did not send it.

### A5. Report inventory

All of these read the local `orders` and `mpesa_payments` tables through `RubisDatabase`; `reports.ts` states it makes no network call ([phase-175 F7](phase-175.md)). Day boundary is **Nairobi (UTC+3, fixed offset)** for every report on screen. `getUtcDayRange` still exists but is only the default argument of `generateDailySummary`, and the one IPC caller passes Nairobi `today`. Paper and screen print times with `toLocaleString()`, so the till's own OS time zone (correct on a Kenyan till).

| Report | Data source (function) | Voided | Payment-method filter | Day boundary | Export today |
| --- | --- | --- | --- | --- | --- |
| **Z report** (shift) | `generateZReport`: orders by `shift_id` | excluded | none (all three methods shown) | the shift's own window (by `shift_id`) | **Print only**: thermal printer. **No PDF fallback**: `printZReport` passes none (receipts do), so with the printer offline the Z print just fails. No file. |
| **Shift History** | `listShifts` (10 a page) | n/a | n/a | n/a | **None** |
| **Sales Summary** | `generateSalesSummary` over `getOrdersForDateRange` + `getMpesaPaymentsForDateRange` | excluded | none; M-Pesa also split manual/Daraja | Nairobi, presets: today, yesterday, this/last week, this/last month | **None** (the "Export" card gives orders/lines CSV, not the summary) |
| **Fiscal Status** (by day) | `generateFiscalStatusByDay` | **included on purpose** (a filed sale stays filed) | none | Nairobi day | **None** |
| **Fiscal Reconciliation** | `generateFiscalReconciliation`: orders with `fiscal_status='fiscalized'` | **included** | none | Nairobi, presets | **None** |
| **Invoice List** | `getOrderRowsForRange` (newest first, 10 a page) | **included** (not filtered) | none | Nairobi, presets | **None** on its own (the orders CSV carries the same rows) |
| **End of Day** | `generateEndOfDayReport`: orders by Nairobi day, per cashier by `staff_id` (not by shift) | excluded | none; manual M-Pesa entries and carry-over | Nairobi day, one at a time | **None** (approval is recorded, not exported) |
| **Today's Sales** (Overview) | `generateDailySummary` with `getReportRange('today')` | excluded | none | Nairobi today | **None** |
| **M-Pesa Logs** | `getMpesaTransactions(50)` on `mpesa_transactions` | n/a | n/a | none (latest 50, no date filter) | **None** |
| Orders CSV / Lines CSV (Export card) | `buildOrdersCsv` / `buildLinesCsv` | **included**, marked `voided` | none | Nairobi preset | **CSV**, UTF-8 with BOM, via save dialog |

**M-Pesa Logs is not built from sales.** It lists STK-push requests (`mpesa_transactions`: phone, amount, status, receipt), which exist whether or not a sale followed. With the till on manual verification, as the pilot is, it is empty (it is empty in the copy). So "every report is built from the sales on the till" is **true for eight of nine screens, and false for M-Pesa Logs**, which should be called what it is (a Daraja request log) in any export screen.

**One real result per report** (live copy, Nairobi 2026-10-03; every function run unmodified):

| Report | Result |
| --- | --- |
| Today's Sales (`generateDailySummary`) | 2 orders, revenue **91.00**, VAT included 12.55, cash 91.00 / M-Pesa 0 / card 0 |
| Sales Summary (`generateSalesSummary`) | the same, plus `mpesaByMode` 0/0 and `vatFromDeviceGroups` **12.41** covering 1 of 1 fiscalised sale |
| End of Day (`generateEndOfDayReport('2026-10-03')`) | 1 cashier ("Admin"), 2 orders, cash 91.00; no manual entries, no carry-over, `pendingIds` empty |
| Fiscal Status (`generateFiscalStatusByDay`) | 2026-10-03: **1 fiscalized, 0 waiting, 1 needs_fixing** |
| Fiscal Reconciliation | 1 row, **matched**: charged 90.00, device 90.00, difference 0 |
| Invoice List (`getOrderRowsForRange`) | order #2 (90.00, cash, fiscalized, no shift), order #1 (1.00, cash, needs_fixing, no shift) |
| orders.csv / lines.csv | header + `2026-10-03 00:37:08,INV-000000001,…,Admin,cash,…,1.00,0.14,,completed,…`; the "Shift id" cell is **empty**, as it would be for every unattached sale |
| M-Pesa Logs (`getMpesaTransactions`) | `[]` |
| Shift History (`listShifts`) | `[]` |

Z report: no shift exists in the copy, so its real result is the **fixture** one in A3 above. Fixture, others: `generateSalesSummary` over 2026-10-01 to 04, **8 orders, revenue 1800.00**, cash 950 / M-Pesa 700 (manual 300, Daraja 400) / card 150; `generateDailySummary` for Nairobi 2026-10-02: 2 orders, 350.00 (cash 250, M-Pesa 100), the voided 60.00 excluded; `generateEndOfDayReport('2026-10-02')`: Ann, 2 orders, M-Pesa manual 100, `pendingManualTotal 300` (the 200 manual from shift 1 is carry-over).

### A6. The Export screen (phase 158)

- Reports page → **Export** card ([ReportsPage.tsx:588](../src/renderer/src/pages/ReportsPage.tsx#L588)): one of six presets (Today, Yesterday, This week, Last week, This month, Last month; fixed buttons, no free date), then **Export orders CSV** or **Export lines CSV**. Both disable while one runs.
- IPC `reports:export-csv` ([index.ts:3730](../src/main/index.ts#L3730)): validates preset and kind, builds the CSV with `buildOrdersCsv`/`buildLinesCsv` ([reportsExport.ts](../src/main/services/reportsExport.ts)), then **`dialog.showSaveDialog`** attached to the calling window, default folder `app.getPath('documents')`, filter CSV, file name `rubis-<kind>-<preset>-<Nairobi start day>.csv`; cancel returns `{ saved: false }` (not an error); otherwise `writeFileSync(path, csv, 'utf8')`. Nothing is written without that choice.
- **orders.csv:** one row per order **including voided** (marked `voided`), with date/time (Nairobi), trader and CU invoice numbers, fiscal status, cashier, payment method, first M-Pesa code and mode, total, VAT included, **Shift id**, order status, Shopify id, sync status, KRA PIN present yes/no, client UUID, the fiscal reconciliation figures, and VAT groups A to E. **lines.csv:** one row per line item from `payload_json`. No secrets in either.
- It exports **orders and lines only**. No Z report, shift list, summary, fiscal view, End of Day or M-Pesa log can be exported.
- The only PDF the app makes is the **receipt** fallback ([pdf-receipt.ts](../src/main/services/pdf-receipt.ts), phase 171): `pdfkit`, an 80 mm page, Courier, rendering the same layout array the thermal printer uses. It saves to the **Desktop** with a fixed name and opens it with `shell.openPath`; it has no save dialog and does not exist for Z reports.

## Part B. Past shifts (proposal, not built)

**1. Finding the gaps.** Agree. Shift History gets a block above the table, "Sales with no shift", one row per Nairobi day: count, first and last sale time (Nairobi), total (voided not counted), and a **Create shift for these** button that opens the create screen prefilled. Build it from `SELECT … WHERE shift_id IS NULL AND status <> 'voided'` grouped with `localDayOf`, so it matches the other reports' day. A night that crosses midnight appears as two days; the manager may widen the period to span both (item 2 still applies). Recommend the list also be a **read-only count on the Overview/Shift Controls card** ("3 sales have no shift") so a gap is noticed before it grows.

**2. The overlap rule.** Refuse when **any** of:
- the period overlaps any existing shift's window;
- it ends in the future (`end > now` in the main process);
- `end < start`, or either time is unparseable.

Define a window as the **closed interval `[clock_in, clock_out]`**, an **open shift as `[clock_in, +∞)`**, and two windows as overlapping when `newStart <= existingEnd AND newEnd >= existingStart`, so **touching counts as overlap** (equal instants are refused). Reason: sales are stamped to the millisecond and a sale on a boundary instant could not be said to belong to either side. The cost is that a manager prefilling from sale times next to a neighbouring shift's exact boundary has to leave one millisecond, which in practice never comes up because the prefill is the sale times, not the neighbour's. All times are compared as ISO-8601 UTC strings with the same `.000Z` format `clock_in` already uses (they sort correctly as text); the main process normalises with `new Date(x).toISOString()` first.
- **Where it is checked:** the main process, **inside the creating transaction** (read every shift row, test, insert, attach, all in one `better-sqlite3` `transaction()`), exactly as `approveMpesaEntries` does ([database.ts approveMpesaEntries](../src/main/services/database.ts)). The screen may pre-check for a friendlier message; it is not the guard.
- **Decision for the owner:** whether to refuse **whenever any shift is open**, or to allow a period that lies wholly before the open shift's start. I recommend the second (it falls out of the rule above), because a manager catching up on yesterday while today's shift runs is the normal case. Refusing while a shift is open is one extra line if preferred.
- Sub-case worth stating: a shift whose `clock_out` is NULL but `status` is not `open` cannot occur through the code, but an older database could hold one; treat any NULL `clock_out` as open-ended, which refuses more, never less.

**3. Which sales join.** Only rows with `shift_id IS NULL`, `status <> 'voided'` and `created_at` inside `[start, end]`. Never move a sale from one shift to another. **Voided sales should not join**: they count in no report and no Z total, so attaching them adds nothing but a shift number on a void, and leaving them NULL keeps "no shift" meaning "a counted sale with no shift". (If the owner wants every order to carry a shift id for the CSV, say so; attaching them is harmless to the figures.)

**4. Bound to the preview.** Agree, as End of Day does (phase 152). The create screen shows the exact sales that will join (id, time, method, total) with their count and total by method. The request carries `{ startIso, endIso, orderIds[], … }`. The transaction attaches **exactly those ids**, each only if it still has no shift (guard in the UPDATE, item 9) and is inside the period; it then checks `changes === orderIds.length`. **If any id fails, it throws, nothing is written, and the screen says which sale and why** ("order #12 now belongs to shift 4", "order #12 is outside the period", "order #12 was voided"). Also refuse an empty id list. And refuse if new unattached sales have appeared inside the period since the preview (compare the request's ids to a fresh `SELECT` of the period's NULL, non-voided ids: a mismatch means the preview is stale, ask to refresh), so a shift never claims to cover a period while quietly omitting a sale in it.

**5. What a past shift records.** New columns on `shifts`, added by an idempotent `ALTER TABLE` like `migrateShiftsColumns`, all nullable so every existing row is untouched:

| Column | Meaning |
| --- | --- |
| `kind` | `'normal'` (default for every existing and future normal shift) or `'retrospective'`; CHECK-constrained |
| `created_by_staff_id` | the manager who made it (for a normal shift, the existing `staff_id`) |
| `created_at` | when the record was made (a retrospective shift's `clock_in` is the period start, so this is the only place the real time is kept) |
| `reason` | required text for `retrospective`; refused if blank |
| cash fields | the existing `starting_cash`, `ending_cash`, `expected_cash`, `discrepancy`; **required** for a retrospective shift (expected cash cannot be computed without a float) |
| M-Pesa fields | Part C |

Created **already closed** (`status='closed'`, `clock_out` = period end). Authorisation: **`requireAdminPin`** in the main process, exactly like `reports:approve-day`: the request carries `managerId` and `managerPin`, and the creator recorded is that verified manager, not whatever the renderer claims. (Today's `shifts:open`/`shifts:close` take no PIN; I would leave those alone, since adding a PIN there is a behaviour change nobody asked for.) Plus the audit trail already used elsewhere: a new append-only row is not needed because the shift row itself holds who, when, why.

**6. No editing afterwards.** Agree: **no edit and no delete of any shift**, normal or past; the existing code has none, and the proposal adds none. **What the owner loses:** a typo in a counted figure, or a wrong period, can never be repaired in place, **and because the overlap rule also forbids a second shift over the same period, it cannot be redone either.** That is a real hole, not a footnote. Recommended remedy, small and still no edit: an **append-only `shift_corrections` table** (shift id, who, when, reason, the corrected cash and M-Pesa counted figures), shown under the original on the Z report as "Corrected on <date> by <name>: <reason>", with the original left visible. Build it **after** the main feature, not with it; until then a mistake can only be noted outside the till. Say if you would rather ship the two together.

**7. The Z report for a past shift.** Same layout, plus a line **"RETROSPECTIVE SHIFT, created <date> by <name>"** and the reason, on screen and on paper, and in any PDF/CSV. This needs the Z layout to exist **once** (a `buildZReportLayout(report)` list of lines, like the receipt's `buildReceiptLayout`) and be rendered by the thermal printer, the modal, and the PDF; today the thermal text and the modal are separate copies, so a new line would be added in two places and could drift. `ZReport` gains `kind`, `createdAt`, `createdByName`, `reason`.

**8. Day or Night.** Derive it from the **period's start time** with the existing `shiftTypeForTime(startIso)` ([main/lib/shiftWindows.ts:89](../src/main/lib/shiftWindows.ts#L89)): 09:00:00 to 17:30:59 Nairobi is `day`, everything else `night`. Store it in `shift_type` as normal, and let the manager see it (and change it, since this is the only free choice a normal shift also has). A period that starts in one window and ends in the other (09:00 to 20:00) still gets one label, from its start, as an ordinary shift would.

**9. What must not change, and the one UPDATE.** No sale's amount, time, payment, fiscal fields, trader number or Shopify state. Only `orders.shift_id`, only from NULL to the new shift id:

```sql
UPDATE orders
   SET shift_id = :newShiftId
 WHERE local_id = :orderId
   AND shift_id IS NULL
   AND status <> 'voided'
   AND created_at >= :periodStart
   AND created_at <= :periodEnd
```

run once per id in the request inside the same transaction as the `INSERT INTO shifts`, each checked for `info.changes === 1`; a 0 anywhere throws and rolls the whole thing back. Every guard is in the WHERE clause, so a concurrent checkout or a second manager cannot cause a sale to be moved (the update simply matches nothing and the transaction fails). The same transaction first runs the overlap test (item 2) and inserts the shift. No trigger, no other table, no change to `sync_queue`: `shift_id` is not part of the Shopify payload (A4), so **nothing is re-sent to Shopify or the fiscal device**.

## Part C. M-Pesa balances on every shift (proposal, not built)

**1. New fields.** `mpesa_opening_balance` and `mpesa_closing_balance` (REAL, nullable), entered where the cash figures are entered: the Open Shift form and the Close Shift form on Overview (today `startingCash` and `endingCash`, both with the on-screen numeric keyboard), and the create form for a past shift. **Recommend optional, with an explicit "Not recorded" state, not required.** Reason: the balance of the till number is read from the M-Pesa portal or the statement, which the person opening the till in the morning often cannot see; a forced field gets filled with 0 or a guess, and a wrong figure is worse than none because the report would then show a false difference and nobody would trust it. Cash stays required because the cashier can count it. For a **past** shift, cash is required and M-Pesa optional on the same reasoning. Suggest (not require) pre-filling a new shift's opening with the previous shift's closing figure, editable, so a break in the chain is visible.

**2. Expected and difference.**
- `expectedMpesa = mpesa_opening_balance + sum(total of the shift's non-voided orders with payment_method = 'mpesa')`, the same source the Z report already uses for "M-Pesa Sales" (and, per A3, equal to the manual + Daraja split).
- `mpesaDifference = mpesa_closing_balance − expectedMpesa`.
- Show the split by mode as End of Day does (manual, Daraja), keeping "manual (not yet matched to a statement)" distinct, since that is the part a manager actually checks.
- Compute only when **both** figures were entered; if either is missing, show "Not recorded" and no difference. Store the computed expected and difference at close (`mpesa_expected`, `mpesa_difference`) the way `expected_cash` and `discrepancy` are stored, so a later change to reporting code cannot rewrite a closed shift's figure.

**3. The wording.** Label the line **"Check against the M-Pesa statement"**, never "shortage", "over" or "discrepancy". The balance of the till number also moves for things the till never sees (withdrawals, bank transfers, M-Pesa charges, payments received outside the POS, reversals), so a non-zero difference means "look at the statement", not "money is missing". On paper: `M-Pesa expected: …`, `M-Pesa counted: …`, `Check against the M-Pesa statement: …`.

**4. Cash and card.** Cash fields and the cash discrepancy stay exactly as they are. Card is **not reconciled** (no balance is entered or knowable at the till): keep the card total and count on the Z report, and I suggest one plain line, "Card: N sales, KES X: check against the PDQ settlement", with **no difference figure**. Nothing else for card.

**5. Old shifts.** The new columns are NULL on every existing shift. The Z report shows **"Not recorded"** (blank), never 0; zero would read as "the balance was nothing". The same rule applies to a new shift where the manager chose not to enter one.

**Related gap, not in scope.** There is no pay-out or cash-drop (A3), so the cash side has the same blind spot the M-Pesa label above warns about. If the owner wants a drawer pay-out entry, it is a separate feature that feeds `expected_cash`.

## Part D. One screen to view and export every report (proposal, not built)

(Built from the text that arrived; the brief stopped partway through item 1.)

**Where.** Extend the **Reports page** (its card grid and the existing **Export** card), not a new page. Rename the Export card **"View and export"**; it lists every report in A5, and each row opens the existing on-screen view (all of which already exist) and shows an **Export** button with the formats it supports. The on-screen views are unchanged; only the buttons and one shared save path are new.

**How a file is saved.** One handler `reports:export` `{ report, format, preset | localDay | shiftId }` replaces the pattern of `reports:export-csv`: validate with zod (fixed enums, no free text), build the content in `main`, then the **same `dialog.showSaveDialog` flow** the CSV export uses (parent window, Documents as default folder, a cancel is not an error, nothing written without a choice). Extract that dialog-and-write block into one function and make the existing CSV handler call it, so there is one save path. "Download" on a desktop till means this save dialog; there is no browser download.

**Formats.** CSV (UTF-8 with BOM, the existing `buildCsv`/`csvMoney`, so Excel opens it) for every table. **PDF only where paper matters**: the Z report and End of Day. The Z report PDF should reuse the pdf-receipt approach (`pdfkit`, already a dependency, Courier, 80 mm) fed by the shared Z layout from Part B item 7, but saved through the dialog, **not** to the Desktop silently like the receipt fallback does. A4 for End of Day.

| Report | View today | Proposed export | Notes |
| --- | --- | --- | --- |
| Z report | modal from Shift History | **PDF** (80 mm, shared layout) and **CSV** (one row of figures) | also fixes "Z print has no PDF fallback" (A5) if the same layout feeds a fallback; separate decision |
| Shift History | table, 10 a page | **CSV**, all shifts in the preset (one row per shift: id, kind, period, cashier, type, cash start/expected/counted/difference, M-Pesa start/expected/counted/difference) | the list the owner will actually send to an accountant |
| Sales Summary | totals block | **CSV** (label, value rows) | Today's Sales is this report with the Today preset; no separate export |
| Today's Sales | Overview card | none of its own | same as above |
| Fiscal Status | table by day | **CSV** | |
| Fiscal Reconciliation | table, 10 a page | **CSV**, the whole range, not the page | the screen pages client-side; the export must not |
| Invoice List | table, 10 a page | **CSV** | identical rows to `orders.csv`, so offer the existing orders CSV here instead of a duplicate |
| End of Day | page for one day | **PDF** (A4: per cashier, manual entries, carry-over, approval line) and **CSV** | read-only; approving stays on the existing button |
| M-Pesa Logs | table of the last 50 | **CSV**, with a date range | label it "M-Pesa request log"; it is not built from sales (A5) and today has no date filter and a hard limit of 50, so the export needs a range |
| Orders / Lines | Export card | **CSV** (unchanged) | |

**Day boundary and voids in exports.** Every export states its Nairobi range in the first line (title and preset label) and its void rule, because the reports differ (A5: Z, Sales, End of Day exclude voids; Fiscal Status, Fiscal Reconciliation, Invoice List and orders.csv include them). One sentence in each file's header.

**Not changed by any of this.** No report's calculation, no existing view, no fiscal or payment code (the same promise `reports:export-csv` already makes), nothing sent anywhere.

## Observed, not changed

1. **A Z print with the printer offline fails** (no fallback), while a receipt falls back to a PDF. Related to Part D.
2. **`shifts:open` and `shifts:close` take no manager PIN** (A1). Past shifts propose one; normal shifts are as they were.
3. **`generateDailySummary`'s default range is the UTC day** (still reachable by a future caller); the live handler passes Nairobi `today`. Harmless today.
4. **Z report and Shift History print and show times with the machine's locale**, everything else with Nairobi arithmetic. Same result on a Kenyan till; differs on a PC set to another zone.
5. **The invoice list includes voided orders** (the Z, summary and End of Day exclude them), by design for a record list; the on-screen list does not mark them as void. A manager comparing it to the Z report will see the gap.
6. **No pay-out or cash-drop** (A3), so a legitimate withdrawal from the drawer reads as a cash shortage.
7. **The dev PC holds only 2 test sales and no shifts**; the real Kisumu and Enjoy tills' gaps cannot be counted from here. The same query (A2) run on a copy of each till's database would give the real numbers before anything is built.

## Open questions for the owner

1. Overlap with an **open** shift: allow a period wholly before it (recommended) or refuse while any shift is open?
2. **Voided** unattached sales: leave them out of a past shift (recommended) or attach them?
3. **M-Pesa balances optional** (recommended) or required?
4. **Corrections** (Part B item 6): ship `shift_corrections` with the feature or after it?
5. Should **normal** open/close also ask for a manager PIN? (Not proposed; asked because past shifts would be stricter than the shifts they sit between.)
6. What did the cut-off end of Part D item 1 say?
7. Which tills' databases should the gap count be run on, and by whom?

## What was not done

No code, test, schema or data change; nothing run against the live database file (a copy was read); `check:fit` not run; nothing built, published or installed.
