# Phase 46 — Remove `_Settings` Step for Remote TSL Service

## Summary

Phase 45's `_Settings` request (sent as Step 1 of a 4-step flow) turned
out to be wrong for the actual deployment: the remote Tremol TSL
service at `http://154.79.253.241:8080/TSL/kra` is pre-configured
server-side with the fiscal device it drives (IP/port/password) and
has no `_Settings`-equivalent HTTP endpoint — sending it produced an
HTTP 404. Reverted `RealFiscalizationProvider` to the original 3-step
`OpenInvoice` → `SellPLU` → `CloseReceipt` flow.

## Changes

- `src/main/services/integrations/real-etims-provider.ts` — removed
  the `_Settings` request, `buildSettingsPayload`, the `settings` entry
  in `FiscalEndpointPaths`/`DEFAULT_FISCAL_ENDPOINTS`, and the now-dead
  `DEFAULT_DEVICE_IP`/`DEFAULT_DEVICE_PORT` constants and instance
  fields. `submitInvoice` step logs renumbered `Step 1/3` → `Step 3/3`.
  `deviceIp`/`devicePort` remain accepted on
  `RealFiscalizationProviderOptions` (so the Admin UI's fields still
  round-trip through `main/index.ts`) but are documented as
  informational only — never read by the class, never sent in any HTTP
  payload.
- `src/main/index.ts` — startup debug log now labels `deviceIp`/
  `devicePort` as informational-only, not sent to the TSL service.
- `src/renderer/src/components/AdminScreen.tsx` — added a helper note
  under the Device IP/Port fields: "Configured on the remote TSL
  server. Not sent in API requests."
- `tests/realEtimsProvider.test.ts` — removed all `_Settings`
  assertions/mocks; happy-path and failure-path call sequences are
  back to 3 steps (4 HTTP calls: 1 OpenInvoice + 2 SellPLU + 1
  CloseReceipt in the sample fixture); added a test asserting
  `deviceIp`/`devicePort`/`password` never appear in any HTTP payload.

`src/renderer/src/lib/etimsConfig.ts` and `tests/etimsConfig.test.ts`
needed no changes — the renderer's `DEFAULT_ETIMS_ENDPOINTS` never
included a `settings` entry.

## Verification

- `npm test` — 619/619 passing.
- `npm run typecheck` — clean (node + web).
