# Phase 29 — `Request` Envelope Attribute Casing Correction

**Date:** 2026-08-31 · **Branch:** `main` · **Previous:** [Phase 28](./phase-28.md)

## 1. Objective

Phase 28 fixed the checkout stall and, based on live device evidence,
switched the `Request` envelope's dispatch attribute from `name` to
`command` — reasoning that the device's `Code 51: command attribute
name not found` couldn't mean "attribute missing" once an attribute
was confirmed present. That swap was still wrong: further live testing
against the Tremol ZFP server confirmed the same Code 51 rejection
persisted with `command=` too. The attribute name was never the
problem — its **casing** was. The server's XML schema is
case-sensitive and expects the attribute literally as `Name`, capital
N. Neither `name` nor `command` (both lowercase) satisfied it.

## 2. Fix (`src/main/services/integrations/xml-utils.ts`)

`serializeToXml` now wraps every request in
`<Request Name="commandName">...</Request>`:

```
Phase 27.2: <Request name="OpenInvoiceWithCustomerData">...</Request>
Phase 28:   <Request command="OpenInvoiceWithCustomerData">...</Request>
Phase 29:   <Request Name="OpenInvoiceWithCustomerData">...</Request>
```

No other part of the envelope, payload field construction, or command
names changed. This applies to every device call uniformly
(`OpenInvoice`, `OpenInvoiceWithCustomerData`, `SellPLU`,
`CloseReceipt`, `CancelReceipt`, `OpenCreditNote`) since all of them
serialize through this one function.

## 3. Testing

- `tests/xmlUtils.test.ts` — every `serializeToXml` assertion updated
  from `<Request command="...">` to `<Request Name="...">`.
- `tests/realEtimsProvider.test.ts` — same envelope-attribute update
  across all `OpenInvoice`/`SellPLU`/`CloseReceipt`/
  `OpenInvoiceWithCustomerData` assertions. No other assertions
  (headers, timeout, payload fields) changed.

## 4. Verification

- `npm test` — 535/535 passing (42 files), no regressions.
- Live re-verification against the running ZFPLabServer is the
  remaining step to confirm `Code="0"` on `OpenInvoiceWithCustomerData`
  instead of Code 51.

## 5. Follow-ups (carried from Phase 28, still open)

- Confirm the full Open → Sell → Close sequence returns a real
  `invoiceNumber`/QR code end to end now that the envelope attribute
  is corrected; capture the actual response shape if extraction still
  comes up empty.
- Decide whether the "synced" vs "queued-offline" receipt trade-off
  from Phase 28 §2 needs a bounded-wait compromise instead of pure
  fire-and-forget on the Shopify sync tick.
- The shadowed `etimsConfig` local in `orders:checkout` (Phase 28 §7)
  still means an eTIMS base-URL change in Admin > Integrations won't
  take effect until app restart.
