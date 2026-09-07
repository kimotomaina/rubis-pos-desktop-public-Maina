# Phase 81 — Task 1: logging, Apply

Applies the standard from `docs/phase-80.md`'s audit, adjusted per your
review: a debug flag that mutes/restores the wire trace rather than
deleting it, `localId` on every fiscal event, the reclassification event
specifically covered, the Code 40 diagnostic left untouched, and the
password redacted everywhere the settings URL is logged.

## What changed

### One shared logger

New `src/main/services/logger.ts` exports `Logger` (`log`/`warn`/`error`)
— the same three-method shape `checkout.ts`'s `CheckoutLogger` already
had, now used everywhere instead of just there. `CheckoutLogger` is kept
as a type alias (`export type CheckoutLogger = Logger`) so nothing
importing it had to change. `fiscal-engine.ts`, `fiscal-retry.ts`, and
`real-etims-provider.ts` all gained an optional `logger` (defaults to
`console`) — production wiring in `main/index.ts` passes `console`
explicitly everywhere, same as `runCheckout` already did.

### One debug flag: `FISCAL_DEBUG_LOGGING`

Read once in `main/index.ts` (`FISCAL_DEBUG_LOGGING=true`, off by
default) and threaded into `RunCheckoutDeps.debugLogging` and
`RealFiscalizationProviderOptions.debugLogging`. Off, the per-step
`[ETIMS] Step N/7` progress log, `http-client.ts`'s `[DEBUG-HTTP]`
request/response wire trace, a handful of intermediate diagnostic lines
inside the duplicate-filing recovery, and the `checkout.ts` Shopify-tick
completion line are all silent. On, they're back exactly as they were —
nothing was deleted, only gated, per your note that this is the lever
you'll want when there's an actual device issue to chase after go-live.

### The password leak

`http-client.ts#sendGet` now redacts the settings() URL before logging
it (`password=***`), and only when `debug` is on — so the real device
password can no longer reach the console or a log file, whether or not
debug logging is enabled. Separately, `postXml`/`sendGet`'s error
handlers no longer dump the raw `axios` error object (whose `config` can
carry the request URL) — they log `describeFiscalHttpError`'s already-
translated message instead, which never contains the URL at all. Both
changes are logging-only; the returned `ServiceResult` is unchanged.

### `localId` on every fiscal-outcome log line

`checkout.ts` hoists `let localId: number | undefined` above its try
block (previously block-scoped `const`) purely so the outer catch can
still name the sale if the throw happens after the order was queued —
logging only, control flow and return values are unchanged. Every fiscal
warn/error/info line in `checkout.ts`, `fiscal-engine.ts`, and
`fiscal-retry.ts` now says `Sale {localId}: ...`.

### Level split: `warn` for data, `error` for system

Previously `checkout.ts` logged every fiscal failure at `warn`
regardless of kind. Now: `retryable` (queued) → `log`; non-retryable
`kind: 'data'` → `warn`; non-retryable `kind: 'system'` → `error`. The
same split now applies in `fiscal-engine.ts`'s reclassification branch
and `fiscal-retry.ts`'s resend outcome — including the retry-queue
`recordFiscalQueueFailure` path, which now only logs (a `warn`) when an
item is finally abandoned after repeated failures, not on every
individual backoff — a device down for hours would otherwise log the
same "still failing" line every 30 seconds.

### The reclassification event (the one that mattered most)

`fiscal-engine.ts#tick()` now logs the "waiting → needs_fixing"
reclassification explicitly — `warn` for a `data` kind, `error` for
`system` — the exact transition that previously happened in total
silence, and the one your first message on this feature called out by
name (a wrong device password means everything fails as "unreachable"
first, and a genuine data problem only surfaces on a later retry).

### `fiscal-retry.ts` — resend paths now log too

`resendFiscalization` and `correctPinAndResend` were completely silent
before this. Now: a resend on an already-fiscalized order logs `log`
(no-op, no device call); no stored request logs `warn`; no such order
logs `error`; a successful resend logs `log` with the invoice number; a
still-failing resend follows the same data/system split; and
`correctPinAndResend` logs one line ("buyer PIN corrected/removed,
resending") before delegating, so a manual fix-and-resend is
distinguishable in the log from a background retry.

### Left alone, on purpose

- `real-etims-provider.ts#checkDeviceResponse`'s Code 40 STE1/STE2 dump
  (line ~376) — untouched, per your call: it's there to capture the
  first live device error, and removing it before that happens would
  throw away the one thing it exists to catch.
- `formatPrice`'s over-length warning and `ReadCUnumbers`'s best-effort
  failure warning — both already rare, already fine, left as they were
  (the latter now goes through the injected logger for consistency, but
  its behavior/frequency is unchanged).

## Tests

- **`tests/runCheckout.test.ts`** (+5): a plain successful sale logs
  nothing at all (no `log`/`warn`/`error`) with `debugLogging` off; a
  data rejection logs a `warn` containing the sale's `localId` and the
  reason; a `system`-kind failure logs an `error` containing the
  `localId`; a retryable/technical failure logs at `log` level, not
  `warn`/`error`; an unhandled exception logs an `error` with the
  `localId`.
- **`tests/fiscalEngine.test.ts`** (+5): a successful queued retry logs
  only an info line, no warn/error; a `data`-kind reclassification logs
  a `warn` with the `localId`; a `system`-kind reclassification logs an
  `error`; a still-retrying (not yet exhausted) failure logs nothing at
  all; an item abandoned after repeated failures logs a `warn`.
- **`tests/http-client.test.ts`** (+4): `getSettings`/`postXml` log
  nothing by default; with `debug: true`, `getSettings` logs the request
  URL but the real password never appears in any logged line
  (`password=***` does); `postXml` logs both the request and response
  lines when debug is on.
- **`tests/realEtimsProvider.test.ts`** (+4): a normal sale is silent on
  both `console.log` and `console.warn` with `debugLogging` off; with it
  on, the `[ETIMS] Step 1/7` trace appears; the already-opened-receipt
  recovery and the duplicate-filing (`ReadCUinvoiceNumber`) recovery both
  route through the injected `logger`, each including the sale's
  `localId`.

## Verification

- `npx vitest run`: **61 files / 953 tests** (935 going in + 18 new), 0
  failures.
- `npm run typecheck` (node + web): clean.
- No control flow, DB write, return value, or timing was changed —
  confirmed by every pre-existing test in `runCheckout.test.ts`,
  `fiscalEngine.test.ts`, `fiscalResend.test.ts`, `fiscalRetry.test.ts`,
  `http-client.test.ts`, and `realEtimsProvider.test.ts` passing
  unmodified (two test files — `fiscalIntegration.test.ts` and
  `runCheckout.test.ts`'s own `makeDeps` helper — needed a
  `debugLogging: false` field added to their dependency objects, since
  `RunCheckoutDeps` gained a new required field; nothing about what they
  assert changed).

Holding here for review before Task 2 (the sale-complete toast).
