# Phase 14 — Pre-Deployment Security Patch

**Date:** 2026-08-25 · **Branch:** `staging` · **Previous:** [Phase 12](./phase-12.md)

## 1. Objective

Close the two findings raised by the Pre-Deployment Audit Report, 48
hours ahead of the Enjoy Haile Selassie live-store PoC:

- **C1 (Critical)** — `staff:create`, `staff:resetPin`, and
  `integrations:set-config` trusted the renderer's `ManagerPinModal`
  gate with no check in the main process at all. Since
  `contextBridge` exposes `window.api.createStaff(...)` etc. globally,
  a cashier with DevTools open (or any compromised renderer code)
  could call these channels directly — no PIN, no role check — to
  self-promote to `admin` or rewrite the M-Pesa Paybill/Till numbers.
- **H3 (High)** — `VITE_DEMO_MODE` was invisible to on-floor staff (a
  `console.warn` only), so leaving it on by accident at the live store
  would go unnoticed.

## 2. C1 — Server-Side Admin Authorization

### 2.1 Root cause

The app had no concept of "who is currently authorized" in the main
process — every write IPC trusted whatever shape the renderer sent.
`ManagerPinModal` genuinely does prompt for and verify a PIN today,
but only via `window.api.login`, and its result (`onAuthorized()`)
never left the renderer — so a call straight to `window.api.createStaff(...)`
from a console skipped the prompt entirely.

### 2.2 Fix — `requireAdminPin`

`src/main/lib/requireAdminPin.ts` re-runs the same `authenticateStaff`
check `auth:login` performs, plus an explicit `role === 'admin'`
requirement, against a `managerId`/`managerPin` pair now carried on
the request payload itself:

```ts
export function requireAdminPin(
  db: RubisDatabase,
  managerId: number,
  managerPin: string
): ServiceResult<void>
```

Every failure mode — unknown `managerId`, wrong PIN, a correct PIN on
a non-admin account, or an unexpected exception out of
`authenticateStaff` — returns the same generic `'Manager PIN required
for this action'` message, mirroring `authenticateStaff`'s own
generic-error pattern in `auth.ts` (Phase 6) so the response never
reveals which part of the check failed. `authenticateStaff` does not
throw in practice (`verifyPin` never throws), but the call is wrapped
in a `try/catch` regardless — this is a privileged gate reached from
every write IPC it guards, so an unforeseen failure should degrade to
a clean rejection rather than an unhandled exception escaping
`ipcMain.handle`.

### 2.3 Validation — `ipcValidator.ts`

Three new `zod` schemas, each extending a shared `managerAuthzSchema`
(`managerId: z.number().int().positive()`, `managerPin: z.string().min(1)`):
`staffCreateSchema`, `staffResetPinSchema`, `integrationsSetConfigSchema`.
Malformed payloads (missing manager fields, an invalid `role`/`provider`,
an empty PIN) are rejected before `requireAdminPin` or any database
call runs, matching how `checkoutRequestSchema`/`loginRequestSchema`
already gate `orders:checkout`/`auth:login`.

### 2.4 IPC handlers — `main/index.ts`

`staff:create`, `staff:resetPin`, and `integrations:set-config` now
run, in order: (1) `validate()` against the new schema, (2)
`requireAdminPin(db, managerId, managerPin)`, (3) the existing
business logic, unchanged. Either of the first two steps short-circuits
with a `{ success: false }` `ServiceResult` before touching the
database.

### 2.5 Preload / renderer contract

`window.api.createStaff`, `resetStaffPin`, and `setIntegrationConfig`
each gained two trailing parameters, `managerId: number` and
`managerPin: string`, forwarded verbatim into the IPC payload
(`src/preload/index.ts`, `src/preload/window.d.ts`). This is an
additive signature change — every existing call site was updated in
this phase, so no caller silently omits the new fields.

