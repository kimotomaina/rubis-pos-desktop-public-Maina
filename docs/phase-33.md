# Phase 33 — Remove Invalid `settings` Step, Revert to 3-Step Flow

**Date:** 2026-08-31 · **Branch:** `main` · **Previous:** [Phase 32](./phase-32.md)

## 1. Objective

Phases 31–32 added a `settings`/`_Settings` HTTP call to satisfy the
ZFP server's `Code 53: ClientSettingsNotInitialized` response, trying
two casing variants — both rejected with `Code 10: ServDefMissing`. A
review of the official ZFP HTTP command list confirmed there is no
`settings`, `Settings`, or `_Settings` command exposed over HTTP at
all. The `Code 53` message ("First use settings() command to set
connection parameters") refers to the ZFPLabServer *desktop GUI*
needing the physical device's IP/port/password configured locally on
that machine — an operational/installation step, not something this
HTTP API can perform. Phases 31–32 were solving a problem that doesn't
have an HTTP-level fix; this phase removes that entire code path and
returns to the working 3-step flow from Phase 30.

## 2. Provider changes (`src/main/services/integrations/real-etims-provider.ts`)

- Removed the `settings` step from `submitInvoice` entirely.
  `OpenInvoice`/`SellPLU`/`CloseReceipt` are back to `Step 1/3`,
  `Step 2/3`, `Step 3/3`.
- Removed `settings` from `FiscalEndpointPaths` and
  `DEFAULT_FISCAL_ENDPOINTS`.
- Removed `deviceIp`/`devicePort`/`devicePassword` from
  `RealFiscalizationProviderOptions`, their private fields, and the
  `buildSettingsPayload()` helper.
- File-level JSDoc rewritten to document *why* no settings call exists
  — recording that `settings`/`Settings`/`_Settings` were each tried
  live and rejected, so a future reader doesn't reintroduce the same
  dead end.

## 3. Configuration cleanup

- **`src/main/index.ts`** — `etimsConfig`'s shape and the
  `RealFiscalizationProvider` constructor call dropped `deviceIp`/
  `devicePort`/`devicePassword`, back to `baseUrl`/`endpoints`/
  `defaultVatClass`/`password` only.
- **`src/renderer/src/lib/etimsConfig.ts`** — removed
  `DEFAULT_ETIMS_DEVICE_IP`/`DEFAULT_ETIMS_DEVICE_PORT` and the
  `settings` entry from `DEFAULT_ETIMS_ENDPOINTS`.
- **`src/renderer/src/components/AdminScreen.tsx`** — removed the
  "Device IP"/"Device Port" form fields (state, load, save, and JSX)
  added in Phase 31; the password field's label reverted from "Fiscal
  Device Password" back to "Device Password" now that there's nothing
  else in the section to disambiguate it from.
- `src/main/services/integrations/etims.ts` needed no change — the
  persisted config shape has only ever lived as an inline type in
  `index.ts`, not in `etims.ts` itself (noted in Phase 31 too).

## 4. Testing

- `tests/realEtimsProvider.test.ts` — deleted the two Phase 31 tests
  exercising the settings call directly (payload correctness,
  settings-failure short-circuit). Every `calledPaths` exact-order
  assertion across the happy-path, B2B/B2C, endpoint-override, and
  both CancelReceipt-rollback tests had its leading `settings` entry
  removed. The device-level-error test's `toHaveBeenCalledTimes`
  assertion reverted from 2 back to 1.
- `tests/etimsConfig.test.ts` — the default-endpoints test reverted to
  six paths (removed `settings`).

## 5. Verification

- `npm test` — 535/535 passing (42 files; back to the Phase 30
  baseline count, having removed the 2 tests Phase 31 added).
- `npx tsc --noEmit -p tsconfig.node.json` — no new errors (only the
  pre-existing cross-project `TS6307` noise already confirmed
  unrelated in Phase 28).
- Live re-verification against the running ZFPLabServer is the
  remaining step: confirm `OpenInvoiceWithFreeCustomerData` succeeds
  once the ZFPLabServer GUI itself has the device IP/port/password
  configured locally (outside this codebase's control), without any
  HTTP settings call preceding it.

## 6. Follow-ups

- **Operational, not code**: the physical fiscal device's IP/port/
  password must be configured directly in the ZFPLabServer desktop
  application on the till machine before fiscalization will work —
  this is now understood to be a one-time local setup step, not
  something `RealFiscalizationProvider` can or should automate over
  HTTP.
- Carried from Phase 30: confirm live whether the split
  `openInvoice`/`openInvoiceWithPin` endpoint paths matter now that
  both send the same `Name` attribute.
- Carried from Phase 28: confirm the full invoice round trip returns a
  real `invoiceNumber`/QR code; the "synced" vs "queued-offline"
  receipt trade-off; the shadowed `etimsConfig` local in
  `orders:checkout`.
