# Phase 45 — Remote Tremol TSL Integration & Configurable Admin UI

## Summary

Switched the eTIMS fiscalization integration from a locally installed
fiscal device server (ZFPLabServer) to the remote Tremol TSL (Tax
Service Layer) service, and made the connection parameters (service
path, device IP, device port, password) fully configurable from the
Admin screen's Integrations tab.

## Changes

- `src/renderer/src/lib/etimsConfig.ts` — `DEFAULT_ETIMS_BASE_URL` now
  points at `http://154.79.253.241:8080/TSL/kra`; added
  `DEFAULT_ETIMS_DEVICE_IP` (`154.79.253.236`) and
  `DEFAULT_ETIMS_DEVICE_PORT` (`8000`).
- `src/main/services/integrations/http-client.ts` — default base URL
  updated to match; error/doc text no longer references ZFPLabServer.
- `src/main/services/integrations/real-etims-provider.ts` —
  `RealFiscalizationProvider` now opens every `submitInvoice` call
  with a `_Settings` request (`<ip>`, `<port>`, `<password>`) before
  `OpenInvoice`, so the shared TSL service knows which physical device
  to drive. Added `deviceIp`/`devicePort` options (with the production
  defaults above) and a `settings` entry in `FiscalEndpointPaths`
  (`/_Settings`, overridable like the other endpoints).
- `src/main/index.ts` — reads `deviceIp`/`devicePort` out of the
  `etims` integration config and passes them to
  `RealFiscalizationProvider`; updated startup/connectivity log text
  and the connectivity-monitor fallback URL.
- `src/renderer/src/components/AdminScreen.tsx` — Integrations tab's
  eTIMS section: "Server URL" renamed to "Service Path", added
  "Device IP" and "Device Port" fields, all bound to state and saved
  through the existing `setIntegrationConfig('etims', …)` flow.
- Tests updated: `tests/etimsConfig.test.ts` (new defaults),
  `tests/realEtimsProvider.test.ts` (every call sequence now expects
  the leading `_Settings` call; added tests for the `_Settings`
  payload content, its device-error handling, and default IP/port
  fallback).

## Verification

- `npm test` — 621/621 passing.
- `npm run typecheck` — clean (node + web).
