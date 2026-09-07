# Phase 47 — TSL Single-Endpoint Routing & Code Audit

## Summary

The remote Tremol TSL service is a single HTTP endpoint
(`http://154.79.253.241:8080/TSL/kra`) that routes internally on the
XML body's `<Request Name="...">` attribute — unlike the old local
ZFPLabServer, which mapped each command to its own URL path
(`/OpenInvoice`, `/CloseReceipt`, ...). Appending a command name to
the path (e.g. `.../TSL/kra/OpenInvoiceWithCustomerData`) 404s against
Tomcat. Every fiscal HTTP call now posts to the bare base URL.

## Changes

- `src/main/services/integrations/real-etims-provider.ts` —
  `DEFAULT_FISCAL_ENDPOINTS` now maps every command (`openInvoice`,
  `openInvoiceWithPin`, `sellPLU`, `closeReceipt`, `cancelReceipt`,
  `openCreditNote`) to `''` instead of a command-specific path. The
  `endpoints` override mechanism is unchanged, so a differently routed
  deployment can still supply per-command paths.
- `src/main/services/integrations/http-client.ts` —
  - `createFiscalHttpClient` now strips a trailing slash from the
    configured base URL (`normalizeBaseUrl`), so a single-endpoint POST
    with an empty request path lands on exactly that URL rather than
    that URL plus a stray `/`.
  - Both the instance defaults and `postXml`'s per-request header
    override now set `Accept: 'text/xml, application/xml'` alongside
    the existing `Content-Type: text/xml`, since Tomcat can be strict
    about both.
  - `postXml`'s doc comment now explains the single-endpoint routing
    and that its `path` parameter is almost always `''`.
- `src/renderer/src/lib/etimsConfig.ts` — `DEFAULT_ETIMS_ENDPOINTS`
  mirrored to the same all-`''` shape, keeping it in sync with the
  main-process defaults per its existing "duplicated, not imported"
  comment.
- No XML payload fields, request bodies, or the `<Request Name="...">`
  envelope structure were touched — per Phase 47's Rule 1, these were
  left exactly as they were.

## Task 3 audit — not executed

The prompt asked to cross-reference payloads against a Tremol ZFP
spec file (`Pasted_Text_1788150689504.txt`) said to be in "the
knowledge base." I searched this project's entire working tree and
found no such file, so I have no source to verify field-level claims
against (e.g. that `OpenInvoiceWithFreeCustomerData` needs a
`CompanyName`/`ClientPINnum`/`TraderSystemInvNum`, or that `SellPLU`
should use `NamePLU`/`OptionVATClass`/`Price`/`Quantity` instead of
the current `pluCode`/`description`/`quantity`/`unitPrice`/`vatClass`
field names). Adding fields on that basis would be guessing at an
external vendor spec I can't see — and Phase 47's own Rule 1
("Preserve XML Payloads... They are correct") explicitly forbids
changing the structure/fields anyway, since these are the exact
payloads already confirmed working against the live device in earlier
phases.

If you have the spec file, share its contents (or its path) and I'll
do the field-by-field comparison for real; otherwise the current
payload shapes are left untouched as directed.

## Verification

- `npm test` — 627/627 passing (added `tests/http-client.test.ts`,
  8 new tests; `tests/realEtimsProvider.test.ts` rewritten to
  differentiate mocked calls by the XML body's command name instead of
  the (now-identical) URL path).
- `npm run typecheck` — clean (node + web).
