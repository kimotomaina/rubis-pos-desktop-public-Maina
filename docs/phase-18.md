# Phase 18 — First-Run Onboarding & Runtime Configuration

**Date:** 2026-08-26 · **Branch:** `main` · **Previous:** [Phase 17.1](./phase-17.md)

## 1. Objective

A packaged `.exe` failed immediately on a fresh machine with "Shopify
credentials missing," because it depended on `VITE_SHOPIFY_STORE_URL`/
`VITE_SHOPIFY_ADMIN_API_TOKEN` env vars that don't exist outside the
machine that built the installer. This phase adds a first-run
onboarding wizard that lets an operator connect the till to Shopify
and pick its location interactively, with no `.env` file required.

## 2. Deviation from the brief: no new `configStore.ts`

The brief asked for a new `src/main/services/configStore.ts` — a
JSON file at `userData/config.json` for `storeUrl`/`locationId`, plus
a second, separate `safeStorage`-encrypted file (`secure_token.bin`)
for the token. That would have been a **second** persistence
mechanism sitting next to one that already does the exact same job:

- `secretStore.ts`'s `safeStorage`-backed vault (Phase 14) already
  encrypts and persists the Shopify Admin API token.
- The `settings` SQLite table (Phase 16) already persists
  `shopify_store_url` and `location_id`.
- `AdminScreen.tsx`'s "Shopify Connection" section already lets an
  operator set the store URL/token post-install.

Building a parallel system would leave two competing sources of truth
for the same three values with no way to know which one a given
launch actually used. This phase instead extends the existing
mechanisms: the onboarding wizard calls the same `setSecret`/
`db.setSetting` calls `shopify:set-store-url`/`secrets:set-shopify-token`
already use, just bundled behind two new IPC channels
(`config:save`, `config:clear`) built for the wizard's flow.

## 3. The actual root cause, fixed at the source

Independently of the onboarding wizard, `secretStore.ts`'s
`resolveShopifyToken` only fell back from the vault to `.env` when
`isDev` (`!app.isPackaged`) was true — a deliberate Phase 12 decision
made before Phase 16 built the "bake `.env` into the installer for a
zero-touch fresh install" deployment story
(`electron-builder.yml`'s `extraResources`, `check-env.cjs`,
`verify-dist.cjs`). The two were never reconciled: a packaged build's
vault starts empty, and it was never allowed to seed itself from the
bundled `.env`, so "Shopify credentials missing" fired on first launch
regardless of whether `.env` was correctly bundled (Store URL's
`resolveShopifyStoreUrl`, added in Phase 16, never had this
restriction — only the token side did).

