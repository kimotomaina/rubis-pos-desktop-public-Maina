# Phase 77 — Cashier notice, Part A: carry the fiscal outcome to the till

Part A of Step 3 ("cashier notice at the till + fix-and-resend for a
wrong PIN"). Pure plumbing — no UI yet, no change to `runCheckout`'s own
routing/queueing logic. Builds on phase-71 (three states), phase-73
(`runCheckout`), phase-76 (`resendFiscalization`).

## 1. Audit (read-only)

- **`CheckoutReceipt` today** (`database.ts`): `{ localId, mode, shopifyOrderId?,
  fiscal? }` — `fiscal` only present on a successful fiscalization
  (`{invoiceNumber, qrCode}`). Nothing distinguishes `waiting` from
  `needs_fixing`, and no reason/kind reaches the renderer at all —
  confirms `docs/phase-70.md`'s §8 finding.
- **The renderer's checkout-complete handler**: `cartStore.ts#checkout`
  (Zustand). On `result.success && result.data`, it sets `checkoutStatus`
  (`'synced'`/`'queued-offline'`, derived from `receipt.mode`) and stores
  the full receipt in `lastReceipt` — a piece of store state, **not**
  cleared by the effects that immediately reset `checkoutStatus`/local
  form inputs back to idle (`PosCheckoutPanel.tsx`'s `useEffect` on
  `checkoutStatus === 'synced' || 'queued-offline'`). So `lastReceipt`
  is the right thing for a notice to key off — it survives the
  transient status reset that happens moments after checkout completes,
  unlike `checkoutStatus` itself.
- **`PosCheckoutPanel.tsx`** is the live checkout UI — its own doc
  comment confirms it replaced `CheckoutModal.tsx`'s popup "entirely for
  Cash/M-Pesa sales." Confirmed `CheckoutModal.tsx` is not imported or
  rendered anywhere in the app (only referenced by
  `tests/checkout.test.ts`'s doc comment, explaining why that suite
  tests the pure math functions without mounting it) — it's dead code,
  out of scope for Part B/C's UI work.
- **Where fiscal_status/reason/kind can already be read from the
  renderer**: `orders:getLocal` (→ `db.getOrders()`) already returns
  full `OrderRow[]`, which has carried `fiscal_status`/
  `fiscal_error_reason`/`fiscal_error_kind` since phase-71 — but it's a
  list read, a separate round trip, and isn't wired to the checkout-
  complete flow. For an immediate post-checkout notice, extending
  `CheckoutReceipt` itself (returned directly by the same
  `orders:checkout` call) avoids that extra round trip and matches the
  brief's instruction to keep these fields on the eTIMS-specific
  `CheckoutReceipt` shape rather than the generic `ServiceResult<T>`.

## 2. Applied

### `CheckoutReceipt` (`database.ts`) — four new fields

```ts
export interface CheckoutReceipt {
  localId: number
  mode: 'synced' | 'queued-offline'
  shopifyOrderId?: string
  fiscal?: CheckoutFiscalInfo
  fiscalStatus: FiscalStatus | null
  fiscalErrorReason: string | null
  fiscalErrorKind: FiscalFailureKind | null
  fiscalDataIssue: 'wrong-pin' | null
}
```

`fiscalStatus`/`fiscalErrorReason`/`fiscalErrorKind` are **read back**
from the order row (`db.getOrder(localId)`) right before `runCheckout`
returns — not hand-tracked through the fiscalization block's branches —
so they're guaranteed to reflect exactly what got persisted, including
the rare double-failure edge (the exception-fallback's own DB write also
failing) where they'd correctly come back `null`. This one extra local
SQLite read is the only new I/O; no routing, queueing, or write
behavior changed.

### `fiscalDataIssue` — the wrong-PIN marker, threaded from the provider

The brief's own instruction: detect "wrong PIN" via a stable marker from
the provider's classification, not by matching `reason` text. `STE2=59`
("Wrong client PIN") is the one `mapFiscalDeviceError` entry specific
enough for a same-visit fix. Added:

- `FiscalSubmitOutcome`'s failure branch (`etims.ts`) gained an optional
  `dataIssue?: 'wrong-pin'`.
- `real-etims-provider.ts#classifyDeviceFailure` — the single place
  every device-classified failure already funnels through — sets it
  when `result.code === STE2_WRONG_CLIENT_PIN` (`'59'`, a named
  constant next to the existing `CODE_OPENED_FISCAL_RECEIPT` sentinel).
  No changes needed to `mapFiscalDeviceError`, `checkDeviceResponse`, or
  `DeviceResult` — `classifyDeviceFailure` already receives `result.code`.

`fiscalDataIssue` on `CheckoutReceipt` is populated from THIS attempt's
in-memory `FiscalSubmitOutcome` only — **not persisted** to the order
row. Deliberate: it only matters for the immediate post-checkout notice
this step builds; a `needs_fixing` sale discovered later by the
background retry queue (a different attempt, a different in-memory
outcome) is Step 4's (back-office list) concern, not this one. Threading
it through the DB would mean designing a persistence/retrieval story
for a value that's only ever consulted in the same call that produced
it — unnecessary for what Part A–C need.

### `MockFiscalizationProvider`

Unchanged — its two failures are both `kind: 'system'`, never
`'data'`, so `dataIssue` never applies there (the field is optional;
omitting it is valid).

## 3. Tests

- **`tests/runCheckout.test.ts`**: the two `toEqual`-on-the-full-shape
  tests (success, technical failure) updated to include the four new
  fields — not loosened, corrected to match the intentional shape
  change. Added `fiscalStatus`/`fiscalErrorReason`/`fiscalErrorKind`/
  `fiscalDataIssue` assertions to the data-rejection, system-failure,
  and thrown-exception tests. Two new tests: a `dataIssue: 'wrong-pin'`
  outcome surfaces `fiscalDataIssue: 'wrong-pin'` on the receipt; a
  plain (non-wrong-PIN) data rejection leaves it `null`.
- **`tests/realEtimsProvider.test.ts`**: two new tests in the
  "OpenInvoiceWithFreeCustomerData payload" `describe` block — STE2=59
  tags `dataIssue: 'wrong-pin'`; a different STE2 data code (64,
  invalid HS code) does **not** get tagged.
- No existing routing/queueing test needed changing beyond the two
  `toEqual` shape updates above — confirms this step changed nothing
  about *what* happens, only what's *reported back*.

## 4. Verification

- `npx vitest run`: **60 files / 903 tests** (899 going into this part +
  4 new), 0 failures, 0 loosened assertions.
- `npm run typecheck` (node + web): clean.

## VERIFY-ON-DEVICE

None introduced. `STE2_WRONG_CLIENT_PIN`'s value (`'59'`) is the same
already-tabulated, already-tested code from phase-69's STE2 table — this
step only reads a code that was already being computed, it doesn't
change how any code is interpreted.

---

**STOP for review**, per this step's brief — Part B (the till notice UI)
does not start until reviewed.
