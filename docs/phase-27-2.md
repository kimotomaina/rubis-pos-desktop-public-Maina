# Phase 27.2 — Fix XML Envelope Structure

**Date:** 2026-08-27 · **Branch:** `main` · **Previous:** [Phase 27.1](./phase-27-1.md)

## 1. Objective

Phase 27.1 switched the wire format from JSON to XML but still sent
the command name as the root element itself (`<OpenInvoice>...`).
The ZFP Lab Server's own console log narrowed the still-failing
error 63 down further: `"E: command attribute name not found"` — the
server dispatches on a `name` attribute on a generic envelope element,
not on the root tag's name. This phase wraps every request in
`<Request name="CommandName">...</Request>`.

## 2. Envelope change (`xml-utils.ts`)

`serializeToXml`'s second parameter is now read as the command name
rather than a literal root tag: it always wraps the serialized fields
in `<Request name="commandName">...</Request>`, with the command name
itself escaped (so a command name containing `&`/`<`/etc. — not
expected in practice, but cheap to guard) doesn't corrupt the
envelope. Per Q1, `<Request>` was used rather than `<Command>` — it's
the more common envelope name for Tremol/ZFP-style HTTP APIs, and
easy to swap in one place if the device rejects it too.

## 3. Provider and HTTP client wiring

`http-client.ts`'s `postXml` parameter was renamed `commandName` (was
`rootElement`) to match its new meaning — no behavioral change beyond
what `serializeToXml` already handles. `createFiscalHttpClient`'s
axios instance also had a stale `Content-Type: application/json`
default left over from before the XML switch (each `postXml` call
already overrides it correctly, so this was cosmetic, not a live bug)
— corrected to `text/xml` while the file was already open for this
change.

`real-etims-provider.ts`'s five device calls already passed
literal command-name strings (`'OpenInvoice'`, `'SellPLU'`,
`'CloseReceipt'`, `'CancelReceipt'`, `'OpenCreditNote'`) as the third
`postXml` argument from Phase 27.1 — those needed no change. The one
exception is the B2B branch: a new `resolveOpenInvoiceCommandName`
(mirroring the existing `resolveOpenInvoiceEndpoint`) now sends
`name="OpenInvoiceWithCustomerData"` for a B2B invoice instead of the
generic `name="OpenInvoice"`, matching the brief's explicit call-out
of that command name and the endpoint it's paired with.

One deviation, flagged for confirmation once the device is reachable
again: the brief's command-name list (`OpenInvoice`, `SellPLU`,
`CloseReceipt`, `CancelReceipt`, `OpenCreditNote`) doesn't match the
endpoint paths' own SDK method names (`OpenInvoiceWithFreeCustomerData`,
`SellPLUfromExtDB`, `OpenCreditNoteWithFreeCustomerData`). It's
plausible the `name` attribute the device actually wants is the exact
SDK method name rather than a shortened form, but the brief was
explicit about the shortened names to use, and changing that guess
again without a fresh error message to react to would be exactly the
kind of unverified swap Phase 27.1 already deviated from once. Kept
the brief's literal names; if the device rejects with a similar
"attribute value not recognized" error next, the fix is a one-line
swap to the endpoint path (minus its leading slash) per command.

## 4. Testing

- `tests/xmlUtils.test.ts` — every `serializeToXml` assertion updated
  to expect the `<Request name="...">` wrapper; added a case escaping
  special characters in the command name itself.
- `tests/realEtimsProvider.test.ts` — the content-type/shape smoke
  test, the `OpenInvoice`/`SellPLU`/`CloseReceipt`/`OpenCreditNote`
  exact-string checks, and the B2B/B2C envelope checks all updated to
  expect `<Request name="...">`; added an explicit assertion that a
  B2B invoice's envelope reads `name="OpenInvoiceWithCustomerData"`.

## 5. Verification

- `npm run typecheck` — clean (both `node` and `web` projects).
- `npm test` — 535/535 passing (534 prior + 1 new).
