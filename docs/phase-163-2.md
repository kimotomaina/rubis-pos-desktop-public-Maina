# Phase 163-2 — audit: where the fiscal date and time comes from, and where it is stored

Audit only. No code changed, no device command sent, no SQL run against a
real database. Every claim below is quoted from the file and line it comes
from, or from `git log` output.

## Plain answer

Yes, and by a wide margin. The stored and printed fiscal time can differ
from the control unit's own clock, because **the control unit's own clock
value is thrown away before it ever reaches a receipt or the database.**

Two separate things are true at once:

1. **The printed receipt never shows a fiscal-device time at all.** It has
   always shown `order.createdAt` — the POS machine's own clock at the
   moment the order was created — not the device's `ReadDateTime` reply.
   This applies to the first print, a reprint, and the PDF fallback alike,
   because all three go through the same rendering code.
2. **`orders.fiscal_fiscalized_at`** (shown only in Order History) has
   stored the POS machine's own `new Date().toISOString()` at the moment
   `setOrderFiscalInfo` runs, since the column was introduced. It has never
   once stored the device's own timestamp, even though `submitInvoice`
   computes one specifically for that purpose (`fiscalizedAt`,
   `fiscalizedAtSource`). That result is discarded at every call site that
   would persist it.

How far apart the two clocks can end up:

- **A first-attempt success**: the gap is however long it takes the POS
  process to get from `CloseReceipt` to calling `setOrderFiscalInfo` —
  normally under a second, so in practice this case is usually close to
  the device's own time even though it is never actually read from it.
- **A queued retry that eventually succeeds**: the stored value is "now"
  at the moment the retry succeeds, not the device's time and not the
  time of the original sale. Retries back off exponentially from 30
  seconds up to a 30-minute cap (`SYNC_BACKOFF_BASE_MS`/`SYNC_BACKOFF_CAP_MS`,
  `src/main/services/database.ts:308-311`), for up to 10 attempts
  (`SYNC_MAX_ATTEMPTS`, `database.ts:314`) before the row is left
  `ABANDONED` for manual attention rather than deleted
  (`database.ts:1362-1369`). So the recorded "fiscalized at" time can be
  minutes, or — if IT manually revisits an abandoned row later — hours or
  days after the sale and the device's own receipt actually happened.
- **Independent clock drift**: the control unit is its own piece of
  hardware with its own real-time clock. Even a first-attempt success
  only happens to look close to the device's time because the two clocks
  are both roughly "now" — any drift between the till's clock and the
  device's own clock passes straight through, unnoticed, because the
  device's clock is never the thing being read.

## 1. Tracing `fiscalizedAt`/`fiscalizedAtSource` from the provider onward

**Where the values are produced** — `src/main/services/integrations/real-etims-provider.ts:1060-1087`,
Step 7 of `submitInvoice`, `ReadDateTime`:

```
1060: // Step 7/7: ReadDateTime — best-effort; a failure here doesn't undo an already-closed receipt.
1061: logStep(7, 'ReadDateTime')
1062: const dateTimeResult = await this.sendCommand(this.endpoints.readDateTime, 'ReadDateTime', {})
1063: const deviceDateTime = dateTimeResult.success
1064:   ? (dateTimeResult.data?.DateTime ?? dateTimeResult.data?.dateTime)
1065:   : undefined
...
1078:     fiscalizedAt: deviceDateTime ?? new Date().toISOString(),
1079:     fiscalizedAtSource: deviceDateTime ? 'device' : 'local-fallback',
```

There is a second success return, for the already-filed recovery path
(`verifyAlreadyFiled`, phase-162-2), which never calls `ReadDateTime` at
all and hard-codes the local-fallback shape —
`real-etims-provider.ts:966-967`:

```
966: fiscalizedAt: new Date().toISOString(),
967: fiscalizedAtSource: 'local-fallback',
```

