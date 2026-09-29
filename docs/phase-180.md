# Phase 180 — Ship installers with no credentials in the bundled `.env`

- **Date:** 2026-09-29
- **Requested:** Check whether the Admin screen and first-run wizard cover everything currently set only through `.env`, then build with the credential fields blank. The values must be set correctly on a till's first install and kept across every update.
- **Outcome:** Implemented. No app code changed.
- **Branch / base commit:** staging @ cb1ee04 (chore: bump to 2.0.5)

---

## Why

`electron-builder.yml`'s `extraResources` copies `.env` into every installer as a loose plaintext file at `resources/.env`. The local `.env` held a real Shopify store URL and Admin API token plus M-Pesa consumer key, secret and passkey, so anyone who unpacked a 2.0.x installer could read them. Phase 177 publishes installers to a public repo, which would have handed these credentials to anyone.

## Audit

Every `.env` key the app reads (`src/main/index.ts:515-828`, `src/renderer/src/App.tsx:189`), and where each value ends up:

| Key | Set on the till by | Stored in | Kept across an update |
| --- | --- | --- | --- |
| `VITE_SHOPIFY_ADMIN_API_TOKEN` | First-run wizard (`config:save`, `index.ts:2407`) or Admin (`secrets:set-shopify-token`, `index.ts:2133`) | `userData/secret-vault.json`, DPAPI (`secretStore.ts`) | Yes |
| `VITE_SHOPIFY_STORE_URL` | Wizard, or Admin (`shopify:set-store-url`, `index.ts:2172`) | `settings.shopify_store_url` | Yes |
| `VITE_SHOPIFY_LOCATION_ID` | Wizard, or Admin > Location (`location:set`) | `settings.location_id` + `location_confirmed` | Yes |
| `MPESA_CONSUMER_SECRET`, `MPESA_PASSKEY` | Admin > M-Pesa (`index.ts:1610-1618`) | Vault | Yes |
| `MPESA_CONSUMER_KEY`, shortcode, environment, callback | Admin > M-Pesa (`integrations:set-config`) | `integrations` table | Yes |
| `VITE_TAX_RATE`, `VITE_MOCK_PRINTER`, `VITE_PRINTER_INTERFACE`, `VITE_DEMO_MODE`, `VITE_USE_MOCK_*`, `FISCAL_DEBUG_LOGGING` | Not credentials; no Admin path needed | Stay in `.env` | n/a |

Findings:
- **A first install with blank credentials already works.** `config:get-status` (`index.ts:2203`) returns `hasConfig=false` when the URL or token is missing, so the onboarding wizard runs and `config:save` stores the token in the vault and the URL and location in `settings`.
- **Updates keep everything.** The vault file and the database both live under `userData`, which the phase-177 `${isUpdated}` guard preserves. DPAPI is tied to the Windows user, and an update doesn't change the user. A blank `.env` cannot override a stored value: `resolveShopifyStoreUrl` is `envUrl || storedUrl`, and the token and M-Pesa values read the vault first.
- **No credential is compiled into the JavaScript bundles.** A redacted scan of `out/main`, `out/preload` and `out/renderer` found no token; `electron.vite.config.ts` has no `define`, and the renderer references only `VITE_DEMO_MODE`. The loose `resources/.env` was the only carrier.
- **`VITE_TAX_RATE` has no Admin path** and feeds the fiscal VAT rate, so it stays in `.env`.
- **Gap on tills already installed from the old `.env`:** only the Shopify token was ever copied from `.env` into the vault (`resolveShopifyToken`). The store URL, the location and the M-Pesa fallbacks were read from `.env` on every launch and never stored. Installing 2.0.5 over the top replaces `resources/.env` before any 2.0.5 code runs, so no startup migration can recover them. The pilot checklist below covers this instead.

## Changes

