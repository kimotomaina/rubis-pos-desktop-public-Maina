# Phase 55 Completion Report — G03 Nine-Step Workflow, Error Handlers & Sanitization

## Summary

Rebuilt `RealFiscalizationProvider.submitInvoice` to run the TSL G03
Integration Programming Manual's invoice workflow end-to-end, added a
fiscal text sanitizer applied to every free-text field sent to the
device, added a device error-code translation table surfaced through
`ServiceResult.error`, and wired VAT class / HS classification fields
through the checkout → fiscal-line mapping. Shopify sync, M-Pesa, and
the offline `sync_queue` fallback are unchanged.

## Files changed

- `src/main/services/integrations/fiscal-sanitize.ts` (new) —
  `sanitizeFiscalText(value, maxLen)`.
- `src/main/services/integrations/real-etims-provider.ts` — rebuilt
  `submitInvoice` as the 7-step G03 sequence; added
  `mapFiscalDeviceError`; added `readStatus`; sanitizes every free-text
  field; new `FiscalEndpointPaths` entries (`readStatus`,
  `readCurrentReceiptInfo`, `readDateTime`); `SellPLU` renamed to the
  spec's `SellPLUfromExtDB` and now omits `HSCode`/`HSName` for VAT
  class `A`.
- `src/main/services/integrations/http-client.ts` — `createFiscalHttpClient`
  gained `initMode: 'none' | 'query-params' | 'headers'` (default
  `'query-params'`); warns once if no password is configured.
- `src/main/index.ts` — checkout → `FiscalInvoiceLine` mapping (both
  the immediate-fiscalization path and the failure/queue path) now
  passes `vatClass`/`hsCode`/`hsName`, defaulting to `'A'`/`''`/`''`.
- `src/main/lib/ipcValidator.ts` — `cartItemSchema` accepts optional
  `vatClass`/`hsCode`/`hsName`.
- `src/renderer/src/types/shopify.ts` — `CartItem` gained the same
  three optional fields.
- `tests/realEtimsProvider.test.ts` — rewritten for the 7-step flow
  (51 tests).
- `tests/fiscalSanitize.test.ts` (new, 7 tests).

## The 7-step workflow (`submitInvoice`)

1. **Settings/Initialize** — logs the resolved `initMode`/deviceIp/
   devicePort and warns if no password is configured. This step makes
   no network call of its own: `deviceIp`/`devicePort`/`password` are
   already attached to every request by `createFiscalHttpClient`
   per `initMode`, and the G03 manual gives no dedicated "Settings"
   HTTP command — inventing one against a real, unconfirmed device
   contract seemed riskier than logging the resolved config. `initMode`
   is real and testable today (it controls whether those three values
   ride as query params, headers, both, or neither on every call); if
   the TSL contract turns out to need an actual initialization POST,
   step 1 is the place to add it.
2. **ReadStatus** — sends `<Request Name="ReadStatus"></Request>`.
   Reads `Connected`/`Fiscalized` (fails closed if either is `'0'`)
   and `OptionIsReceiptOpened`/`ReceiptOpened` (triggers a recovery
   `CancelReceipt` before opening a new invoice). Per the confirmed
   fallback, an unrecognized response shape with no error code is
   treated as connected — `postXml`'s existing debug logging captures
   the raw body for diagnosis.
3. **OpenInvoiceWithFreeCustomerData** — unchanged raw-XML payload
   (three sibling `<reserved>` tags), now sanitized. A Code 52
   ("already opened") response triggers one `CancelReceipt` +
   retry; any other failure returns immediately.
4. **SellPLUfromExtDB** per line — `HSCode`/`HSName` included only
   when `OptionVATClass !== 'A'`.
5. **ReadCurrentReceiptInfo** — the "READ VAT" gate. Requires
   `OptionIsReceiptOpened === '1'` and a non-zero `SubTotal`;
   otherwise cancels and fails.
6. **CloseReceipt** — unchanged extraction of `InvoiceNum`/`QRcode`.
7. **ReadDateTime** — best-effort; a failed/missing response falls
   back to `new Date().toISOString()` without undoing the already-closed
   receipt.

Each step logs `[ETIMS-G03] Step N/7: <label> +<ms>ms`.

## Error handling (`mapFiscalDeviceError`)

Maps device codes `52/59/58/60/61/62/0` to the manual's friendly
messages (52 marked retryable, driving the OpenInvoice retry); any
other code falls back to the device's own raw message, preserving the
existing `Fiscal device error (Code N): <message>` format.

## Sanitization

`sanitizeFiscalText` strips everything outside `[A-Za-z0-9 .,-]`,
collapses whitespace, trims, and truncates. Applied to `CompanyName`
(30), `ClientPINnum` (14), `HeadQuarters`/`Address`/
`PostalCodeAndCity`/`ExemptionNum` (30), `TraderSystemInvNum` (15),
`NamePLU` (36), and `HSName` (20).

## VAT/HS plumbing — scope note

`FiscalInvoiceLine` already carried `vatClass`/`hsCode`/`hsName`/
`measureUnit` from an earlier phase, so no change was needed there.
The checkout mapping in `index.ts` now reads these off the incoming
cart item (`item.vatClass || 'A'`, etc.), and `cartItemSchema`/
`CartItem` accept them end-to-end from the renderer through to the
fiscal payload.

**What's not included**: an actual Shopify GraphQL query for the
`rubis.vat_class`/`rubis.hs_code`/`rubis.hs_name` variant metafields.
`ShopifyVariant`/`ProductSummary` currently carry no metafield data at
all — adding that means a GraphQL query change, a product-cache schema
change, and a renderer/store change to carry it from catalog fetch
through to the cart, which is a distinct feature outside this fiscal-
engine phase's file list. The plumbing accepts the fields today if
supplied; wiring the actual Shopify fetch is a follow-up.

## Test results

- `npm test`: **51 test files, 677 tests, 100% passing.**
- `npm run typecheck` (node + web): clean, no errors.
