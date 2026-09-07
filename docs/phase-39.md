# Phase 39 — M-Pesa Transaction Logs & Status Validation

**Date:** 2026-09-01 · **Branch:** `main` · **Previous:** [Phase 38](./phase-38.md)

## 1. Objective

Give cashiers/managers visibility into M-Pesa STK Push attempts and a
way to validate a sale when no public webhook URL exists yet for
Daraja to call back to (see [Phase 38](./phase-38.md)'s follow-ups).
Scope: a `mpesa_transactions` log table, Daraja's STK Push Query API
(`queryStkPushStatus`) as the manual-check counterpart to callbacks,
IPC handlers to log/list/re-check transactions, and an Admin-screen
"M-Pesa Logs" tab with a per-row "Check Status" action.

## 2. Database — `src/main/services/database.ts`

New `mpesa_transactions` table (idempotent `CREATE TABLE IF NOT
EXISTS`, following the existing `SCHEMA` object convention — no
foreign-key constraint is enforced at the DB level, matching `orders`/
`sync_queue`'s existing app-level-only integrity):

```sql
CREATE TABLE IF NOT EXISTS mpesa_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_local_id INTEGER,
  checkout_request_id TEXT NOT NULL,
  merchant_request_id TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  mpesa_receipt_number TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
)
```

Plus `idx_mpesa_transactions_checkout_request_id`, since every lookup
(`updateMpesaTransactionStatus`) filters on that column. Both are
executed in `init()` right after `SCHEMA.printers`.

New `RubisDatabase` methods, mirroring the existing
`getIntegrationConfig`/`getPrinters`/`savePrinter` style:

- `logMpesaTransaction(data: LogMpesaTransactionInput): { id: number }`
  — inserts a `'pending'` row.
- `getMpesaTransactions(limit = 50): MpesaTransactionRow[]` — newest
  first.
- `updateMpesaTransactionStatus(checkoutRequestId, status,
  mpesaReceiptNumber?): boolean` — overwrite, not accumulate, so
  re-checking an already-resolved transaction is a no-op in effect
  (idempotent).

## 3. Provider — STK Push Query

### `src/main/services/integrations/mpesa.ts`

Added `StkPushStatusResult` (`{ status: 'success' | 'failed' |
'pending'; receiptNumber?; resultDesc? }`) and
`queryStkPushStatus(checkoutRequestId)` to the `MpesaProvider`
interface. `MockMpesaProvider` got a matching sentinel-driven
implementation (`checkoutRequestId` suffix `'FAIL'` → failed, `'PEND'`
→ pending, anything else → success with a synthetic receipt number) so
the mock path stays exercisable without Daraja credentials.

### `src/main/services/integrations/daraja-mpesa-provider.ts`

`DarajaMpesaProvider.queryStkPushStatus`:

- `POST /mpesa/stkpushquery/v1/query` with `BusinessShortCode`,
  `Password` (the same `base64(Shortcode + Passkey + Timestamp)`
  logic as `initiateStkPush`, recomputed with the *current* timestamp
  per Daraja's requirement), `Timestamp`, `CheckoutRequestID`.
- `ResultCode === '0'` → `'success'`, extracting
  `MpesaReceiptNumber` when present.
- `ResultCode === '1032'` (cancelled by user) or `'1'` (insufficient
  funds) → `'failed'`.
- Any other `ResultCode` → `'pending'`.
- A query sent before the customer has responded to the prompt comes
  back from Daraja as an **HTTP error** carrying `errorCode
  "500.001.1001"` ("transaction is being processed"), not a
  `ResultCode` — this is recognized and reported as `'pending'`
  (`success: true`) rather than a failed `ServiceResult`, so a cashier
  checking too soon doesn't see a false error.

## 4. IPC — `src/main/index.ts`

Three new handlers, added after the existing
`integrations:mpesa-verify-code`:

- **`mpesa:log-transaction`** — validated via new
  `mpesaLogTransactionSchema` (zod), calls `db.logMpesaTransaction`.
  No manager PIN: a routine checkout-flow side effect, not a
  privileged write (same risk class as `orders:checkout` itself).
- **`mpesa:get-logs`** — calls `db.getMpesaTransactions(limit)`, no
  schema (bare optional number, matching `orders:getLocal`'s existing
  pattern).
- **`mpesa:query-status`** — validated via `mpesaQueryStatusSchema`
  (a bare checkout-request-id string, mirroring `voidOrderSchema`),
  calls `mpesaProvider.queryStkPushStatus`, and — only when the result
  resolves to `'success'`/`'failed'` (never `'pending'`) — persists it
  via `db.updateMpesaTransactionStatus` before returning the result to
  the renderer. A persistence failure is logged and swallowed rather
  than surfaced as the query's own failure, since the query itself
  still succeeded.

Both new schemas live in `src/main/lib/ipcValidator.ts`, next to the
existing schema exports.

## 5. Preload — `src/preload/index.ts` / `src/preload/window.d.ts`

Added `logMpesaTransaction`, `getMpesaTransactions`,
`queryMpesaStatus` to both the `api` object and the mirrored `PosApi`
interface (kept in sync, per this file's existing convention).

## 6. Renderer UI

### `src/renderer/src/pages/MpesaLogsPage.tsx` (new)

First file under a new `src/renderer/src/pages/` directory — every
other page-level component in this codebase lives flat under
`src/renderer/src/components/` (there is no router), but this file's
path was specified directly by the task; `AdminScreen.tsx` imports and
renders it rather than duplicating its logic inline.

- Fetches via `window.api.getMpesaTransactions(50)` on mount; a
  "Refresh" button re-fetches on demand.
- Table columns: Order, Phone, Amount, Time, Status (color-coded pill
  — amber/pending, emerald/success, rose/failed), Receipt No., Action.
- **No auto-polling** (per the task's recommended default) — a
  "Check Status" button appears only on `'pending'` rows and calls
  `window.api.queryMpesaStatus(checkoutRequestId)` on demand, so
  Daraja's query endpoint is only hit when a cashier actually needs an
  answer (e.g. a customer claims they paid).
- Styling matches the existing Tailwind conventions (`rose-*`/
  `slate-*` palette, `rounded-lg`/`rounded-xl`, touch-sized buttons) —
  there is no `lucide-react` in this codebase, so no icons were added
  (text-only buttons, matching `OrderHistory.tsx`).

### `src/renderer/src/components/AdminScreen.tsx`

Added `'mpesaLogs'` to the `activeTab` union, a matching tab button
("M-Pesa Logs"), and a panel rendering `<MpesaLogsPage />` — the same
tab-switcher pattern already used for Overview/Integrations/
Peripherals/System. No new state or effects were needed here since
`MpesaLogsPage` manages its own fetch lifecycle.

## 7. Testing

### `tests/darajaMpesaProvider.test.ts`

Added a `DarajaMpesaProvider.queryStkPushStatus` describe block (6
tests): posts to the correct endpoint and extracts
`MpesaReceiptNumber` on `ResultCode: '0'`; maps `'1032'` and `'1'` to
`'failed'`; maps an unrecognized `ResultCode` to `'pending'`; maps the
`500.001.1001` HTTP-error "still processing" response to `'pending'`
(`success: true`); and a genuine network error still returns a failed
`ServiceResult`.

### `tests/database.test.ts`

- Extended the `RubisDatabase.init` test to assert
  `SCHEMA.mpesaTransactions` and
  `SCHEMA.mpesaTransactionsCheckoutRequestIndex` are executed.
- New `RubisDatabase mpesaTransactions` describe block (9 tests):
  logging with/without a linked order, empty-list default, default
  vs. custom `limit`, a success update with receipt number, a failed
  update with a null receipt number, and the "no matching row" `false`
  path — all asserting exact SQL substrings and positional params via
  the existing recording-fake-connection harness.

## 8. Verification

- `npm test` — 585/585 passing (45 files), no regressions to
  checkout, fiscalization, or Shopify sync flows.
- `npm run typecheck` (`typecheck:node` + `typecheck:web`) — clean.

## 9. Follow-ups

- Still no real webhook receiver — every transaction resolves via the
  manual "Check Status" button or a future callback endpoint, not
  automatically. A public callback URL (or a background poller with
  rate limiting) remains the real fix.
- `mpesa:log-transaction` is exposed over IPC but nothing in the
  checkout/`PaymentModal` flow calls it yet — wiring that up (so an
  STK Push initiated at checkout actually produces a log row) is
  needed before this screen shows real, non-manually-logged data.
- No pagination on the M-Pesa Logs table beyond the 50-row default —
  fine for now given expected till volumes, but worth revisiting
  alongside `OrderHistory`'s own lack of pagination.
