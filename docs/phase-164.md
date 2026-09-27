# Phase 164 — store and print the control unit's date/time and serial; label reprints as duplicates

Source: VIL G03 manual, "details received from control unit (to be
printed on invoice)" (CU invoice number, QR code URL, date and time
stamp, CU serial number); workflow step 8; post-implementation checklist
item 11 (Duplicate label). Builds on docs/phase-163-2's audit finding
that the provider already returns this data but every caller discarded
it before it reached storage.

Two commits, as directed.

- **Commit 1** (`1a58f05`): store `fiscalizedAt`, `fiscalizedAtSource` and
  `cuSerial` against the order, write-once.
- **Commit 2** (`ff8caf8`): print them on the receipt, and stamp a
  reprint DUPLICATE.

No fiscal-device command was added or changed. No Shopify call was made.
No SQL ran against a real database.

## Commit 1 — store them

### Audit

**Where `cuSerialNumber` comes from.** `real-etims-provider.ts:903-914`,
Step 1 of `submitInvoice`, ancillary and session-cached:

```
908: const cuNumbersResult = await this.ensureCUNumbers()
...
914: const cuSerialNumber = cuNumbersResult.success ? cuNumbersResult.data?.serialNumber : undefined
```

`ensureCUNumbers` (`real-etims-provider.ts:1363` onward) is documented as
"read once per session" (`real-etims-provider.ts:725-730`) — it never
sends `ReadCUnumbers` again just because this phase now stores its
result; a later sale reuses the same cached value.

**Is `cuSerialNumber` present on the already-filed recovery return?**
Yes. `cuSerialNumber` is computed once at the top of `submitInvoice`
(quoted above), before the code branches into either the normal Step
1-7 success return (`real-etims-provider.ts:1080`) or the already-filed
recovery return (`real-etims-provider.ts:968`) — both quote the SAME
`cuSerialNumber` variable:

```
956:  if (verdict.outcome === 'already-filed') {
...
968:    cuSerialNumber,
```

So no extra device command was needed, and none was added — the
recovery path already carried it; it was only ever dropped by the
callers (`checkout.ts`, `fiscal-engine.ts`, `fiscal-retry.ts`), exactly
like `fiscalizedAt`/`fiscalizedAtSource` (docs/phase-163-2).

