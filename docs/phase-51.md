# Phase 51 — Raw XML String Bypass for Duplicate `<reserved>` Tags

## Summary

Phase 49's `reserved1`/`reserved2`/`reserved3` workaround still 404/500'd
because the Java TSL server's deserializer looks for the literal tag
name `reserved` three times, not three distinctly-named tags. A plain
JS object can't hold three same-named keys, so `OpenInvoiceWithFreeCustomerData`
now bypasses the object-based `serializeToXml`/`postXml` path entirely
and is built as a raw XML string.

## Changes

- `src/main/services/integrations/http-client.ts` — added
  `postRawXml(client, path, body)`, which posts a caller-supplied XML
  string as-is (no serialization step). Refactored the shared
  POST/parse/error-translation logic out of `postXml` into a private
  `sendXmlBody` helper so `postXml` and `postRawXml` share it instead
  of duplicating the try/catch block.
- `src/main/services/integrations/real-etims-provider.ts`:
  - Replaced `buildOpenInvoicePayload`/`resolveOpenInvoiceCommandName`
    with `buildOpenInvoiceXml`, which returns the complete
    `<Request Name="OpenInvoiceWithFreeCustomerData">...</Request>`
    string directly, with three literal sibling `<reserved>` tags
    (`1`, `     0` — five spaces then zero — and `0`).
  - `submitInvoice`'s Step 1 now calls `postRawXml` with that string
    instead of `postXml` with a payload object.
  - Added `MAX_COMPANY_NAME_LENGTH` (30) and `MAX_CLIENT_PIN_LENGTH`
    (14) constants; `CompanyName`/`ClientPINnum` are truncated to them
    (and `TraderSystemInvNum` remains capped at 15, per Phase 48)
    before being escaped with `xml-utils.ts`'s `escapeXml` — reused
    rather than reimplemented, since it already covers `<`, `>`, `&`,
    `'`, `"` identically to the escaper in the prompt's snippet.
  - `SellPLU`/`CloseReceipt` were untouched — the duplicate-tag problem
    is unique to `OpenInvoice`'s `reserved` args; those two commands
    have no repeated-tag fields, so the standard object serializer
    still correctly represents them.

## Verification

- `npm test` — 630/630 passing. Added two tests to
  `tests/realEtimsProvider.test.ts`: one asserting the literal
  `<reserved>1</reserved><reserved>     0</reserved><reserved>0</reserved>`
  substring is present (per Task 3's requested assertion style) and
  that no `reserved1`/`reserved2`/`reserved3` remains, and one
  asserting `CompanyName`/`ClientPINnum` truncate to 30/14 characters.
  The existing exact-payload test now expects three `<reserved>` tags
  instead of the numbered ones.
- `npm run typecheck` — clean (node + web).
