# Phase 21 — eTIMS Application Integration & Configuration

**Date:** 2026-08-27 · **Branch:** `main` · **Previous:** [Phase 20](./phase-20.md)

## 1. Objective

`RealFiscalizationProvider` (the eTIMS fiscal-device client) was fully
implemented and unit tested, but nothing in the app surfaced it: the
Admin screen's Integrations tab still only saved a `middlewareUrl`
field the provider had already stopped reading, the fiscalized
invoice number/QR code went nowhere in the UI, and receipts never
printed the fiscal footer KRA requires. This pass wires the provider
into the Admin UI, Order History, and the thermal receipt.

## 2. Admin screen — eTIMS configuration form

`AdminScreen.tsx`'s eTIMS section now has four fields instead of one:
Server URL (`baseUrl`), Device Password (`password`, sent as the
`X-ZFP-Password` header), Default VAT Class (`defaultVatClass`), and
an advanced "Endpoint Paths" JSON textarea (`endpoints`) with a
"Reset to Defaults" button.

The textarea's parse/validate logic lives in a new framework-free
module, `src/renderer/src/lib/etimsConfig.ts`
(`parseEtimsEndpointsInput`, plus the default constants), rather than
inline in the component. Two reasons: it keeps `AdminScreen.tsx`'s
save handler a thin dispatch to a pure function, and — the forcing
constraint — `AdminScreen.tsx` pulls in a chain of extension-less
relative imports (`../stores/authStore`, `./ZReportModal`, etc.) that
are only resolvable under `tsconfig.web.json`'s `Bundler` module
resolution. `tests/**` is type-checked under `tsconfig.node.json`
(`NodeNext`, which requires explicit `.js` extensions), so a test
importing `AdminScreen.tsx` directly broke `npm run typecheck` on
files this phase never touched. Extracting the pure logic into its
own leaf module (no relative imports of its own) sidesteps that
entirely and is unit tested directly in `tests/etimsConfig.test.ts`.

The default endpoint paths are duplicated (not imported) from
`DEFAULT_FISCAL_ENDPOINTS` in
`src/main/services/integrations/real-etims-provider.ts` — importing
that module into the renderer bundle would pull in the main-process
`axios`-based provider code across the process boundary.

## 3. Order History — fiscal display

`OrderHistory.tsx` now renders, under any order with a stored
`fiscal_invoice_number`: a small QR thumbnail (`data:image/png;base64,`)
when `fiscal_qr_code` is present, otherwise a "Fiscalized" badge, plus
an expandable `<details>` showing the invoice number and
`fiscal_fiscalized_at` timestamp.

This reads columns `RubisDatabase.getOrders()` — the query behind
`getLocalOrders` — didn't previously select
(`fiscal_invoice_number`, `fiscal_qr_code`, `fiscal_fiscalized_at`
were added to the `orders` table in Phase 3 but only wired into
`getOrder()`, the single-row lookup, not the list query the Order
History screen actually uses).

## 4. Receipt printing — fiscal footer

`renderReceipt()` in `printer.ts` is now `async` (previously
synchronous formatting calls only) and prints, after "Thank you!":
`Fiscal Inv: <number>` when present, then attempts the QR code via a
new optional `ThermalPrinterLike.printImageBuffer()` call. On any
throw (unsupported client, or a payload that isn't a decodable PNG —
today's stored QR payloads are placeholder text/base64, not real
image bytes; see Phase 2's note on QR code generation being deferred)
it falls back to a `[QR CODE: <invoice number>]` text line so the
receipt layout never breaks.

`sendToPrinter()`'s `render` callback type widened from `void` to
`void | Promise<void>` to `await` this. The mock print sink used in
`settings.mock` mode has no `printImageBuffer`, so demo/offline mode
always takes the text-placeholder path — acceptable since it never
touched real hardware anyway.

`ReceiptOrder` gained `fiscalInvoiceNumber?`/`fiscalQrCode?`; the
`receipt:print` IPC handler in `index.ts` now passes both through
from the freshly-read `OrderRow`.

## 5. Testing

- `tests/printer.test.ts` — five new cases: fiscal footer omitted
  when unfiscalized, invoice number + image print on success, text
  fallback when the client lacks `printImageBuffer`, text fallback
  when `printImageBuffer` throws, and invoice-number-only (no QR).
  Existing `renderReceipt` cases were updated to `await` the now-async
  call.
- `tests/etimsConfig.test.ts` (new) — blank input, valid JSON,
  round-tripping the default endpoints, malformed JSON, and JSON that
  parses to an array/string/null (all rejected as "not an object").
- `tests/orderHistory.test.ts` — the `getOrders` SQL assertion was
  loosened from an exact column-list substring to tolerate the three
  new trailing columns.
- `npm run typecheck` — clean (both `node` and `web` projects).
- `npm test` — 463/463 passing.

## 6. Known follow-ups

- The QR code is still whatever the fiscal device (or, in Phase 2's
  mock path) returns as a base64 string — it is not guaranteed to be
  a decodable PNG. Real on-device QR image support depends on
  confirming ZFPLabServer's actual response shape; local generation
  via the `qrcode` package remains the fallback plan noted in Phase 2.
- The eTIMS device password is stored in the same plaintext
  `integrations.config_json` column as the rest of the config (unlike
  the Shopify Admin API token, which uses the OS credential vault). It
  authenticates a LAN-local fiscal device rather than a cloud API, so
  this was judged acceptable for now; revisit if that changes.
