# Phase 71 / Step 1 — Three fiscalization states + routing

Builds on `docs/phase-70.md`'s audit (Step 0). Standing context: the master
brief, the four rules this feature must never break, and the three-state
model (`fiscalized` / `waiting` / `needs_fixing`). This step covers Rules 3
and 4. **STOP for review** — Step 2 (never-file-twice) does not start until
reviewed.

## 1. Audit confirmation

All of `docs/phase-70.md`'s findings held at the cited lines:

- `orders` had only `fiscal_invoice_number`/`fiscal_qr_code`/
  `fiscal_fiscalized_at`, no status field. `setOrderFiscalInfo`
  (`database.ts`) was the single writer, reached from `main/index.ts`'s
  checkout attempt and `markFiscalQueueItemSynced`'s queued-retry success.
- The checkout handler queued **every** failure unconditionally — both the
  `{success:false}` branch and the thrown-exception fallback (which
  rebuilds the request but preserves `localId`/`clientOrderUuid`).
- `FiscalizationProvider.submitInvoice` returned the shared
  `ServiceResult<FiscalInvoiceResult>` (`shopify-types.ts`); `retryable`
  was computed inside `checkDeviceResponse` but never reached this
  boundary. Both `RealFiscalizationProvider` and `MockFiscalizationProvider`
  implemented it; both `main/index.ts` and `fiscal-engine.ts`'s `tick()`
  called it.

## 2. Applied

### (a) Data — `orders` gained three columns

`migrateOrdersFiscalColumns` (idempotent `ALTER TABLE ADD COLUMN`, same
pattern as the original three fiscal columns) and `SCHEMA.orders`'s
`CREATE TABLE` both extended with:

