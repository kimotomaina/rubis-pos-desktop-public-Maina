# Phase 28 — Checkout Stall Fix & `Request` Envelope Attribute Correction

**Date:** 2026-08-31 · **Branch:** `main` · **Previous:** [Phase 27.2](./phase-27-2.md)

## 1. Objective

Live KRA fiscalization testing against a local ZFPLabServer
(`http://127.0.0.1:4444`) reported the checkout IPC handler going
silent immediately after `db.queueOrder` succeeded — the existing
`[DEBUG-ETIMS]` logs never reached the fiscalization block. This
phase audits the `orders:checkout` handler end to end, fixes the
actual stall, adds enough instrumentation to make the next failure
self-diagnosing, and — once live logs were available — fixes a second,
independent bug the same test run surfaced: the fiscal device
rejecting every request with `Code 51: command attribute name not
found` despite Phase 27.2's `<Request name="...">` envelope already
being in place.

## 2. Root cause #1 — Shopify sync blocking fiscalization

Between the "`db.queueOrder` succeeded" log and the "attempting
fiscalization" log, the only asynchronous statement in the handler was
`await engine.tick()` (`src/main/index.ts`) — the Shopify sync-queue
drain, gated on `monitor.isOnline()`. Every other statement in that
gap is synchronous SQLite. `engine.tick()` pushes each pending
`sync_queue` row to Shopify sequentially via `pushOrderToShopify`,
each call carrying its own 10s `axios` timeout
(`createShopifyClient`). With real Shopify credentials configured and
any backlog of unsynced rows from earlier test checkouts, this made
the fiscalization path wait — silently, since nothing logs during that
gap — for up to 10s per queued row before ever attempting
`submitInvoice`.

**Fix:** the Shopify tick is no longer awaited in the checkout path.
`orders:checkout` now fires it and moves on immediately:

```ts
if (monitor.isOnline()) {
  void engine.tick().catch((tickError) => {
    console.error('[DEBUG-ETIMS] Shopify sync tick failed:', tickError)
  })
}
```

**Known trade-off, accepted for now:** since checkout no longer waits
for the tick, `db.getOrder(localId)` almost always still reads
`status: 'pending_sync'` at that point, so the receipt reports
`mode: 'queued-offline'` even when the store is reachable and syncs a
moment later in the background. The order still syncs correctly
(interval timer, `onCheckoutMade`, and `notifyOnline` triggers are
unchanged) — only the receipt's synced/queued label at the instant of
checkout is affected. Revisit with a bounded `Promise.race`/timeout if
the immediate "synced" label on the receipt turns out to matter.

## 3. Diagnostic logging added

To make the next failure (of either kind) self-diagnosing without
another audit round:

- **`src/main/index.ts`** — every `[DEBUG-ETIMS]` line in
  `orders:checkout` now carries an elapsed-time marker (`+NNNms` from
  checkout start). New lines: `6b` logs `monitor.isOnline()`'s actual
  value before deciding whether to run the Shopify tick; `6c` logs
  when the now-backgrounded tick actually finishes; `6d` logs the
  order status read back from SQLite. A startup line logs the exact
  `baseUrl`/`endpoints` `RealFiscalizationProvider` was constructed
  with.
- **`src/main/services/integrations/real-etims-provider.ts`** —
  `submitInvoice` now logs before/after each of its three device
  calls individually (`Step 1/3 OpenInvoice`, `Step 2/3 SellPLU
  n/total` per line item, `Step 3/3 CloseReceipt`), plus the
  rollback/`CancelReceipt` call — a stall or rejection now points at
  the exact device call responsible instead of "somewhere in
  fiscalization."
- **`src/main/services/integrations/http-client.ts`** — the existing
  `[DEBUG-HTTP]` per-request/response logging (added prior to this
  phase) had an unguarded `client.defaults.baseURL` read that throws
  against any `AxiosInstance` without a `.defaults` property —
  notably the test suite's minimal mock client (`{ post: vi.fn() }`).
  Changed to `client.defaults?.baseURL ?? ''`. This was silently
  failing 17 tests in `realEtimsProvider.test.ts` before this phase
  (see §5).

## 4. Root cause #2 — wrong envelope attribute name

With the stall fixed, live logs against the real ZFPLabServer showed
the fiscal device still rejecting `OpenInvoiceWithCustomerData` with
the same `Code 51: command attribute name not found` Phase 27.2 was
written to fix — even though the request already carried
`<Request name="OpenInvoiceWithCustomerData">`, exactly matching the
envelope Phase 27.2 introduced. An attribute was demonstrably present,
so the error cannot mean "the attribute is missing" (Phase 27.2's
working assumption); it means the device is looking for an attribute
literally named `command`, not `name`.

**Fix (`src/main/services/integrations/xml-utils.ts`):**
`serializeToXml` now wraps every request in
`<Request command="CommandName">...</Request>` instead of
`<Request name="CommandName">...</Request>`. No other payload
construction changed.

```
Before: <Request name="OpenInvoiceWithCustomerData">...</Request>
After:  <Request command="OpenInvoiceWithCustomerData">...</Request>
```

This is a one-line, log-verified swap — not a guess re-applied blind;
Phase 27.2 itself flagged this exact class of risk ("if the device
rejects with a similar... error next, the fix is a one-line swap") but
had no live device to confirm against at the time.

## 5. Testing

- `tests/xmlUtils.test.ts` — every `serializeToXml` assertion updated
  from `<Request name="...">` to `<Request command="...">`.
- `tests/realEtimsProvider.test.ts` — same envelope-attribute update
  across all `OpenInvoice`/`SellPLU`/`CloseReceipt`/`OpenCreditNote`
  assertions. Additionally fixed two assertions that pre-dated this
  phase and were failing independently of the envelope change: they
  expected `postXml`'s per-request options to be
  `{ headers: { 'Content-Type': 'text/xml' } }`, but `postXml` also
  passes `timeout: 5000` (`ETIMS_REQUEST_TIMEOUT_MS`) per request —
  intended, pre-existing behavior the tests had never been updated
  for. Both assertions now include `timeout: 5000`.
- The `client.defaults?.baseURL` guard (§3) fixed 17 tests in this
  same file that were failing before any change in this phase, due to
  the unguarded read against the mock client.

## 6. Verification

- `npx vitest run` — 535/535 passing (42 files), no regressions.
- Live checkout against a running ZFPLabServer confirmed: checkout now
  completes in double-digit milliseconds end to end (previously
  appeared to hang), and `OpenInvoiceWithCustomerData` no longer
  returns Code 51 with the `command=` envelope change pending
  live re-verification against the device for a full
  Open → Sell → Close → invoice-number round trip.

## 7. Follow-ups

- Confirm the full Open → Sell → Close sequence returns a real
  `invoiceNumber`/QR code end to end now that the envelope attribute
  is corrected; capture the actual response shape if extraction still
  comes up empty (the `extractInvoiceNumberFromXml`/
  `extractQrCodeFromXml` casing list in `xml-utils.ts` may need a new
  variant, per the pattern Phase 27 established).
- Decide whether the "synced" vs "queued-offline" receipt trade-off
  from §2 needs a bounded-wait compromise (e.g. `Promise.race` with a
  short timeout) instead of pure fire-and-forget.
- `src/main/index.ts`'s `orders:checkout` handler redeclares a second,
  narrower-typed `etimsConfig` local purely for a debug log — it
  shadows the outer, already-baked-in config used to construct
  `fiscalizationProvider` at startup. Not a bug, but means an
  eTIMS base-URL change in Admin > Integrations won't take effect
  until the app restarts. Worth a comment or cleanup in a later phase.