1. **`.env`** (local, gitignored, not committed): copied to `.env.secrets.local`, which is gitignored by `.env*` and never bundled because `extraResources` copies `.env` by name. Then blanked `VITE_SHOPIFY_STORE_URL`, `VITE_SHOPIFY_ADMIN_API_TOKEN`, `VITE_SHOPIFY_LOCATION_ID`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET` and `MPESA_PASSKEY`. Every other key is unchanged. Checks only ever printed "set" or "blank", never a value.
2. **`scripts/check-env.cjs`**: replaced the old warning, which nudged builders to fill the Shopify fields, with a hard stop. `findBundledCredentialKeys(contents)` returns the six keys above when they hold a value, ignoring comments and treating `""` or a bare trailing comment as blank. The script exits 1 and names the keys, never the values. It runs from `predist` and `predist:dir`, so it also guards `dist:publish`. The function is exported, and the check runs only under `require.main === module`.
3. **`.env.example`**: the header no longer says to "fill in your real credentials". The Shopify and Daraja comments now say these fields stay blank for any build and are set on each till. `MPESA_PASSKEY` is blank (the sandbox value would now fail the guard if copied to `.env`).
4. **`tests/checkEnv.test.ts`** (new): 12 tests. A blank file passes; each of the six keys is reported when it has a value; a trailing comment or empty quotes count as blank; a value followed by a comment is still reported; commented-out lines and non-credential keys are never reported; the guarded list is exactly the six keys.
5. **`docs/RELEASING.md`**: step c now says the build refuses a `.env` holding credentials, and a new "First install on a new till" section lists what to enter in the wizard and in Admin.

Not changed: `secretStore.ts`'s doc comment on `resolveShopifyToken` still describes baking `.env` into the installer for a zero-touch install. The behaviour is still right (vault first, `.env` as a dev fallback), so only the wording is out of date.

## Verification

| Check | Result |
| --- | --- |
| Guard on the backed-up old `.env` | Refused: `VITE_SHOPIFY_STORE_URL, VITE_SHOPIFY_ADMIN_API_TOKEN, MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_PASSKEY` |
| Mutation: `MPESA_PASSKEY` removed from the guarded list | 2 tests failed; reverted, 12/12 pass |
| Negative build: `VITE_SHOPIFY_ADMIN_API_TOKEN=dummy`, `npm run dist:dir` | Stopped at `predist` with exit 1 before typecheck or build; `.env` reverted |
| Positive build: `npm run dist:dir` | Succeeded; `verify-dist.cjs` passed |
| Packaged `release/win-unpacked/resources/.env` (redacted) | All six keys blank; `VITE_TAX_RATE` set |
| `npm run typecheck` | Clean |
| `npx vitest run` | 151 files, 2290 tests, all passing |
| Tripwire `git diff --stat -- src/` | Empty |
| `git status` | `.env`, `.env.secrets.local` and `release/` all ignored |

## Pilot and existing-till checklist (human, before installing 2.0.5)

On each till running 2.0.x built from the old `.env`:

- [ ] Admin > Integrations > Shopify: press **Save Store URL** once, so the URL currently coming from `.env` is written to the database.
- [ ] Admin > Integrations > Location: select and confirm the location again.
- [ ] Admin > Integrations > M-Pesa: if the till uses Daraja and the secret shows as not configured, enter it from `.env.secrets.local`. Tills on manual confirmation need nothing here.
- [ ] Shopify token: nothing to do; it was copied into the vault on first launch.
- [ ] Recommended: rotate the Shopify Admin API token and the Daraja consumer secret, because every 2.0.x installer handed out so far contains them. Enter the new values in Admin on each till.

If a till skips this, it is not stuck: after the update the first-run wizard reappears and asks for the store URL, token and location again.

## Rollback

`git revert` this commit. The local `.env` is not tracked, so to undo the blanking, copy `.env.secrets.local` back over `.env`. That would re-bundle the credentials, and the reverted guard would no longer stop it.
