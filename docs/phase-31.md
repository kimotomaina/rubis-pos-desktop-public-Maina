# Phase 31 — `settings` Command for Device Connection Parameters

**Date:** 2026-08-31 · **Branch:** `main` · **Previous:** [Phase 30](./phase-30.md)

## 1. Objective

With Phase 30's command-name fix in place, `OpenInvoiceWithFreeCustomerData`
was recognized by the ZFP Lab Server, but every call was rejected with:

```
Code="53", Type="ClientSettingsNotInitialized"
Message="First use settings() command to set connection parameters"
```

The ZFP Lab Server is a local middleware fronting the physical fiscal
device — it needs the device's IP, port, and password before it can
relay any fiscal command to it. This phase adds that `settings` call
as a new first step of `submitInvoice`, and plumbs the three new
config fields (`deviceIp`, `devicePort`, `devicePassword`) from Admin
> Integrations down to the provider.

## 2. Provider changes (`src/main/services/integrations/real-etims-provider.ts`)

- `FiscalEndpointPaths` gained a `settings` path, defaulting to
  `/settings` in `DEFAULT_FISCAL_ENDPOINTS` — consistent with the
  existing pattern where a command's default endpoint path mirrors its
  `Name` attribute.
- `RealFiscalizationProviderOptions` gained `deviceIp` (default
  `'127.0.0.1'`), `devicePort` (default `'9100'`), and
  `devicePassword` (default: falls back to the existing `password`
  option, then `'0'`) — `devicePassword` reuses `password` by default
  since most deployments only have one device password to configure,
  not two.
- New private `buildSettingsPayload()` builds
  `{ ip, port, password }` from those three fields.
- `submitInvoice` now runs `settings` as **Step 1/4**, before
  `OpenInvoice` (now Step 2/4), `SellPLU` (Step 3/4), and
  `CloseReceipt` (Step 4/4). A failed `settings` call returns
  immediately — no rollback is attempted, since no receipt has been
  opened yet. Per the SDK's implication that the server may not
  persist settings between requests, `settings` is sent on every
  `submitInvoice` call rather than once at provider construction — the
  safest, most idempotent option, at the cost of one extra HTTP round
  trip per invoice.
- All step-log messages renumbered from `Step N/3` to `Step N/4`
  accordingly.

## 3. Configuration plumbing

- **`src/main/index.ts`** — the `etimsConfig` shape read via
  `db.getIntegrationConfig('etims')` gained `deviceIp`, `devicePort`,
  `devicePassword`, all threaded into the `RealFiscalizationProvider`
  constructor call.
- **`src/renderer/src/lib/etimsConfig.ts`** — added
  `DEFAULT_ETIMS_DEVICE_IP` (`'127.0.0.1'`) and
  `DEFAULT_ETIMS_DEVICE_PORT` (`'9100'`); `DEFAULT_ETIMS_ENDPOINTS`
  gained the `settings: '/settings'` entry, mirroring the provider's
  defaults.
- **`src/renderer/src/components/AdminScreen.tsx`** — added `Device
  IP` and `Device Port` fields to the eTIMS integration form (state,
  load-from-config, save-to-config, and the two new inputs in the
  form grid). The existing password field's label was changed from
  "Device Password" to "Fiscal Device Password" to disambiguate it
  from the new IP/port fields once both sit in the same section.

## 4. Testing

- `tests/realEtimsProvider.test.ts` — two new tests: `settings` is
  sent first with the exact configured `ip`/`port`/`password` payload,
  and a failed `settings` call short-circuits before `OpenInvoice`
  (asserting exactly one `post` call). Every existing `calledPaths`
  exact-order assertion across the happy-path, endpoint-override,
  SellPLU-failure, and CloseReceipt-failure tests was updated to
  expect `settings` as the first call. The device-level-error test's
  `toHaveBeenCalledTimes` assertion moved from 1 to 2 (`settings` +
  the failing `OpenInvoice`) accordingly. Tests that locate a call by
  `find`/`filter` on a specific endpoint were unaffected by the new
  leading call.
- `tests/etimsConfig.test.ts` — the "exposes all N default endpoint
  paths" test updated from six to seven paths, including `settings`.

## 5. Verification

- `npm test` — 537/537 passing (42 files; +2 from this phase).
- `npx tsc --noEmit -p tsconfig.node.json` — no new errors (only the
  pre-existing cross-project `TS6307` noise already confirmed
  unrelated in Phase 28).
- Live re-verification against the running ZFPLabServer is the
  remaining step to confirm `Code="0"` on `settings`, followed by a
  clean `OpenInvoiceWithFreeCustomerData` → `SellPLU` →
  `CloseReceipt` round trip.

## 6. Follow-ups

- If live testing shows the server *does* persist settings across
  requests, sending `settings` on every `submitInvoice` call could be
  narrowed to "once per provider instance" or "once per app session"
  to save a round trip per sale — deferred until confirmed, per this
  phase's brief to favor the safest idempotent option.
- Carried from Phase 30: confirm live whether the split
  `openInvoice`/`openInvoiceWithPin` endpoint paths matter at all now
  that both send the same `Name` attribute.
- Carried from Phase 28: confirm the full invoice round trip returns a
  real `invoiceNumber`/QR code; the "synced" vs "queued-offline"
  receipt trade-off; the shadowed `etimsConfig` local in
  `orders:checkout`.