**The three callers, before this commit** (all confirmed by reading each
file, matching docs/phase-163-2's trace):

- `checkout.ts:554` (pre-phase-164): `db.setOrderFiscalInfo(localId, invoice.data.invoiceNumber, invoice.data.qrCode, invoice.data.vatGroups)` — no `fiscalizedAt`/`fiscalizedAtSource`/`cuSerialNumber`.
- `fiscal-engine.ts:139` (pre-phase-164): `db.markFiscalQueueItemSynced(item.id, result.data.invoiceNumber, result.data.qrCode, result.data.vatGroups)` — same gap.
- `fiscal-retry.ts:196` (pre-phase-164): `deps.db.setOrderFiscalInfo(localId, outcome.data.invoiceNumber, outcome.data.qrCode, outcome.data.vatGroups)` — same gap.

**`setOrderFiscalInfo`** (`database.ts`, pre-phase-164) took no
`fiscalizedAt`/`fiscalizedAtSource`/`cuSerial` parameters at all and
always bound `new Date().toISOString()` for the timestamp — this is the
exact gap docs/phase-163-2 documented and this commit closes.

### Changes made

- **`src/main/services/database.ts`**:
  - `OrderRow` gained `fiscal_fiscalized_at_source: 'device' | 'local-fallback' | null` and `fiscal_cu_serial: string | null`.
  - `SCHEMA.orders` DDL gained both columns (`fiscal_fiscalized_at_source` with the same `CHECK` pattern as `fiscal_status`; `fiscal_cu_serial` plain `TEXT`).
  - `migrateOrdersFiscalColumns` gained both column names, added as plain `TEXT` on an upgraded database (no `CHECK` — SQLite can't add one via `ALTER TABLE ADD COLUMN`; this matches the existing, already-accepted asymmetry for `fiscal_status`/`fiscal_error_kind`).
  - Every existing "full `OrderRow`" `SELECT` (`getOrder`, `getOrderByFiscalInvoiceNumber`, `getOrdersForDateRange`, `getOrderRowsForRange`, `getOrders`) now selects both new columns — same set of places `fiscal_vat_groups_json` was added to in docs/phase-163.
  - `setOrderFiscalInfo` gained three optional parameters, `fiscalizedAt`, `fiscalizedAtSource`, `cuSerial`; stores `fiscalizedAt ?? new Date().toISOString()` **verbatim** (no reparsing/reformatting of the device's `dd-MM-yyyy HH:mm:ss` string), and the two new columns under the same `COALESCE(column, ?)` write-once guard as the existing fiscal fields.
  - `markFiscalQueueItemSynced` gained the same three optional parameters and forwards them to `setOrderFiscalInfo`.
- **`src/main/services/checkout.ts`**: `CheckoutDb.setOrderFiscalInfo`'s signature extended to match; the one call site now passes `invoice.data.fiscalizedAt`, `invoice.data.fiscalizedAtSource`, `invoice.data.cuSerialNumber`.
- **`src/main/services/fiscal-engine.ts`**: `FiscalEngineDatabase.markFiscalQueueItemSynced`'s signature extended; the one call site now forwards the same three fields from `result.data`.
- **`src/main/services/fiscal-retry.ts`**: `FiscalResendDb.setOrderFiscalInfo`'s signature extended; `resendFiscalization`'s one call site now forwards the same three fields from `outcome.data`.

### Tests

- **`tests/fiscalIntegration.test.ts`, Scenario J — deliberately changed, as the brief required.** Both tests previously asserted `fiscal_fiscalized_at` equalled the DB-write-time system clock, with an explicit comment that this was "not the device's own reported `fiscalizedAt`" (proving the old bug, not testing correct behaviour). Now:
  - **"a race-path queue replay..."**: mocked outcome's `fiscalizedAt` changed from `'2026-08-27T10:05:00.000Z'` (coincidentally equal to the system clock) to `'27-08-2026 10:04:55'` (a genuine device-format string, deliberately DIFFERENT from the system clock set via `vi.setSystemTime`), plus `fiscalizedAtSource: 'device'` and `cuSerialNumber: 'CU-SERIAL-0001'` added. Assertions changed from `toBe('2026-08-27T10:05:00.000Z')` to `toBe('27-08-2026 10:04:55')`, plus new assertions on `fiscal_fiscalized_at_source`/`fiscal_cu_serial`, both before and after the race-path replay. **Why**: proves the fix — the stored value is now the outcome's own value, not "now".
  - **"a genuine first success..."**: mocked outcome gained `fiscalizedAtSource: 'local-fallback'`/`cuSerialNumber: 'CU-SERIAL-0002'`; the assertion on `fiscal_fiscalized_at` changed from `toEqual(expect.any(String))` to `toBe('2026-08-27T11:00:00.000Z')` (the outcome's exact value). **Why**: `expect.any(String)` would also have passed under the old "always now" behaviour — it proved nothing about correctness.
- **`tests/database.test.ts`**:
  - `RubisDatabase.markFiscalQueueItemSynced`'s "saves the invoice number/QR code..." test: `params[3]`/`params[4]` assertions (`null`/`7`) changed to `params[3]`/`params[4]`/`params[5]`/`params[6]` (`null`/`null`/`null`/`7`). **Why**: two more bind parameters were inserted ahead of `localId`.
  - `RubisDatabase.setOrderFiscalInfo`'s test: `params` array `['KRA-0001', 'base64qr', expect.any(String), null, 7]` changed to `['KRA-0001', 'base64qr', expect.any(String), null, null, null, 7]`. **Why**: same reason.
  - **New**: "binds fiscalizedAt, fiscalizedAtSource and cuSerial exactly as given, not reformatted" — asserts the full 7-element bind array with real, non-`expect.any` values, including a device-format `fiscalizedAt` string bound unchanged.
- **`tests/fiscalEngine.test.ts`**:
  - "resubmits every due item and marks successes synced": `toHaveBeenNthCalledWith` calls extended from 4 args to 7 (added `fiscalizedAt: '2026-08-24T10:00:00.000Z'` — the stub's own value — plus `undefined`, `undefined`). **Why**: `markFiscalQueueItemSynced` now forwards three more arguments; an exact-args assertion needs all of them present.
  - "makes NO device call and marks the queue item synced when already fiscalized": same 4→7 args change, forwarding the order's own stored `fiscal_fiscalized_at` (`'2026-01-01T00:00:00.000Z'`) plus two `undefined` (the short-circuit never carries `fiscalizedAtSource`/`cuSerialNumber`).
  - **New**: a dedicated test with a full outcome (`fiscalizedAtSource: 'device'`, `cuSerialNumber` set) proving all three values reach `markFiscalQueueItemSynced` together.
- **`tests/fiscalIntegration.test.ts`, Scenario A**: new test proving `checkout.ts`'s direct-success path stores `fiscalizedAt`/`fiscalizedAtSource`/`cuSerial` from the outcome.
- **`tests/fiscalResend.test.ts`**: new test proving `resendFiscalization` stores the same three fields from a successful manual resend.
- **`tests/fiscalCuInfoMigration.test.ts`** (new file, copying `fiscalVatGroupsMigration.test.ts`'s pattern exactly): a real, file-backed `better-sqlite3` upgrade test — builds the pre-phase-164 `orders` table, inserts an already-fiscalized row, then opens it with a fresh `RubisDatabase` and confirms both new columns exist as `NULL` and are then fully functional.
- **Fixture-only updates** (no assertion changes, required by `OrderRow` gaining two new required fields): `tests/reportRanges.test.ts`, `tests/reports.test.ts`, `tests/reportsExport.test.ts`, `tests/shifts.test.ts`, `tests/voids.test.ts` each had `fiscal_fiscalized_at_source: null, fiscal_cu_serial: null` added to their local `OrderRow` factory functions.

**Mutation test**: temporarily changed `checkout.ts`'s call to
`db.setOrderFiscalInfo(...)` to pass `undefined` instead of
`invoice.data.fiscalizedAt`. Ran `tests/fiscalIntegration.test.ts` —
exactly two tests failed (Scenario A's new CU-fields test, and Scenario
J's "genuine first success" test), both asserting the exact
`fiscal_fiscalized_at` value from `checkout.ts`'s own call site. Every
other test, including Scenario J's race-path test (which writes via
`fiscal-engine.ts`, not `checkout.ts`), stayed green — the mutation was
caught precisely where it was introduced. Restored, re-verified green.

## Commit 2 — print them

### Audit

**Every call site of the receipt-print pipeline**, found by grepping the
whole repo for `printReceiptToType(`, `printReceipt(` and
`window.api.printReceipt`:

| Layer | Call site | Notes |
|---|---|---|
| Renderer → IPC | `App.tsx:258`, `window.api.printReceipt(localId)` | The ONLY call in the renderer, wired to exactly one prop: `onPrint` on `OrderHistory` (`App.tsx:531`), which is `OrderHistory.tsx`'s "Print Receipt" button (`OrderHistory.tsx:181-185`). |
| Main → printer | `main/index.ts:2482` (`printReceiptToType`), inside the `receipt:print` IPC handler | The ONLY call to `printReceiptToType` anywhere in `src/`. |

There is **no separate "print automatically after checkout" code path**.
`checkout.ts` never calls anything print-related (confirmed by grep for
`print`/`Receipt` in that file — the only matches are a doc comment and
the `CheckoutReceipt` type name). `cartStore.ts` stores the checkout
result for the `FiscalNotice` UI only, never triggers a print. This
means the literal first print of a freshly completed sale and any later
reprint are **the same button, same handler, same IPC channel** — there
is no call-site distinction to key "original vs duplicate" off. The
Z-report path (`isZReport: true`) is a separate branch of the same
handler, using `shiftId` not `localId`; it already has its own,
unrelated "Reprint" action (`ReportsPage.tsx:100`) and is untouched here.

Because of this, "original vs duplicate" has to be decided from
**persisted state** — whether this order's receipt has ever been
successfully printed before — not from which code path called it, since
there is only one.

**The PDF fallback never printed a fiscal block at all**, before this
commit (`pdf-receipt.ts`, pre-phase-164) — no `fiscalInvoiceNumber`, no
QR, nothing. This was a pre-existing gap, not introduced here; Commit 2
closes it as part of sharing the block between both surfaces.

**Today's printed label was "Fiscal Inv:"**, not "CU Invoice No:"
(`printer.ts:296`, pre-phase-164) — the brief's phrase '"CU Invoice No:
..." (as today)' does not match the code. Renamed to `CU Invoice No:` to
read consistently with the two new lines (`CU Date/Time`, `CU Serial
No`) and the VIL manual's own terms — flagged here in case the product
owner wanted the old wording kept and only the two new lines added.

### Changes made

- **`src/main/lib/receiptFiscalBlock.ts`** (new, shared the same way
  `receiptTotals.ts` is shared): `buildFiscalBlockLines(order)` — returns
  `[]` for an order with no `fiscalInvoiceNumber` (rule 3: never a CU
  block for an unfiled sale); otherwise `CU Invoice No: <n>`, then
  `CU Date/Time: <value>` when `fiscalizedAtSource === 'device'` or
  `Till time (device time unavailable): <value>` otherwise (covers
  `'local-fallback'` and an unknown/missing source on an older order),
  omitted entirely when there is no `fiscalizedAt` to show; then
  `CU Serial No: <serial>` when present, omitted otherwise.
- **`src/main/services/printer.ts`**: `ReceiptOrder` gained
  `fiscalizedAt?`, `fiscalizedAtSource?`, `cuSerial?`, `isDuplicate?`.
  `renderReceipt` now: stamps `*** DUPLICATE ***` (bold) at the top
  (before the store name) and bottom (before `cut()`) when
  `order.isDuplicate`; relabels the sale-creation line
  `Sale time: <value>` (was unlabelled); replaces the old
  `Fiscal Inv:`-only block with `buildFiscalBlockLines(order)`'s lines,
  still followed by the existing QR-code image/placeholder logic
  (unchanged).
- **`src/main/services/pdf-receipt.ts`**: same `isDuplicate` stamp
  (top/bottom), same `Sale time:` relabel, and — new — the same
  `buildFiscalBlockLines(order)` block before `doc.end()`. No QR image in
  the PDF (it never had one).
- **`src/main/services/database.ts`**: new nullable column
  `receipt_printed_at TEXT`, additive migration
  (`migrateOrdersReceiptColumns`, kept separate from the fiscal-column
  migration since this isn't a fiscal field), added to `SCHEMA.orders`
  and to the same five `SELECT`s Commit 1 touched. Two new methods:
  `hasReceiptPrinted(localId)` (plain read) and `markReceiptPrinted(localId)`
  (write-once via `COALESCE`, same pattern as the fiscal fields).
- **`src/main/index.ts`**: the `receipt:print` handler now reads
  `db.hasReceiptPrinted(localId)` **before** printing (deciding
  `isDuplicate`), passes the CU fields and `isDuplicate` into the
  `ReceiptOrder`, and calls `db.markReceiptPrinted(localId)` **only
  after** `printReceiptToType` reports success (physical print or PDF
  fallback) — an attempt that fails entirely (printer offline AND the
  PDF fallback also throws) leaves the row unmarked, so the next attempt
  is still correctly treated as the original.

### Tests

- **`tests/printer.test.ts`** — three existing assertions changed
  (label rename, all deliberate, all documented inline):
  - "omits the fiscal footer entirely...": `startsWith('Fiscal Inv:')` → `startsWith('CU Invoice No:')`.
  - "prints the fiscal invoice number and the QR code...": `'Fiscal Inv: KRA-0001'` → `'CU Invoice No: KRA-0001'`.
  - "prints only the invoice number line...": `'Fiscal Inv: KRA-0004'` → `'CU Invoice No: KRA-0004'`.
  - **New**: "Sale time:" prefix test; a full describe block for the CU date/time/serial lines (device-sourced wording, local-fallback wording, unknown-source wording, serial present, serial absent, no block at all for an unfiled order even if it happens to carry fiscal-looking fields); a describe block for duplicate labelling (stamped for `isDuplicate: true`, absent otherwise, position checked at both top and bottom).
- **`tests/receiptFiscalBlock.test.ts`** (new): exhaustive, plain-string-array tests of `buildFiscalBlockLines` itself — the one place the exact line content and wording is asserted for both callers, since PDF output isn't text-extractable in this project (see `pdfReceipt.test.ts`'s own note on why, unchanged from before this phase).
- **`tests/pdfReceipt.test.ts`**: new tests, matching this file's existing "doesn't throw, produces a PDF" style (no PDF text-content library exists in this project): a device-sourced CU block, a local-fallback CU block with no serial, an unfiled order, and `isDuplicate: true` — each just proves the shape reaches `generatePdfReceipt` without throwing.
- **`tests/receiptPrintTracking.test.ts`** (new, real in-memory `RubisDatabase`, matching `fiscalIntegration.test.ts`'s write-once precedent): `hasReceiptPrinted` false initially, true after `markReceiptPrinted`, unaffected on a different order, and — with fake timers forcing a real clock gap — a second `markReceiptPrinted` call leaves the first timestamp in place.
- **Fixture-only updates** (required by `OrderRow` gaining `receipt_printed_at`): the same five test files as Commit 1's fixture updates gained `receipt_printed_at: null`.

**Mutation test**: temporarily changed `printer.ts`'s
`buildFiscalBlockLines(order)` call to
`buildFiscalBlockLines({ ...order, fiscalizedAt: order.createdAt })`.
Ran `tests/printer.test.ts` — exactly the three new CU-date/time tests
failed (device-sourced, local-fallback, unknown-source wording), every
other test (including the serial, duplicate-stamp and "omits the fiscal
footer" tests) stayed green. Restored, re-verified green.

## Verify

```
$ npm run typecheck
(clean — both commits)

$ npx vitest run
Commit 1: Test Files 126 passed (126) | Tests 1921 passed (1921)
Commit 2: Test Files 128 passed (128) | Tests 1947 passed (1947)

$ npm run build
(succeeds — both commits; verify-no-mock-provider.cjs confirmed clean)

$ npm run check:fit
All 18 case(s) fit with no overflow. (both commits)
```

## The four rules

- **No fiscal-device command added or changed.** Confirmed: the only
  production files touched are `database.ts`, `checkout.ts`,
  `fiscal-engine.ts`, `fiscal-retry.ts`, `main/index.ts`, `printer.ts`,
  `pdf-receipt.ts`, and the new `receiptFiscalBlock.ts` — none of them
  are the provider (`real-etims-provider.ts`), which was read but never
  edited in either commit.
- **No fiscal/payment command sequence or filed data changed.** The data
  stored is exactly what `submitInvoice` already returned; nothing new is
  computed, guessed, or re-derived from the device.
- **No Shopify call.** None made.
- **No SQL run on real/production data.** All tests use `:memory:` or a
  disposable temp-file SQLite database.
- **Fiscal suite additions-only, except the named deliberate changes.**
  Every changed existing assertion is listed above by name, old value,
  new value, and why.

## Rollback

Commit 1: `git revert 1a58f05`. Commit 2: `git revert ff8caf8` (revert
Commit 2 first if reverting both, since it depends on Commit 1's columns
and `ReceiptOrder` fields).

Both migrations are additive (`ALTER TABLE ... ADD COLUMN`, idempotent,
already-tested against a real file-backed upgrade) — reverting the code
leaves the extra columns in place, unused, which is harmless.

## Observed but not changed

- **A rare double-click race**: `receipt:print`'s "peek, then print, then
  mark" sequence is not one atomic transaction. Two near-simultaneous
  print requests for the same brand-new order could both read
  `hasReceiptPrinted() === false` and both render as "original". The
  consequence is cosmetic only (a paper label, not fiscal data), and
  closing it fully would mean marking-before-printing, which risks the
  opposite, worse failure (a genuine first attempt that fails outright
  gets permanently mislabelled a duplicate on retry). Left as is;
  flagged for a human to weigh if it matters in practice.
- **Wording changes on file**: `Sale time:` prefix and `CU Invoice No:`
  (renamed from `Fiscal Inv:`) both change text on a printed,
  tax-adjacent document. Called out explicitly in the audit above in case
  the product owner wants different wording — easy to change in
  `printer.ts`/`pdf-receipt.ts`/`receiptFiscalBlock.ts` alone, nothing
  else depends on the exact strings.
- **Legacy orders**: any order fiscalized before Commit 1 has
  `fiscal_fiscalized_at_source`/`fiscal_cu_serial` as `NULL` forever
  (write-once; nothing backfills history). A reprint of one of those
  older sales shows the `Till time (device time unavailable):` wording
  (since the source is unknown, not `'device'`) and no serial line —
  correct given what the till actually knows, not a bug.
- **Not verified against real hardware.** As with every prior fiscal
  phase, this was verified against mocks/fakes and a real but local
  SQLite file — not a live control unit or physical printer.

STOP for review, per the brief.
