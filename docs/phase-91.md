# Phase 91 — Go-live prep, Part 3: admin-configured, human-readable variables

Closes blocker 3 from `docs/phase-89.md` (the device password's three
exposures) and rewrites the fiscal device form so a branch manager can
set it up from the screen alone. Verified on the real app, not just in
tests — see **On-screen verification** below.

## 1. The password: three exposures, three fixes

The audit found the device TCP password stored in plaintext, returned to
the renderer over IPC, and pre-filled into a form field. All three are
closed.

**Storage.** New `ETIMS_DEVICE_PASSWORD_ACCOUNT = 'etims-device-password'`
in `secretStore.ts`, and a new `src/main/services/etimsCredentials.ts`
whose `resolveEtimsDevicePassword({ keytar, db })` mirrors
`resolveShopifyToken`'s shape: vault first, then a **one-time migration**
of any legacy plaintext `password` on the `integrations` row into the
vault, deleting the key from the row. An install that predates this heals
itself on first launch with nobody retyping anything. There is no third
tier — no `.env` fallback, no default (see Part 4).

Kept separate from `etimsSetup.ts` deliberately: that module answers
"may the gate lift", this one answers "where does the secret come from",
and needs the vault and database that one does not.

**IPC.** `redactIntegrationConfig` (same module) strips `password` from
any config before it crosses to the renderer, and
`integrations:get-config` now goes through it. It is provider-agnostic,
so an M-Pesa-shaped config is covered too.

**The form.** The password box is never populated from stored state. It
shows `•••••••• (saved)` or `Required`, driven by a new boolean-only
`secrets:get-etims-status` channel — the same pattern the Shopify token
and Daraja secrets already use. A blank box means "leave the saved one
alone", so the value is only sent when a manager actually types one.

Writes go through a new `secrets:set-etims-password` (manager PIN, via
`requireAdminPin`), and the **setup gate writes the same way** —
`setup:save-etims-config` no longer puts the password on the row either.

## 2. Config applies to the next sale, not the next launch

The provider was built once at startup, so every device change needed a
relaunch. `RealFiscalizationProvider` now has:

```ts
reconfigure(options: ReconfigureFiscalDeviceOptions): void
```

`deviceIp`/`devicePort`/`password`/`defaultVatClass` became mutable and
are replaced together. It applies `baseUrl` to the existing axios
instance via `normalizeBaseUrl` rather than rebuilding the client — a
rebuild would drop an injected test client and any interceptors — and
clears both per-session caches (`settingsPromise` is bound to the old
credentials; `cuNumbersPromise` belongs to the old device).

`main/index.ts`'s `applyEtimsConfigToProvider()` re-reads the row and the
vault and pushes both in. It runs after `integrations:set-config` (etims
only), after `secrets:set-etims-password`, and after
`setup:save-etims-config`.

## 3. The form itself

`AdminScreen.tsx`'s eTIMS block is rewritten. Every field has a plain
label and a short help line:

| Label | Help |
|---|---|
| Fiscal server address | Leave this as it is unless the fiscal server was installed on another machine. |
| Fiscal device IP address | The address of the control unit on the shop network. |
| Fiscal device port | Usually 8000. |
| Fiscal device password | Saved securely on this till. Leave blank to keep it, or type a new one to replace it. |
| Default tax class | Used for items that have no tax class of their own. Normally A. |
| Store name | (under **Store Details**) Printed at the top of every receipt this till issues. |
| Store KRA PIN | Your own PIN, not the customer's. Leave blank to keep it off the receipt. |

A **Status: Set up / Not set up yet** line sits under the heading,
mirroring `RealFiscalizationProvider.isConfigured` — the password half
comes from the vault status flag, never from a form value.

Removed:

- The **"Endpoint Paths (advanced)" JSON textarea**, with
  `parseEtimsEndpointsInput` and `DEFAULT_ETIMS_ENDPOINTS`. All twelve
  paths are `''` because the server routes on `<Command Name>`, so it was
  jargon configuring nothing — and it carried a live drift bug
  (`readCUnumbers` missing from the renderer copy, so "Reset to Defaults"
  wrote an incomplete object).
- `"These settings are only used when VITE_USE_MOCK_ETIMS=false in your
  .env file."` — stale, wrong, and a raw env string shown to a user.
- `"Real eTIMS Connection Details (Ignored if Mock is enabled)"` and the
  mis-positioned TCP-password note.
- The password placeholder `"Optional"`, which was the opposite of true.
- `DEFAULT_ETIMS_DEVICE_IP` — a real production device IP used as
  placeholder text, which invites someone to accept it as correct. The
  placeholder is now a shape example, `192.168.1.50`.

The section heading became **Payments & Fiscal Device** with a one-line
description, since "M-Pesa & eTIMS" no longer described its contents.

## 4. Test connection — three hops, named

`config:test-etims` → `RealFiscalizationProvider.testConnection()`, with
the phrasing in a new pure `integrations/fiscal-connection-test.ts` so it
is testable without a device.

Reaching the device is three hops that fail for unrelated reasons, and a
blended "connection failed" would tell a branch nothing:

1. **Fiscal server on this till** — the HTTP request itself.
2. **Fiscal device answering** — `settings()` returning `Code 0` vs 30/31/32/34.
3. **Device ready to file** — `ReadStatus`'s `CU_fiscalized` / `Paired_with_TIMS`.

It stops at the first failure and marks later hops **not attempted**
(`passed: undefined`) rather than failed — showing them red would send
someone chasing the wrong problem.

