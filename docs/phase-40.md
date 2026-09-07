# Phase 40 — M-Pesa Logging Wired to Checkout & Admin Full-Screen Layout

**Date:** 2026-09-01 · **Branch:** `main` · **Previous:** [Phase 39](./phase-39.md)

## 1. Objective

Two fixes reported against Phase 39's M-Pesa Logs screen:

1. The logs table stayed empty after real M-Pesa sales — Phase 39
   built the DB table, provider, and IPC/UI to display logs, but
   never wired `logMpesaTransaction` into the actual STK Push flow
   (flagged in that phase's own follow-ups).
2. The Admin panel rendered in a narrow, centered column
   (`mx-auto max-w-3xl`) leaving large blank margins on wider
   viewports instead of using the full available width.

## 2. M-Pesa transaction logging — `src/renderer/src/components/PaymentModal.tsx`

`handleSendStkPush` now logs every attempt via
`window.api.logMpesaTransaction`, in both directions:

- **Accepted** (`result.success && result.data`): logs
  `checkoutRequestId`/`merchantRequestId` from Daraja's own response,
  `phoneNumber`, `amount`, `status: 'pending'` — then calls `onPaid`
  exactly as before (`CheckoutModal.handleMpesaPaid` immediately
  checks out; see the note on `order_local_id` below).
- **Rejected or thrown** (`!result.success` or a caught exception):
  a new `logFailedStkPushAttempt` helper logs `status: 'failed'`.
  Daraja never issues a `CheckoutRequestID` for a request it didn't
  accept, so a client-generated placeholder (`` `failed-${Date.now()}` ``)
  is used — there's nothing to later "Check Status" against, only an
  audit trail of the attempt. This call is wrapped in its own
  try/catch and swallows its own failure (logged nowhere further)
  since a *logging* failure must never block the cashier from
  retrying the actual payment.

**`order_local_id` is intentionally left unset at logging time.**
STK Push is initiated *before* checkout — `CheckoutModal.handleMpesaPaid`
only calls `checkout()` once `PaymentModal` reports success — so no
local order id exists yet at the point `logMpesaTransaction` fires.
The column stays nullable for exactly this reason (see Phase 39's
schema). Backfilling it after the order is created would need
`cartStore.checkout` to return the new `localId` to its caller (it
currently only updates `lastReceipt` in the store) and a new DB method
to link an existing `mpesa_transactions` row to it — deferred rather
than done here to keep this fix scoped to "logs populate," not a
cart-store contract change.

### `src/main/services/database.ts` / `src/main/lib/ipcValidator.ts` / preload

`LogMpesaTransactionInput` gained an optional `status?:
MpesaTransactionStatus` (defaults `'pending'`), threaded through:

- `logMpesaTransaction`'s INSERT now includes the `status` column.
- `mpesaLogTransactionSchema` accepts `status` and relaxed
  `merchantRequestId` from `min(1)` to a bare `z.string()` — a logged
  failure has no merchant request id to report.
- `logMpesaTransaction`'s preload/`PosApi` signatures gained the same
  optional `status` field.

The "Check Status" flow itself (`mpesa:query-status` →
`queryStkPushStatus` → `db.updateMpesaTransactionStatus`) already
existed from Phase 39 and needed no changes — it already persists a
resolved status when a cashier checks a pending row, which is what the
task's "update the M-Pesa status polling" step asked for.

## 3. Admin panel full-width layout

### `src/renderer/src/components/AdminScreen.tsx`

The root cause of "not full screen" was `mx-auto max-w-3xl` on the
screen's outermost `<div>` — App.tsx's `<main className="flex-1
overflow-y-auto p-6">` wrapper was already full-width/full-height
(standard flexbox `flex-1`), but that inner container capped content
to a centered 768px column regardless. Changed to:

```tsx
<div className="h-full min-h-full w-full space-y-6">
```

The `'mpesaLogs'` tab panel also dropped its bordered/padded
`<section className="rounded-xl border ... p-4">` wrapper — the
transactions table now renders directly (`{activeTab === 'mpesaLogs'
&& <MpesaLogsPage />}`) so it can go edge-to-edge like the task asked,
rather than sitting inside another card's padding on top of its own.
Every other tab (Overview/Integrations/Peripherals/System) is
unchanged and now simply stretches to the full width this container
provides, satisfying "all tabs render correctly at full width" without
touching their individual section markup.

### `src/renderer/src/pages/MpesaLogsPage.tsx`

Already matched the target shape from Phase 39 (`overflow-x-auto` on
the table wrapper, `w-full` table, Refresh button top-right via
`flex justify-between`) — the only change was making that explicit on
the page's own root (`<div className="w-full space-y-4">`) now that it
is no longer nested inside a padded card.

## 4. Testing

- `tests/database.test.ts` — updated the three existing
  `logMpesaTransaction` assertions for the new 6-parameter insert
  (`status` appended), and added two new cases: status defaults to
  `'pending'` when omitted, and a `'failed'` log with an empty
  `merchantRequestId` inserts correctly.
- No new renderer/component test: this repo has no
  `@testing-library/react` (or any component-test) setup — every
  existing test targets services/stores/main-process logic — so
  `PaymentModal`'s new logging calls aren't independently unit-tested
  here; they were checked by reading the call sites against the
  already-tested `logMpesaTransaction`/schema behavior.

## 5. Verification

- `npm test` — 587/587 passing (45 files), no regressions to
  checkout, fiscalization, or Shopify sync.
- `npm run typecheck` (`typecheck:node` + `typecheck:web`) — clean.

## 6. Follow-ups

- `order_local_id` still isn't backfilled onto a logged M-Pesa
  transaction once its order is created — see the note in §2. Needs
  `cartStore.checkout` to expose the new `localId` to its caller (or a
  `linkMpesaTransactionToOrder(checkoutRequestId, localId)` DB method)
  before the Logs table's "Order" column reflects anything but `—`
  for STK-Push-originated rows.
- A failed STK Push's placeholder `checkoutRequestId` (`failed-<ts>`)
  is only ever unique per-cashier-click; two failures in the same
  millisecond (not realistically possible from one UI click, but
  worth noting) would collide. Not addressed, since `Date.now()`
  millisecond collisions from sequential awaited IPC calls are not a
  practical risk here.
