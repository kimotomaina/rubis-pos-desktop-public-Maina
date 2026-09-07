# Phase 80 — Task 1: logging, Audit

Read-only. No code changed. STOP for review before Apply.

## The shared logger

`CheckoutLogger` (`checkout.ts`) is the only injected logger anywhere in
the fiscalization path — `{ log, warn, error }`, wired to
`logger: console` in production (`main/index.ts:777`) and to a fake in
`runCheckout`'s own tests. Nothing else uses it:

- `fiscal-engine.ts` (the retry-queue `tick()`) and `fiscal-retry.ts`
  (`attemptFiscalRetry`/`resendFiscalization`/`correctPinAndResend`) have
  **zero logging of any kind** — not the injected logger, not even a bare
  `console.*`. Confirmed by grep, not just a quick read.
- `real-etims-provider.ts` and `http-client.ts` (the device-protocol
  client) call raw `console.*` directly throughout. They're constructed
  independently of `runCheckout`'s dependency injection, so they never
  had a `logger` to use in the first place.

So today there are two disconnected logging styles in one feature: one
injected/testable (`checkout.ts`, unused everywhere else), one raw and
global (`real-etims-provider.ts`/`http-client.ts`).

## File-by-file inventory

### `checkout.ts` (`runCheckout`) — via the injected `logger`

| Line | Level | Fires on | localId included? |
|---|---|---|---|
| 230 | `log` | every sale that starts online (fire-and-forget Shopify tick finish) | yes, in the message |
| 232 | `error` | Shopify tick failure | no |
| 264 | `warn` | every fiscal failure — both `waiting`/queued and `needs_fixing`/flagged | **no** |
| 279 | `error` | fiscalization threw | **no** |
| 300 | `error` | fallback queue write also failed | **no** |
| 324 | `error` | top-level unhandled exception | no (staff/order may not exist yet) |

Two findings:
- **Line 230 fires on every normal sale**, regardless of fiscal outcome —
  it's a Shopify-sync line, not a fiscal one, but it's the one line that
  guarantees console noise on a clean happy-path sale.
- **None of the fiscal-outcome lines (264/279/300) include `localId` in
  the message**, even though `localId` is in scope at every one of those
  call sites. This directly works against the brief's "say... the sale's
  localId, so a stuck sale is findable" goal — right now you'd have to
  correlate on timing, not on an id you can search for.

### `real-etims-provider.ts` — raw `console.*`, not the injected logger

- **`logStep`** (line 564): `console.log` on every one of the 7 workflow
  steps, plus once per line item at step 4. Fires unconditionally on
  **every sale, including a clean happy path** — for a 3-item sale
  that's roughly 9-10 lines on its own. The single noisiest offender in
  this file.
- Line 375 (`checkDeviceResponse`): `console.warn` dumping both raw STE
  bytes on every Code 40. The doc comment says this is deliberate,
  temporary diagnostic scaffolding ("so the first live Code 40 settles
  which byte the real device populates") — flagging it as a candidate to
  downgrade once that's confirmed on a real device, not removing it
  blind.
- Line 581: `console.warn`, `ReadCUnumbers` failure (best-effort serial
  lookup) — fires only on failure, fine as-is, no localId (not
  sale-specific).
- Line 610/649/675/642: the duplicate-filing recovery path (`isRetry`
  branch) — exactly the "recovered as already-filed" event the brief
  calls out by name. Currently `console.log`/`console.warn` with no
  `localId` (available in scope via `request.localId`, not used).
- Line 733: `console.warn` + a raw `JSON.stringify` dump of the entire
  `CloseReceipt` response when it carries no invoice number — internal/
  raw, not plain language, no localId.
- Line 753: `console.warn`, `ReadDateTime` returned no timestamp — a
  best-effort fallback notice; can't tell from a read-only audit how
  often this fires in practice, flagging as a possible noise source.
- Line 950: `console.log`, Code 53 session-drop recovery — fine as an
  event, but no localId.
- Line 1144: `console.log('[ETIMS] CancelReceipt result:', result)` —
  fires on **every** rollback (any failed step past `OpenInvoice`), dumps
  the entire raw result object with no framing at all.
- Line 1176: `console.warn`, price exceeds vendor length — rare edge
  case, fine as-is.

### `http-client.ts` — raw `console.*`, the actual noise floor

`postXml` and `sendGet` are the transport underneath every single device
command (`settings`, `ReadStatus`, `OpenInvoice`, each line item's
`SellPLU*`, `ReadCurrentReceiptInfo`, `CloseReceipt`, `ReadDateTime`,
`CancelReceipt`, `ReadCUinvoiceNumber`, `ReadCUnumbers`). Both log,
unconditionally, tagged `[DEBUG-HTTP]`:

- the full outgoing request (URL or XML body) **before** sending,
- the full raw response body + HTTP status **after**.

That's 2 lines per device command. A normal 3-item sale (settings +
ReadStatus + ReadCUnumbers + OpenInvoice + 3×Sell + ReadCurrentReceiptInfo
+ CloseReceipt + ReadDateTime = 10 commands) produces **~20 `[DEBUG-HTTP]`
lines by itself**, on top of `logStep`'s own ~10 — 30+ console lines for
one clean, successful sale. This is the noisiest offender by a wide
margin, and the `[DEBUG-HTTP]` tag itself suggests it was meant to be
gated behind a debug flag and never was.