Hops 1 and 2 are told apart structurally, not by string matching: a
transport failure passes through `checkDeviceResponse` with no `code`
(`real-etims-provider.ts:354`), while a server rejection carries one. The
codes themselves are never shown; `describeSettingsFailure` maps them to
sentences (31 → "refused the password", 30 → "did not answer… check the
device is switched on"). `testConnection` clears the cached handshake
first — a test that reported a session opened minutes ago under different
settings would not be a test.

## 5. Validation

`validateEtimsConnection` in `renderer/src/lib/etimsConfig.ts` (already
the framework-free, tested home) checks IP shape, port range 1-65535, and
required fields, returning per-field messages that name the field and
give an example: *"That does not look like an IP address. It should look
like 192.168.1.50."* It runs **before** the manager-PIN prompt — no point
interrupting someone for a PIN only to reject the form afterwards.

Mirrored in `ipcValidator.ts` (`etimsConnectionFields`,
`etimsIntegrationConfigSchema`, `etimsPasswordSetSchema`,
`storeIdentitySetSchema`) so the main process does not trust the
renderer. The rules are duplicated rather than imported — pulling
renderer code into main would drag in its module graph.

This also closes the audit's silent-default bug: the old save path
backfilled IP/port/URL with hardcoded defaults and wrote a blank password
as `undefined`, bypassing the `.min(1)` rules the setup gate enforced.

## 6. The setup gate, brought in line

The gate is the screen a branch meets **first** at go-live, and it was
the lenient one: jargon labels ("ZFPLabServer URL", "Device IP"), no help
lines, no validation beyond non-blank, and the real production device IP
as its placeholder. It now uses the same labels, the same help lines and
the same `validateEtimsConnection` as the Admin form, and its heading
reads "Set up the fiscal device".

## 7. Store identity on the receipt

Store name and store KRA PIN are admin fields (`store:get-identity` /
`store:set-identity`, manager PIN to write), stored in `settings` like
`location_name`, and applied to `printerSettings` immediately.
`renderReceipt` prints `PIN: <value>` under the store name when set.

They replace `process.env.VITE_STORE_NAME`, which remains a fallback.
Neither reaches the ZFP wire: the control unit holds the store's own
identity, and `CompanyName`/`ClientPINnum` on an invoice are the
*customer's* — hence the "Your own PIN, not the customer's" help line.

## 8. On-screen verification

Driven against the real app over CDP (Electron's own remote-debugging
port and Node 24's built-in `WebSocket` — no new dependency). Two
environment notes worth recording: this shell sets
`ELECTRON_RUN_AS_NODE=1`, which makes Electron run as plain Node and fail
with `does not provide an export named 'BrowserWindow'` (`env -u` it);
and port 4444 is not bindable here, so the mock server ran on
`MOCK_ZFPLAB_PORT=45444`.

What the run proved, end to end:

- With the DB flag cleared, the **setup gate appears** — real provider,
  nothing configured.
- Startup log reads `deviceIp = (not configured), devicePort = (not
  configured), password = (not configured)`. No `Password` placeholder
  anywhere.
- Filling the gate in and saving **lifts it and flips the connectivity
  badge to ✓ Fiscal**.
- **Test connection passes all three hops** against the mock server:
  ✓ Fiscal server on this till / ✓ Fiscal device answering / ✓ Device
  ready to file.
- Killing the mock server and re-testing names the **server** hop, with
  hops 2 and 3 shown as "(not checked)".
- A malformed IP is rejected inline, before any PIN prompt.
- `getIntegrationConfig('etims')` returns `{baseUrl, deviceIp,
  devicePort}` — **no `password` key**, and the typed password appears
  nowhere in the payload. The status channel reports
  `passwordConfigured: true`; the form field is empty.
- On disk: the `integrations` row is
  `{"baseUrl":…,"deviceIp":…,"devicePort":…}` with no password, and
  `secret-vault.json` holds `RUBIS POS etims-device-password` as
  ciphertext that does not contain the plaintext.

Two defects the screenshots caught, both fixed: the validation summary
said "details below" while the fields were above it, and the
server-unreachable message named "ZFPLabServer" — vendor jargon a branch
manager cannot act on. It now says "the fiscal server software"; the
service name an installer needs belongs in `docs/GO_LIVE.md`.

## 9. Tests

- **`tests/etimsCredentials.test.ts`** (new, 11): vault-first; "none"
  rather than a default when nothing is configured; plaintext migrated
  into the vault; the key deleted from the row while other fields
  survive; a stale plaintext copy stripped even when the vault already
  wins; a blank plaintext value not vaulted; no rewrite when the row is
  already clean. Plus `redactIntegrationConfig`: removes the password,
  leaves a clean config alone, does not mutate its input, works on an
  M-Pesa-shaped config.
- **`tests/fiscalNotConfigured.test.ts`** (new, 40): the not-configured
  path (Part 4), `reconfigure`, `testConnection`'s hop naming, and a
  sweep asserting every branch-visible message names no vendor product,
  protocol code, command or config key, and is a finished sentence.
- **`tests/etimsConfig.test.ts`**: rewritten for `isIpv4Address` and
  `validateEtimsConnection` — including that messages carry no field
  keys or codes.
- **`tests/ipcValidator.test.ts`**: malformed IP and out-of-range port
  now rejected, not just missing ones; new blocks for
  `etimsPasswordSetSchema`, `etimsIntegrationConfigSchema` and
  `storeIdentitySetSchema`.
- **Existing provider tests** (`realEtimsProvider`, `fiscalResend`,
  `fiscalIntegration`, `tremolConformance`): 97 constructions now pass a
  `TEST_DEVICE` block. Removing the defaults broke 73 tests at once,
  which is the guard proving itself — every one of them had been relying
  on `DEFAULT_DEVICE_PASSWORD`. The one test that asserted the defaults
  is replaced by its opposite: the provider substitutes nothing and
  refuses to call.

## Verification

- `npx vitest run`: **71 files / 1089 tests** (69/1014 going in), 0 failures.
- `npm run typecheck` (node + web): clean.
- `npm run build`: mock-provider guard still passes.
- On-screen: section 8 above.
