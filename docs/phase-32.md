# Phase 32 — `_Settings` Command Name Casing Correction

**Date:** 2026-08-31 · **Branch:** `main` · **Previous:** [Phase 31](./phase-31.md)

## 1. Objective

Phase 31 added a `settings` command sent before every invoice, to
satisfy the ZFP server's `Code 53: ClientSettingsNotInitialized`
requirement. Live testing showed the lowercase `settings` name itself
was rejected:

```
Code="10", Type="ServDefMissing"
Message="Command 'settings' not found in server definitions"
```

The Tremol ZFP HTTP API is case-sensitive on command names (already
established in Phases 29 and 30 for the envelope attribute and
`OpenInvoice` command respectively), and the vendor's own
configuration file is `_Settings.xml` — the documented command name is
`_Settings`, underscore-prefixed and capitalized, not `settings`.

## 2. Fix (`src/main/services/integrations/real-etims-provider.ts`)

- `DEFAULT_FISCAL_ENDPOINTS.settings` changed from `/settings` to
  `/_Settings`, keeping the established pattern of a command's default
  endpoint path mirroring its `Name` attribute.
- The `postXml` call in `submitInvoice`'s Step 1/4 now passes
  `'_Settings'` as the command name instead of `'settings'`.
- All JSDoc/log-string references to the wire command name updated
  from `settings` to `_Settings`; the `FiscalEndpointPaths.settings`
  **field name** (a TypeScript identifier, not a value sent over the
  wire) is intentionally left as-is.

```
Phase 31: <Request Name="settings">...</Request>   → Code 10, ServDefMissing
Phase 32: <Request Name="_Settings">...</Request>
```

No change to the envelope structure, payload field names
(`ip`/`port`/`password`), or the settings-before-every-invoice
behavior from Phase 31.

## 3. Testing

- `tests/realEtimsProvider.test.ts` — the settings-payload test's
  exact-string envelope assertion updated to
  `<Request Name="_Settings">...`. All other assertions reference
  `DEFAULT_FISCAL_ENDPOINTS.settings` symbolically and needed no
  change.
- `tests/etimsConfig.test.ts` — the default-endpoints assertion
  updated to `settings: '/_Settings'`.
- `src/renderer/src/lib/etimsConfig.ts` — `DEFAULT_ETIMS_ENDPOINTS.settings`
  updated to `'/_Settings'` to keep the renderer's mirrored defaults
  in sync with the provider's.

## 4. Verification

- `npm test` — 537/537 passing (42 files), no regressions.
- Live re-verification against the running ZFPLabServer is the
  remaining step to confirm `Code="0"` on `_Settings`, followed by a
  clean `OpenInvoiceWithFreeCustomerData` → `SellPLU` →
  `CloseReceipt` round trip.

## 5. Follow-ups

- If `_Settings` also fails live, `Settings` (capitalized, no
  underscore) is the next documented variant to try per the original
  diagnosis — a one-line change in the same two spots as this phase.
- Carried from Phase 31: confirm whether `_Settings` needs to be sent
  once per session/provider instance rather than on every
  `submitInvoice` call, once the device's persistence behavior is
  observed live.
- Carried from Phase 30: confirm live whether the split
  `openInvoice`/`openInvoiceWithPin` endpoint paths matter now that
  both send the same `Name` attribute.
- Carried from Phase 28: confirm the full invoice round trip returns a
  real `invoiceNumber`/QR code; the "synced" vs "queued-offline"
  receipt trade-off; the shadowed `etimsConfig` local in
  `orders:checkout`.
