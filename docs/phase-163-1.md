# Phase 163-1 - Make fiscal fields write-once, plus three small fixes

- **Date:** 2026-09-27
- **Requested:** stop a race-path queue replay from silently rewriting an already-fiscalised order's stored fields; add a coverage caption to the Sales Summary's "VAT from device groups" figure; note two residual caveats in `docs/KNOWN_GAPS.md`; add Commit 2's SHA to `docs/phase-163.md`. Same hard rules as phase 163 (no command/argument/sequence/filed-data change; every changed existing assertion listed by name).
- **Outcome:** Implemented.
- **Branch / base commit:** staging @ 42a9931 (Phase 163, Commit 2 - fiscal reconciliation report).

## STEP 1: AUDIT

### `markFiscalQueueItemSynced`, quoted in full (before this phase)

```ts
markFiscalQueueItemSynced(
  queueId: number,
  invoiceNumber: string,
  qrCode: string,
  vatGroups?: FiscalVatGroupAmounts
): void {
  const row = this.conn
    .prepare('SELECT entity_id FROM sync_queue WHERE id = ?')
    .get(queueId) as { entity_id: number } | undefined
  if (!row) return

  const settle = this.conn.transaction(() => {
    this.setOrderFiscalInfo(row.entity_id, invoiceNumber, qrCode, vatGroups)
    this.conn.prepare('DELETE FROM sync_queue WHERE id = ?').run(queueId)
  })
  settle()
}
```

### `setOrderFiscalInfo`, quoted in full (before this phase)

```ts
setOrderFiscalInfo(
  localId: number,
  invoiceNumber: string,
  qrCode: string,
  vatGroups?: FiscalVatGroupAmounts
): void {
  this.conn
    .prepare(
      `UPDATE orders SET fiscal_invoice_number = ?, fiscal_qr_code = ?, fiscal_fiscalized_at = ?,
       fiscal_status = 'fiscalized', fiscal_error_reason = NULL, fiscal_error_kind = NULL,
       fiscal_data_issue = NULL, fiscal_vat_groups_json = ?
       WHERE local_id = ?`
    )
    .run(
      invoiceNumber,
      qrCode,
      new Date().toISOString(),
      vatGroups ? JSON.stringify(vatGroups) : null,
      localId
    )
}
```

### The "already fiscalized (race with a resend)" path

Traced through `fiscal-engine.ts`'s `tick()` and `fiscal-retry.ts`'s `attemptFiscalRetry`:

```ts
// fiscal-retry.ts
if (order?.fiscal_status === 'fiscalized') {
  return {
    ok: true,
    data: {
      invoiceNumber: order.fiscal_invoice_number ?? '',
      qrCode: order.fiscal_qr_code ?? '',
      fiscalizedAt: order.fiscal_fiscalized_at ?? new Date().toISOString()
    }
  }
}
```

```ts
// fiscal-engine.ts's tick()
if (result.ok) {
  db.markFiscalQueueItemSynced(item.id, result.data.invoiceNumber, result.data.qrCode, result.data.vatGroups)
  ...
}
```

**Which columns does the `UPDATE` rewrite, and with what values?** All four: `fiscal_invoice_number`, `fiscal_qr_code`, `fiscal_fiscalized_at`, `fiscal_vat_groups_json` - unconditionally, every time `setOrderFiscalInfo` is called, regardless of the order's current state. In this specific race path:

