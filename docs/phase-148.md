# Phase 148 (Step 1) — Decouple the Admin Integrations saves: M-Pesa, Fiscal Device and Store Details

- **Date:** 2026-09-26
- **Requested:** Following the phase-147 M-Pesa audit, implement the client's locked POC decisions for M-Pesa, one commit per step, STOP after each for review. This report covers **Step 1 only**: split `handleSaveIntegrationsConfig` into three independent handlers (M-Pesa, Fiscal Device, Store Details), each with its own validation, manager-PIN prompt, IPC calls and message; remove the fiscal-validation gate from the M-Pesa save; load state per section; give the M-Pesa save an honest restart prompt instead of hot-reload.
- **Outcome:** Implemented.
- **Branch / base commit:** staging @ 50030c0 (Phase 147)
- **Standing tripwires:** unmodified and passing (see §5).
- **Pre-existing uncommitted changes noted, not touched:** `resources/logos/logo-rubis.png` (deleted), `resources/logos/logo-rubis.jpg`/`logo-rubis1.png` (untracked), `tsconfig.web.tsbuildinfo` (modified). These predate this session and are unrelated to this task; they are left exactly as found and are not part of this commit.

## 1. Audit

### What was examined

- `src/renderer/src/components/AdminScreen.tsx` — read in full (1963 lines) before editing, per the disciplined-engineering protocol. This is the only file that implements `handleSaveIntegrationsConfig`, the M-Pesa/Fiscal Device/Printer/Shopify/Location Admin sections, and their shared state.
- `tests/adminIntegrationsSections.test.ts` — read in full. Source-inspection style test (regex/string matching against the raw file text, not a component mount — the file's own header comment explains why: `AdminScreen.tsx`'s relative imports lack `.js` extensions, which is fine for Vite but breaks `tsconfig.node.json`'s stricter NodeNext resolution that `tests/**` compiles under).
- `src/main/lib/ipcValidator.ts` — confirmed `integrationsSetConfigSchema`, `mpesaIntegrationConfigSchema`, `etimsIntegrationConfigSchema`, `storeIdentitySetSchema` and `mpesaCredentialsSetSchema` are already fully separate per-provider schemas server-side.
- `src/main/index.ts:1480-1520` (`integrations:set-config` handler) — confirmed it already branches validation by `provider` and writes only that provider's own `integrations` row; no main-process change was needed for this step.
- `src/renderer/src/components/RestartCountdownModal.tsx` — read in full to confirm its copy is generic ("Configuration changes require an app restart to take effect") and safe to reuse for the M-Pesa save, not hardcoded to the mock-toggle flow.
- `docs/phase-147.md` (this project's own prior audit) — used as the map, per the task's instruction. Part 6 #5 ("the fiscal-validation gate blocks the M-Pesa save entirely") and Part 6 #6/§7.5 (M-Pesa saves report success but silently need a restart) are exactly what this step fixes.

### How it currently worked (before this change)

One function, `handleSaveIntegrationsConfig` (old `AdminScreen.tsx:451-537`), was wired to two separate "Save Integration Settings" buttons — one under the M-Pesa section, one under the Fiscal Device section (which also contained the unrelated "Store Details" fields). On either click it: ran `validateEtimsConnection` on the fiscal fields and aborted the **entire** save (including M-Pesa) if they were blank/invalid; opened one manager-PIN prompt; then fired `setIntegrationConfig('mpesa', …)`, `setIntegrationConfig('etims', …)`, `setStoreIdentity(…)`, and conditionally `setEtimsPassword(…)`/`setMpesaCredentials(…)`, all via one `Promise.all`; showed one shared `integrationsMessage` regardless of which button was pressed; and on success reloaded every section's state via one `loadIntegrationsConfig()` call. There was no restart prompt on this path — success showed the same bare "Settings saved." as a fiscal change that genuinely does hot-apply, even though M-Pesa's provider is resolved once at boot with no live re-apply path.

### Dependencies found

- **Inbound (callers of the changed code):** only `AdminScreen.tsx` itself (two `onClick` handlers) and `tests/adminIntegrationsSections.test.ts` (one test asserting the shared-handler design). Confirmed by a repo-wide grep for `handleSaveIntegrationsConfig`/`integrationsMessage`/`loadIntegrationsConfig` — no other renderer file, main-process file, or test references them.
- **Outbound (what it depends on):** `window.api.setIntegrationConfig`, `window.api.setMpesaCredentials`, `window.api.setEtimsPassword`, `window.api.setStoreIdentity`, `window.api.getIntegrationConfig`, `window.api.getMpesaCredentialStatus`, `window.api.getEtimsSecretStatus`, `window.api.getStoreIdentity` (all preload-bridged IPC calls) — none of their signatures changed; they are simply called from three places instead of one.
- **String-based / indirect references:** none found — no route names, DI tokens, or config keys reference `handleSaveIntegrationsConfig` by name outside the two files above.

### Risks and constraints identified

- The backend (`ipcValidator.ts`, `main/index.ts`, `database.ts`) was already correctly decoupled by provider — the coupling was entirely in this one renderer file, which is why this step touches only `AdminScreen.tsx` and its test.
- `tests/adminIntegrationsSections.test.ts` asserted the coupling as an intentional invariant (its own docstring called it "Store Details together exactly as before"), so this step required a **deliberate, explicitly-sanctioned** test change (recorded in §2 below), not an incidental one.
- M-Pesa's own fields have no format validation server-side beyond the `smsInboxPath`-required-when-`sms` refinement — so "M-Pesa save must succeed with fiscal fields blank" required only removing the cross-domain gate, not adding new M-Pesa validation.

## 2. Changes made

- **`src/renderer/src/components/AdminScreen.tsx`:**
  - Replaced the single `integrationsMessage` state with three independent pairs: `mpesaMessage`/`mpesaSaving`, `fiscalMessage`/`fiscalSaving`, `storeIdentityMessage`/`storeIdentitySaving`.
  - Split the combined `loadIntegrationsConfig` into `loadMpesaConfig`, `loadFiscalConfig`, `loadStoreIdentityConfig`, plus a slimmer `loadIntegrationsConfig` that still fires all of them together (plus the untouched Shopify-token/store-URL/location-status fetches) **once, on the Integrations tab's initial mount only** — no save handler calls the combined loader any more.
  - Split `handleSaveIntegrationsConfig` into `handleSaveMpesaConfig`, `handleSaveFiscalConfig`, `handleSaveStoreIdentity`. Each opens its own `requestManagerPin` prompt, makes only its own domain's IPC calls, sets only its own message state, and reloads only its own section's state on success.
  - Removed `validateEtimsConnection` entirely from the M-Pesa save path — `handleSaveMpesaConfig` no longer reads or checks any `etims*` field.
  - `handleSaveMpesaConfig` no longer shows "Settings saved." — on success it clears the write-only credential inputs, reloads M-Pesa's own state, and opens the existing `RestartCountdownModal` (the same instance/state already used by the System tab's mock-toggle save), matching the task's "Save & Restart" instruction. No hot-reload was built.
  - Updated the M-Pesa section's Save button: label now reads "Save & Restart" (was "Save Integration Settings"), disabled while saving, with a new line of copy above it stating plainly that M-Pesa settings apply after a restart.
  - Gave the Fiscal Device section its own "Save Fiscal Device Settings" button (unchanged behavior: still hot-applies via the existing `applyEtimsConfigToProvider()` server-side call, still shows "Settings saved." on success).
  - Gave the Store Details block (nested inside the Fiscal Device section, printed on receipts) its own "Save Store Details" button and message, independent of the Fiscal save.
  - Updated the stale Phase E2(e) doc comment above the Integrations tab's JSX, which used to say `handleSaveIntegrationsConfig` "still submits M-Pesa + Fiscal device + Store Details together" — it now describes the three independent handlers and cites the phase-147 finding this fixes.
- **`src/renderer/src/components/RestartCountdownModal.tsx`:** updated its doc comment to note it is now also shown after the M-Pesa Admin save, not only the mock-toggle flow. No behavioral change — the component's props and rendering are untouched.
- **`tests/adminIntegrationsSections.test.ts`:** deliberate test change, instructed by the task (see below), plus four new tests covering the split's specific guarantees.

### Deliberate test change (recorded, as instructed)

- **File:** `tests/adminIntegrationsSections.test.ts`
- **Old assertion** ("keeps Save Integration Settings reachable from both M-Pesa and Fiscal Device, same handler, no new one"): exactly one `handleSaveIntegrationsConfig`, called from exactly 2 places (`onClick={() => void handleSaveIntegrationsConfig()}`), and no `handleSave(Mpesa|Fiscal)(Only)?Config` existing anywhere in the Integrations block.
- **New assertion** ("saves M-Pesa, Fiscal Device and Store Details independently — no shared handler"): `handleSaveIntegrationsConfig` no longer exists anywhere in the file; `handleSaveMpesaConfig`, `handleSaveFiscalConfig` and `handleSaveStoreIdentity` each exist and are each wired to exactly one `onClick`.
- **The decision that required it:** the client's locked POC decision #1 (M-Pesa configuration fully decoupled from KRA/eTIMS) and the specific instruction in this task's Step 1 ("Split `handleSaveIntegrationsConfig` into `handleSaveMpesaConfig`, `handleSaveFiscalConfig` and `handleSaveStoreIdentity`... DELIBERATE TEST CHANGE"). The old assertion was a regression test guarding the very coupling phase-147 Part 6 #5 flagged as a live-till risk (a shop cannot save M-Pesa settings until its fiscal device is configured) — that coupling is the thing being removed.
- **Four new tests added** in the same file, each proving one of the task's required guarantees: the M-Pesa save's validation never reads any `etims*` field; the M-Pesa save prompts for a restart instead of claiming a hot-apply; the Fiscal Device save never references any `mpesa*` field or `setMpesaCredentials`; a failing Store Details save cannot touch M-Pesa or Fiscal message/reload state; each section renders its own message variable and not another's.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/renderer/src/components/AdminScreen.tsx` | Modified | Admin → Integrations → M-Pesa, Fiscal Device, and the Store Details block nested in Fiscal Device — how each section validates, saves, messages, and reloads |
| `src/renderer/src/components/RestartCountdownModal.tsx` | Modified (doc comment only) | No behavior change; documents its new M-Pesa-save caller |
| `tests/adminIntegrationsSections.test.ts` | Modified | Regression coverage for the Admin Integrations sectioning and, as of this step, the independence of the three saves |

## 4. Possible impact

- **Direct:** an admin can now save M-Pesa settings (including just testing a consumer key) with the fiscal device IP/port left blank or invalid — previously blocked entirely. Saving M-Pesa now shows a restart prompt instead of a silent, misleading "Settings saved." Saving the Fiscal Device or Store Details fields no longer touches or reloads the other two sections' state.
- **Indirect:** none expected on other screens or IPC handlers — the main process, database, and every other Admin section (Shopify, Location, Printer, System) were not touched, and the audit found no other file references the changed functions.
- **Data / schema / contract:** none. The `integrations:set-config`, `secrets:set-mpesa-credentials`, `secrets:set-etims-password`, and `identity:set-store` IPC calls are made with the exact same payload shapes as before, just from three call sites instead of one.
- **Security posture:** unchanged. Every write still requires a re-verified manager PIN (`requestManagerPin` → server-side `requireAdminPin`), now three separate PIN prompts instead of one shared prompt for three domains — arguably tighter, since a manager approving an M-Pesa change no longer also silently approves whatever is currently sitting in the Fiscal Device/Store Details form fields.
- **Idempotency / re-run safety:** unchanged — each save is a plain upsert (`setIntegrationConfig`'s whole-row replace per provider, unchanged from before), safe to click again.
- **Residual risk:** the whole-row-replace behavior of `setIntegrationConfig` itself (phase-147 §2.3/§7.3 — no merge semantics, safe today only because each handler still sends all of its own domain's fields together) was **not** changed in this step — it wasn't in scope for Step 1 and remains exactly as documented in phase-147.

## 5. Verification

- `npm run typecheck` — clean, both node and web projects, run twice (once after the `AdminScreen.tsx`/test changes, once more after the `RestartCountdownModal.tsx` comment edit).
- `npx vitest run tests/adminIntegrationsSections.test.ts` — **14/14 passed** (8 original tests retained and passing, minus the one deliberately rewritten, plus 4 new ones — see §2).
- Standing tripwires, run explicitly and unmodified: `fiscalEngine`, `fiscalRouting`, `fiscalProviderFactory`, `fiscalRetry`, `fiscalResend`, `fiscalValidate`, `fiscalSanitize`, `fiscalNotConfigured`, `fiscalNotice`, `fiscalDate`, `fiscalIntegration`, `mpesaPaymentGate`, `mpesaPaymentsRecord`, `darajaMpesaProvider`, `smsMpesaProvider`, `mpesaSmsClaim`, `mpesaSmsInbox`, `mpesaSmsMessages`, `mpesaPaymentPoller`, and the Phase E layout tests (`posCheckoutPanelFit`, `virtualNumpadCompact`, `scale`, `belowLgUnreachable`) — **396/396 passed**, all files unmodified.
- Full suite: `npx vitest run` — **107 test files, 1612 tests passed**, zero failures.
- `git diff` of `AdminScreen.tsx` re-read top to bottom before this report: no accidental deletions, no debug output, no unrelated edits.

## 6. Rollback

`git revert` of this step's commit. This restores the single shared `handleSaveIntegrationsConfig`, the fiscal-validation gate on the M-Pesa save, the shared `integrationsMessage`, and the original `tests/adminIntegrationsSections.test.ts` assertion — cleanly, since nothing outside `AdminScreen.tsx`, `RestartCountdownModal.tsx`'s comment, and the one test file was touched.

## 7. Observed but not changed

- The M-Pesa section's "Test Connection" button still tests whatever credentials were loaded at last app boot, not what's currently typed in the form (phase-147 §3.5) — unaffected by this step, since it was never part of the combined save.
- `setIntegrationConfig`'s whole-row-replace-with-no-merge behavior (phase-147 §2.3) is unchanged — each new handler still sends its own domain's fields as a complete set, same as before.
- Confirmation-method dropdown still offers only `daraja`/`sms` (no `manual` mode yet) — that is Step 2 of this task, not this step.
- Manager PIN is still required for the M-Pesa save in this step — removing per-sale (not per-*configuration*) approval is Step 3's concern (the "no manager PIN" instruction in the task applies to the **manual M-Pesa sale at the till**, not to Admin configuration writes, which the task explicitly says "stays PIN-gated; only the per-SALE approval goes").

---

**STOP — Step 1 complete, awaiting review before Step 2 (three M-Pesa modes with MANUAL as default).**
