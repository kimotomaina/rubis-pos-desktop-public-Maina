# Phase 34 — Per-Integration Mock/Real Switches, Default to Mock

**Date:** 2026-08-31 · **Branch:** `main` · **Previous:** [Phase 33](./phase-33.md)

## 1. Objective

A request came in reporting `VITE_USE_MOCK_INTEGRATIONS=true` in `.env`
with logs still showing `RealFiscalizationProvider` being instantiated.
The request's diagnosis — that `dotenv` wasn't loaded in the main
process — didn't hold up: `src/main/index.ts` already calls
`loadEnvFile()` (from `dotenv`) at the very top of the file, before any
other logic, and `dotenv` is already a runtime `dependency` (not
`devDependency`) in `package.json`, wired for both dev and packaged
builds (a `.env` copied to `resourcesPath` via electron-builder's
`extraResources`). The real cause was a Phase-9-era design decision,
documented in a comment at the old `index.ts:409-421`:
`fiscalizationProvider` was **hardcoded** to always construct
`RealFiscalizationProvider`, deliberately ignoring
`VITE_USE_MOCK_INTEGRATIONS` so eTIMS could always be exercised against
a real device regardless of that flag.

Given that Phases 28–33 spent considerable effort chasing a real ZFP
integration that turned out to need device-side GUI configuration this
codebase can't reach, the request evolved into: give each integration
its own mock/real switch, defaulting to mock, so a fresh `.env` never
accidentally drives checkout at a real Shopify-adjacent integration or
physical fiscal device.

## 2. Changes (`src/main/index.ts`)

- Replaced the single `VITE_USE_MOCK_INTEGRATIONS` flag with two
  independent ones: `VITE_USE_MOCK_MPESA` and `VITE_USE_MOCK_ETIMS`.
- Both **default to mock** — `!== 'false'` rather than `=== 'true'` —
  so an unset or misspelled value stays safely mocked instead of
  silently falling through to a real integration.
- `mockEtimsEnabled` now actually selects the provider class:
  ```ts
  const fiscalizationProvider: FiscalizationProvider = mockEtimsEnabled
    ? new MockFiscalizationProvider()
    : new RealFiscalizationProvider({ ... })
  ```
  This is the behavioral fix — eTIMS fiscalization is now genuinely
  mockable, which it never was before this phase.
- `mockMpesaEnabled` keeps its prior meaning (gates whether checkout
  verifies a manually-entered M-Pesa code at all) since no real
  `DarajaMpesaProvider` exists yet to switch to — `mpesaProvider` is
  still always `MockMpesaProvider`. Documented explicitly in the
  updated comment so this isn't mistaken for the same kind of gating
  `mockEtimsEnabled` does.
- Startup log replaced: now prints `mockMpesaEnabled`/`mockEtimsEnabled`
  and which fiscalization provider class was chosen (with its
  `baseUrl`/`endpoints` only when real).
- The checkout handler's `[DEBUG-ETIMS] 1. ...` log updated from
  printing the removed raw `VITE_USE_MOCK_INTEGRATIONS` env var to
  printing both resolved booleans.

## 3. Configuration files

- **`.env`** — `VITE_USE_MOCK_INTEGRATIONS=true` replaced with
  `VITE_USE_MOCK_MPESA=true` / `VITE_USE_MOCK_ETIMS=true`.
- **`.env.example`** — same split, with an updated comment block
  explaining the default-to-mock semantics and what each flag actually
  controls.

## 4. Testing

- `tests/etims.test.ts` exercises `MockFiscalizationProvider` directly
  and was unaffected by the `index.ts` wiring change.
- No test exercised `index.ts`'s provider-construction branch directly
  (it's wired at app startup, outside the IPC-handler-level test
  surface this suite covers), so no test needed updating for the new
  branch itself.

## 5. Verification

- `npm test` — 535/535 passing (42 files), no regressions.
- `npx tsc --noEmit -p tsconfig.node.json` — no new errors (only the
  pre-existing cross-project `TS6307` noise already confirmed
  unrelated in Phase 28).

## 6. Follow-ups

- With `VITE_USE_MOCK_ETIMS` defaulting to mock, live ZFP device
  testing now requires explicitly setting `VITE_USE_MOCK_ETIMS=false`
  — worth calling out to whoever picks up live fiscalization testing
  next, since the default changed out from under the Phase 28–33 test
  setup.
- Carried from Phase 33: the physical fiscal device's IP/port/password
  still need to be configured directly in the ZFPLabServer desktop
  application before real fiscalization will work at all.
- Carried from Phase 30: confirm live whether the split
  `openInvoice`/`openInvoiceWithPin` endpoint paths matter now that
  both send the same `Name` attribute.
- Carried from Phase 28: confirm the full invoice round trip returns a
  real `invoiceNumber`/QR code; the "synced" vs "queued-offline"
  receipt trade-off; the shadowed `etimsConfig` local in
  `orders:checkout`.
- Unrelated, noticed in passing: `.env` has a real-looking Shopify
  Admin API token committed in plaintext. Not addressed here — flagged
  for the user to rotate/gitignore as they see fit.
