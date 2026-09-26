# Phase 149 (Step 2) — Three M-Pesa modes, MANUAL as default

- **Date:** 2026-09-26
- **Requested:** Following phase-148 step 1 (decoupling the Admin saves), implement Step 2 of the client's locked M-Pesa POC decisions: `confirmationMethod` becomes `'manual' | 'daraja' | 'sms'`, defaulting to `'manual'` everywhere it is unset; Sandbox/Live environment applies only to `'daraja'`; `'sms'` stays in code but is unselectable while its parser is a stub; `PaymentModal` renders an entirely different screen per mode; the header's M-Pesa status reflects the mode (neutral for manual, environment-aware host probe for Daraja, "Not available" for SMS).
- **Outcome:** Implemented.
- **Branch / base commit:** staging @ df859a4 (Phase 148 step 1, plus an unrelated logo-asset commit made outside this session between steps — noted, not touched).
- **Standing tripwires:** unmodified and passing, full list in §5 — plus this step's own new/updated tests.

## 1. Audit

### What was examined

- `src/main/services/mpesa-provider-factory.ts` — read in full. The single place that decides which M-Pesa provider a till runs and what checkout may rely on it for; every "assumes Daraja" code path traces back here or to its two callers.
- `src/main/lib/ipcValidator.ts`'s `mpesaIntegrationConfigSchema` — read in full, including the two other integration schemas beside it for comparison (`etimsIntegrationConfigSchema`, `storeIdentitySetSchema`).
- `src/main/index.ts` — the M-Pesa boot-resolution block (`mpesaConfirmationMethod`, `darajaOptions`, `resolveMpesaProvider` call), the `integrations:mpesa-capabilities` IPC handler, and the connectivity-monitor wiring (`checkMpesa`).
- `src/main/services/connectivityMonitor.ts` — read in full, including its existing test file, to find the right seam for an environment-aware, mode-aware M-Pesa probe.
- `src/main/lib/mpesaSms.ts` — confirmed `MPESA_SMS_PARSER_READY = false` and its doc comment, so the SMS-rejection gate cites the same fact main and renderer already agree on.
- `src/renderer/src/components/PaymentModal.tsx` — read in full before restructuring it around `mode` instead of the two capability booleans.
- `src/renderer/src/components/AdminScreen.tsx`'s M-Pesa section, `src/renderer/src/components/NavStatusButton.tsx`, `src/renderer/src/components/ConnectivityModal.tsx`, `src/renderer/src/types/connectivity.ts`, `src/preload/index.ts`, `src/preload/window.d.ts` — read in full for the parts this step touches.
- `src/main/services/checkout.ts` — read the M-Pesa payment gate specifically to confirm it consumes only `verifyReferenceNumbers`/`manualEntryEnabled`/`manualApproval`, never `confirmationMethod` directly, and already has its own `mode: 'daraja'|'sms'|'manual'` literal for `mpesa_payments.mode` — confirming this step needed **no change to checkout.ts** (Step 3's territory).
- `src/main/services/integrations/mock-mpesa-provider.ts` and `daraja-mpesa-provider.ts` — read to confirm `DARAJA_SANDBOX_BASE_URL`/`DARAJA_PRODUCTION_BASE_URL` were already exported (no new constant needed) and to understand what the dev mock actually simulates.
- `tests/mpesaProviderFactory.test.ts`, `tests/ipcValidator.test.ts`, `tests/adminIntegrationsSections.test.ts`, `tests/connectivityMonitor.test.ts`, `tests/navStatusButton.test.ts` — read in full before editing any of them.
- `docs/phase-120.md` §7.3 — read in full to accurately cite and reverse its original "manual as a fallback flag only" recommendation, per the task's explicit instruction to record that reversal.

### How it currently worked (before this step)

`confirmationMethod` was typed `'daraja' | 'sms'` everywhere. Every place that needed a default when the field was unset — `resolveMpesaProvider` (implicitly, by falling through to the Daraja branch), `main/index.ts`'s boot resolution (`... === 'sms' ? 'sms' : 'daraja'`), `AdminScreen.tsx`'s React state and its load function (same ternary) — assumed Daraja. `PaymentModal` decided what to show from two independent booleans (`manualCodeSupported`, `manualEntryEnabled`) rather than from the mode itself, so a genuinely separate "manual, exclusive method" concept did not exist in the UI at all — only "Daraja, optionally with a fallback tab" and "SMS, optionally with a fallback tab, if a confirmation could ever be read." The header's M-Pesa probe (`checkMpesa` in `main/index.ts`) always checked a hardcoded sandbox host regardless of configured environment (phase-147 Part 6 #1) and had no way to represent "nothing to check" — only connected/disconnected.

### Dependencies found

- **Inbound (callers of `resolveMpesaProvider`):** `main/index.ts` (boot) and every test in `tests/mpesaProviderFactory.test.ts`.
- **Inbound (callers of `mpesaIntegrationConfigSchema`):** `main/index.ts`'s `integrations:set-config` handler (unchanged call site — validates whatever provider-scoped config it's given) and `tests/ipcValidator.test.ts`.
- **Inbound (readers of `integrations:mpesa-capabilities`):** only `PaymentModal.tsx` in the renderer, confirmed by a repo-wide grep — no other component reads `manualCodeSupported` or would be affected by adding `mode` alongside it.
- **Inbound (readers of `ConnectivityCheckResult`/`ConnectivityCheckPayload`):** `NavStatusButton.tsx`, `ConnectivityModal.tsx`, `App.tsx` (passes the payload through untouched), and their three duplicated type declarations (main, two preload files, one renderer type file) — all four updated together with the same optional `notApplicable` field so the IPC boundary stays consistent.
- **Outbound:** `resolveMpesaProvider` depends on `DarajaMpesaProvider`, `SmsMpesaProvider`, the new `UnconfiguredMpesaProvider(message)` constructor parameter (backward compatible — defaults to the existing message). `checkMpesaConnectivity` (new) depends on `checkHttpReachable`, `mockDisconnectedResult`, `notApplicableResult` (new), and the two already-exported Daraja base-URL constants.
- **String-based / indirect references:** the `confirmationMethod` string literal appears in the `integrations.mpesa` JSON blob stored in SQLite — untouched by this step (read/write paths both still pass the value through verbatim; only the *interpretation* of "absent" changed, and only at read/default time, never by rewriting stored rows).

