# Phase 41 — Robust M-Pesa Checkout Gates, Polling, and Automated Completion

**Date:** 2026-09-01 · **Branch:** `main` · **Previous:** [Phase 40](./phase-40.md)

## 1. Objective

Bring the M-Pesa checkout flow in line with how a real STK Push
payment terminal behaves: block payment on an empty cart, guarantee
the charged amount always matches the cart total, and — the core gap
— never treat *STK Push acceptance* as a completed sale. Previously
`PaymentModal.handleSendStkPush` called `onPaid` (which immediately
triggers `checkout()`) the instant Daraja accepted the push request,
before the customer had even seen the prompt on their phone. This
phase adds a polling "Waiting for M-Pesa Confirmation" step so
`onPaid` only fires once Daraja actually confirms the payment.

## 2. Gates — `src/renderer/src/components/PaymentModal.tsx`

- **Gate 1 (empty cart):** `total <= 0` now short-circuits the entire
  component to a blocking notice — "Cart is empty. Please add items
  before paying." — with only the "← Change payment method" escape
  hatch, before any tab/form renders.
- **Gate 2 (exact amount matching):** there was already no editable
  amount field — `initiateMpesaStkPush`'s `amount` has always been the
  `total` prop directly. A read-only, disabled "Amount" input showing
  `formatCurrency(total)` was added to the STK tab so the cashier
  *sees* the fixed charge (compliance/clarity), without introducing a
  field that could be mistyped. No parsing/validation branch was
  needed since there is nothing for a cashier to enter.

## 3. Polling — `src/renderer/src/lib/mpesaPaymentPoller.ts` (new)