**`FiscalInvoiceResult`'s type**, `src/main/services/integrations/etims.ts:154-163`:

```
154: fiscalizedAt: string
...
163: fiscalizedAtSource?: 'device' | 'local-fallback'
```

**First stop: `checkout.ts`**, the immediate-checkout caller —
`src/main/services/checkout.ts:552-554`:

```
552: if (invoice.ok) {
553:   fiscal = { invoiceNumber: invoice.data.invoiceNumber, qrCode: invoice.data.qrCode }
554:   db.setOrderFiscalInfo(localId, invoice.data.invoiceNumber, invoice.data.qrCode, invoice.data.vatGroups)
```

Both the in-memory `fiscal` object (which becomes part of `CheckoutReceipt`,
handed back to the renderer right after checkout) and the `setOrderFiscalInfo`
call read only `invoiceNumber`, `qrCode` and `vatGroups` off `invoice.data`.
`invoice.data.fiscalizedAt` and `invoice.data.fiscalizedAtSource` are never
referenced here. `CheckoutFiscalInfo`, the type of `fiscal`, confirms this
isn't an oversight in this one line — the type itself has no field for it
(`database.ts:183-186`):

```
183: export interface CheckoutFiscalInfo {
184:   invoiceNumber: string
185:   qrCode: string
186: }
```

So a fiscalizedAt value never even reaches the renderer's own
post-checkout receipt notice, let alone the database.

**Second stop: `fiscal-retry.ts`**, used by both the background queue
(`fiscal-engine.ts`) and a manual resend (`resendFiscalization`). The
already-fiscalized short-circuit fabricates its own fallback value rather
than reading anything real —`fiscal-retry.ts:86-94`:

```
86: if (order?.fiscal_status === 'fiscalized') {
87:   return {
88:     ok: true,
89:     data: {
90:       invoiceNumber: order.fiscal_invoice_number ?? '',
91:       qrCode: order.fiscal_qr_code ?? '',
92:       fiscalizedAt: order.fiscal_fiscalized_at ?? new Date().toISOString()
93:     }
94:   }
```

(and identically at `fiscal-retry.ts:172-179` inside `resendFiscalization`'s
own fiscalized short-circuit, before it even calls `attemptFiscalRetry`).
This `fiscalizedAt` is read back out of the order row purely so the
function's return type is satisfied — nothing downstream reads it (see
below), so it never causes a second write either way.

When the device is genuinely called again (`attemptFiscalRetry`,
`fiscal-retry.ts:97`, `return deps.fiscalizationProvider.submitInvoice(...)`),
its `fiscalizedAt`/`fiscalizedAtSource` flow back out of `submitInvoice`
exactly as in section 1 above, and are then dropped at the two places that
consume the result:

