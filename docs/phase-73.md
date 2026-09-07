# Phase 73 — Make `orders:checkout` testable, then fully test it

Follows `docs/phase-72.md`'s read-only audit of the `orders:checkout` IPC
handler (`main/index.ts:756-1002`). This step extracts that handler's
logic into a plain, injected, directly-testable function, drives it with
a full branch-coverage test suite, and retires
`fiscalIntegration.test.ts`'s test-local mirror of it.

## 1. What was extracted

The audit's map held exactly as described. Everything the handler did
**after** `validate(checkoutRequestSchema, request)` — the staff check,
the mock-mode M-Pesa manual-code check, `queueOrder`, the online
`engine.tick()` kick, the `getOrder` read-back/`synced` computation, the
whole fiscalization block, and the unconditional success/outer-catch
returns — moved verbatim into a new file,
`src/main/services/checkout.ts`:

```ts
export async function runCheckout(
  deps: RunCheckoutDeps,
  input: CheckoutRequest
): Promise<ServiceResult<CheckoutReceipt>>
```

`RunCheckoutDeps` injects every dependency the audit listed, including
the three the handler used to close over instead:

```ts
export interface RunCheckoutDeps {
  db: CheckoutDb                          // getStaffById/getOpenShift/queueOrder/getOrder/
                                           // setOrderFiscalInfo/setOrderFiscalFailure/queueFiscalInvoice
  mpesaProvider: CheckoutMpesaProvider     // verifyTransactionCode
  fiscalizationProvider: CheckoutFiscalizationProvider // submitInvoice
  fiscalEngine: CheckoutFiscalEngine       // onCheckoutMade
  monitor: CheckoutMonitor                 // isOnline
  engineTick: () => Promise<void>          // was inline `engine.tick()`
  idGen: () => string                      // was inline `randomUUID()`
  taxRate: number                          // NOW injected — was `printerSettings.taxRate`, closed over
  mockMpesaEnabled: boolean                // NOW injected — was a closed-over flag
  logger: CheckoutLogger                   // NOW injected — was the global `console`
}
```

Each dependency is its own small structural interface (`CheckoutDb`,
`CheckoutMpesaProvider`, …) rather than `Pick<RealType, …>` — matching
this codebase's existing convention (`SyncEngineDatabase` in
`sync-engine.ts`, `FiscalEngineDatabase` in `fiscal-engine.ts`: a
"structural slice… unit tests supply a fake with the same shape").
`fiscal-routing.ts`'s `routeFiscalOutcome`/`classifyThrownFiscalError`
are imported and reused as-is — not re-implemented.

`runCheckout` is plain TypeScript: no Electron, no IPC, no module-level
state. `main/index.ts`'s `orders:checkout` handler is now an 8-line thin
wrapper:

```ts
ipcMain.handle(
  'orders:checkout',
  async (_event, request: unknown): Promise<ServiceResult<CheckoutReceipt>> => {
    const validation = validate(checkoutRequestSchema, request)
    if (!validation.success) {
      return { success: false, error: validation.error }
    }
    return runCheckout(
      {
        db, mpesaProvider, fiscalizationProvider, fiscalEngine, monitor,
        engineTick: () => engine.tick(),
        idGen: randomUUID,
        taxRate: printerSettings.taxRate,
        mockMpesaEnabled,
        logger: console
      },
      validation.data
    )
  }
)
```

### Behavior-preserving — confirmed, with one disclosed simplification

Every side effect, its order, and every return shape are unchanged. The
one thing *not* moved verbatim: the handler's ~20 step-numbered
`[DEBUG-ETIMS] N. …` `console.log` calls (plus a `db.getIntegrationConfig
('etims')` re-fetch done solely to log its value, and a defensive
`if (!fiscalizationProvider) console.error(...)` check that TypeScript's
own types already make unreachable) were **not** carried over 1:1.
These were pure diagnostic noise with **zero effect on control flow, DB
writes, or the return value** — the `etimsConfig` variable they logged
was never read again, and the null-check could never fire given
`fiscalizationProvider`'s required, non-optional type. `runCheckout`
keeps `logger.log`/`.warn`/`.error` calls at the same decision points
(order queued/sync-tick outcome, fiscalization accepted/rejected/
enqueued, thrown-exception fallback, outer-catch) with clearer messages,
via the newly-injected `logger`. This is disclosed here per this task's
"if you find something, report it — don't hide it" spirit; it is a
logging-verbosity simplification, not a behavior change, and every
existing test that exercises this handler's actual outcomes (DB state,
return shape, queue contents) still passes unmodified in
`fiscalIntegration.test.ts`.

