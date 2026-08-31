# Phase 30 — `OpenInvoice` Command Name Correction

**Date:** 2026-08-31 · **Branch:** `main` · **Previous:** [Phase 29](./phase-29.md)

## 1. Objective

With Phase 29's `<Request Name="...">` casing fix in place, the ZFP
server parsed the envelope successfully — no more Code 51 syntax
rejections — but returned:

```
Code="10", Type="ServDefMissing"
Message="Command 'OpenInvoiceWithCustomerData' not found in server definitions"
```

Per the SDK profile (`ETIMS_Integration_Phase1_Profile.md`),
`OpenInvoiceWithCustomerData` was never a real server command — a
naming assumption carried since Phase 3/25 that nothing had
contradicted until now. The documented command is
`OpenInvoiceWithFreeCustomerData` for **both** B2C and B2B opens; the
device determines B2B status solely from whether `taxpayerPin` is
present in the payload, not from which command name was sent.

## 2. Fix (`src/main/services/integrations/real-etims-provider.ts`)

`resolveOpenInvoiceCommandName` no longer branches on `buyerPin` — it
always returns `'OpenInvoiceWithFreeCustomerData'`:

```
Before (B2B): <Request Name="OpenInvoiceWithCustomerData">...<taxpayerPin>...</Request>
Before (B2C): <Request Name="OpenInvoice">...<buyerPin></buyerPin></Request>
After  (both): <Request Name="OpenInvoiceWithFreeCustomerData">...</Request>
```

`buildOpenInvoicePayload` (unchanged) still emits `taxpayerPin` for a
non-blank `buyerPin` and an empty `buyerPin` field otherwise — that
payload branching is what the device actually reads to distinguish
B2B from B2C, per the SDK profile.

**Deliberately left unchanged, flagged as a follow-up:**
`resolveOpenInvoiceEndpoint` still routes a B2B request's HTTP call to
`endpoints.openInvoiceWithPin` (`/OpenInvoiceWithCustomerData` by
default) and a B2C request to `endpoints.openInvoice`
(`/OpenInvoiceWithFreeCustomerData`) — two different URLs now carrying
the *same* `Name` attribute in the body. The evidence from Phases 28–30
(Code 51 and Code 10 both came from parsing the request body, with no
sign of URL-based routing) suggests the device dispatches purely on
the `Name` attribute and the URL path is close to irrelevant, but this
was out of today's explicit scope and hasn't been confirmed live. See
§5.

## 3. Testing (`tests/realEtimsProvider.test.ts`)

- "serializes the OpenInvoice payload as a `<Request Name="OpenInvoiceWithFreeCustomerData">` envelope" (renamed from `"...OpenInvoice">`) — B2C command name updated.
- "submits a B2C invoice via the free-customer endpoint when the PIN is blank" — envelope assertion updated to `OpenInvoiceWithFreeCustomerData`; endpoint-path and `taxpayerPin`-absence assertions unchanged.
- "submits a B2B invoice with the customer PIN via `openInvoiceWithPin`" — envelope assertion updated to `OpenInvoiceWithFreeCustomerData`; the endpoint-path assertion (still `openInvoiceWithPin`) and the `<taxpayerPin>` payload assertion are unchanged, confirming the PIN still flows into the body under the single unified command name.

## 4. Verification

- `npm test` — 535/535 passing (42 files), no regressions.
- Live re-verification against the running ZFPLabServer is the
  remaining step to confirm `Code="0"` on `OpenInvoiceWithFreeCustomerData`
  for both a B2C and a B2B checkout.

## 5. Follow-ups

- Confirm live whether the split `openInvoice`/`openInvoiceWithPin`
  endpoint paths matter at all now that both send the identical `Name`
  attribute — if the device only dispatches on the body, collapsing
  `resolveOpenInvoiceEndpoint` to a single endpoint would remove a
  now-fictitious B2B/B2C URL distinction. Left alone this phase since
  it wasn't part of the reported error and endpoint routing hasn't
  been shown to be broken.
- Carried from Phase 29: confirm the full Open → Sell → Close sequence
  returns a real `invoiceNumber`/QR code end to end; the
  "synced" vs "queued-offline" receipt trade-off from Phase 28; the
  shadowed `etimsConfig` local in `orders:checkout`.