### Risks and constraints identified

- **`checkout.ts` was explicitly out of scope** — verified it needs no change, so manager-PIN-gated manual sales (unchanged from before this step) continue exactly as they did; Step 3 removes that PIN.
- Six existing `mpesaProviderFactory.test.ts` tests and one `ipcValidator.test.ts` test relied on the implicit Daraja default without saying so — each needed either an explicit `confirmationMethod: 'daraja'` (if its real intent was unrelated to the default) or a deliberate flip (if its real intent *was* the default). Both kinds are recorded below, distinctly.
- `ConnectivityCheckResult` (and its three mirrored types across the preload/renderer boundary) needed a new field to represent "nothing to probe" as a state distinct from `connected: false` — extending a duplicated type in four places is inherent to how this codebase already handles the main/preload/renderer boundary (no shared runtime module crosses it), not a new pattern introduced here.
- The dev-only mock M-Pesa provider is now shadowed by the new default: with `confirmationMethod` unset, a dev instance with `VITE_USE_MOCK_MPESA=true` now shows the manual-recording screen instead of the STK form the mock was built to exercise. This is a real, disclosed change in local developer experience (see §7), not a defect — the mock's `initiateStkPush`/`verifyTransactionCode` are unchanged and fully reachable by explicitly setting `confirmationMethod: 'daraja'` in Admin.

## 2. Changes made