- `fiscal-engine.ts:139` (the background queue's success path):
  ```
  139: db.markFiscalQueueItemSynced(item.id, result.data.invoiceNumber, result.data.qrCode, result.data.vatGroups)
  ```
- `fiscal-retry.ts:196` (`resendFiscalization`'s success path):
  ```
  196: deps.db.setOrderFiscalInfo(localId, outcome.data.invoiceNumber, outcome.data.qrCode, outcome.data.vatGroups)
  ```

Neither call passes `fiscalizedAt` or `fiscalizedAtSource` through.
`markFiscalQueueItemSynced` itself just forwards to `setOrderFiscalInfo`
(`database.ts:1354-1355`), so there is exactly one place in the whole
codebase that ever writes these three columns — see section 4.

**Conclusion for section 1**: `fiscalizedAt`/`fiscalizedAtSource` are
computed carefully (device-first, with an explicit fallback tag) in the
provider, and are discarded at the very next line in every one of the
three call sites that consume a `submitInvoice`/`attemptFiscalRetry`
result. Nothing downstream — not the renderer, not the database, not a
report — ever sees them.

## 2. `setOrderFiscalInfo` and `new Date().toISOString()` — since when?

```
$ git log --oneline -S "fiscal_fiscalized_at" -- src/main/services/database.ts
da353d6 fix: make fiscal fields write-once; add VAT-from-device-groups coverage
a2c0654 feat: Admin Reports tab - shift history, sales summary, fiscal status, invoice list, CSV export
85a7f3a feat: fiscalization v1 done
f41e77c feat: etims
```

`f41e77c` ("feat: etims", 2026-08-28) is the commit that introduced the
column and the function together — there is no earlier commit to check.
Its version of `setOrderFiscalInfo`:

```
$ git show f41e77c:src/main/services/database.ts | sed -n '681,687p'
681: setOrderFiscalInfo(localId: number, invoiceNumber: string, qrCode: string): void {
682:   this.conn
683:     .prepare(
684:       'UPDATE orders SET fiscal_invoice_number = ?, fiscal_qr_code = ?, fiscal_fiscalized_at = ? WHERE local_id = ?'
685:     )
686:     .run(invoiceNumber, qrCode, new Date().toISOString(), localId)
687: }
```

The function has never taken a `fiscalizedAt` parameter at any point in
this repository's history. Every later change to it (`85a7f3a`, `a2c0654`,
`da353d6`) only ever added the `fiscal_status`/error-clearing columns, then
`vatGroups`, then the write-once `COALESCE` guards (phase-163-1) — the
`new Date().toISOString()` at the value position for `fiscal_fiscalized_at`
is untouched across all four commits. Today's version, `database.ts:1465-1487`:

```
1465: setOrderFiscalInfo(
1466:   localId: number,
1467:   invoiceNumber: string,
1468:   qrCode: string,
1469:   vatGroups?: FiscalVatGroupAmounts
1470: ): void {
1471:   this.conn
1472:     .prepare(
1473:       `UPDATE orders SET fiscal_invoice_number = COALESCE(fiscal_invoice_number, ?),
1474:        fiscal_qr_code = COALESCE(fiscal_qr_code, ?),
1475:        fiscal_fiscalized_at = COALESCE(fiscal_fiscalized_at, ?),
1476:        fiscal_status = 'fiscalized', fiscal_error_reason = NULL, fiscal_error_kind = NULL,
1477:        fiscal_data_issue = NULL, fiscal_vat_groups_json = COALESCE(fiscal_vat_groups_json, ?)
1478:        WHERE local_id = ?`
1479:     )
1480:     .run(
1481:       invoiceNumber,
1482:       qrCode,
1483:       new Date().toISOString(),
1484:       vatGroups ? JSON.stringify(vatGroups) : null,
1485:       localId
1486:     )
1487: }
```

**Did an earlier version store the device's own date string?** No — not
structurally, because the function has never accepted one to store. This
directly contradicts a premise in `docs/phase-96.md`, written well after
`setOrderFiscalInfo` already looked exactly like this. Phase-96's audit
table states (`docs/phase-96.md:17`):

```
| Device-sourced | `real-etims-provider.ts:906` — `fiscalizedAt: deviceDateTime ?? new Date().toISOString()` ... | `dd-MM-yyyy HH:mm:ss`, e.g. `05-09-2026 14:30:00` |
```

I checked the commit phase-96.md was written in
(`858f710`, `git log --oneline --diff-filter=A -- docs/phase-96.md`). At
that exact commit, `checkout.ts`'s only call to `setOrderFiscalInfo` was
already:

```
$ git show 858f710:src/main/services/checkout.ts | sed -n '379,382p'
379:   if (invoice.ok) {
380:     fiscal = { invoiceNumber: invoice.data.invoiceNumber, qrCode: invoice.data.qrCode }
381:     db.setOrderFiscalInfo(localId, invoice.data.invoiceNumber, invoice.data.qrCode)
```

and `setOrderFiscalInfo` itself was already hard-coding
`new Date().toISOString()`:

```
$ git show 858f710:src/main/services/database.ts | sed -n '989,998p'
989: setOrderFiscalInfo(localId: number, invoiceNumber: string, qrCode: string): void {
990:   this.conn
991:     .prepare(
992:       `UPDATE orders SET fiscal_invoice_number = ?, fiscal_qr_code = ?, fiscal_fiscalized_at = ?,
...
997:     .run(invoiceNumber, qrCode, new Date().toISOString(), localId)
```

So phase-96's "device-sourced" row in its own audit table was never
actually reachable in the write path it names — `fiscal_fiscalized_at` in
the database has, in fact, only ever held the local-fallback ISO-8601
shape phase-96's own table lists as the *other* format. Phase-96's actual
fix (the `parseFiscalTimestamp` dual-format parser in
`src/renderer/src/lib/fiscalDate.ts`) is not wrong to have either branch —
it is defensive against a shape that, per this trace, has never actually
occurred — but its stated justification for the device-format branch, "the
two write paths, confirmed by reading the call sites, not assumed"
(`phase-96.md:12-13`), does not hold up against `checkout.ts`'s actual call
site at that commit. This is a correction to that phase's premise, not a
new bug: the display code phase-96 shipped is still correct and still
needed if the write path is ever fixed to actually store a device string
(see section 6).

## 3. What each display/output shows, and from which source

| Output | Field shown | Source | Citation |
|---|---|---|---|
| First printed receipt | order date/time line | `order.createdAt` (order creation time on the till) | `src/main/services/printer.ts:241` — `client.println(new Date(order.createdAt).toLocaleString())` |
| Reprint | same date/time line | same — there is no separate reprint code path for a sale receipt; a reprint calls the same `renderReceipt` | `printer.ts:217-241` (the only receipt-rendering function; "Reprint" elsewhere in the codebase refers only to the Z-report, `src/renderer/src/pages/ReportsPage.tsx:100`) |
| PDF fallback receipt | order date/time line | `order.createdAt` | `src/main/services/pdf-receipt.ts:62` — `doc.text(new Date(order.createdAt).toLocaleString(), ...)` |
| Order History | "Fiscalized at …" | `order.fiscal_fiscalized_at`, parsed by `parseFiscalTimestamp` | `src/renderer/src/components/OrderHistory.tsx:236-239` |
| Reports → Invoice List | "Time" column | `order.created_at` | `src/renderer/src/pages/ReportsPage.tsx:546` — `{new Date(order.created_at).toLocaleString()}` |
| `orders.csv` export | "Date and time (Nairobi)" column | `order.created_at`, via `formatNairobiDateTime` | `src/main/services/reportsExport.ts:78,114` |

Confirmed by grep across `src/main/services/reports.ts`,
`src/main/services/reportsExport.ts` and
`src/renderer/src/pages/ReportsPage.tsx`: none of them reference
`fiscal_fiscalized_at` or `fiscalizedAt` at all — no match found. The Sales
Summary, Fiscal Status by Day, and Fiscal Reconciliation reports don't
show a fiscalization timestamp of any kind.

**`main/index.ts:802-810`** is a seventh reader of `fiscal_fiscalized_at`,
but it isn't a display site — it's the `lookupInvoice` callback the real
provider uses for its own already-filed check:

```
802: lookupInvoice: (invoiceNumber) => {
803:   const order = db.getOrderByFiscalInvoiceNumber(invoiceNumber)
804:   if (!order?.fiscal_invoice_number) return undefined
805:   return {
806:     invoiceNumber: order.fiscal_invoice_number,
807:     qrCode: order.fiscal_qr_code ?? '',
808:     fiscalizedAt: order.fiscal_fiscalized_at ?? order.created_at
809:   }
810: }
```

This value is never formatted or shown to a person — it only feeds back
into the provider's internal `FiscalInvoiceResult`-shaped object for its
own bookkeeping. Confirmed by grep: nothing reads a `fiscalizedAt` off
`getInvoiceDetails`'s return value anywhere in the renderer.

**Result**: `fiscal_fiscalized_at` is displayed to a person in exactly one
place in the whole application — Order History. Every receipt (print,
reprint, PDF) and every Reports screen shows `order.created_at` instead,
which is unaffected by anything in this trace or by the phase-163-1
write-once change.

## 4. Can a failure path set these three columns?

**`setOrderFiscalFailure`** — `database.ts:1513-1525`:

```
1513: setOrderFiscalFailure(
1514:   localId: number,
1515:   status: Exclude<FiscalStatus, 'fiscalized'>,
1516:   reason: string,
1517:   kind: FiscalFailureKind,
1518:   dataIssue: 'wrong-pin' | null = null
1519: ): void {
1520:   this.conn
1521:     .prepare(
1522:       'UPDATE orders SET fiscal_status = ?, fiscal_error_reason = ?, fiscal_error_kind = ?, fiscal_data_issue = ? WHERE local_id = ?'
1523:     )
1524:     .run(status, reason, kind, dataIssue, localId)
1525: }
```

No — its `UPDATE` statement names only `fiscal_status`, `fiscal_error_reason`,
`fiscal_error_kind`, `fiscal_data_issue`. It cannot touch
`fiscal_invoice_number`, `fiscal_qr_code` or `fiscal_fiscalized_at`.

**Any other writer?** Grepped the whole `src/` tree for
`fiscal_invoice_number\s*=`, `fiscal_qr_code\s*=` and
`fiscal_fiscalized_at\s*=` as SQL assignment targets. The only match for
all three, in any file, is the single `UPDATE` inside `setOrderFiscalInfo`
quoted in section 2 (`database.ts:1473-1475`). There is exactly one writer
of these three columns in the entire codebase.

So the answer to the brief's question is **no**: no failure path can set
these fields, and the phase-163-1 `COALESCE` guard has nothing to protect
against on that front — its actual job (per its own doc comment,
`database.ts:1443-1454`) is guarding `setOrderFiscalInfo` against being
called a second time on an already-fiscalized order, which does happen
today (the already-fiscalized short-circuit replay described in section
1 and in `docs/phase-163-1.md`).

## 5. (see "Plain answer" above)

## 6. Smallest proposed fix — not built

**Change**: give `setOrderFiscalInfo` two more optional parameters,
`fiscalizedAt?: string` and `fiscalizedAtSource?: 'device' | 'local-fallback'`,
and have it store `fiscalizedAt ?? new Date().toISOString()` instead of
always computing "now" itself. Add one nullable column,
`fiscal_fiscalized_at_source TEXT`, written the same COALESCE-guarded way
as the other four value columns (additive migration, same pattern as
`fiscal_vat_groups_json` in phase-163).

Thread the value through the three call sites identified in section 1:

- `checkout.ts:554` — pass `invoice.data.fiscalizedAt`, `invoice.data.fiscalizedAtSource`.
- `fiscal-engine.ts:139` — pass `result.data.fiscalizedAt`, `result.data.fiscalizedAtSource`.
- `fiscal-retry.ts:196` — pass `outcome.data.fiscalizedAt`, `outcome.data.fiscalizedAtSource`.

No change needed in `real-etims-provider.ts` itself — it already computes
and returns both values correctly (section 1); the fix is purely in what
the three callers do with a result they already have.

**What this does not change**: the printed receipt, reprint, PDF fallback,
Invoice List and `orders.csv` all use `order.createdAt`/`order.created_at`
today (section 3), not the fiscal timestamp — this fix only affects Order
History's "Fiscalized at" line and the raw `fiscal_fiscalized_at` column.
Whether the receipt itself should also switch to a device-sourced time is
a separate, bigger decision (it would need to happen at print time, after
fiscalization completes, not at order-creation time as today) and is
deliberately not part of this proposal.

**Tests affected** (existing assertions that would need to change, named
so a future implementer isn't surprised by red tests that are actually
correct to change):

- `tests/fiscalIntegration.test.ts:844,860` — "Scenario J — fiscal fields
  are write-once (docs/phase-163-1)". Both lines currently assert
  `fiscal_fiscalized_at` equals the DB-write-time system clock
  (`'2026-08-27T10:05:00.000Z'`) even though the test's own mocked
  `submitInvoice` result already carries a `fiscalizedAt` of the same
  value (line 826) — the comment at lines 840-843 states outright that
  this is asserting the DB write time, "not the device's own reported
  `fiscalizedAt`". Under the fix, this test's mock would need a
  `fiscalizedAt` value deliberately different from `vi.setSystemTime`'s
  clock, and the assertions would change to expect that device value
  instead — otherwise the test would still pass by coincidence and stop
  proving anything.
- `tests/database.test.ts:568` — asserts `setOrderFiscalInfo`'s SQL
  parameters with `expect.any(String)` for the timestamp position; this
  would keep passing unchanged, but a new test should be added asserting
  the *specific* string passed through is stored verbatim (proving the
  new parameter actually reaches the query, not just "a string of some
  kind").
- `tests/realEtimsProvider.test.ts:561,576,2211,2252` — already assert
  `fiscalizedAtSource` on the provider's own return value; these are
  unaffected (the provider side is not what's changing) but are the tests
  that would need a companion set one layer up, in
  `tests/fiscalEngine.test.ts` / `tests/fiscalRetry.test.ts` /
  `tests/database.test.ts`, proving the value survives the extra hop into
  `setOrderFiscalInfo`.
- A genuinely new test would be needed for the migration
  (`tests/fiscalVatGroupsMigration.test.ts` is the direct precedent to
  copy: a real file-backed `better-sqlite3` upgrade test, not `:memory:`)
  covering the new `fiscal_fiscalized_at_source` column.
- `src/renderer/src/lib/fiscalDate.ts` and its test,
  `tests/fiscalDate.test.ts`, need no code change — this is the one place
  in the codebase already built to handle a genuine device-format string
  in `fiscal_fiscalized_at`, and under this fix it would finally be
  exercised by real data instead of only by test fixtures.

**Tripwire**: the fix must not let a queued retry's `fiscalizedAt` ever
overwrite an already-stored one — but this is already guaranteed by the
existing `COALESCE(fiscal_fiscalized_at, ?)` guard from phase-163-1
(`database.ts:1475`), so no new guard logic is needed, only the extra
parameter.

## Files examined

`src/main/services/integrations/real-etims-provider.ts`,
`src/main/services/integrations/etims.ts`, `src/main/services/checkout.ts`,
`src/main/services/fiscal-engine.ts`, `src/main/services/fiscal-retry.ts`,
`src/main/services/database.ts`, `src/main/index.ts`,
`src/main/services/printer.ts`, `src/main/services/pdf-receipt.ts`,
`src/main/services/reports.ts`, `src/main/services/reportsExport.ts`,
`src/renderer/src/components/OrderHistory.tsx`,
`src/renderer/src/pages/ReportsPage.tsx`, `src/renderer/src/lib/fiscalDate.ts`,
`docs/phase-96.md`, `docs/phase-56.md`, `docs/KNOWN_GAPS.md`,
`tests/fiscalIntegration.test.ts`, `tests/database.test.ts`,
`tests/realEtimsProvider.test.ts`, and `git log`/`git show` output for
`src/main/services/database.ts` and `src/main/services/checkout.ts` at
commits `f41e77c`, `858f710`, `85a7f3a`, `a2c0654`, `da353d6`.

## The four rules

Unaffected. This was a read-only audit: no fiscal device command was
sent, no fiscal or payment sequence was touched, no Shopify call was made,
no SQL ran against a real database, and no production code changed.