- `fiscal_status TEXT` — `'fiscalized' | 'waiting' | 'needs_fixing'`
  (`CHECK` constraint on the fresh-install DDL only, matching this
  codebase's existing convention of no `CHECK` on `ALTER`-added columns);
  `NULL`/absent = never attempted.
- `fiscal_error_reason TEXT` — short plain-language reason, `NULL` once
  fiscalized (or never attempted).
- `fiscal_error_kind TEXT` — `'data' | 'system' | 'technical'`, `NULL`
  under the same conditions.

`OrderRow`, and every `SELECT` that builds one (`getOrder`,
`getOrderByFiscalInvoiceNumber`, `getOrders`), extended to include the
three columns — otherwise `OrderRow` objects would have silently carried
`undefined` for fields the type declares as `string | null`.

Two writers, one per outcome:

- **`setOrderFiscalInfo`** (existing, extended) — now also sets
  `fiscal_status = 'fiscalized'` and clears `fiscal_error_reason`/
  `fiscal_error_kind` to `NULL`. Unchanged signature/call sites — both the
  immediate checkout attempt and a successful queued retry
  (`markFiscalQueueItemSynced`) get the new behavior for free.
- **`setOrderFiscalFailure`** (new) — `(localId, status, reason, kind)`
  where `status` is typed `Exclude<FiscalStatus, 'fiscalized'>` (a
  compile-time guarantee this writer can never mark something
  `'fiscalized'`). Never touches `fiscal_invoice_number`/`fiscal_qr_code`/
  `fiscal_fiscalized_at`.

### (b) Channel — `FiscalSubmitOutcome`

Added to `etims.ts` (not `shopify-types.ts` — kept out of the shared
`ServiceResult<T>` used by roughly a dozen unrelated services):

```ts
export type FiscalFailureKind = 'data' | 'system' | 'technical'

export type FiscalSubmitOutcome =
  | { ok: true; data: FiscalInvoiceResult }
  | { ok: false; reason: string; kind: FiscalFailureKind; retryable: boolean }
```

A discriminated union, per the brief's requirement — a failure literally
cannot be constructed without stating `kind`/`retryable`.
`FiscalizationProvider.submitInvoice` (and both implementations) now
return this instead of `ServiceResult<FiscalInvoiceResult>`.

**`RealFiscalizationProvider`**: every failure return point in
`submitInvoice` now goes through a new `classifyDeviceFailure(result,
fallbackReason, fallbackKind?)` helper (in `real-etims-provider.ts`,
alongside `checkDeviceResponse`) that reads the already-correct
`DeviceResult.retryable`/`.code` (from `phase-69`) and maps it:

- `result.retryable` → `kind: 'technical'`
- else `result.code === '63'` → `kind: 'system'`
- else → `kind: 'data'` (the STE2 business-table codes)

Two call sites needed small supporting fixes to make this correct:

- **`readStatus()`** was rebuilding a bare `{success:false, error}` on a
  failed `sendCommand`, silently dropping `code`/`retryable`. Now returns
  the `DeviceResult` as-is.
- **`readStatus()`'s own two hand-built checks** ("not fiscalized" / "not
  paired with TIMS") never carry an STE code at all — they're device
  configuration problems, not business rejections. `classifyDeviceFailure`
  gained an explicit `fallbackKind` parameter so this one call site can
  override the default (`'data'`) to `'system'`.
- Three failure points that were never STE-coded to begin with
  (`clientOrderUuid`/items-empty guards, the read-VAT-gate anomaly, a
  `CloseReceipt` with no `InvoiceNum`) get a hardcoded `kind` directly:
  `'system'` for the first and third (malformed input / anomalous device
  response), `'data'` for pre-send validation failures (the sale's own
  data — bad PIN format, missing HS classification).

**`MockFiscalizationProvider`**: its two guard failures (no
`clientOrderUuid`, no items) return `kind: 'system'`, `retryable: false`.

**`fiscal-engine.ts`**: `SubmitInvoiceFn` retyped to
`Promise<FiscalSubmitOutcome>`; `tick()` changed `result.success`/
`result.data`/`result.error` to `result.ok`/`result.data`/`result.reason`.
Deliberately **unchanged otherwise** — every item reaching this queue was
already routed here as retryable/technical (the checkout handler never
enqueues a `needs_fixing` sale), so a retry's own failure still just backs
off via the existing `recordFiscalQueueFailure`, same as before this step.
(Noted as a scope boundary below.)

### (c) Route — the checkout handler, plus a new pure routing module

Rather than inlining the three-way branch directly in `main/index.ts`
(a large, already-hard-to-test IPC handler closure — confirmed
untestable-as-is per `docs/phase-70.md`'s audit), the classification-to-
status/queue **decision** was extracted into a new file,
`src/main/services/fiscal-routing.ts`:

```ts
export interface FiscalRoutingDecision {
  status: FiscalStatus
  enqueue: boolean
}

export function routeFiscalOutcome(outcome: FiscalSubmitOutcome): FiscalRoutingDecision
// (overloaded so a caller in an `else` branch on `outcome.ok` gets a
// return type that statically excludes 'fiscalized')

export function classifyThrownFiscalError(error: unknown): { reason: string; kind: 'technical' }
```

Both are pure — no I/O, no Electron, no database — specifically so the
routing *rules* are unit-testable without mocking IPC/DB/fiscal-engine.
`main/index.ts`'s checkout handler now:

```ts
if (invoice.ok) {
  fiscal = { invoiceNumber: invoice.data.invoiceNumber, qrCode: invoice.data.qrCode }
  db.setOrderFiscalInfo(localId, invoice.data.invoiceNumber, invoice.data.qrCode)
} else {
  const { status, enqueue } = routeFiscalOutcome(invoice)
  db.setOrderFiscalFailure(localId, status, invoice.reason, invoice.kind)
  if (enqueue) {
    db.queueFiscalInvoice(localId, fiscalRequest)
    fiscalEngine.onCheckoutMade()
  }
}
```

and the thrown-exception fallback uses `classifyThrownFiscalError` to get
`(reason, kind: 'technical')`, then calls `setOrderFiscalFailure(localId,
'waiting', reason, kind)` before the existing unconditional
`queueFiscalInvoice`. The final `return { success: true, data: {...} } }`
at the end of the handler is untouched and unconditional — Rule 4 holds
by construction, not by a test that reaches into Electron.

## Routing table

| Outcome | `status` | `enqueue` | Where decided |
|---|---|---|---|
| `ok: true` | `fiscalized` | never | `routeFiscalOutcome` |
| `ok: false, retryable: true` (`kind: 'technical'` — server codes 19/30/31/53, or STE1=52 still unresolved after its one-shot retry) | `waiting` | yes | `routeFiscalOutcome` |
| `ok: false, retryable: false, kind: 'data'` (STE2 business-table codes 52/57–64 — wrong PIN, unknown item, bad HS code, …) | `needs_fixing` | no | `routeFiscalOutcome` |
| `ok: false, retryable: false, kind: 'system'` (Code 63, "not fiscalized"/"not paired", a `CloseReceipt` with no invoice number, malformed request from this build) | `needs_fixing` | no | `routeFiscalOutcome` |
| thrown exception (a bug, not a device-reported rejection) | `waiting` (`kind: 'technical'`) | yes | `classifyThrownFiscalError` + the existing unconditional queue in the `catch` |

## 3. Tests

- **`tests/database.test.ts`**: migration adds all six `fiscal_*` columns;
  a duplicate-column throw from `ALTER TABLE` (simulating a restart
  against an already-migrated DB) is swallowed, not propagated;
  `setOrderFiscalInfo` sets `fiscal_status = 'fiscalized'` and clears the
  error columns (and is confirmed to be the same writer
  `markFiscalQueueItemSynced` uses); `setOrderFiscalFailure` tested for
  `waiting`/`technical`, `needs_fixing`/`data`, and `needs_fixing`/`system`.
- **`tests/fiscalRouting.test.ts`** (new): `routeFiscalOutcome` — success
  → fiscalized/never-enqueued; technical → waiting/enqueued; data → needs_
  fixing/not-enqueued; system (Code 63-style) → needs_fixing/not-enqueued;
  routing is driven purely by `retryable`, independent of message text;
  a failure never routes to `fiscalized` and success never routes to
  `waiting`/`needs_fixing`. `classifyThrownFiscalError` — extracts an
  `Error`'s message, stringifies a non-`Error` throw, always `'technical'`.
- **`tests/fiscalIntegration.test.ts`** (existing suite extended — this
  drives the real `RubisDatabase` + `fiscal-engine.ts` against a mocked/
  real provider, the closest thing to an end-to-end check without booting
  Electron): its `attemptFiscalization` test-local mirror of the checkout
  handler was rewired to call the *real* `routeFiscalOutcome`/
  `classifyThrownFiscalError` (rather than re-encoding the same rules a
  second time, which would have let this suite silently drift from
  production behavior). Added:
  - Scenario A (success) and Scenario B (thrown exception) gained
    `fiscal_status`/`fiscal_error_kind`/`fiscal_error_reason` assertions.
  - **Scenario F** (new): a business rejection (wrong PIN, `kind: 'data'`)
    → `needs_fixing`, confirmed **not** enqueued, and a subsequent engine
    tick makes zero additional `submitInvoice` calls.
  - **Scenario G** (new): a malformed-request/`system` failure (Code
    63-style) → `needs_fixing`, not enqueued.
  - **"Rule 4" describe block** (new): `it.each` over success/technical/
    data/system outcomes plus a dedicated thrown-exception case, each
    asserting `attemptFiscalization` never throws and the order row
    survives — the explicit Rule-4 test the brief asked for.
- **`tests/etims.test.ts`**, **`tests/realEtimsProvider.test.ts`**,
  **`tests/tremolConformance.test.ts`**: every existing `submitInvoice`
  assertion updated from `.success`/`.data`/`.error` to `.ok`/`.data`
  (narrowed via `result.ok && result.data.x`)/`.reason` (narrowed via
  `!result.ok && result.reason`) — a pure rename, no expected values
  changed. `cancelInvoice`/`getInvoiceDetails`/`readCUInvoiceNumber`
  results (still `ServiceResult`) were left untouched throughout.
- Whole suite: **57 files / 850 tests**, 0 unexplained regressions, 0
  loosened assertions.

## Verification

- `npx vitest run`: 57 files / 850 tests green.
- `npm run typecheck` (node + web): clean.

## Scope boundaries (deliberate, not oversights)

1. **`fiscal-engine.ts`'s queued-retry failure handling is unchanged.**
   Every item in `sync_queue` was already routed there as
   retryable/technical at enqueue time (the checkout handler never
   enqueues a `needs_fixing` sale), so today a retry's own failure just
   backs off via the existing attempt-count/backoff mechanism regardless
   of what the *new* failure's classification says. If a queued item's
   *next* retry attempt comes back non-retryable (e.g. the device now
   rejects it for a data reason it didn't the first time), it still stays
   in the queue backing off rather than flipping to `needs_fixing`
   immediately. This is what the brief's Apply section explicitly asked
   for ("do not change what the queued-retry path does on its own
   success/failure beyond writing the new status via the same writer") —
   flagging it here as the resulting behavior, in case it should be
   revisited in a later step.
2. **The full `orders:checkout` IPC handler is still not independently
   unit-tested end-to-end** (it never was, per `docs/phase-70.md`'s
   audit — this predates this feature). This step mitigated that by
   extracting the routing *decision* into `fiscal-routing.ts` (directly
   tested) and by extending `fiscalIntegration.test.ts`'s existing
   database+engine-level integration suite to exercise the same
   functions the real handler calls — but the handler's own wiring
   (schema validation, `db.queueOrder`, the exact IPC return shape) is
   still only exercised manually/in the running app.

## VERIFY-ON-DEVICE

Nothing new — this step is pure classification/routing over already-
computed (`phase-69`) values; no new device-facing behavior was added. The
existing `phase-69` VERIFY-ON-DEVICE items (the open-receipt byte,
`FPLibErrorCode`'s meaning, whether 57/63/64 are ever actually emitted)
stand as before.

---

**STOP for review**, per this step's brief — Step 2 (never-file-twice)
does not start until reviewed.