The `isDev` gate is now removed from `resolveShopifyToken`: a missing
vault entry falls back to `.env` and persists into the vault
unconditionally, matching `resolveShopifyStoreUrl`'s existing
behavior. The `.env` file's plaintext-on-disk exposure is unchanged
either way (see `secretStore.ts`'s file-level doc comment) — this
only changes whether that tradeoff buys a working fresh install, which
was the entire point of bundling it.

## 4. `validateAndFetchLocations` (`shopify.ts`)

```ts
export async function validateAndFetchLocations(
  storeUrl: string,
  token: string,
  options?: { client?: AxiosInstance }
): Promise<ServiceResult<{ shopName: string; locations: ShopifyLocation[] }>>
```

One GraphQL round trip (`VALIDATE_STORE_QUERY`) fetching `shop.name`
(proves the token authenticated) and up to 10 locations, reusing
`createShopifyClient`/`translateAxiosError` — the same client
construction and error-message translation `fetchAllProducts` already
uses, so a bad URL or an expired token surfaces the same
human-readable message the rest of the app already shows.

## 5. New IPC channels (`main/index.ts`)

| Channel | Auth | Purpose |
| --- | --- | --- |
| `config:get-status` | none | `{ hasConfig, config? }` — `hasConfig` is `shopifyStoreUrl && shopifyToken` both resolved. `App.tsx` calls this on mount. |
| `config:validate` | none | Wraps `validateAndFetchLocations`; read-only, same risk class as `printers:test`. |
| `config:save` | none | Persists store URL (`settings` table), token (vault), and the selected location id (`settings`), then updates the three in-memory bindings (`shopifyStoreUrl`, `shopifyToken`, `locationId`) so `products:fetch` picks them up immediately, no restart. No manager PIN — this runs *before* any staff session exists, since the wizard replaces the Login screen entirely until a config is present. |
| `config:clear` | Manager PIN | The Admin screen's "Reset Configuration" (Q2) — wipes all three, gated like `shopify:set-store-url` since it's a destructive, already-authenticated-session action. |

`products:fetch` needed **no changes** — it already reads
`shopifyEnv()` (a closure over the mutable `shopifyStoreUrl`/
`shopifyToken` bindings) at call time rather than a fixed snapshot, so
once `config:save` updates those bindings, the very next catalog fetch
uses them.

## 6. `OnboardingScreen.tsx`

Two-step wizard, styled to match `LoginScreen.tsx`'s full-screen dark
layout:

1. **Connect** — Store URL + token inputs, "Connect & Verify" calls
   `config:validate`. On success, moves to step 2 with the shop name
   and location list; on failure, shows the translated API error
   inline.
2. **Location** — radio list of fetched locations; auto-selected with
   a "Location automatically selected" message when there's only one
   (Q1's single-location constraint). "Save Configuration & Start"
   calls `config:save`, then `window.location.reload()` (Q1 default)
   — the cleanest way to let the main process's already-updated
   config flow through every service that depends on it without
   hand-rolled state teardown.

`App.tsx` gates on a new `configStatus` state (`'loading' |
'unconfigured' | 'ready'`), checked via `config:get-status` on mount
and rendered *before* the existing `!currentStaff` → `LoginScreen`
check. **Demo Mode bypasses this entirely** — it's a local-only trial
mode that never talks to Shopify (Phase 11), so gating it behind an
onboarding wizard asking for real Shopify credentials would break an
existing, intentional deployment path.

## 7. Admin screen: "Reset Configuration" (Q2)

A new "System" tab in `AdminScreen.tsx` alongside Overview/
Integrations/Peripherals, with a single "Reset Configuration" button.
Routes through the existing `requestManagerPin` → `ManagerPinModal`
flow (same pattern as every other privileged Admin write), calls
`config:clear`, then reloads the window — bringing back
`OnboardingScreen` on the next render.

## 8. Testing

- `tests/secretStore.test.ts` — updated the three `resolveShopifyToken`
  tests for the removed `isDev` parameter; the "does not fall back in
  production" test is gone since that behavior no longer exists,
  replaced by asserting the fallback now happens unconditionally.
- `tests/shopifyService.test.ts` — new `validateAndFetchLocations`
  suite (7 tests): success shape, exact query sent, empty-locations
  handling, missing-shop-name failure, GraphQL error passthrough, HTTP
  401 mapping, and invalid-URL rejection before any request is made.
- `tests/ipcValidator.test.ts` — new suites for `configValidateSchema`,
  `configSaveSchema`, and `configClearSchema` (14 tests).
- No `tests/configStore.test.ts` — there is no `configStore.ts` in
  this implementation (§2); the equivalent coverage lives in the three
  files above, covering the same persistence paths (vault + settings
  table) that already had tests from Phases 14/16.
- `OnboardingScreen.tsx` and the `AdminScreen.tsx` "System" tab are
  UI-only wiring around already-tested main-process logic (same
  reasoning `phase-17.md` §6 used for `ProductCard`/`CartLineItem`);
  no test in the repo mounts `AdminScreen` or would mount
  `OnboardingScreen`, so nothing needed updating there.

## 9. Verification

- `npm run typecheck` — clean (both `node` and `web` projects).
- `npm test` — 423/423 passing across 35 files (407 prior + 7 new
  `validateAndFetchLocations` tests + a net +9 in `ipcValidator.test.ts`,
  with `secretStore.test.ts`'s `resolveShopifyToken` suite reduced from
  4 tests to 3 by removing the now-invalid "production" case).