- **`src/main/services/mpesa-provider-factory.ts`:**
  - `MpesaConfirmationMethod` widened to `'manual' | 'daraja' | 'sms'`, with doc comments explaining the reversal of `docs/phase-120.md` §7.3.
  - Added `MPESA_MANUAL_MODE_MESSAGE`, shown if any provider method is ever called while in manual mode (should never happen — see the message's own doc comment).
  - `UnconfiguredMpesaProvider` gained an optional constructor `message` parameter (default: the existing `MPESA_NOT_CONFIGURED_MESSAGE`), so it can be reused for manual mode with an accurate message instead of the misleading "not configured" one.
  - `resolveMpesaProvider` now computes `confirmationMethod = options.confirmationMethod ?? 'manual'` and a `manualEntryEnabled` that is always `true` in manual mode (ignoring whatever was stored) and exactly the configured fallback otherwise. A new `if (confirmationMethod === 'manual')` branch returns `UnconfiguredMpesaProvider(MPESA_MANUAL_MODE_MESSAGE)` with `verifyReferenceNumbers: false` (so no dead "Manual Code" tab can ever appear) before the `'sms'`/Daraja branches are reached.
- **`src/main/lib/ipcValidator.ts`:** `mpesaIntegrationConfigSchema`'s `confirmationMethod` field is now `z.enum(['manual', 'daraja', 'sms']).default('manual')` (was `z.enum(['daraja', 'sms']).optional()`), and gained a second `.refine()` rejecting `'sms'` outright while `MPESA_SMS_PARSER_READY` is `false` (imported from `./mpesaSms.js`). The existing "smsInboxPath required for sms" refine is untouched — an `'sms'` payload can now fail one or both refines at once. Updated the doc comment, which used to cite phase-120 §7.3 as the reason manual is absent from the enum — now explains the reversal.
- **`src/main/index.ts`:**
  - Boot resolution: `mpesaConfirmationMethod` is now a three-way check (`'sms'` → `'sms'`, `'daraja'` → `'daraja'`, else → `'manual'`) instead of the old two-way `'sms' ? 'sms' : 'daraja'`.
  - Extracted `mpesaEnvironment` as its own named `const`, computed once from the same fallback chain the Daraja client used inline before — now reused by both `darajaOptions.environment` and the connectivity checker, so they can never disagree.
  - `checkMpesa` in the connectivity monitor now calls the new `checkMpesaConnectivity({ mode: mpesaConfirmationMethod, mockEnabled: mockMpesaEnabled, environment: mpesaEnvironment })` instead of an inline hardcoded-sandbox check.
  - `integrations:mpesa-capabilities`'s response gained a `mode: MpesaConfirmationMethod` field alongside the existing two booleans.
- **`src/main/services/connectivityMonitor.ts`:**
  - `ConnectivityCheckResult` gained an optional `notApplicable?: boolean` field.
  - Added `notApplicableResult(message)`, mirroring `mockDisconnectedResult`'s shape but semantically distinct (a normal state, not a warning).
  - Added `checkMpesaConnectivity(options)` — the extracted, unit-testable decision of how to check M-Pesa reachability: not-applicable for `'manual'`/`'sms'`, `mockDisconnectedResult` if mocked, otherwise `checkHttpReachable` against whichever Daraja base URL matches the given `environment` (fixing phase-147 Part 6 #1 — the old inline version always checked sandbox).
- **`src/preload/index.ts` / `src/preload/window.d.ts`:** `ConnectivityCheckPayload` gained the same `notApplicable?: boolean` field; `getMpesaCapabilities`'s return type gained `mode: MpesaConfirmationMethod` (imported from the main-process factory module, matching how these two files already import several other main-process types for compile-time sharing across the IPC boundary).
- **`src/renderer/src/types/connectivity.ts`:** `ConnectivityCheckPayload` mirrored with the same `notApplicable?: boolean` field.
- **`src/renderer/src/components/NavStatusButton.tsx`:** M-Pesa's row is now `unknown` (slate, neutral) tone when `notApplicable` is set, with its detail text taken from the check's own `error` message ("Manual recording" / "Not available") instead of "Connected"/"Disconnected". The overall header dot's "any bad connectivity" calculation now excludes `mpesaNotApplicable` from counting as bad, mirroring how an untested barcode scanner already doesn't turn the dot red.
- **`src/renderer/src/components/ConnectivityModal.tsx`:** the per-integration detail modal now shows "Not applicable" instead of "Disconnected" for a `notApplicable` result, and renders its message in a neutral slate box instead of the rose "error" box — otherwise tapping through from the header's now-neutral M-Pesa row would land on a modal that still called it a disconnected error, directly contradicting the header.
- **`src/renderer/src/lib/mpesaConfig.ts`** *(new file)*: a renderer-local `MPESA_SMS_PARSER_READY = false` constant, mirroring `main/lib/mpesaSms.ts`'s value the same way `etimsConfig.ts` already mirrors `DEFAULT_ETIMS_BASE_URL` — a renderer file cannot import from the main process, so this repo's existing convention for this exact situation is a small, explicitly-cross-referenced duplicate.
- **`src/renderer/src/components/AdminScreen.tsx`:**
  - `mpesaConfirmationMethod` state widened to `'manual' | 'daraja' | 'sms'`, defaulting to `'manual'`; `loadMpesaConfig`'s parse updated to the same three-way logic as `main/index.ts`'s boot resolution.
  - The M-Pesa section's dropdown now offers all three modes: manual (new, first, worded as the default), Daraja (unchanged wording), and SMS — SMS's `<option>` is `disabled` and its label reads "SMS modem (not available yet)" while `MPESA_SMS_PARSER_READY` is `false`, so a manager already on an old `'sms'` row still sees their own setting but nobody can newly select it (matching the server-side refusal — belt and braces, not the actual gate).
  - All Daraja-only fields (Environment, Shortcode, Consumer Key, Consumer Secret, Passkey, Callback URL) and the "Test Connection" button now render only when `mpesaConfirmationMethod === 'daraja'`.
  - The "Allow recording unverified M-Pesa payments" fallback checkbox now renders only in Daraja mode (hidden entirely in manual mode, where it's meaningless — that mode already works this way for every sale — and in SMS mode, which `PaymentModal` no longer consults it for either).
  - Added a short explanatory note shown only in manual mode ("No Daraja credentials are needed for this mode...").
  - Section heading changed from "M-Pesa (Daraja)" to "M-Pesa" — the old heading actively misnamed the section once it covers three modes with Daraja no longer even the default.
- **`src/renderer/src/components/PaymentModal.tsx`** (the largest change): restructured to branch on a new `mode` state (from `getMpesaCapabilities`, defaulting to `'daraja'` before the reply arrives — the same fail-safe direction the old flags took) instead of the two booleans alone:
  - **`mode === 'sms'`**: a single early return with a plain "M-Pesa by SMS is not available on this till." notice and nothing else.
  - **`mode === 'manual'`**: a single early return showing one screen, headed "Record M-Pesa payment" — no STK form, no tab bar.
  - **`mode === 'daraja'`** (the existing final `return`): the STK form, plus a tab bar with an "Unverified" tab **only** when `manualEntryEnabled` — the "Manual Code" tab (fed by the old `manualCodeSupported`/`verifyReferenceNumbers` flag) is **deleted entirely**, since it is now unreachable in every mode this component handles (manual mode's own `verifyReferenceNumbers` is `false`; Daraja's always was; SMS mode bypasses the tab system altogether). Its supporting state (`manualCodeSupported`, `code`, `verifying`, `verifyError`) and handler (`handleVerifyCode`) were removed along with it.
  - Extracted a shared `renderManualEntryPanel(heading, description)` helper for the code-entry/acknowledgement/manager-PIN form, used by both manual mode's sole screen and Daraja mode's optional Unverified tab — identical mechanics, different framing (manual mode's copy describes normal operation; Daraja's Unverified tab keeps its original "nobody has confirmed this" framing, since there it remains a genuine exception).
  - Rewrote the file's top doc comment to describe the new per-mode rendering and the fail-safe default.

### Deliberate test changes (recorded, as instructed)

- **File:** `tests/mpesaProviderFactory.test.ts`
  - **Old:** six tests (`returns the real provider in a packaged build…`, `returns the real provider when the mock was not requested`, `reports that Daraja cannot verify a reference number`, `refuses everything… when no credentials are saved`, `an unconfigured till can confirm nothing…`, `treats any missing credential as unconfigured`) plus one in the mock-fencing block (`is never selected in a packaged build, whatever the config says`) omitted `confirmationMethod` and relied on it implicitly meaning Daraja.
  - **New:** each now passes `confirmationMethod: 'daraja'` explicitly, so they keep testing what they always meant to (Daraja/mock behavior), not the new default.
  - **Decision that required it:** making `'manual'` the default (this step) means "no `confirmationMethod` passed" no longer resolves to Daraja — these seven tests would otherwise have started silently exercising the manual branch instead of Daraja, without their titles or assertions changing to say so.
  - **Old:** `'still selects Daraja when no method is configured at all'` asserted `DarajaMpesaProvider` and `verifyReferenceNumbers === false`.
  - **New:** `'resolves the manual provider, not Daraja, when no method is configured at all'` asserts the provider is **not** `DarajaMpesaProvider`, `verifyReferenceNumbers === false`, `claimsStoredPayments === false`, and `manualEntryEnabled === true`.
  - **Decision that required it:** this is the literal "what does an unconfigured till now do" test — its own old title was the assumption being reversed.
  - **Added** (not a change to an existing assertion, but new coverage the task's own test list required): `'resolves the manual provider when the method is explicitly manual, even with full Daraja credentials on hand'`, `'never calls a provider method in manual mode without the till-specific refusal message'`, `'ignores a stored manualEntryEnabled=false in manual mode — it is always implied on'`.
- **File:** `tests/ipcValidator.test.ts`
  - **Old:** `'accepts a message-based till with a folder'` asserted `success: true` for `{ confirmationMethod: 'sms', smsInboxPath: '...' }`.
  - **New:** `'rejects a message-based till even with a folder, while the SMS parser is a stub'` asserts `success: false` with a "not available on this till yet" reason.
  - **Decision that required it:** the client's POC decision keeps SMS in code but makes it unselectable until its parser is real — a valid folder is no longer sufficient on its own.
  - **Old:** `'accepts a row with no method at all, which means Daraja'` only checked `success: true`.
  - **New:** `'accepts a row with no method at all, which now means manual'` additionally asserts the schema actually fills in `confirmationMethod: 'manual'`, and a new `'accepts an explicit manual row'` test confirms the enum member round-trips.
  - **Decision that required it:** same default flip, at the schema layer specifically (the `.default('manual')` the task asked for).
- **File:** `tests/adminIntegrationsSections.test.ts`
  - **Old:** `'titles each section distinctly…'` asserted `'M-Pesa (Daraja)</h3>'`.
  - **New:** asserts `'>M-Pesa</h3>'`.
  - **Decision that required it:** the section heading itself changed (§2) because it would otherwise misname two of the three modes it now covers.

### New test files/coverage added

- **`tests/paymentModal.test.ts`** *(new file, 5 tests)*: a real `react-dom/client` mount (the `NeedsAttentionPage.test.ts` pattern, with `window.api` stubbed per test) proving the four rendering guarantees the task's own "TESTS" list asked for: manual mode is one screen with no STK form/tab bar/Manual Code; Daraja without the fallback shows STK only; Daraja with the fallback shows STK+Unverified and never Manual Code; SMS mode shows only the plain unavailable notice; and a rejected/slow capabilities call fails closed to the same STK form as before (unchanged fail-safe behavior, now re-verified against the new code path).
- **`tests/connectivityMonitor.test.ts`** (+9 tests): coverage for `notApplicableResult` and the new `checkMpesaConnectivity`, including the specific claim "daraja uses sandbox or live URL per the setting" (phase-147 Part 6 #1) — asserted directly against `axios.get`'s call arguments, the same technique the file's existing `checkHttpReachable` tests already use.
- **`tests/navStatusButton.test.ts`** (+1 test): M-Pesa reported `notApplicable` renders the same neutral slate tone the untested barcode scanner already does, and does not turn the header's overall dot red.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/main/services/mpesa-provider-factory.ts` | Modified | Which M-Pesa provider a till runs and its reported capabilities — now three-way instead of two |
| `src/main/lib/ipcValidator.ts` | Modified | Server-side validation of `integrations:set-config` for the `mpesa` provider |
| `src/main/index.ts` | Modified | Boot-time M-Pesa resolution, the header connectivity probe, and the capabilities IPC payload |
| `src/main/services/connectivityMonitor.ts` | Modified | Adds a neutral "not applicable" reachability state and the M-Pesa-specific check decision |
| `src/preload/index.ts`, `src/preload/window.d.ts` | Modified | IPC contract types only — `mode` on capabilities, `notApplicable` on connectivity |
| `src/renderer/src/types/connectivity.ts` | Modified | Renderer-side mirror of the same `notApplicable` field |
| `src/renderer/src/components/AdminScreen.tsx` | Modified | M-Pesa section: three-mode dropdown, Daraja-only fields, hidden fallback checkbox in manual mode |
| `src/renderer/src/components/PaymentModal.tsx` | Modified | The cashier-facing M-Pesa screen — now entirely mode-driven |
| `src/renderer/src/components/NavStatusButton.tsx` | Modified | Header status: M-Pesa's row is neutral, not red, when there's nothing to check |
| `src/renderer/src/components/ConnectivityModal.tsx` | Modified | Per-integration detail view, consistent with the header's neutral state |
| `src/renderer/src/lib/mpesaConfig.ts` | Added | Renderer-local mirror of `MPESA_SMS_PARSER_READY`, for the Admin dropdown only |
| `tests/mpesaProviderFactory.test.ts`, `tests/ipcValidator.test.ts`, `tests/adminIntegrationsSections.test.ts` | Modified | Deliberate assertion changes + new coverage (see above) |
| `tests/connectivityMonitor.test.ts`, `tests/navStatusButton.test.ts` | Modified | New coverage, no existing assertions changed |
| `tests/paymentModal.test.ts` | Added | New coverage for `PaymentModal`'s per-mode rendering |

## 4. Possible impact

- **Direct:** a till with no `confirmationMethod` ever saved (fresh install, or one saved before this default existed) now shows the cashier a single "Record M-Pesa payment" screen instead of an STK phone-number form. An admin must explicitly choose "Send a payment request to the customer" to get the old Daraja behavior. The header's M-Pesa status is now a neutral grey "Manual recording"/"Not available" line for manual/SMS tills instead of a red "Disconnected" — this directly removes phase-147 Part 6 #1's "green when payments can't be taken" risk for the Daraja case (now environment-aware) and closes the "manual till always shows red" risk this step's own default would otherwise have created.
- **Indirect:** a developer running the app locally with `VITE_USE_MOCK_MPESA=true` and no `confirmationMethod` configured will now see the manual-recording screen rather than the mock-backed STK form — see §7. `checkout.ts`, `mpesa_payments`, the M-Pesa Logs/Reconciliation pages, and the fiscal integration are all untouched and unaffected — confirmed by the audit in §1.
- **Data / schema / contract:** no database migration. A stored `integrations.mpesa.config_json` row's `confirmationMethod` field, if present, is read exactly as before; only the *interpretation of its absence* changed, and only in application code, not in the stored data.
- **Security posture:** unchanged for this step — the manual-entry gate in `checkout.ts` (manager PIN, code format, acknowledgement, cross-mode uniqueness) is untouched; Step 3 is where the PIN requirement itself changes.
- **Idempotency / re-run safety:** all changes are pure function/schema logic and stateless React rendering — safe to reload, restart, or re-save any number of times.
- **Residual risk:** the Admin dropdown's `disabled` `<option value="sms">` relies on the browser correctly keeping an already-selected-but-now-disabled option visible and selected for a till with a pre-existing `'sms'` row — this is standard, well-supported `<select>` behavior, but was not separately re-verified in an actual browser beyond the source-level test coverage (see §8).

## 5. Verification

- `npm run typecheck` — clean, both node and web projects, re-run after every file group (factory/schema/index/AdminScreen/connectivity, then PaymentModal, then the new test files).
- Targeted test runs during development: `adminIntegrationsSections.test.ts` + `ipcValidator.test.ts` + `mpesaProviderFactory.test.ts` (134 tests, all passing after the deliberate changes above); `paymentModal.test.ts` + `connectivityMonitor.test.ts` + `navStatusButton.test.ts` (42 tests, all passing on first write).
- Full suite: `npx vitest run` — **108 test files, 1628 tests passed**, zero failures (up from phase-148's 107 files / 1612 tests: +1 new file, +16 net tests after the deliberate rewrites and additions above).
- `git status --short` re-checked before and after this step's work — only the 18 files listed in §3 are touched; the unrelated logo-asset commit made outside this session (`df859a4`) was left alone.
- `git diff` of every changed file re-read top to bottom before this report: no accidental deletions, no debug output, no unrelated edits.

## 6. Rollback

`git revert` of this step's commit. This restores: the two-way `MpesaConfirmationMethod` type and Daraja-implicit defaulting everywhere; the un-refined `mpesaIntegrationConfigSchema` (SMS newly saveable again, no default); the hardcoded-sandbox connectivity probe with no neutral state; `PaymentModal`'s tab-boolean-driven rendering including the "Manual Code" tab; and every deliberately-changed test assertion back to its phase-148 wording. Nothing outside the 18 files in §3 was touched, so the revert is clean.

## 7. Observed but not changed

- **Developer/mock testing convenience changed.** With `'manual'` now the default, a dev instance with `VITE_USE_MOCK_MPESA=true` and no `confirmationMethod` set shows the manual-recording screen, not the mock-backed STK form — the mock's `initiateStkPush`/`verifyTransactionCode` fabrication is still fully functional and reachable, just no longer the path a fresh dev config lands on. A developer wanting the old STK/mock dev flow now sets `confirmationMethod: 'daraja'` in Admin (one dropdown change). Not fixed here since the task gave no dev-mode exception to the default.
- **`manualCodeSupported`/`window.api.verifyMpesaCode` left in the backend contract, now unused by any renderer surface.** `PaymentModal` was the field's only consumer and no longer reads it (the top-level `mode` branch replaces it). Removing the field and its underlying `mpesa:verify-code`-style IPC plumbing entirely was out of scope for this step — `verifyTransactionCode` remains a legitimate part of the provider contract (used server-side by `checkout.ts`'s SMS-mode path), and the capabilities payload still reports it in case another consumer is added later.
- **The disabled SMS `<option>`'s exact cross-browser behavior for an already-selected-but-disabled value** was verified at the source/test level (§4's residual risk) but not against a real browser render — flagged for the human check in §8.
- Everything Step 3 explicitly owns (removing the per-sale manager PIN for manual entries, cashier attribution, the "positive attestation" copy change) was **not** touched here — `checkout.ts`'s manual-approval gate, `PaymentModal`'s `renderManualEntryPanel` PIN flow, and the amber "unverified" framing on the Daraja fallback tab are all exactly as they were before this step.

## 8. What only a human can check

- Opening Admin → Integrations → M-Pesa on a fresh till and confirming the dropdown defaults to "Record the code myself…", the Daraja fields are hidden until Daraja is chosen, and the SMS option is visibly greyed out with its "not available yet" label.
- A till with a pre-existing `confirmationMethod: 'sms'` row (simulated, since no live SMS-configured till exists) still shows its own current SMS selection in the dropdown (disabled, not silently reset) after this change.
- The header status dialog showing "M-Pesa — Manual recording" in a neutral grey on an actual running till, and that tapping it opens a `ConnectivityModal` that agrees ("Not applicable", not "Disconnected").
- A real cashier flow through the new "Record M-Pesa payment" single-screen manual mode, including the still-required manager PIN (unchanged from before this step — Step 3 removes it).

---

**STOP — Step 2 complete, awaiting review before Step 3 (manual mode at the till, no per-sale approval).**