- `invoiceNumber`/`qrCode` are set to the **same values already stored** (`attemptFiscalRetry`'s short-circuit echoes them straight back from `order.fiscal_invoice_number`/`order.fiscal_qr_code` - it never calls the device). Value-wise a no-op, but still a write.
- `fiscal_fiscalized_at` is set to `new Date().toISOString()` - the JS `Date` object built **at the moment `setOrderFiscalInfo` runs**, not anything from `order.fiscal_fiscalized_at` or the outcome's `data.fiscalizedAt` (the function has no parameter for either - it always stamps "now"). This is a **new** value, not a repeat of the old one.
- `fiscal_vat_groups_json` is set from `vatGroups`, which is `result.data.vatGroups` - and the short-circuited outcome object above **has no `vatGroups` field at all**, so this is always `undefined`, which `setOrderFiscalInfo` turns into `null`.

**Answer: can it overwrite `fiscal_vat_groups_json` with `NULL`? Yes, always, on this path.** Every race-path replay of an already-fiscalized order wipes its stored `fiscal_vat_groups_json` back to `NULL`, even though the order was correctly fiscalised (with a real device figure) moments or days earlier. This is a genuine data-loss bug for the fiscal reconciliation report: any order whose queue ever raced (a manual resend racing the background engine, or a stray leftover queue row for an already-settled order) would silently lose its device figures and start reporting as `'no-device-figure'`.

**Answer: can it change `fiscal_invoice_number`, `fiscal_qr_code`, or `fiscal_fiscalized_at` on an order that is already fiscalised?** `fiscal_invoice_number`/`fiscal_qr_code`: written again, but to the same value, so no observable change today (this could only diverge if a future bug ever made the short-circuit echo back something other than the order's own stored value). `fiscal_fiscalized_at`: **yes, genuinely changed** - every race-path replay rewrites it to the current wall-clock time, silently replacing the true original fiscalization timestamp with a false "just now" one. Any receipt reprint, audit trail, or future report reading this column after a race would show the wrong time.

## STEP 2: FIX

`fiscal_invoice_number`, `fiscal_qr_code`, `fiscal_fiscalized_at`, and `fiscal_vat_groups_json` are each guarded with `COALESCE(column, ?)` in `setOrderFiscalInfo`'s single `UPDATE` statement - see the exact diff in "Changes made" below.

**Chosen: guard the `SET` with `COALESCE`, not skip the `UPDATE` in the race path.** The alternative (skip the `UPDATE` entirely when the order is already fiscalized, e.g. an early return in `markFiscalQueueItemSynced` or a check in `fiscal-engine.ts`'s `tick()`) would need: an extra `SELECT` to read the order's current `fiscal_status` before deciding whether to call `setOrderFiscalInfo` at all, a code change in at least one more file (`database.ts`'s `markFiscalQueueItemSynced`, or `fiscal-engine.ts`), and would still leave `setOrderFiscalInfo` itself unguarded for any OTHER caller that might one day call it twice on the same order (`checkout.ts`'s own direct call, for instance, is currently only ever reached once per order in practice, but nothing enforces that structurally). The `COALESCE` guard is a single SQL statement change, in the one function that is already the sole writer of these four columns, and makes `setOrderFiscalInfo` write-once **by construction** - correct no matter which caller, or how many times, calls it. This is the smaller change by every measure: fewer lines touched, one file instead of two or three, and a stronger invariant (any accidental double-write anywhere is now harmless) rather than a narrower one (only this specific race path is patched).

`fiscal_status`/`fiscal_error_reason`/`fiscal_error_kind`/`fiscal_data_issue` need no guard: setting an already-`'fiscalized'` row's status to `'fiscalized'` again is a true no-op, and by this function's own existing invariant those three error fields are already `NULL` on any fiscalized row (nothing else can set them without going through `setOrderFiscalFailure`, which requires a non-`'fiscalized'` status) - resetting them to `NULL` again changes nothing.

**The race path still deletes its queue row**: unchanged - `markFiscalQueueItemSynced` was not touched at all; `COALESCE` only changes what `setOrderFiscalInfo`'s `UPDATE` writes, not whether `markFiscalQueueItemSynced` calls it or deletes the queue row afterward.

## STEP 3: TESTS

Added to `tests/fiscalIntegration.test.ts` (`Scenario J`, run against the real `RubisDatabase` + `createFiscalEngine`, not a mock):

1. **The race scenario, driven through fake timers so the "unchanged" assertion cannot pass by coincidence**: a first attempt fails technically (queued), the queued retry succeeds and stores `KRA-FIRST`/`qr-first`/a fiscalized-at timestamp/`{A: '150.00'}`; the system clock is then advanced almost two hours and a **second** `sync_queue` row is queued for the same, already-fiscalized order; after that row is processed (no device call - confirmed via `submitInvoice`'s call count staying at 2), every one of the four fields is asserted unchanged from what the first success stored, and the race-path queue row is confirmed deleted.
2. **A genuine first success still writes every fiscal field** - a plain, single-attempt success stores `fiscal_invoice_number`, `fiscal_qr_code`, a `fiscal_fiscalized_at` timestamp, and `fiscal_vat_groups_json`, proving the `COALESCE` guard does not interfere with the normal, once-only write it is meant to allow through.

### Verification

- `npx vitest run tests/fiscalIntegration.test.ts` - **125 test files unaffected, this file's own 24/24 passed** (22 pre-existing + 2 new).
- **Mutation test**: temporarily reverted the four `COALESCE(column, ?)` guards back to plain `?`. Reran `Scenario J`: the race-path test **failed** exactly as expected - `fiscal_fiscalized_at` came back as the advanced-clock time (`'2026-08-27T12:00:00.000Z'`) instead of the original (`'2026-08-27T10:05:00.000Z'`) - proving the guard, not a coincidence of timing, is what the test depends on. The "genuine first success" test was unaffected (it never depended on the guard at all). Restored the `COALESCE` guards; reran - both tests passed again, and the full `fiscalIntegration.test.ts` file (24/24) and the full suite were rerun to confirm nothing else was disturbed.
- No existing assertion in `tests/database.test.ts`, `tests/fiscalIntegration.test.ts`, `tests/fiscalResend.test.ts`, `tests/fiscalEngine.test.ts`, or `tests/fiscalVatGroupsMigration.test.ts` needed changing for this fix - none of them assert on the literal SQL text of `setOrderFiscalInfo`'s `UPDATE` (only on substrings like `"fiscal_status = 'fiscalized'"`, which the `COALESCE` wrapping does not touch), and the bound-parameter count/order is unchanged.

## STEP 4: Sales Summary coverage caption

`SalesSummary` gained `vatFromDeviceGroupsCoverage: { ordersWithFigure: number; ordersFiscalized: number }`, computed by `sumVatFromDeviceGroups` alongside the existing `total`. An order counts as "with figure" only when its stored `fiscal_vat_groups_json` is present, parses, and every group it contains is numeric - the same all-or-nothing rule `buildReconciliationRow` already applies, so the two reports' coverage language means the same thing. A group-`'D'`-only order still counts as "with figure" (its amount was known; only its VAT rate was not) - the caption calls this out separately ("group D not included") rather than conflating "we don't know the amount" with "we know the amount but not its VAT".

**Correction to this phase's own premise**: the task asked to "show coverage next to 'VAT from device groups'", which assumed that figure was already visible on the Sales Summary screen. Auditing `ReportsPage.tsx`'s `SalesSummaryView` found it was not - docs/phase-163 added `vatFromDeviceGroups` to the `SalesSummary` data model and tested it in `reports.ts`'s own unit tests, but never actually rendered a card for it in the UI. This phase adds both the base figure's card and the coverage caption together, since showing a coverage caption next to a figure that was not on screen at all would not have been meaningful.

### Changes made

- `src/main/services/reports.ts`: `VatFromDeviceGroupsCoverage` interface; `sumVatFromDeviceGroups` now returns `{ total, ordersWithFigure, ordersFiscalized }`; `SalesSummary.vatFromDeviceGroupsCoverage` added; `generateSalesSummary` destructures and returns both.
- `src/renderer/src/pages/ReportsPage.tsx`: `SalesSummaryView` gained a "VAT from device groups" card (alongside, not replacing, the existing "VAT included" card) with the coverage line underneath, e.g. "from 12 of 15 sales; group D not included".

### Tests

- `tests/reports.test.ts`: extended the two existing `vatFromDeviceGroups` tests with coverage assertions, added a test matching the task's own "12 of 15" worked example, and a test confirming a non-numeric group is excluded from "with figure" (matching `buildReconciliationRow`'s rule).
- `tests/reportsPage.test.ts`: added the missing `vatFromDeviceGroups`/`vatFromDeviceGroupsCoverage` fields to the existing Sales Summary mocks (needed once the UI actually reads them - see Verification), and a new test asserting the coverage caption text renders.

### Verification

- `npx vitest run tests/reports.test.ts tests/reportsPage.test.ts` - **20/18 and 14/13 tests respectively** (2 and 1 new).
- **Existing test fixtures updated, not assertion changes**: the three existing `getSalesSummary` mock objects in `tests/reportsPage.test.ts` (the `stubApi` default and two per-test overrides) gained `vatFromDeviceGroups`/`vatFromDeviceGroupsCoverage` fields. This is listed here for transparency even though it is not a changed *assertion* (nothing that was previously checked changed) - without it, the two pre-existing "Sales Summary" tests would throw `Cannot read properties of undefined (reading 'ordersWithFigure')` once the UI started reading the new field, confirmed by running them before this fix was applied.

## STEP 5: `docs/KNOWN_GAPS.md`

Updated the existing "No fiscal reconciliation report" entry (found stale during this phase's own audit - docs/phase-163 built exactly the report this entry said didn't exist) with an "Update (docs/phase-163, docs/phase-163-1)" note marking it built, and two residual caveats: VAT-group `'D'` is excluded from every derived VAT figure (no known rate - docs/phase-65), and the report's matched/mismatch verdict is only as good as what the device actually returns at Step 5 (it can confirm till-vs-device agreement, not the device's own accuracy). Retitled the entry to reflect the new state rather than leaving a "not built" heading over a "here's what was built" body.

## STEP 6: `docs/phase-163.md`

Added Commit 2's SHA (`42a9931`) to the Commit 2 heading and to the rollback section's `git revert` line, replacing the `(this commit)`/`<commit-2-sha>` placeholders left when that report was written before Commit 2 had actually been committed.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/main/services/database.ts` | Modified | `setOrderFiscalInfo`'s `UPDATE` - write-once guard on four columns |
| `src/main/services/reports.ts` | Modified | `sumVatFromDeviceGroups`/`SalesSummary.vatFromDeviceGroupsCoverage` |
| `src/renderer/src/pages/ReportsPage.tsx` | Modified | Sales Summary now shows "VAT from device groups" and its coverage caption |
| `tests/fiscalIntegration.test.ts` | Modified (additions) | Write-once race-path coverage |
| `tests/reports.test.ts`, `tests/reportsPage.test.ts` | Modified (additions + fixture updates) | Coverage figure tests |
| `docs/KNOWN_GAPS.md` | Modified | Reconciliation gap entry marked built, two caveats noted |
| `docs/phase-163.md` | Modified | Commit 2 SHA filled in |

## 4. Possible impact

- **Direct:** an already-fiscalized order can no longer have its invoice number, QR code, fiscalization timestamp, or stored VAT-group figures overwritten by any later call to `setOrderFiscalInfo`, from any caller, for any reason. The Sales Summary now visibly shows the device-derived VAT figure and how much of the range it actually covers.
- **Indirect:** any past order whose fiscal fields were already corrupted by this race before this fix (a wiped `fiscal_vat_groups_json`, or a fiscalized-at timestamp rewritten to a later "now") is **not** repaired retroactively - this fix only prevents the corruption from happening again. No SQL was run against real data to check for or fix existing occurrences, per this phase's hard rules.
- **Data / schema / contract:** no schema change. The `UPDATE` statement's shape changed; its bound-parameter count and order did not.
- **Security posture:** unchanged.
- **Idempotency / re-run safety:** directly improved - `setOrderFiscalInfo` is now safe to call any number of times on the same order; only the first call's values are ever kept.
- **Residual risk:** the race window itself (two `sync_queue` rows existing for the same order at once) is not closed by this phase - `attemptFiscalRetry`'s own short-circuit remains the mechanism that detects the race and avoids a second device call; this phase only ensures that when it does fire, it can no longer damage the DB row it echoes from.

## 5. Verification (combined)

- `npm run typecheck` - clean.
- `npx vitest run` - **125 test files, 1915 tests passed** (up from 1910 before this phase; 0 failed).
- `npm run build` - succeeded; `verify-no-mock-provider.cjs` postbuild check clean.
- `npm run check:fit` - **18/18 cases fit**, no overflow, including the Sales Summary's new card.
- Both required mutation tests (the write-once guard, and phase-163's own reconciliation NULL-handling, re-verified as part of this phase's full-suite run) performed and reported with exact, non-vacuous failure counts.

## 6. Rollback

```
git checkout 42a9931 -- src/main/services/database.ts src/main/services/reports.ts src/renderer/src/pages/ReportsPage.tsx tests/fiscalIntegration.test.ts tests/reports.test.ts tests/reportsPage.test.ts docs/KNOWN_GAPS.md docs/phase-163.md
```
No data to unwind - the write-once guard only changes future writes; no migration or backfill was performed.

## 7. Observed but not changed

- Existing orders whose fiscal fields were already overwritten by the pre-fix race (if any occurred in a real deployment) are not detected or repaired here - out of this phase's scope (no SQL against real data), and there is no reliable way to distinguish a race-corrupted row from a normal one after the fact without an external record of the original figures.
- The race window itself (two queue rows for one order) is a pre-existing, separately-understood characteristic of the retry/resend system (`fiscal-retry.ts`'s own doc comments already describe it) - this phase hardens the write, not the race's likelihood or detection.
