# Phase 27.1 — XML Payload Serialization for ZFP Server

**Date:** 2026-08-27 · **Branch:** `main` · **Previous:** [Phase 27](./phase-27.md)

## 1. Objective

The ZFP Lab Server rejected every call with error 63, "Content of
post body must be valid xml" — `RealFiscalizationProvider` had been
sending JSON bodies with a JSON content type since Phase 2. Phase 27's
casing-tolerant JSON extraction was solving the wrong problem: the
device wasn't returning an unusual JSON shape, it was never accepting
the request in the first place. This phase switches the wire format
to XML end to end — request bodies, the `Content-Type` header, and
response parsing — without touching the `OpenInvoice → SellPLU →
CloseReceipt` call sequence itself.

## 2. XML utilities (`xml-utils.ts`, new)

Custom serializer/parser per Q1 — the payload shapes are small,
flat-ish, and fully known, so `xml2js` would be a second dependency
for something ~150 lines covers directly:

- `serializeToXml(payload, rootElement)` — walks own properties
  recursively; a plain object becomes a nested element, an array
  repeats a singular tag per entry (`items` → `<item>`, or `item` when
  the key doesn't end in `s`), and everything else becomes escaped
  text content. `undefined` properties are skipped so optional fields
  don't emit empty tags.
- `parseXmlResponse(xml)` — a regex walk (no dependency, no DOM), not
  a full XML parser: it flattens every leaf element (one with no
  further nested tags) into a `Record<string, string>` keyed by tag
  name, skipping container elements but still descending into them.
  A `<Res Code="...">` root additionally exposes the attribute as
  `code`.
- `extractInvoiceNumberFromXml` / `extractQrCodeFromXml` — the same
  casing-tolerant lookups Phase 27 built for JSON (`invoiceNumber`,
  `InvoiceNumber`, `receiptNumber`, `ReceiptNumber` /
  `qrCode`, `QrCode`, `qr_code` per Q2), now reading the flattened XML
  record instead. Phase 27's JSON-shaped `CloseReceiptResponse` type
  and its local `extractInvoiceNumber`/`extractQrCode` functions in
  `real-etims-provider.ts` were removed as redundant — they operated
  on a JSON shape the device never actually returns.

## 3. HTTP client (`http-client.ts`)

`postJson<T>` was replaced with `postXml(client, path, rootElement, payload)`:
serializes via `serializeToXml`, posts with `Content-Type: text/xml`,
and parses the (string) response body with `parseXmlResponse` instead
of trusting `response.data` as already-structured JSON. Timeout and
the non-2xx/network error handling are unchanged in shape;
`describeFiscalHttpError` additionally tries to parse an XML error
body (`<Res Code="...">`) out of a non-2xx response for a cleaner
message, falling back to the old raw-stringify behavior when the body
isn't one.

## 4. Provider payloads (`real-etims-provider.ts`)

Every device call now goes through `postXml` with an explicit root
element matching its endpoint's purpose (`OpenInvoice`, `SellPLU`,
`CloseReceipt`, `CancelReceipt`, `OpenCreditNote`) instead of
`postJson`. The payload *field construction* — `buildOpenInvoicePayload`,
`buildSellPluPayload`, the `CloseReceipt` fields — is unchanged from
Phase 3/5/25; only the wire format changed, per rule 1.

Two deliberate deviations from the brief's illustrative XML examples,
both preserving working behavior over an example that wasn't backed
by a bug report:

- **`receiptType` stays `'INVOICE'`**, not the brief's example value
  `'Brief'`. `'Brief'` isn't a documented KRA/eTIMS receipt type and
  changing it isn't what fixes error 63 (the missing XML format was);
  swapping it on the strength of one illustrative example would be an
  unreviewed behavior change to the actual fiscal classification of
  every receipt.
- **`OpenCreditNote`/rollback payload field names stay
  `referenceInvoiceNumber` (cancelInvoice) and empty-body (rollback)**,
  not the brief's single unified `<CancelReceipt><receiptNumber>...`
  shape — those are two different endpoints for two different
  situations (cancelling a *closed* invoice by number vs. voiding a
  *still-open, never-closed* receipt that has no invoice number yet),
  and the existing field name is the one already validated in earlier
  phases. Each keeps its own endpoint-matching root element
  (`OpenCreditNote` / `CancelReceipt`) instead of sharing one.

## 5. Device-level error detection

A ZFP-style error can arrive as a 2xx HTTP response with the failure
encoded in the body (`<Res Code="63"><Err><Message>...</Message></Err></Res>`),
which `postXml` alone can't see as a failure — only the caller knows
which fields mean "the device rejected this." A new
`checkDeviceResponse` helper wraps every `postXml` result in
`submitInvoice`/`cancelInvoice`: when the parsed response's `code`
field is present and not `'0'`, it converts an HTTP-successful
`ServiceResult` into a failed one reading
`Fiscal device error (Code 63): Data at the root level is invalid`,
using the parsed `Message`. Applied uniformly to `OpenInvoice`,
`SellPLU`, `CloseReceipt`, `CancelReceipt`, and `OpenCreditNote` so a
device-level rejection at any step surfaces (and, for `SellPLU`/
`CloseReceipt`, still triggers the existing rollback) exactly like a
transport-level failure always did.

## 6. Testing

- `tests/xmlUtils.test.ts` (new, 19 tests) — `serializeToXml` against
  flat objects, nested objects, arrays, numbers/booleans, `undefined`
  omission, and special-character escaping; `parseXmlResponse` against
  flat and one-level-nested success bodies, the `Res Code`/`Message`
  error shape, entity unescaping, and an empty response; both
  extraction helpers against every casing variant.
- `tests/realEtimsProvider.test.ts` — every mocked response is now an
  XML string; payload assertions check the serialized XML body
  instead of a JS object. Added: a content-type/shape smoke test
  across every call, an exact-string check of the `OpenInvoice`/
  `SellPLU`/`CloseReceipt` XML bodies, an XML `<Res Code="63">`
  end-to-end failure case on `submitInvoice`, and the equivalent for
  `cancelInvoice`'s manual-fallback path. All prior JSON-era invoice-
  number-casing tests carried over, translated to XML responses.

## 7. Verification

- `npm run typecheck` — clean (both `node` and `web` projects).
- `npm test` — 534/534 passing (511 prior + 23 new: 19
  `xmlUtils.test.ts` + 4 `realEtimsProvider.test.ts`).