A framework-free poller (factory function, not a class — mirrors
`connectivityMonitor.ts`'s `createConnectivityMonitor` shape) so it's
unit-testable with plain fake timers, no component-test harness:

- `MPESA_POLL_INTERVAL_MS = 5000`, `MPESA_POLL_TIMEOUT_MS = 90_000`
  (90s — the clarification default: enough time for a customer to
  enter their PIN, without an indefinite cashier wait; Daraja pushes
  themselves expire around 2 minutes).
- `createMpesaPaymentPoller({ checkoutRequestId, queryStatus, callbacks, intervalMs?, timeoutMs? })`
  returns `{ start(), stop() }`. `stop()` is idempotent (safe to call
  any number of times, before `start()`, or after the poller has
  already settled) and always `clearInterval`s — satisfying this
  phase's cleanup/no-leak rule.
- Every tick: skip entirely if a previous poll is still in flight (an
  `inFlight` guard — no two concurrent status queries for the same
  `checkoutRequestId`); if elapsed time has reached `timeoutMs`, stop
  and fire `onTimeout` *instead of* issuing one more query; otherwise
  call `queryStatus` and dispatch to `onPending` (also covers a failed
  status *query* itself — a transient network blip while polling
  doesn't fail the payment, it just waits for the next tick),
  `onSuccess`, or `onFailed`. A response that resolves after `stop()`
  was called is discarded, so a cancelled/settled poller can never
  fire a callback late.

## 4. `PaymentModal.tsx` — waiting/failed overlay + wiring

New `StkPhase` union (`'form' | 'waiting' | 'failed'`) replaces the
old "accept push → call `onPaid` immediately" behavior:

- **`handleSendStkPush`** still logs the accepted push as `'pending'`
  via `logMpesaTransaction` (Phase 40), but now calls `startPolling`
  instead of `onPaid`.
- **`'waiting'`** phase renders a full-screen-within-modal overlay:
  spinner, the phone number, the exact amount, and a live countdown
  (`Math.ceil(msRemaining / 1000)`, updated on every `onPending`
  tick) — plus a **"Cancel Payment"** button that stops the poller and
  calls `onCancel()` (per this phase's clarification default: this
  only stops the *POS* from waiting, it cannot cancel the prompt
  already sitting on the customer's phone — Daraja has no such API).
- **`onSuccess`** stops tracking the poller and calls `onPaid(receiptNumber
  ?? checkoutRequestId)` — exactly the same checkout trigger
  `CheckoutModal.handleMpesaPaid` already used, just invoked later
  (on confirmed payment, not on push acceptance) rather than changed
  in shape. No changes were needed in `CheckoutModal.tsx`.
- **`'failed'`** phase (both a Daraja-reported failure and a timeout
  route here) shows the reason and **"Retry Payment"** (clears the
  poller, returns to the phone-number form with the number preserved)
  / **"Cancel"** (`onCancel()`) buttons, per the task spec.
- **Cleanup:** `useEffect(() => stopPolling, [])` stops any in-flight
  poller on unmount — covers the modal being closed via the X button,
  a payment-method change, or any other unmount path during polling,
  not just the explicit Cancel button.
- The STK/Manual tab switcher, the "amount" gate note, and the
  `logFailedStkPushAttempt` audit-log helper are unchanged from
  Phase 40 apart from being reachable only in the `'form'` phase —
  while waiting or after a failure, only the overlay's own
  Cancel/Retry controls are shown (an intentional narrowing: switching
  to Manual Code mid-poll isn't offered, matching the task's Retry/
  Cancel-only spec for the failed state).

## 5. Main-process verification (Task 3)

Re-checked `mpesa:query-status` in `src/main/index.ts` (unchanged this
phase): it `await`s `mpesaProvider.queryStkPushStatus` then, only when
the result resolves to `'success'`/`'failed'` (never `'pending'`),
calls `db.updateMpesaTransactionStatus` before returning — exactly the
persistence behavior this phase's polling relies on, already correct
since Phase 39/40. It does not block the main thread beyond the
in-flight HTTP call itself, same as every other IPC handler in this
codebase (no synchronous heavy work).

## 6. Testing

### `tests/mpesaPaymentPoller.test.ts` (new, 9 tests)

Fake-timer tests (`vi.useFakeTimers()` / `vi.advanceTimersByTimeAsync`,
matching `connectivityMonitor.test.ts`'s established pattern):
pending-then-success resolution (with the exact `onPending` countdown
value asserted); failed resolution, both with and without a Daraja
`resultDesc`; a failed *status query* being treated as pending rather
than erroring the payment; timeout after `MPESA_POLL_TIMEOUT_MS` of
persistent pending (asserting the exact query count — one fewer than
`timeoutMs / intervalMs`, since the tick that crosses the threshold
fires `onTimeout` without querying); no query at all when stopped
before the first tick; a late response arriving after `stop()` being
discarded; no overlapping queries when one is still in flight past the
next tick; and `stop()` being safely callable multiple times.

### `tests/darajaMpesaProvider.test.ts` (+3 tests)

Added a `queryStkPushStatus` idempotency/concurrency group: three
concurrent calls for the *same* `checkoutRequestId` each resolve
correctly and independently; two concurrent calls for *different*
ids resolve to their own distinct receipt numbers without
cross-contamination (both issue their own OAuth fetch, since neither
sees a token cached by the other yet — documented in the test rather
than asserted away, since there's no request-coalescing mutex on
`getAccessToken`); and a later, non-concurrent call correctly reuses
the by-then-cached token.

## 7. Verification

- `npm test` — 598/598 passing (46 files), no regressions to
  Cash/Card checkout, fiscalization, or Shopify sync.
- `npm run typecheck` (`typecheck:node` + `typecheck:web`) — clean.

## 8. Follow-ups

- `getAccessToken` has no in-flight-request coalescing — two
  concurrent Daraja calls issued before any token is cached each fetch
  their own token (harmless, just an extra OAuth round trip; see the
  concurrency test above). Worth a small mutex if concurrent STK Push
  + status-query traffic becomes common, but out of this phase's scope.
- The "Waiting for M-Pesa Confirmation" overlay has no manual "Check
  Status now" button of its own — it relies entirely on the 5s
  interval. A cashier who believes the customer already paid still has
  to wait for the next tick (at most 5s), which was judged acceptable
  given the short interval.
- No `@testing-library/react` exists in this repo, so `PaymentModal`'s
  JSX/interaction itself (as opposed to the extracted poller logic) is
  still not directly unit-tested — consistent with every other
  component in this codebase.