`ManagerPinModal`'s `onAuthorized` callback now receives
`(managerId, managerPin)` instead of firing with no arguments, and
that shape propagates through `App.tsx`'s `PinGateRequest`/
`requestManagerPin` and the `requestManagerPin` prop on
`CartLineItem`, `OrderHistory`, and (new) `AdminScreen`. Existing
zero-argument callers (`CartLineItem`'s price/discount overrides,
`OrderHistory`'s void flow) are untouched — a callback declared with
fewer parameters than the type allows is valid TypeScript and simply
ignores the extra arguments — so this widening is non-breaking for
every pre-existing `requestManagerPin` call site.

`AdminScreen.tsx` gained a `requestManagerPin` prop (passed from
`App.tsx`, same instance used everywhere else) and its three
privileged actions — **Create Staff**, **Reset PIN**, **Save
Integration Settings** — now open `ManagerPinModal` before calling the
corresponding `window.api.*` function, forwarding the resolved
`managerId`/`managerPin`. Client-side field validation (name/PIN
required, etc.) still runs *before* the PIN prompt opens, so a cashier
can't burn a manager's PIN entry on an obviously-invalid form.

### 2.6 What this does and doesn't change

- `orders:void` is unchanged — explicitly out of scope for this phase
  per the audit report (it was flagged as a lower-severity, already
  status-gated action; revisit alongside Shopify refunds).
- No IPC channel *names*, request/response envelopes, or existing
  fields changed shape — `managerId`/`managerPin` are additive fields
  on three request payloads only.

## 3. H3 — Visible Demo Mode Banner

`App.tsx` now renders a non-dismissible amber banner
(`⚠️ Demo Mode Active — Sales are local only and will not sync to
Shopify ⚠️`) at the very top of the app shell whenever
`import.meta.env.VITE_DEMO_MODE === 'true'` — before login (above
`LoginScreen`) and after, so it's visible for the entire session
regardless of auth state. `src/renderer/src/env.d.ts` gained the
`VITE_DEMO_MODE` key on `ImportMetaEnv` so this reads type-checked
rather than through an untyped `import.meta.env` access.

## 4. Bonus Fix — `keytar` Native Module Risk Removed

While verifying this phase, `node_modules/keytar` was found with no
`.node` binary present — `postinstall`'s `electron-rebuild -f -w keytar`
step (which needs a C++/Python build toolchain) had not produced one
on this machine. `secretStore.ts`'s pre-existing `loadKeytar()` already
caught the resulting `MODULE_NOT_FOUND` and degraded to `NULL_KEYTAR`
rather than crashing — but a degraded vault means the Shopify Admin
API token can never actually persist, which is unacceptable 48 hours
from the live-store PoC and a real risk of the exact "fighting Windows
native build tools" scenario flagged as unacceptable this close to
deployment.

**Fix:** replaced the vault backend with Electron's built-in
`safeStorage` (Windows DPAPI / macOS Keychain / Linux libsecret) —
compiled into Electron itself, so it needs no native build step at
all. Critically, this was done *without* touching the existing
`KeytarLike` contract:

- `KeytarLike`, `getSecret`, `setSecret`, `deleteSecret`,
  `resolveShopifyToken`, `NULL_KEYTAR`, `SECRET_SERVICE_NAME`,
  `SHOPIFY_TOKEN_ACCOUNT` — **all unchanged**. Every caller in
  `main/index.ts` (`secrets:get-shopify-token-status`,
  `secrets:set-shopify-token`) works exactly as before.
- New: `createSafeStorageVault({ safeStorage, vaultFilePath, io?, chmod? })`
  builds a `KeytarLike` backed by one flat, base64-ciphertext JSON file
  (`secret-vault.json` in `app.getPath('userData')`), following the
  same injectable-narrow-interface convention as `printer.ts`'s
  `ThermalPrinterLike`/`PrinterFactory` — `SafeStorageLike` and
  `VaultFileIO` keep it fully unit-testable without touching Electron
  or the real filesystem. A missing or corrupt vault file degrades to
  "no secrets stored" rather than throwing; every operation degrades
  to `NULL_KEYTAR`-equivalent behavior when
  `safeStorage.isEncryptionAvailable()` is false. Writes apply the
  same owner-only (`0o600`) permission restriction `database.ts`
  already applies to `rubis-pos.db` (Phase 12, Task 4), via the
  existing `restrictToOwnerOnly`.
- `loadKeytar()` → renamed `loadSecretVault()` (it no longer touches
  `keytar` at all) — the one Electron-touching call site in
  `main/index.ts` updated accordingly.
- `keytar` removed from `package.json` `dependencies` and from the
  `postinstall` script's `electron-rebuild` invocation. `better-sqlite3`
  is unaffected — it's the only native module the build still needs.

**Verified clean:** running this checkout's own `npm` scripts
triggered npm's lockfile sync — `package-lock.json` no longer
references `keytar`, and `node_modules/keytar` is gone from disk. No
manual `rm -rf node_modules && npm install` was needed here, though
running `npm install` once on the store till machine before the PoC is
still the recommended sanity check (it also drops the broken `keytar`
postinstall step so a fresh install there never attempts a rebuild
that requires build tools this project no longer needs).

## 5. Bonus Fix — Dev-Mode CSP Blocked Vite's Fast Refresh (Blank Window)

Verifying C1/H3 required actually launching `npm run dev`. Two
environment issues surfaced first (Electron's binary hadn't been
downloaded; a sandboxed terminal's `ELECTRON_RUN_AS_NODE=1` — neither
a code defect, both resolved outside the repo). Once launched for
real, the window opened but rendered nothing but its
`backgroundColor` (`#0f172a`) — a genuine bug, not an environment
artifact.

**Root cause:** the Phase 5.1 CSP (`script-src 'self'`) is applied
unconditionally to every response the session serves, dev or
packaged. `@vitejs/plugin-react` injects an inline `<script
type="module">` "preamble" into the dev HTML to wire up React Fast
Refresh. `'self'` never permits inline script execution regardless of
origin, so that preamble silently failed CSP, and every component
module then threw `@vitejs/plugin-react can't detect preamble` on
first import — an uncaught render-time exception with no error
boundary, hence a blank window instead of a visible error (the actual
CSP violation and exception were only visible in DevTools' console,
per the browser's own CSP reporting — nothing surfaced in the `npm run
dev` terminal output).

**Fix:** `window-factory.ts`'s `buildCspHeaders()` now takes an
optional `policy` string (defaults to the unchanged, strict
`CONTENT_SECURITY_POLICY` — every existing caller and test is
unaffected). New `buildDevContentSecurityPolicy(devServerUrl)` builds
a relaxed policy — `script-src` additionally allows `'unsafe-inline'`
(for the preamble) and the dev server's own origin; `connect-src`
additionally allows the dev server's `http`/`ws` (or `https`/`wss`)
origin for its HMR socket. `main/index.ts` selects between the two
based on `!app.isPackaged && process.env['ELECTRON_RENDERER_URL']` —
a packaged build never sets that env var, so production keeps the
exact original strict policy with zero change in behavior.

## 6. Testing Strategy

- `tests/requireAdminPin.test.ts` (7 tests, new) — mirrors
  `auth.test.ts`'s fake-`RubisDatabase` pattern: a correct admin PIN
  succeeds; a correct PIN on a cashier account, an unknown manager id,
  a wrong PIN, and an inactive admin account are all rejected with the
  same generic message; a `getStaffById` that throws (simulating an
  `authenticateStaff` failure) returns the generic rejection instead of
  propagating (Q2).
- `tests/ipcValidator.test.ts` (+22 tests) — `staffCreateSchema`,
  `staffResetPinSchema`, `integrationsSetConfigSchema`: well-formed
  payloads accepted; invalid `role`/`provider` enums, missing
  name/PIN/staffId, and a missing or empty `managerId`/`managerPin`
  all rejected.
- No changes needed in `tests/database.test.ts` /
  `tests/reconciliation.test.ts` — those exercise `RubisDatabase.createStaff`/
  `setIntegrationConfig` directly, whose signatures this phase does not
  touch; only the IPC-layer wrapper in `main/index.ts` gained the
  authorization step.
- `tests/secretStore.test.ts` (+11 tests) — `createSafeStorageVault`
  against fake `SafeStorageLike`/`VaultFileIO`: round-trip a secret;
  the on-disk JSON never contains the plaintext value; a never-set
  secret and a delete-of-a-never-set-secret both resolve cleanly;
  distinct `service`/`account` pairs stay independent; a corrupt vault
  file is treated as empty rather than throwing; a write triggers the
  `0o600` permission restriction when `chmod` is provided; every
  operation (`get`/`set`/`delete`) degrades safely when
  `isEncryptionAvailable()` is false, without touching the file at all
  for reads/deletes.

```bash
npm test           # vitest run — 32 files / 346 tests passing
npm run typecheck  # tsc --noEmit (node + web) — clean
```

## 7. Files Created / Modified

**Created:**
- `src/main/lib/requireAdminPin.ts`
- `tests/requireAdminPin.test.ts`
- `docs/phase-14.md`

**Modified:**
- `src/main/lib/ipcValidator.ts` — `managerAuthzSchema`,
  `staffCreateSchema`, `staffResetPinSchema`,
  `integrationsSetConfigSchema`
- `src/main/index.ts` — `staff:create`, `staff:resetPin`,
  `integrations:set-config` handlers now validate + call
  `requireAdminPin` before their existing logic
- `src/preload/index.ts`, `src/preload/window.d.ts` — `createStaff`,
  `resetStaffPin`, `setIntegrationConfig` gain `managerId`/`managerPin`
  parameters
- `src/renderer/src/components/ManagerPinModal.tsx` —
  `onAuthorized(managerId, managerPin)`
- `src/renderer/src/App.tsx` — `PinGateRequest`/`requestManagerPin`
  widened to match; Demo Mode banner
- `src/renderer/src/components/AdminScreen.tsx` — `requestManagerPin`
  prop; Create Staff / Reset PIN / Save Integrations route through
  `ManagerPinModal`
- `src/renderer/src/components/CartLineItem.tsx`,
  `OrderHistory.tsx` — `requestManagerPin` prop type widened
  (non-breaking; behavior unchanged)
- `src/renderer/src/env.d.ts` — `VITE_DEMO_MODE` on `ImportMetaEnv`
- `tests/ipcValidator.test.ts` — new schema coverage
- `src/main/services/secretStore.ts` — `SafeStorageLike`,
  `VaultFileIO`, `createSafeStorageVault`; `loadKeytar` renamed
  `loadSecretVault` and rebuilt on `safeStorage`
- `src/main/index.ts` — `loadKeytar` import/call site renamed to
  `loadSecretVault`
- `src/renderer/src/components/AdminScreen.tsx` — Shopify token
  storage copy updated (DPAPI, not Windows Credential Manager)
- `package.json` — `keytar` dependency and its `electron-rebuild`
  postinstall step removed
- `tests/secretStore.test.ts` — new `createSafeStorageVault` coverage
- `src/main/window-factory.ts` — `buildDevContentSecurityPolicy`;
  `buildCspHeaders` takes an optional `policy` argument
- `tests/security.test.ts` — new dev-CSP and `buildCspHeaders(policy)`
  coverage

## 8. Known Limitations (candidate backlog)

- `orders:void` still has no main-process role re-check (documented,
  pre-existing behavior from Phase 10 — out of scope here per the
  audit's severity ranking; the void action is already constrained to
  `pending_sync` orders and reversible at the DB layer).
- `requireAdminPin` re-hashes the PIN via `pbkdf2Sync` (100k
  iterations) on every privileged write, same as a fresh login — an
  acceptable cost for the infrequent Admin-screen actions it now
  gates, not worth caching for a 1-week PoC.
- The dev CSP (§5) is intentionally scoped to `!app.isPackaged` only —
  if a future change ever loads the dev server URL in a packaged
  build (it shouldn't), the relaxed policy would not apply and the app
  would hit the same blank-window failure this phase just fixed.

---

## Phase 14 Completion Report

**Files created:** `src/main/lib/requireAdminPin.ts`,
`tests/requireAdminPin.test.ts`, `docs/phase-14.md`.

**Files modified:** 16 files across main, preload, renderer, and
`package.json` — full list in §7. Includes two unplanned but necessary
fixes found while verifying this phase: the `keytar` → `safeStorage`
vault swap (§4), since a degraded credential vault was itself a
pre-deployment risk, and the dev-mode CSP fix (§5), found only once
`npm run dev` was actually launched end-to-end and hit a blank window.

**Tests:** `npm test` — **32 files / 346 tests passing** (48 new: 7
`requireAdminPin` + 22 `ipcValidator` schema cases + 11
`createSafeStorageVault` cases + 8 CSP policy cases; existing suite
unaffected, zero regressions). `npm run typecheck` — clean (node + web
projects).

**Not implemented (explicitly out of scope per the audit report):**
`orders:void` server-side re-authorization; real Daraja/eTIMS clients
(unchanged Phase 9 boundary).

**Next steps:**
1. Run `npm run dev` and confirm the app now renders past the login
   screen (this was the blank-window failure §5 fixes) — verified
   building cleanly here, but a live visual check is worth doing on
   your machine.
2. Manually verify: Create Staff / Reset PIN / Save Integrations all
   prompt for a Manager PIN and succeed with a correct admin PIN; the
   Shopify token save/reload round-trips after a full app restart
   (confirms `safeStorage` persistence); the Demo Mode banner appears
   when `VITE_DEMO_MODE=true` and is absent otherwise.
3. `npm install` once on the store till machine before the PoC as a
   general sanity check — `keytar` is already fully gone from
   `package.json`/`package-lock.json`/`node_modules` in this checkout
   (§4), so this is precautionary, not required to unblock anything.
4. `orders:void`'s main-process re-authorization (flagged low-severity
   in the audit) remains a candidate for a future hardening pass, not
   this 48-hour window.
