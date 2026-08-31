# Phase 36.1 — Mock M-Pesa/eTIMS Report as Disconnected

**Date:** 2026-08-31 · **Branch:** `main` · **Previous:** [Phase 36](./phase-36.md)

## 1. Objective

Phase 36's `mockedConnectivityResult()` reported **connected** for any
mocked integration — M-Pesa, eTIMS, and the mock printer alike — on
the reasoning that "the configured (mock) provider is available."
That's the wrong signal for M-Pesa/eTIMS specifically: mocking those
means there is no real Daraja/fiscal connection at all, so the badge
showing a green "Connected" while running entirely on
`MockFiscalizationProvider`/no real M-Pesa provider was misleading —
it implied a working live integration that doesn't exist. Corrected so
mock mode is now visibly **disconnected** for those two, while the
separate, older `VITE_MOCK_PRINTER` flag (a printer that was never
expected to have a real counterpart — it deliberately logs to the
console) still reports connected.

## 2. Fix (`src/main/services/connectivityMonitor.ts`)

Split the one mock-result helper into two, so the printer's unrelated
mock behavior can't be changed by accident:

- `mockConnectedResult()` — unchanged behavior (connected, zero
  latency), now reserved for the mock printer only.
- `mockDisconnectedResult(message?)` — new; reports `connected: false`
  with an explanatory `error` message (defaults to `"Mock mode enabled
  — not a real connection"`, overridable per integration).

`src/main/index.ts`'s connectivity wiring updated accordingly:

```
Before: mockMpesaEnabled/mockEtimsEnabled → mockedConnectivityResult()  (connected: true)
After:  mockMpesaEnabled/mockEtimsEnabled → mockDisconnectedResult('M-Pesa mock mode enabled' / 'eTIMS mock mode enabled')
        printerSettings.mock             → mockConnectedResult()        (unchanged)
```

## 3. Testing

`tests/connectivityMonitor.test.ts`'s `mockedConnectivityResult`
describe block split into `mockConnectedResult` (unchanged assertion)
and a new `mockDisconnectedResult` block covering the default message
and a custom override.

## 4. Verification

- `npm test` — 557/557 passing (44 files; +2 from this fix).
- `npx tsc --noEmit -p tsconfig.node.json` — no new errors (only the
  pre-existing, unrelated cross-project `TS6307` noise).

## 5. Follow-ups

Carried from Phase 36, unaffected by this fix: Q3's sandbox/production
M-Pesa toggle still doesn't exist (Phase 37); "Test Connection"
re-checks every integration at once; barcode "connected" status still
resets each app restart by design.