No other logic changed. No bug was found during extraction.

## 2. The full test — `tests/runCheckout.test.ts` (new, 20 tests)

Drives the real `runCheckout` with a real in-memory `RubisDatabase`
(`:memory:`), the real `createFiscalEngine` (for the one test that
exercises a background retry), and a controllable
`fiscalizationProvider.submitInvoice`; `mpesaProvider`/`monitor`/`idGen`/
`logger` are stubbed. No checkout logic is re-encoded — every assertion
reads `runCheckout`'s actual return value and the real database it wrote
to.

Branches covered:

- **Success**: order created; `fiscal_status` `'fiscalized'`; invoice
  number/QR stored on the row; exact return shape; `submitInvoice`
  called with the generated `clientOrderUuid`.
- **`engineTick` kicked iff `monitor.isOnline()`** — both directions
  asserted.
- **`mode`/`shopifyOrderId` mapping**: a dedicated test proves the
  `'synced'` branch using a fake `CheckoutDb` whose `getOrder` returns a
  synced row — documented inline as necessary because, in the *real*
  flow, that read-back happens synchronously right after firing
  `engineTick()` (never awaited), so a brand-new order is always still
  `'pending_sync'` at that point regardless of `monitor.isOnline()`.
  This is an existing quirk of the original handler's fire-and-forget
  design, not something this step changed or is fixing.
- **Fiscal failure classes**, each against the real `routeFiscalOutcome`:
  - technical/retryable → `waiting`, enqueued, `onCheckoutMade` fired.
  - data → `needs_fixing`, **not** enqueued, `onCheckoutMade` **not**
    fired.
  - system (Code-63-style) → `needs_fixing`, not enqueued, not fired.
  - a queued technical failure is then drained to success by a real
    `fiscalEngine.tick()` — proving the extraction didn't disturb the
    retry pipeline `fiscalIntegration.test.ts` already covered.
- **Thrown exception** (from `submitInvoice`) → `waiting`, enqueued,
  `success: true` with `fiscal: undefined`, and identity preserved —
  the queued payload's `clientOrderUuid`/`localId` match the checkout
  that threw.
- **Rule 4**, table-driven over success/technical/data/system plus a
  dedicated thrown-exception case: `runCheckout` always resolves
  `success: true` and the order row exists, whatever fiscalization did.
- **Pre-order rejections create no order, no fiscalization call**: no
  logged-in staff; mock-mode M-Pesa manual-code check failing on a
  verification error; failing on an unverified code; and (the mirror
  case) confirming the check is skipped entirely — and checkout
  proceeds — when `mockMpesaEnabled` is `false`.
- **Outer-catch path**: `queueOrder` throwing → `success: false`, no
  order row exists.
- **KNOWN, PRE-EXISTING EDGE** (documented, not fixed, per this task's
  hard rule): a dependency throwing *after* `queueOrder` already
  committed (`getOrder`, here) still reports `success: false` to the
  till even though the order row exists — proven by asserting on the
  *real* db directly, bypassing the throwing wrapper. This is
  `docs/phase-72.md`'s audit's own observation, carried forward
  unchanged; not something this step's behavior-preserving rule
  permits touching.
- **Duplicate submission** (documented as today's behavior, explicitly
  **not** asserted as safe): the same input submitted twice — same
  `clientOrderUuid` via a fixed `idGen`, forcing a true duplicate —
  creates two separate order rows and calls `submitInvoice` twice. The
  test's own comment states this is the gap the next step
  ("never-file-twice") closes.