**One more thing this surfaced, worth flagging directly rather than
folding into "noise": `sendGet`'s log line includes the full request
URL, and `settings()`'s URL is built by `buildSettingsCommand` as
`settings(ip=…,port=…,password=…,tcp=1)` — the device's real TCP
password is a plain query parameter in that URL. So today, the fiscal
device password is written to the console/log file in cleartext once
per session (whenever `settings()` runs). This isn't a routing/queueing
change, it's a straight logging fix, so it's in scope for this task —
flagging it here rather than fixing it unasked, since it's a bigger deal
than the rest of this audit.**

### `fiscal-engine.ts` (`tick()`) and `fiscal-retry.ts`

Confirmed zero logging, not just low logging. Concretely, today none of
these produce any log line at all:

- a queued item's retry succeeding (`markFiscalQueueItemSynced`),
- a retry still failing and backing off (`recordFiscalQueueFailure`),
- **a later retry reclassifying a `waiting` sale to `needs_fixing`**
  (`tick()` line 141) — the exact scenario the phase-76/79 work was
  built around (device password wrong → everything fails as
  "unreachable" first, and a genuine data problem only reveals itself on
  a later retry). Right now that reclassification happens completely
  silently.
- `resendFiscalization`/`correctPinAndResend` succeeding or failing (the
  manual "fix and resend" path from Part C) — also silent.

This is the mirror image of the `http-client.ts` finding: the path that
fires on every device byte is deafening, and the path carrying the
events an operator would actually want to search for is mute.

## Proposed standard (for Apply, pending your review)

- **Happy path**: drop `logStep`'s per-step chatter and `http-client.ts`'s
  per-command request/response dump to nothing by default (or a level
  below `info` if the project wants a debug toggle later — out of scope
  to add one now). Keep `checkout.ts`'s line 230 Shopify-tick line since
  it's not fiscal-specific and pre-dates this task; happy to drop it too
  if you'd rather the happy path be fully silent.
- **Notable fiscal events, one line each, through the (now shared)
  injected logger, always including `localId`**:
  - `info`: queued/waiting, recovered-as-already-filed, resent
    successfully.
  - `warn`: flagged `needs_fixing` (both on first attempt and on later
    reclassification in `tick()`).
  - `error`: a `system`-kind failure or an unhandled exception.
- **Errors**: keep the existing detail, logged once at the point of
  decision (already true in `checkout.ts`; would newly become true in
  `fiscal-engine.ts`/`fiscal-retry.ts`).
- **Fix the password leak** by redacting it before logging the settings
  URL (e.g. log `settings(ip=…,port=…,password=***,tcp=1)` or just the
  command name, not the built URL).
- **Route `fiscal-engine.ts` and `fiscal-retry.ts` through a logger too**,
  by injecting the same `CheckoutLogger` shape rather than adding new
  raw `console.*` calls — `main/index.ts` already has `console` on hand
  to wire in, same as it does for `runCheckout`.

Holding here — not touching `real-etims-provider.ts`'s Code 40 diagnostic
dump (line 375) without your call on whether that's still needed, and not
touching anything until you've reviewed this inventory.