- **Payment/printing**: per the audit, `orders:checkout` owns neither
  (STK Push initiation is the standalone `mpesa:initiate-stk-push`
  channel; printing happens in the renderer after this call resolves) —
  noted in the test file as a scope call-out, not a gap, with nothing to
  drive.
- **Invalid payload / empty cart** (the wrapper's rejection before
  `runCheckout` is ever called): already exhaustively covered by
  `tests/ipcValidator.test.ts`'s `checkoutRequestSchema` suite (empty
  cart, missing `items`, non-finite `total`, invalid `paymentMethod`,
  non-integer/non-positive `staffId`, malformed/null/undefined payload —
  11 existing tests). Not re-tested here: the wrapper itself is now just
  `validate() → return-or-call runCheckout()`, with no independent logic
  of its own to exercise beyond what `validate()`'s own tests already
  prove, and IPC handler registration itself remains outside what can be
  unit-tested without booting Electron (the same constraint the
  phase-72 audit found for the pre-extraction handler).

## 3. Mirror retired — `tests/fiscalIntegration.test.ts`

`attemptFiscalization` no longer re-encodes the checkout/fiscalization
sequence. It now calls the real `runCheckout`, fixing the checkout
fields this suite never varies (`items`/`total`/`paymentMethod`/
`tenderedAmount`/`changeDue`) to the same literals its old
`db.queueOrder` calls used, with inert stubs for
`mpesaProvider`/`monitor`/`fiscalEngine`/`logger` and `idGen` pinned to
the caller's `clientOrderUuid` so assertions stay deterministic:

```ts
async function attemptFiscalization(params: {
  db: RubisDatabase
  provider: FiscalizationProvider
  staffId: number
  clientOrderUuid: string
  customerPin?: string
}): Promise<{ localId: number; fiscal?: { invoiceNumber: string; qrCode: string } }>
```

All 9 call sites (Scenarios A, B, F, G, C ×2, Rule-4 ×2, Idempotent
retry, and Scenario E's first test) were updated to stop calling
`db.queueOrder` themselves — `runCheckout` now creates the order — and
to read `localId` back from `attemptFiscalization`'s result instead.
Two call sites (`Scenario E`'s second test, and the standalone
"Regression: Shopify sync queue…" suite) never used the mirror — they
drive `RealFiscalizationProvider`/`RubisDatabase` directly — and were
left untouched. `buildFiscalRequest` (a fixture builder, not routing
logic) remains for those two.

`routeFiscalOutcome`/`classifyThrownFiscalError` are no longer imported
directly into this file — `runCheckout` already calls them internally.

Result: **one source of truth for checkout behavior.** Every assertion
in `fiscalIntegration.test.ts` that used to check what the *mirror* did
now checks what the *real production function* did.

## 4. Verification

- `npx vitest run`: **58 files / 870 tests**, 0 failures, 0 loosened
  assertions (850 baseline + 20 new `tests/runCheckout.test.ts` tests;
  `fiscalIntegration.test.ts` stayed at 17 — only its internals changed).
- `npm run typecheck` (node + web): clean.
- No bug was found during extraction; nothing required a STOP-and-report
  under this task's "find a bug → stop, don't fix" rule.

## Scope notes

- `tests/checkout.test.ts` already existed (pre-existing, unrelated —
  `calculateChange`/`canCompleteSale` renderer math). The new
  orchestration test suite was named `tests/runCheckout.test.ts` to
  avoid a collision.
- The two boundaries flagged in `docs/phase-71.md` (fiscal-engine's
  queued-retry classification handling; the IPC handler not being
  independently unit-tested end-to-end) — the second is now
  substantially narrowed: `runCheckout`'s own logic is fully unit
  tested; only the literal 8-line `ipcMain.handle` wrapper (validate →
  call) remains untested by anything other than manual/running-app
  verification, which is inherent to IPC handler registration, not a
  gap this step could close further without a different kind of test
  harness.
- No VERIFY-ON-DEVICE items were introduced — this step is a pure
  refactor plus tests over already-existing (phase-69/71) device-facing
  logic.

---

**STOP for review**, per this task's brief.
