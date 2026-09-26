# Phase 147 — M-Pesa audit: every feature, every configuration source, every effect, and the coupling with KRA/eTIMS (read-only)

- **Date:** 2026-09-26
- **Requested:** A complete, evidence-based map of how M-Pesa works today in rubis-pos-desktop — every feature, every place its configuration comes from or is written, what each setting actually does, and every point where M-Pesa configuration is coupled to the KRA/eTIMS (fiscal) configuration, so the two can eventually be split. **Read-only. No code, config, database row, or vault entry was changed.**
- **Outcome:** Audit complete. STOP for review, per the request — no follow-up implementation started.
- **Branch / base commit:** staging @ c8ea512 (Phase 146)
- **Method:** Five parallel research passes across the codebase (feature inventory, configuration sources, config writers, the checkout-pad flow end to end, and M-Pesa/fiscal coupling), each required to cite `file:line` for every claim, cross-checked against `docs/phase-101.md`, `phase-102.md`, `phase-103.md`, `phase-120.md`, `phase-121.md`, `phase-122.md`/`phase-126.md`, `phase-142.md`/`phase-143.md` for historical context, then verified against the current working tree rather than trusted at face value. No secret value (consumer key/secret, passkey, device password) was printed anywhere in this audit — only presence/location.
- **Note on `docs/phase-122.md`:** the file at that name today is a September 2026 assessment of an unrelated proposed LIVE/DRY-RUN fiscal switch and does **not** contain the "M-Pesa Save refuses without a valid fiscal device IP/port" claim this task's brief attributed to it. `docs/phase-126.md:59` records an instruction to delete the old `phase-122.md`, so the filename appears to have been reused after the original content was retired. The underlying claim was independently re-verified directly against current code (§3, §7) and holds true at a corrected citation.

---

## Part 1 — Feature inventory

### 1.1 Daraja STK Push — **LIVE**, architecturally polling-only, no inbound webhook

- **Initiate:** `DarajaMpesaProvider.initiateStkPush` (`src/main/services/integrations/daraja-mpesa-provider.ts:170-227`) does a real OAuth2 client-credentials exchange (`getAccessToken`, lines 312-341) then POSTs Safaricom's standard Lipa Na M-Pesa Online payload to `/mpesa/stkpush/v1/processrequest`. Reached from the renderer via IPC `integrations:mpesa-stk-push` (`src/main/index.ts:1158-1162`), called from `PaymentModal.handleSendStkPush` (`src/renderer/src/components/PaymentModal.tsx:224-257`).
- **Status polling:** `src/renderer/src/lib/mpesaPaymentPoller.ts` polls every 5s (`MPESA_POLL_INTERVAL_MS`, line 15) via IPC `mpesa:query-status` (`src/main/index.ts:1281-1306` → `queryStkPushStatus`, `daraja-mpesa-provider.ts:263-305`), for up to 90s (`MPESA_POLL_TIMEOUT_MS`, line 23). `ResultCode === '0'` = success, `{'1032','1'}` = failure, Daraja's `500.001.1001` "still processing" = pending.
- **Timeout:** the poller's `tick()` (`mpesaPaymentPoller.ts:85-114`) fires `onTimeout()` at 90s, surfaced by `PaymentModal` as `{ kind: 'failed', reason: 'Payment timed out…' }` (`PaymentModal.tsx:211-217`).
- **Cancel:** "Cancel Payment" only stops the *till* from watching the request (`stopPolling()`/`onCancel()`, `PaymentModal.tsx:158-162, 298-301`) — there is **no cancel call to Daraja anywhere in the codebase**. A prompt can still complete on the customer's phone after the till walks away; the only backstop is that `runCheckout`'s gate still requires `hasConfirmedStkPayment(reference)` before a sale can complete (`checkout.ts:429-433`).
- **Callback URL — this till cannot receive an inbound Daraja callback, full stop.** `DarajaMpesaProvider`'s own file header says so (`daraja-mpesa-provider.ts:65-73`): Safaricom requires a publicly reachable HTTPS URL, which a till cannot offer; `DEFAULT_CALLBACK_URL = 'https://example.com/callback'` (line 73) is the fallback. A repo-wide search finds **no HTTP server anywhere in the codebase** that could receive it (`createServer`/`express`/`.listen(` — the only hit is the unrelated local fiscal-device server). `MpesaLogsPage.tsx:22-26` and `main/index.ts:1277` both document this in comments. **This app relies purely on client-side polling; it cannot receive an inbound Daraja webhook at all**, regardless of network/firewall configuration, because no listener exists in the code to be reached.

### 1.2 The Daraja "Manual Code" tab — **LIVE in the UI**, but dead-ends on every reachable production configuration

- `DarajaMpesaProvider.verifyTransactionCode` (`daraja-mpesa-provider.ts:244-252`) unconditionally returns failure — Daraja has no endpoint to verify a code after the fact.
- The tab shows when `manualCodeSupported` (= the resolved `verifyReferenceNumbers` capability flag) is `true` (`PaymentModal.tsx:426-436`). That flag is `true` for: the dev-only mock, a real `SmsMpesaProvider`, **and** the `UnconfiguredMpesaProvider` fallback (deliberately, `mpesa-provider-factory.ts:225-238`, comment at line 230: "so the refusal above is what the cashier reads"). It is `false` only for a correctly configured, real Daraja provider.
- **Net effect on any till that could exist in production:** unconfigured Daraja → tab shows, always fails with "not configured"; SMS mode → tab shows, always fails with "hasn't come through yet" (§1.4 explains why); correctly configured Daraja → tab is hidden entirely (the one case that doesn't dead-end, because it isn't shown). Dev mock → works, but can't reach a packaged build (§1.5).

### 1.3 The manual "Unverified" entry (phase-121) — **LIVE**, fully wired

- `manualEntryEnabled` (`integrations.mpesa.config_json`, schema `src/main/lib/ipcValidator.ts:431-454`), toggled in Admin → Integrations → M-Pesa ("Allow recording unverified M-Pesa payments", `AdminScreen.tsx:1292-1310`, with the on-screen warning "Nothing checks that the payment really happened").
- Code format `^[A-Z0-9]{10}$` enforced client-side (`PaymentModal.tsx:14, 267-280`) and again, authoritatively, server-side (`checkout.ts:123, 396-398`).
- Acknowledgement checkbox required client-side (`PaymentModal.tsx:569-578`) and re-checked server-side (`checkout.ts:399-401`).
- Manager PIN verified **server-side only**, before `runCheckout` is even called (`requireAdminPin`, `index.ts:1050-1054`; `requireAdminPin.ts:43-57`, requires `role==='admin'`) — the raw PIN never reaches `runCheckout`, only the already-verified `approvedByStaffId` (`index.ts:1055-1058`).
- Gate order in `checkout.ts:386-434`: `manualEntryEnabled` on → code format valid → acknowledged → not already recorded under **any** mode (`hasRecordedMpesaPayment`, the phase-121 cross-mode guard) → writes an `orders` row + one `mpesa_payments` row in one transaction (`queueOrderRecordingManualPayment`, `database.ts:2163-2181`); a duplicate code **throws and rolls the whole sale back** (treated as abuse, not tolerated).
- Reconciliation page (`MpesaReconciliationPage.tsx`) lists every `verification_status='manual_unverified' AND reconciled_at IS NULL` row; "Mark checked" re-verifies the manager PIN and sets `reconciled_at`/`reconciled_by_staff_id` — **`verification_status` never changes**, by design; the row is permanently filed as `manual_unverified` even after reconciliation.
- **Open, documented gap (phase-121 §9.3, still unfixed today):** the reverse cross-mode check is missing — a manual entry followed by the same code's SMS confirmation later arriving and being claimed by a *different* sale is not blocked (`queueOrderClaimingSmsPayment`, `database.ts:2048-2082`, has no `hasRecordedMpesaPayment` check). Currently moot only because SMS confirmations can never arrive at all (§1.4).

### 1.4 The SMS/Gammu method (phase-101/103) — infrastructure **LIVE**, payment confirmation **permanently DEAD**

- `parseMpesaPaymentSms` (`src/main/lib/mpesaSms.ts:86-88`) is a hard stub: `return null` unconditionally, with `MPESA_SMS_PARSER_READY = false` (line 68) and a doc comment explaining why (Safaricom's March-2026 format change, one real sample disagreeing with published examples, Till vs Paybill receipts differing again — "guessing here would mean guessing about money").
- **A till can genuinely be configured for it today**: Admin → Integrations → M-Pesa → "How payments are confirmed" → "Read the payment message on this till" (`AdminScreen.tsx:1259-1261`) sets `confirmationMethod: 'sms'`, requires a non-blank inbox path. At boot this really does construct `SmsMpesaProvider` and start `createMpesaSmsInbox`, which really does poll the folder every 3s and decode/reassemble Gammu multipart messages (`mpesa-sms-inbox.ts`, `gammu-inbox.ts` — fully implemented, unit-tested) — but every decoded message is fed to a parser that always returns `null`, so `mpesa_sms_messages` can never actually gain a row in practice.
- **What a cashier sees:** the inbox health check reports, at top priority, "M-Pesa payments by message are not ready on this till yet… Take payment another way." (`mpesa-sms-inbox.ts:150-167`) — but this is only surfaced through `mpesa-sms:list-unmatched`, and **there is no renderer page that calls that channel** (confirmed by a repo-wide `.tsx` grep — phase-121 §9.2 recorded the same gap and it is still true). So the cashier-facing "pick a confirmed message" screen doesn't exist; the only entry point on an SMS-mode till is the Manual Code tab, which (per §1.2) can never succeed.
- **Net effect: `confirmationMethod: 'sms'` is a real, selectable, restart-effective configuration whose file-watching machinery genuinely runs, but which cannot confirm a single payment today**, and has no cashier UI to work with matched confirmations even if the parser were fixed tomorrow.

### 1.5 The mock M-Pesa provider — correctly **fenced dead** in packaged builds, three independent layers

1. **Runtime gate:** `mockRequested && isPackaged` is explicitly ignored with a warning; the mock branch is only reachable when `!isPackaged && import.meta.env.DEV` (`mpesa-provider-factory.ts:178-198`).
2. **Bundler exclusion:** the mock module is only ever dynamically `import()`-ed behind that `DEV` check, so Vite/electron-vite drops it from the production bundle.
3. **Build-time assertion:** `scripts/verify-no-mock-provider.cjs` greps every file in `out/main` for the literal string `MockMpesaProvider` and fails the build if found; wired into `postbuild` (`package.json:27`), which runs automatically from `dist`.
- M-Pesa's mock also now defaults to **off** when unset (`index.ts:648`), closing the stale phase-102 default-on hole.

### 1.6 Recording tables

| Table | Meaning | Linked to a sale? | Consumed by |
|---|---|---|---|
| `mpesa_transactions` | One row per STK Push **attempt**, any outcome (`database.ts:431-442`), written by `mpesa:log-transaction` before/after the push. | `order_local_id` is **always NULL in practice** — both callers fire before the order exists (phase-121 §2 documented this; still true). Link to a sale exists only indirectly, via `hasConfirmedStkPayment` string-matching the reference at checkout time. | `MpesaLogsPage.tsx` (status pills, manual "Check Status" per pending row). |
| `mpesa_sms_messages` | One row per confirmation SMS the till's modem received (`database.ts:459-474`). | `matched_order_local_id` set only when a sale claims the row — but per §1.4 this table is permanently empty in practice. | Nothing in the renderer today; only read internally by `SmsMpesaProvider`. |
| `mpesa_payments` | The unified settlement ledger (phase-121, `database.ts:583-599`), `order_local_id NOT NULL`, `mode IN ('daraja','sms','manual')`, `UNIQUE(mode, reference)`. **The only one of the three with a guaranteed, non-null link to the order it paid for.** | Yes, always. | `MpesaReconciliationPage.tsx` (manual_unverified subset only); the full-history `mpesa:list-payments` channel exists but **has no renderer page consuming it** today. |

- None of the three foreign-key columns (`order_local_id`, `matched_order_local_id`) are declared as SQL-level `FOREIGN KEY` constraints anywhere in the schema — the linkage is enforced only in application code.
- **The daily figures / Z-report bypass all three tables entirely**: `src/main/services/reports.ts:67,70` sums `orders.total` for every row where `orders.payment_method === 'mpesa'`, independent of `mpesa_payments.verification_status`. A `manual_unverified` sale counts identically toward the shift's "M-Pesa" total as a fully Daraja-confirmed one.

### 1.7 Header status (`NavStatusButton`) and the connectivity monitor's M-Pesa probe — weak, environment-blind, credential-blind

- `NavStatusButton.tsx:104,169-174` renders `connectivityStatus.mpesa.connected` from `checkMpesa` (`index.ts:900-905`):
  ```ts
  const DARAJA_SANDBOX_HOST = 'https://sandbox.safaricom.co.ke'
  checkMpesa: () => mockMpesaEnabled
    ? Promise.resolve(mockDisconnectedResult('M-Pesa mock mode enabled'))
    : checkHttpReachable(DARAJA_SANDBOX_HOST)
  ```
  `checkHttpReachable` (`connectivityMonitor.ts:139-158`) is a plain unauthenticated `axios.get` with `validateStatus: () => true` — **any** HTTP response, including 4xx/5xx, counts as connected; only a transport-level failure counts as disconnected. No OAuth token, no consumer key/secret, no STK Push or query is ever attempted by this probe.
- **"Connected" does not mean "can take a payment."** It means only "an HTTPS GET to Safaricom's sandbox host got any response within 5s." It is blind to: whether credentials are configured at all (an `UnconfiguredMpesaProvider` till still probes this same fixed host and can show green); whether credentials are valid (no OAuth call happens here); and — critically — **it always probes the SANDBOX host regardless of the till's configured `environment`** (`DARAJA_SANDBOX_HOST` is a hardcoded constant with no branch on `mpesaConfig.environment`, unlike the fiscal checker right below it, which correctly re-reads the live device baseUrl on every check, `index.ts:906-917`). A production-configured till reachability-checks the wrong host entirely.
- Mock mode is deliberately shown as disconnected (an honest signal, `index.ts:890-899`).
- SMS-mode tills get the exact same Daraja-sandbox-liveness probe — there is no SMS-specific health check wired into the header at all; the real SMS health signal (`describeInboxHealth`) is a separate, unsurfaced code path.

---

## Part 2 — Every configuration source and its precedence

### 2.1 Env keys

| Key | File:line (value) | Read as | Timing |
|---|---|---|---|
| `VITE_USE_MOCK_MPESA` | `.env:15` (`false`); `.env.example:47` | `process.env.VITE_USE_MOCK_MPESA` — `index.ts:435,648` | Main process, boot-only. Despite the `VITE_` prefix, never read via `import.meta.env` anywhere in the renderer (zero grep hits) — it is not build-time-inlined. |
| `MPESA_CONSUMER_KEY` | `.env:18` (blank); `.env.example:66` | `index.ts:711` | Main process, boot-time fallback under DB `consumerKey`. |
| `MPESA_CONSUMER_SECRET` | `.env:19`; `.env.example:67` | `index.ts:693` | Main process, boot-time fallback, used only if vault has nothing. |
| `MPESA_SHORTCODE` | `.env:22` = `174379`; `.env.example:68` | `index.ts:713` | Main process, boot-time fallback under DB `shortcode`. |
| `MPESA_PASSKEY` | `.env:23`; `.env.example:69` = Safaricom's published sandbox passkey | `index.ts:697` | Main process, boot-time fallback, used only if vault has nothing. |
| `MPESA_ENVIRONMENT` | `.env:24` = `sandbox`; `.env.example:70` = `sandbox` | `index.ts:716-717` (`=== 'production' ? 'production' : 'sandbox'`) | Main process, boot-time fallback under DB `environment`. Anything other than the exact literal string `'production'` — including a typo or `'prod'` — silently resolves to `'sandbox'`. |
| `MPESA_CALLBACK_URL` | Not present in the committed `.env`; only `.env.example:71` | `index.ts:718` | Main process, boot-time fallback under DB `callbackUrl`, falling further to the provider's own internal default. |

No other `VITE_MPESA_*`/`MPESA_*` keys exist anywhere in the codebase. **Every M-Pesa env var is read from `process.env` inside the Electron main process, exclusively during boot — none are ever read via `import.meta.env`, so none are baked into the renderer's Vite bundle.**

### 2.2 `configMigration.ts` — env → DB seeding

- Seeds exactly two keys into `app_configurations`: `mock_mpesa_enabled` and `mock_etims_enabled` (`configMigration.ts:56-57`). It does **not** seed `consumerKey`/`shortcode`/`environment`/`callbackUrl` — those stay a pure runtime fallback chain in `index.ts`, never copied into the DB.
- **Runs once, guarded by a flag:** `settings` table key `config_migration_v1_complete` (`configMigration.ts:14,40,59`); `migrateEnvConfigToDatabase` is called unconditionally every boot (`index.ts:434-437`) but is a no-op after the first successful run.
- Per-key idempotent even within the first run: never overwrites an existing DB value (`seed()`, lines 42-54).
- **Disagreement resolution after first boot: DB wins, forever.** `index.ts:657-658`: `db.getConfig('mock_mpesa_enabled') ?? (rawMockMpesa === 'true' ? 'true' : 'false')` — the `??` only falls through when the DB cell is literally `null`. Editing `.env` post-first-boot has zero effect unless the DB row is cleared or the Admin toggle is used — explicitly warned about in `.env.example:36-40`.
- **Default semantics differ by domain:** M-Pesa defaults to **mock** when the env var is entirely absent (`mockWhenUnset=true`, "so a fresh till never charges a real customer by accident"); eTIMS defaults to **real** (`mockWhenUnset=false`). Because this repo's bundled `.env` does set `VITE_USE_MOCK_MPESA=false`, a fresh install from this exact tree seeds `false` (real) on first boot, matching the env — the mock-by-default fallback would only bite an install that shipped with no `.env` at all.

### 2.3 The `integrations` table's `mpesa` row

- Schema: `provider TEXT PRIMARY KEY, config_json TEXT NOT NULL DEFAULT '{}'` (`database.ts:421-424`) — one row per provider, a JSON blob.
- Fields the `mpesa` row can hold (`ipcValidator.ts:431-454`, `index.ts:666-674`): `consumerKey`, `shortcode`, `environment` (`sandbox`|`production`), `callbackUrl`, `confirmationMethod` (`daraja`|`sms`), `smsInboxPath` (required by `.refine()` when `confirmationMethod==='sms'`), `manualEntryEnabled`. `consumerSecret` and `passkey` never touch this row by design — they live only in the vault (§2.5).
- **`setIntegrationConfig` is a confirmed whole-row replace, no merge:** `database.ts:1855-1861` — `INSERT ... ON CONFLICT(provider) DO UPDATE SET config_json = excluded.config_json`. Any caller sending a partial object silently deletes every field it omitted.
- **Is this exploited today? Not currently** — the single writer, `AdminScreen.tsx`'s `handleSaveIntegrationsConfig` (`:483-496`), always sends all seven fields together, sourced from React state populated by a full read on tab-open. The safety is a **UI convention, not an enforced invariant** — there is no schema-level or DB-level protection, and a future partial-write caller (or a load that partially failed while the tab stayed open) would silently wipe the rest of the row.
- Note: because `integrations` is keyed per-provider, saving `'mpesa'` **cannot** directly overwrite the `'etims'` row's JSON blob at the database layer, or vice versa — the whole-row-replace risk is confined within each domain's own row.

### 2.4 `settings` / `app_configurations`

- `settings` — plain key/value, only holds the migration-complete flag; no M-Pesa business setting lives here.
- `app_configurations` — one M-Pesa key, `mock_mpesa_enabled` (`category='mpesa'`), read at `index.ts:657-658`, written by `configMigration.ts:56` (first boot) or IPC `config:set` (`index.ts:1421-1444`) from the Admin "Startup Configuration" panel. **Per-key upsert, not whole-blob** (`setConfig`, `database.ts:2346-2363`) — setting this key cannot affect `mock_etims_enabled` or any other key. PIN-gated.

### 2.5 The secret vault

- Backed by Electron `safeStorage` (`secretStore.ts`), ciphertext in `userData/secret-vault.json`, owner-only file permissions.
- Two M-Pesa accounts under service `RUBIS POS`: `mpesa-consumer-secret`, `mpesa-passkey`.
- **Set:** IPC `secrets:set-mpesa-credentials` (`index.ts:1341-1372`), PIN-gated, and this **is** a genuinely safe partial update — a blank field in the Admin form means "leave the stored value alone" (`AdminScreen.tsx:509-522`), and each field is written independently.
- **Read:** boot-only, twice (`index.ts:692,696`), each falling back to the corresponding `.env` var then `''`. No per-request re-reads — `DarajaMpesaProvider` captures both as `private readonly` constructor fields (`daraja-mpesa-provider.ts:141-168`). A status-only check (booleans, never values) is exposed for the Admin screen via `secrets:get-mpesa-status`.
- **Precedence:** vault → env → empty string, resolved once at boot. Saving new vault values has **no effect until restart** — stated explicitly in a code comment (`index.ts:1332-1339`).

### 2.6 Boot-time resolution — `resolveMpesaProvider`

Called exactly **once** per process lifetime, inside `app.whenReady()` (`index.ts:704`).

**Inputs assembled just before the call** (`index.ts:648-720`): `mockRequested` (DB → env → `'false'`), `confirmationMethod` (integrations row, default `'daraja'`), `manualEntryEnabled` (integrations row, default `false`), `smsDb` (always the live `db` handle), and the full `darajaOptions` bundle (consumerKey/consumerSecret/shortcode/passkey/environment/callbackUrl per the chains in §2.1/§2.3/§2.5).

**Decision logic** (`mpesa-provider-factory.ts:172-246`):
1. `mockRequested && isPackaged` → warning, mock request **ignored**, falls through to real logic. A packaged build can never get the mock.
2. `mockRequested && !isPackaged && import.meta.env.DEV` → `MockMpesaProvider`.
3. `confirmationMethod === 'sms'` → `SmsMpesaProvider` if `smsDb` present (always true in practice) else `UnconfiguredMpesaProvider`.
4. Else, if Daraja credentials incomplete (`isDarajaConfigured`) → `UnconfiguredMpesaProvider`.
5. Else → `DarajaMpesaProvider`.

**Capability flags** (exact names): `verifyReferenceNumbers` (`true` for mock/SMS/unconfigured, `false` only for real Daraja — Daraja's STK scope has no receipt-lookup endpoint); `claimsStoredPayments` (`true` only for SMS, governs whether a confirmation is "spent" on use); `manualEntryEnabled` (a pass-through policy switch, identical on every branch, orthogonal to which provider was chosen).

**Frozen vs re-evaluated:** the resolved provider instance and all three flags are captured by closure into the `orders:checkout` handler (`index.ts:1061-1072`) for the rest of the running process. **Everything M-Pesa is boot-time-frozen** — unlike eTIMS, which has `applyEtimsConfigToProvider()` to hot-apply Admin changes (`index.ts:773-…`, invoked live from the eTIMS save path), **there is no equivalent function for M-Pesa anywhere in the codebase.** Every M-Pesa Admin-screen save requires a full app restart to take effect, with no live-reload path at all.

### 2.7 Sandbox vs production

- Base URLs (`daraja-mpesa-provider.ts:26,29`): sandbox `https://sandbox.safaricom.co.ke`, production `https://api.safaricom.co.ke`, selected in the constructor by `options.environment === 'production' ? PROD : SANDBOX` (lines 164-165) — anything other than the exact string `'production'` silently selects sandbox. Verified against Safaricom's own published Daraja documentation via web search on 2026-09-26 (direct fetch of `developer.safaricom.co.ke/APIs/MpesaExpressSimulate` 404'd; confirmed instead via aggregated sources citing the same Safaricom-documented base URLs, checked the same date) — matches the code.
- **What the currently bundled `.env` selects:** `MPESA_ENVIRONMENT=sandbox`, `MPESA_SHORTCODE=174379` (Safaricom's published sandbox test Paybill shortcode), `VITE_USE_MOCK_MPESA=false`. The already-built `release/win-unpacked/resources/.env` in this working tree carries identical values, confirming the last packaging run shipped sandbox.
- **What a fresh dev DB seeds:** with no `integrations.mpesa` row yet, the code falls to the env parse — sandbox today; if `.env` were absent entirely, the code's own fallback still defaults to sandbox (safe-by-default). The Admin screen's own React state defaults identically (`useState<'sandbox'|'production'>('sandbox')`).
- **Shortcode type / `TransactionType`:** `TransactionType` is **hardcoded** to `'CustomerPayBillOnline'` (`daraja-mpesa-provider.ts:191`) — the string `'CustomerBuyGoodsOnline'` does not appear anywhere in this codebase. Per Safaricom's documentation, a **Till/Buy Goods** shortcode requires `CustomerBuyGoodsOnline` and a `PartyB` set to the till number, not the paybill shortcode. **This integration only correctly supports Paybill-type shortcodes today** — a real Till number (a very common Kenyan retail setup) would send the wrong transaction type.
- **If a till were built and shipped today from this repo's exact current committed defaults:** it would target Daraja **sandbox** (the code's own safe fallback matches the committed `.env`). Because the committed `.env`'s consumer key/secret fields are blank, `isDarajaConfigured()` would return `false` and the till would actually resolve to `UnconfiguredMpesaProvider` — refusing every M-Pesa payment — until an admin fills in real credentials. Filling in the two blank fields **without also flipping `MPESA_ENVIRONMENT` to `production`** would silently ship a "live-looking" till still talking to Safaricom's sandbox.

### 2.8 Precedence table

| Setting | Sources (highest → lowest) | Read when | Written by | PIN-gated? | Restart needed? | Effect |
|---|---|---|---|---|---|---|
| Mock vs real provider | `app_configurations.mock_mpesa_enabled` → `.env VITE_USE_MOCK_MPESA` → default | Boot only | `configMigration` (first boot) / Admin "Startup Configuration" → `config:set` | Yes | Yes (explicit restart modal) | Packaged builds ignore a `true` request regardless |
| `consumerKey` | `integrations.mpesa.consumerKey` → `.env MPESA_CONSUMER_KEY` → `''` | Boot only | Admin Integrations M-Pesa → `integrations:set-config` (whole-row overwrite) | Yes | Yes (no live re-apply) | Part of Daraja OAuth Basic-auth pair |
| `consumerSecret` | OS vault → `.env MPESA_CONSUMER_SECRET` → `''` | Boot only | `secrets:set-mpesa-credentials` (safe partial write) | Yes | Yes | Same |
| `shortcode` | `integrations.mpesa.shortcode` → `.env MPESA_SHORTCODE` → `''` | Boot only | `integrations:set-config` | Yes | Yes | `BusinessShortCode`/`PartyB` on every STK Push |
| `passkey` | OS vault → `.env MPESA_PASSKEY` → `''` | Boot only | `secrets:set-mpesa-credentials` | Yes | Yes | Builds the STK `Password` field |
| `environment` | `integrations.mpesa.environment` → `.env MPESA_ENVIRONMENT==='production'` test → `'sandbox'` | Boot only | `integrations:set-config` | Yes | Yes | Selects the axios base URL, once, in the constructor |
| `callbackUrl` | `integrations.mpesa.callbackUrl` → `.env MPESA_CALLBACK_URL` → provider's internal default | Boot only | `integrations:set-config` | Yes | Yes | Sent as `CallBackURL` (unreachable regardless, §1.1) |
| `confirmationMethod` | `integrations.mpesa.confirmationMethod` → `'daraja'` default | Boot only | `integrations:set-config` | Yes | Yes | Chooses Daraja/SMS/Unconfigured branch; also gates whether the SMS inbox watcher starts |
| `smsInboxPath` | `integrations.mpesa.smsInboxPath` → `''` | Boot only | `integrations:set-config` (required when `confirmationMethod==='sms'`) | Yes | Yes | Folder the SMS watcher polls |
| `manualEntryEnabled` | `integrations.mpesa.manualEntryEnabled` → `false` default | Boot only | `integrations:set-config` | Yes | Yes | Permits the Unverified checkout path, independent of `confirmationMethod` |
| `verifyReferenceNumbers` (derived) | Computed inside `resolveMpesaProvider` | Boot only | n/a | n/a | Yes (recomputed only on restart) | Whether the Manual Code tab shows and whether `checkout.ts` trusts provider verification |
| `claimsStoredPayments` (derived) | Same | Boot only | n/a | n/a | Yes | Whether an SMS confirmation is "spent" on use |

---

## Part 3 — Every writer

### 3.1 Onboarding — does **not** touch M-Pesa

`OnboardingScreen.tsx` collects only Shopify store URL/API token and one Shopify location. A grep for `mpesa`/`Mpesa`/`MPESA` across `OnboardingScreen.tsx` and `App.tsx` returns zero matches. **M-Pesa cannot be configured during first-run setup at all — only later, from the Admin screen.**

### 3.2 Admin → Integrations → M-Pesa (its own section since Phase E2(e))

Phase E2(e) split the old single stacked "Integrations" tab into five sub-sections (`integrationSection` state: `shopify|location|fiscal|mpesa|printer`, `AdminScreen.tsx:117-119`). M-Pesa now has its own visually distinct section (`AdminScreen.tsx:1169-1338`) with: environment select, shortcode, consumer key, consumer secret (write-only), passkey (write-only), callback URL, confirmation-method dropdown, conditional SMS-inbox-path field, the manual-entry checkbox, and a "Test Connection" button. **Visually separate from Fiscal Device (`:1340-1561`) — but see Part 7 for why this separation is cosmetic underneath.**

### 3.3 `integrations:set-config` (provider `mpesa`)

- Renderer: `AdminScreen.tsx:483-496`, inside `handleSaveIntegrationsConfig` (`:451-537`). Main handler: `index.ts:1480-1520`.
- **Renderer-side validation:** none specific to M-Pesa fields beyond `.trim()`. The *only* client-side gate able to block this call is the **eTIMS** field validator (§7.2) — an unrelated section's fields can block M-Pesa's own save.
- **Main-side validation:** `mpesaIntegrationConfigSchema` (`ipcValidator.ts:431-454`) — every field optional, one `.refine()` requiring `smsInboxPath` when `confirmationMethod==='sms'`. No format checks on shortcode (not required numeric) or callback URL (not required to be a URL, unlike Shopify's own schema). Renderer and main are consistent with *each other* on M-Pesa's own fields — the inconsistency is cross-feature (§7.2).
- **PIN-gated:** yes, server-side (`requireAdminPin`, `index.ts:1487-1490`).
- **What it writes:** whole-row replace of `integrations.mpesa.config_json` (§2.3). Cannot directly touch the `etims` row at the DB layer (separate primary-key rows) — but see the stale-state risk noted in §2.3/§6.
- **Effect timing:** boot-time-frozen (§2.6). Success message is a bare `'Settings saved.'` — **no restart prompt, no `RestartCountdownModal`**, unlike the honest System-tab mock-toggle flow (§3.5). The only restart-related text anywhere in the M-Pesa section is the manual-entry checkbox's own note ("Takes effect after a restart") — nothing next to shortcode/consumer key/environment/callback URL/confirmation method says the same, even though all of them are equally restart-bound.

### 3.4 `secrets:set-mpesa-credentials`

- Renderer: `AdminScreen.tsx:514-522` (called only if a field is non-blank). Main: `index.ts:1341-1372`.
- Schema `mpesaCredentialsSetSchema` (`ipcValidator.ts:362-369`) requires at least one of `consumerSecret`/`passkey` non-blank — consistent with the renderer's own skip-if-blank logic.
- PIN-gated. Each field written **independently** to the vault — a genuinely safe partial update, unlike §3.3's whole-row config write.
- Same boot-time-frozen effect timing as §3.3, same lack of a restart prompt on this screen.

### 3.5 `config:test-mpesa` ("Test Connection")

- Renderer: `AdminScreen.tsx:565-578`. Main: `index.ts:1382-1394`.
- **Does a real Daraja OAuth2 token exchange** (`DarajaMpesaProvider.testCredentials()` → `getAccessToken()`), not mere presence-checking — a real HTTP call, Basic-Auth'd with `consumerKey:consumerSecret`, against whichever base URL the provider was constructed with.
- **Caveat:** because credentials are `private readonly` fields fixed at construction, Test Connection always exercises whatever was loaded **at last app boot** — never a freshly typed-but-unsaved-or-unrestarted value. An admin who edits the shortcode/consumer key and clicks Test Connection immediately is testing the *old* credentials.
- No PIN gate (correctly — it's read-only).

### 3.6 `config:set` (`mock_mpesa_enabled`) — the one honestly-communicated writer

- Renderer: `AdminScreen.tsx:410-444` (`handleSaveStartupConfigs`). Main: `index.ts:1420-1444`. PIN-gated.
- **This is the only M-Pesa write path with an honest restart UX**: the panel text states outright "a change here only takes effect after a restart," the button reads "Save & Restart," and on success it shows `RestartCountdownModal` with an actual restart action (`AdminScreen.tsx:905-907,943-949,1954-1958`).

### 3.7 Env-to-DB migration — no dedicated script for M-Pesa

No migration script or startup routine writes `.env` M-Pesa values into the DB or vault — they are only read as in-memory fallbacks each boot, never persisted. This contrasts with eTIMS, which has a one-time plaintext→vault password migration (`resolveEtimsDevicePassword`, `index.ts:727-732`); there is no M-Pesa equivalent, and `scripts/` contains no M-Pesa config-migration file.

### 3.8 The phase-122-cited validation gate — confirmed, at a corrected citation

**Confirmed against current code, at `AdminScreen.tsx:466-478`** (shifted from the originally reported `:456-463`), inside `handleSaveIntegrationsConfig`:
```ts
const fieldErrors = validateEtimsConnection({ baseUrl, deviceIp, devicePort })
if (fieldErrors.length > 0) {
  setEtimsFieldErrors(...)
  setIntegrationsMessage('Check the highlighted fiscal device details above.')
  return   // aborts the entire save, including M-Pesa fields
}
```
`validateEtimsConnection` (`src/renderer/src/lib/etimsConfig.ts:60-91`) requires a non-blank, valid IPv4 `deviceIp` and a valid 1-65535 `devicePort`, with **no default substituted for `deviceIp`** ("Device IP has no default on purpose," `AdminScreen.tsx:467-469`). This one handler is wired to **both** the M-Pesa section's Save button (`:1330-1336`) and the Fiscal Device section's identical Save button (`:1554-1560`) — see Part 7 for the full coupling analysis and why this survived Phase E2(e)'s otherwise-visual separation.

---

## Part 4 — The checkout pad, end to end

### 4.1 Tab visibility (client)

`PaymentModal.tsx` defines tabs `stk | manual | unverified`, gated by capability flags fetched over IPC and **fail-closed** on any error (`manualCodeSupported`/`manualEntryEnabled` both default `false` and stay `false` if `getMpesaCapabilities()` errors, lines 138-154). The tab strip only renders at all if either flag is true (line 415); each tab's content is additionally re-guarded at render time against a stale `tab` state outliving a capability flip (lines 512, 544).

One inconsistency found: the two "not configured" fallback branches (SMS-without-db, Daraja-without-credentials) both set `verifyReferenceNumbers: true` purely so the *error message* reads "not configured" rather than "unconfirmed" — but this also makes `manualCodeSupported` report `true`, so the Manual Code tab **is shown** on a misconfigured till even though every attempt dead-ends. Safe (no sale can complete), but confusing.

### 4.2 Phone field

`PHONE_PATTERN = /^254\d{9}$/`, fixed `254` prefix in the UI; input is digit-stripped and one leading `0` is normalized away, then validated before the STK push is sent (`PaymentModal.tsx:55,66-69,104,226`). The main process independently re-normalizes and re-validates against the identical pattern before calling Daraja (`daraja-mpesa-provider.ts:99-104,172`) — defense in depth, not trusting the renderer. No carrier-prefix (Safaricom-range) check exists beyond the length/shape regex; Daraja itself would reject a non-Safaricom MSISDN.

### 4.3 Amount

- Fixed to the cart total by construction: the Amount field is `readOnly disabled` and the modal is entirely replaced by a blocking "Cart is empty" notice if `total <= 0` (`PaymentModal.tsx:90-94,336-351,479-486`). There is no editable amount field on any tab.
- **Integer rounding for STK happens server-side, late, and only there:** `daraja-mpesa-provider.ts:192`, `Amount: Math.round(request.amount)`. The renderer sends the raw float `total` over IPC; only the Daraja client rounds it, right before the wire request.
- **Consequence:** the order/fiscal record uses the **unrounded** total, while Safaricom is charged `Math.round(total)`. For any cart total with a fractional-shilling component, the customer is charged a whole-shilling amount on M-Pesa while the sale/fiscal record shows the exact fractional figure — a small but real reconciliation mismatch that nothing in the renderer closes (`checkoutMath.ts`'s `round2()` rounds to cents, not whole shillings).

### 4.4 UI states and messages

- **Waiting:** full-screen overlay with a live countdown, phone number, amount, and a "Cancel Payment" button (`PaymentModal.tsx:353-376`).
- **Success:** handled invisibly inside the poller's `onSuccess` callback — there is **no dedicated success screen inside `PaymentModal`**; control returns immediately to `PosCheckoutPanel`'s own checkout flow.
- **Timeout:** "Payment timed out — the customer did not respond in time" after 90s of only-pending responses.
- **Customer cancel / wrong PIN / explicit Daraja failure:** all three land on the identical "Payment Not Completed" screen, distinguished only by Daraja's own raw `resultDesc` text (e.g. `"DS timeout user cannot be reached"`) — **the UI does not itself distinguish these cases**, and Safaricom's own wording is not guaranteed to be cashier-legible.
- **Network loss mid-poll — this is the audit's clearest "cashier could be told something misleading" finding.** A failed/erroring `queryStatus` call is treated *identically* to "still pending" (`mpesaPaymentPoller.ts:100-103`): `if (!result.success || !result.data || status==='pending') onPending(...)`. A transient network drop produces no distinct error state at all — it silently keeps counting down the same 90s clock, then times out with the generic "customer did not respond in time" message even when the real cause was this till losing its own network connection, not customer behavior.
- **App restart mid-poll — no recovery exists.** `stkPhase`/poller state is pure in-memory React state (`cartStore.ts`'s persistence explicitly excludes `checkoutStatus`); nothing shadows "a poll is in progress for reference X" to disk. Recovery is entirely manual, via the M-Pesa Logs screen's "Check Status" button — but resolving status there **does not create or link a sale**; there is no UI path to feed a recovered receipt back into checkout as a confirmed Daraja payment. The only route to complete such a sale afterward is the **Unverified** fallback (if `manualEntryEnabled` is on) — which then permanently mislabels a genuinely Daraja-confirmed payment as `manual_unverified`. If manual entry is off, a restart during polling **permanently orphans that payment** with no route to complete the sale against it.
- **Double-tap:** well covered at multiple layers — `stkLoading`/`verifying` disable the relevant buttons, and `cartStore.checkout()`'s own re-entrancy guard (`if (checkoutStatus==='submitting') return`, `cartStore.ts:182-184`) protects both the cash and M-Pesa completion paths from a double-fire; the poller itself is single-flight (`inFlight`/`settled` flags).

### 4.5 Server-side payment gate (`runCheckout`, `checkout.ts:386-434`)

- **All M-Pesa modes** require a non-blank `referenceNumber`.
- **Manual/unverified:** `manualEntryEnabled` true → code format valid → acknowledged → `!hasRecordedMpesaPayment(reference)` (cross-mode uniqueness) → writes order + `mpesa_payments` row in one transaction; a duplicate **rolls back the whole sale**. `verifyTransactionCode` is explicitly never called on this branch.
- **SMS/verifying-provider mode:** calls `mpesaProvider.verifyTransactionCode({transactionCode, amount})`; both a transport failure and `verified:false` block the sale.
- **Daraja mode:** `db.hasConfirmedStkPayment(reference)` — a **local, read-only** `SELECT` against this till's own `mpesa_transactions` (status='success' AND matching receipt/checkout-request id). No claim, no lock — see §4.6.
- Mode/status on the resulting `mpesaSettlement` are always derived from which branch ran, **never trusted from the renderer** — the core anti-spoofing guarantee of this gate.

### 4.6 The Daraja reuse residual — confirmed real, and explicitly scoped out as an accepted risk

This is documented, not hypothetical: `docs/phase-120.md` §10.2 states plainly that `hasConfirmedStkPayment` is read-only with no claim, "so one confirmed STK payment could settle two sales… out of scope, as instructed." `database.ts:2087-2094`'s doc comment on `insertMpesaPayment` repeats the same acknowledgement.

**Mechanism:** `hasConfirmedStkPayment` never marks the matched row as spent — calling it twice with the same reference returns `true` both times, forever. `queueOrderRecordingMpesaPayment` (the Daraja write path) queues the order **unconditionally** and only *attempts* an `ON CONFLICT (mode,reference) DO NOTHING` insert into `mpesa_payments` — a conflicting insert is silently dropped, **but the second order is still queued, fiscalized, and recorded as a completed M-Pesa sale.** Unlike SMS mode (an atomic conditional `UPDATE ... WHERE matched_order_local_id IS NULL`) and manual mode (a hard rollback on unique-conflict), **Daraja mode has no equivalent claim step at all.** The scenario most likely to trigger it in practice is exactly the one this audit found independently: an app restart mid-poll (§4.4) followed by a manual reuse of a known/recovered reference.

### 4.7 Fiscalization — payment method is confirmed **not** sent to the KRA device

`checkout.ts`'s `buildFiscalRequest()` does set `paymentMethod`/`amountTendered` as optional fields on the `FiscalInvoiceRequest` interface — but a full-file grep of both `real-etims-provider.ts` and `mock-etims-provider.ts` for `paymentMethod`/`amountTendered` returns **zero matches in either file**. The real device's `OpenInvoice`/`Sell*`/`CloseReceipt` command sequence carries only company/PIN/address and item/price/tax/PLU fields — `CloseReceipt` itself is sent with an empty payload. **Cash, M-Pesa, and card sales produce byte-identical fiscal command sequences; the KRA invoice/QR code carries no record of tender type at all.** That information exists only in the local `orders` table and `mpesa_payments` ledger.

---

## Part 5 — Conditions → effects matrix

| Configuration | Provider selected | Flags (`verifyRef` / `claims` / `manualEntry`) | Tabs shown to cashier | Can an M-Pesa sale complete? | What's recorded | Header "M-Pesa" status |
|---|---|---|---|---|---|---|
| **Daraja configured, sandbox, manual entry off** | `DarajaMpesaProvider` (sandbox URL) | false / false / false | STK only | Yes, via confirmed poll | `mpesa_transactions` (attempt) + `mpesa_payments` (mode=daraja, confirmed) | Green if sandbox host reachable — matches reality here |
| **Daraja configured, production, manual entry off** | `DarajaMpesaProvider` (production URL) | false / false / false | STK only | Yes | Same tables | Still probes the **hardcoded sandbox** host regardless — status is disconnected from what's actually being called (§1.7); can mislead in either direction |
| **Daraja not configured (blank creds)** | `UnconfiguredMpesaProvider` | true (forced, for messaging) / false / per-admin-setting | Manual Code (always dead-ends) + Unverified (if enabled) | Only via Unverified, if enabled and a manager PINs it; otherwise no route at all | Nothing for STK; `mpesa_payments` (manual_unverified) if Unverified used | **Still green if the sandbox host is merely reachable — the probe never checks whether credentials exist at all.** The single most dangerous illusion this audit found (Part 6). |
| **`confirmationMethod: 'sms'`, manual entry off** | `SmsMpesaProvider` (parser permanently stub) | true / true / false | Manual Code (always dead-ends — no message can ever be parsed) | **No — no route exists to complete an M-Pesa sale at all** | Nothing | Same fixed sandbox probe, unrelated to SMS-mode readiness at all |
| **`confirmationMethod: 'sms'`, manual entry on** | `SmsMpesaProvider` | true / true / true | Manual Code (dead-end) + Unverified | Yes, but **only** via the Unverified fallback — this is effectively the sole functioning path on an SMS-configured till | `mpesa_payments` (manual_unverified) | Same, irrelevant |
| **Daraja configured, manual entry on** | `DarajaMpesaProvider` | false / false / true | STK + Unverified | Yes, via STK normally, or Unverified as an orphan-payment recovery route | Per mode | As above (environment-dependent accuracy) |
| **Mock enabled (dev, unpackaged only)** | `MockMpesaProvider` | true / false / per-admin-setting | Manual Code (works, approves nearly any code) + Unverified (if enabled) | Yes, in dev only — cannot exist in a packaged build (three-layer fence) | Dev-only rows | Deliberately shown **disconnected** ("M-Pesa mock mode enabled") — the one honest signal in this system |
| **Till offline / no network** | Whichever provider is configured | unaffected | Whichever tabs the config implies | STK: initiate/poll fail, but a transient network failure is indistinguishable from "still pending" until the full 90s timeout elapses, then reports the misleading "customer did not respond" message | Failed `mpesa_transactions` row if initiate itself failed | Correctly shows disconnected for a *pure* network-down case (transport failure), but doesn't distinguish "till offline" from "Safaricom sandbox specifically unreachable while production is fine" (or vice versa) |

---

## Part 6 — Conflicts

Ranked by severity for a **live till** (a shop actually taking real customer payments today or about to):

1. **HIGH — Header "M-Pesa: Connected" can be green while payments cannot be taken at all.** The probe is a bare, unauthenticated HTTP GET to a hardcoded sandbox host — it never checks configured credentials, never checks the resolved provider, and never checks the till's actual `environment`. An unconfigured till, an SMS-mode till (which can never confirm a payment), and a production till whose real API endpoint is down can all show the same green dot as a correctly working sandbox till. (§1.7, §7.8)
2. **HIGH — `confirmationMethod: 'sms'` is a live, selectable, restart-effective option that can never confirm a single payment**, because the parser is a permanent stub and the cashier-facing "pick a confirmed message" screen doesn't exist. A till switched to this mode silently depends entirely on the Unverified fallback for every M-Pesa sale, with nothing in the Admin UI warning that the mode itself is non-functional. (§1.4)
3. **HIGH — No Buy Goods/Till transaction-type support.** `TransactionType` is hardcoded to `CustomerPayBillOnline`; a shop with an actual Till/Buy-Goods number (a very common setup) would have every STK Push sent with the wrong transaction type, likely to be rejected or mis-processed by Daraja. (§2.7)
4. **HIGH (documented, unfixed by design) — the Daraja reuse residual.** One confirmed STK payment can settle two sales, because the confirmation check is a bare read with no claim/lock. Explicitly scoped out in `docs/phase-120.md` §10.2 as an accepted risk, not an oversight — but it is real, and this audit's own §4.4 finding (no restart-recovery path) is exactly the kind of scenario that would trigger it. (§4.6)
5. **HIGH — the fiscal-validation gate blocks the M-Pesa save entirely.** A shop cannot save *any* M-Pesa configuration — not even just filling in a consumer key to start testing — until the fiscal device's IP and port are already valid, because both sections share one save handler and one client-side validation gate that only checks eTIMS fields. This blocks configuring M-Pesa before the fiscal device is physically installed. (§7.1, §7.2, §3.8)
6. **MEDIUM-HIGH — M-Pesa config changes report success but silently require a restart to take effect, with no restart prompt.** Every M-Pesa write except the mock-toggle shows the same bare "Settings saved." as a fiscal-device change that *does* hot-apply — an admin who edits the Daraja shortcode or credentials mid-shift will reasonably (and wrongly) believe the change is already live. (§2.6, §3.3, §7.5)
7. **MEDIUM — app restart mid-STK-poll permanently orphans a payment (if manual entry is off) or mislabels a genuinely-confirmed payment as `manual_unverified` forever (if manual entry is on)**, because there is no persisted "poll in progress" state and no UI path to reattach a recovered Daraja receipt to a sale. (§4.4)
8. **MEDIUM — network loss during STK polling is indistinguishable from "customer did not respond," and the till tells the cashier the latter regardless.** This is a direct instance of "cashier could be told something misleading." (§4.4)
9. **MEDIUM — the daily figures/Z-report cannot distinguish confirmed M-Pesa from unverified M-Pesa.** A `manual_unverified` sale (nothing has actually checked the money moved) counts identically toward the shift's "M-Pesa" total as a Daraja-confirmed sale — a manager reviewing cash-up has no way to see this distinction without opening the Reconciliation page separately. (§1.6)
10. **MEDIUM (latent) — `integrations.mpesa`'s whole-row replace has no merge semantics**, safe today only because the single writer always sends all seven fields. A future partial-write caller, or a save from a stale-loaded tab, would silently wipe the rest of the row. (§2.3, §7.3)
11. **MEDIUM — the combined Admin save is not transactional.** Three-to-five independent IPC calls fire via `Promise.all`; a late server-side validation failure in one domain (e.g. the KRA-PIN regex on Store Identity, which is not checked client-side) does not roll back the others — a shop can end up with a silent *partial* save while being told the overall save failed. (§7.2)
12. **LOW-MEDIUM — env vs DB disagreement after first boot is invisible.** Editing `.env` post-first-boot has zero effect unless the DB row is cleared or the Admin toggle is used; this is documented in `.env.example` but is a real, recurring source of "I changed the config and nothing happened" confusion. (§2.2)
13. **LOW — the Manual Code tab shows (and can only dead-end) on an unconfigured or SMS-mode till**, because `verifyReferenceNumbers` is deliberately forced `true` on those fallback providers just to route the cashier to the right error message. Safe (no sale can complete) but confusing UX. (§1.2, §4.1)
14. **LOW — STK amount rounding happens after the unrounded total is already recorded** as the order/fiscal total, creating a small, un-reconciled gap between what Daraja actually charged and what the till's own books show as paid, for any fractional-shilling cart total. (§4.3)

---

## Part 7 — Coupling with KRA/eTIMS

**Phase E2(e)'s "Admin Integrations" sectioning (phase-142/143) is confirmed cosmetic-only.** The section split changed only which panel is visible on screen at a time (to fix the ~2,200-2,529px vertical-overflow problem measured in phase-142); the shared state, shared validation, and shared save handler underneath were **deliberately preserved** — stated explicitly in a code comment (`AdminScreen.tsx:1011-1022`) and locked in by a regression test (`tests/adminIntegrationsSections.test.ts:74-81`) that asserts `handleSaveIntegrationsConfig` is reachable from exactly two places and that no separate `handleSaveMpesaConfig`/`handleSaveFiscalConfig` exists anywhere in the file. **This is the strongest evidence the coupling is an intentional design decision, not an oversight** — splitting the handlers today would fail this test by design.

1. **Shared save handler — CONFIRMED.** One function, `handleSaveIntegrationsConfig` (`AdminScreen.tsx:451-537`), fires, on a single click: eTIMS field validation → one manager-PIN prompt → `Promise.all` of `setIntegrationConfig('mpesa',…)`, `setIntegrationConfig('etims',…)`, `setStoreIdentity(...)`, optionally `setEtimsPassword(...)`, optionally `setMpesaCredentials(...)`. Wired to **two separate "Save" buttons** (M-Pesa section `:1330-1336`, Fiscal Device section `:1554-1560`). **What breaks:** an admin wanting to change only an M-Pesa field cannot save that alone.
   *Split sketch:* separate `handleSaveMpesaConfig`/`handleSaveFiscalConfig` (and arguably a third for Store Identity, which isn't really "fiscal" either), each with its own PIN prompt and its own IPC call set.

2. **Shared validation — CONFIRMED, one-directional.** `validateEtimsConnection` runs before the PIN prompt and **aborts the entire save, M-Pesa included**, if the fiscal device IP/port are invalid (`AdminScreen.tsx:466-478`, corrected citation for the phase-122 claim). There is no reverse gate — no M-Pesa validation blocks a fiscal save. Made worse by a UX bug: the field-level error highlighting only renders inside the Fiscal Device section's markup, so an admin sitting on the M-Pesa tab sees only the generic "Check the highlighted fiscal device details above" with nothing actually highlighted on their current tab. **What breaks:** a shop cannot configure M-Pesa before its fiscal device is physically installed and its IP known — exactly the scenario the audit brief asked about.
   *Split sketch:* M-Pesa's save validates only M-Pesa's own fields; fiscal's save validates only its own.

3. **Shared state objects — CONFIRMED, but as adjacency, not a merged object.** No single `{mpesa, fiscal}` object exists; state is per-field `useState`, but all fields for both domains are declared back-to-back and loaded together by one `loadIntegrationsConfig()` (`AdminScreen.tsx:120-159,211-274`), and the shared save handler reloads *everything* after saving *anything*. Lower severity than #1/#2 — splitting the handlers doesn't strictly require touching this.

4. **Shared IPC channel — NOT meaningfully coupled.** `integrations:set-config` is a generic envelope keyed by a `provider` enum, but each call carries only that provider's own config, validated by separate schemas (`mpesaIntegrationConfigSchema` vs `etimsIntegrationConfigSchema`) against separate DB rows. **The coupling is concentrated in the renderer (`AdminScreen.tsx`), not the IPC/backend layer** — a split is mostly a renderer refactor.

5. **Shared restart requirement — mixed.** The `mock_mpesa_enabled`/`mock_etims_enabled` toggles are legitimately, independently restart-bound (both providers really are constructed once at boot) — not artificial coupling. But there's a genuine, under-communicated **asymmetry**: fiscal config changes hot-apply via `applyEtimsConfigToProvider()` with no restart needed, while M-Pesa changes never do — yet both show the identical "Settings saved." message, with no restart-required indication on the M-Pesa save path (Part 6 #6).

6. **Shared setup gate — CHECKED, NOT coupled.** The onboarding completion gate (`EtimsSetupGate.tsx`, `App.tsx:362-364`) checks only `baseUrl`/`deviceIp`/`devicePort`/`password` — fiscal-only. There is no equivalent M-Pesa gate; a till can run indefinitely with M-Pesa fully unconfigured (falling back to `UnconfiguredMpesaProvider`, cash still works). **A shop can already run without M-Pesa configured; it cannot run without fiscal configured** — an intentional, legally-driven asymmetry, not a same-gate coupling. No split needed here.

7. **Shared settings keys — CHECKED, NOT coupled.** `integrations` is one row per provider; `mock_mpesa_enabled`/`mock_etims_enabled` are separate `app_configurations` keys with separate `category` tags. No row mixes fields from both domains.

8. **Shared connectivity probe — CHECKED, essentially not coupled at the data level.** `connectivityMonitor.ts` tracks `mpesa` and `fiscal` as separate keys, checked independently. The header shows one collapsed dot (red if *either* is bad), but the dialog underneath shows separate rows with independent status/detail per integration — one tap fully disambiguates. Low-severity UI compression, not a data-model coupling. (The real M-Pesa-specific problem — the hardcoded-sandbox-host probe — is Part 6 #1, unrelated to fiscal coupling.)

9. **Shared mock seeding in `configMigration` — CHECKED, NOT coupled.** Two independent calls to a shared generic `seed()` helper, different default policies per domain, independently keyed. Sharing a helper function is not domain coupling.

10. **Shared tests — CONFIRMED, and this is the mechanism that locks the coupling in place.** `tests/adminIntegrationsSections.test.ts:74-81` explicitly asserts the shared-handler design as an invariant of the Phase E2(e) work — any split must rewrite this specific test, not just the implementation.

**Net assessment:** the backend/IPC/database layers for M-Pesa and fiscal are already cleanly separated by provider key. **The actual coupling to fix is concentrated entirely in `AdminScreen.tsx`** — state co-declaration, one shared save handler serving two buttons, and a client-side validation gate that only understands the fiscal domain — plus the one regression test that currently locks that design in.

---

## Part 8 — Plan (no code)

Each step below is independently revertible and does not require any other step to be taken.

| # | Step | Files | Tripwires (must stay unmodified/passing) | Rollback | Risk |
|---|---|---|---|---|---|
| 1 | Split `handleSaveIntegrationsConfig` into `handleSaveMpesaConfig` / `handleSaveFiscalConfig` (and a third handler for Store Identity, which belongs to neither), each with its own manager-PIN prompt and its own IPC call set. Remove the fiscal-validation gate from the M-Pesa path — M-Pesa should validate only its own fields. Rewrite `tests/adminIntegrationsSections.test.ts`'s coupling-locking test to assert the *split* instead of the shared handler. | `AdminScreen.tsx` (~120-537, 1011-1022, 1169-1338, 1340-1562); `tests/adminIntegrationsSections.test.ts` | `mpesaPaymentGate.test.ts`, `mpesaManualPayment.test.ts`, `mpesaPaymentsRecord.test.ts`, `mpesaProviderFactory.test.ts`, `fiscalEngine.test.ts`, `fiscalRouting.test.ts`, all Phase E layout tests | Revert commit; restores the shared handler | Low |
| 2 | Make the M-Pesa save success message honest: state plainly that these changes need a restart, matching the pattern already used by the System-tab mock-toggle flow. Copy-only, no functional change. | `AdminScreen.tsx` (M-Pesa save success text) | None functional | Revert wording | Low |
| 3 | **(Flagged — only if the user wants restart-free M-Pesa reconfiguration.)** Build an `applyMpesaConfigToProvider()`-style hot-reload mirroring eTIMS's `applyEtimsConfigToProvider()`. Requires reconsidering the `private readonly` credential fields on `DarajaMpesaProvider` and handling a poll that's in-flight against the old provider instance at the moment of reconstruction. If the user prefers to keep the restart requirement, skip this step and rely on Step 2's honest messaging alone. | `main/index.ts` (~648-720), `mpesa-provider-factory.ts`, `daraja-mpesa-provider.ts` (constructor) | `mpesaProviderFactory.test.ts`, `mpesaPaymentGate.test.ts`, `darajaMpesaProvider.test.ts` | Revert to boot-time-only construction | Medium |
| 4 | Fix the header connectivity probe to check the URL matching the till's actually-configured `environment`, mirroring how the fiscal checker already re-reads its live `baseUrl` on every check — directly closes Part 6 #1, the single most dangerous finding in this audit. | `main/index.ts` (~900-918, `checkMpesa`), `connectivityMonitor.ts` | Any existing connectivity-monitor tests | Revert to the hardcoded sandbox host | Low |
| 5 | **(Flagged — product decision, see below.)** Hide or clearly label the SMS/Gammu confirmation-method option in the Admin dropdown, since it can never itself confirm a payment today and silently depends entirely on the Unverified fallback. | `AdminScreen.tsx` (confirmationMethod dropdown), `ipcValidator.ts` if the enum should shrink | `mpesaProviderFactory.test.ts`, `smsMpesaProvider.test.ts` | Restore the dropdown option | Low |
| 6 | **(Flagged — live-till risk, previously scoped out.)** Add a claim/lock step to the Daraja confirmation path, mirroring SMS mode's atomic conditional update, to close the reuse residual (Part 6 #4). Needs a schema-level "claimed" marker on the matched `mpesa_transactions` row, set atomically at the point of order-queueing. | `database.ts` (`hasConfirmedStkPayment`, `queueOrderRecordingMpesaPayment`, `mpesa_transactions` schema), `checkout.ts` | `mpesaPaymentGate.test.ts`, `mpesaPaymentsRecord.test.ts` | Revert to the read-only check | Medium |
| 7 | **(Flagged — confirm the shop's actual shortcode type first.)** Add Till/Buy-Goods support: a `shortcodeType` config field selecting `CustomerBuyGoodsOnline`/correct `PartyB` vs the current hardcoded `CustomerPayBillOnline`. Only relevant if the target shop actually uses a Till number. | `daraja-mpesa-provider.ts` (TransactionType/PartyB), `AdminScreen.tsx`, `ipcValidator.ts`, `integrations.mpesa` schema | `darajaMpesaProvider.test.ts` | Revert to hardcoded Paybill | Low |
| 8 | **(Flagged — optional, reporting decision.)** Give the Z-report/daily-figures a way to distinguish `manual_unverified` M-Pesa sales from confirmed ones (Part 6 #9), and/or close the amount-rounding gap (Part 6 #14) by rounding once, consistently, before the total is ever recorded. Both are separate from the coupling-split work and shouldn't be folded into it. | `reports.ts`, `checkoutMath.ts` / `daraja-mpesa-provider.ts` | `mpesaPaymentsRecord.test.ts` | Revert | Low |

**Tripwires for any of the above (must stay green, unmodified except where a step explicitly says otherwise): `mpesaPaymentGate.test.ts`, `mpesaManualPayment.test.ts`, `mpesaPaymentsRecord.test.ts`, `mpesaProviderFactory.test.ts`, `darajaMpesaProvider.test.ts`, `smsMpesaProvider.test.ts`, `mpesaSmsClaim.test.ts`, `mpesaSmsInbox.test.ts`, `mpesaSmsMessages.test.ts`, `mpesaPaymentPoller.test.ts`, `mpesa.test.ts`, the full fiscal suite (`fiscalEngine.test.ts`, `fiscalRouting.test.ts`, `fiscalProviderFactory.test.ts`, `fiscalRetry.test.ts`, `fiscalResend.test.ts`, `fiscalValidate.test.ts`, `fiscalSanitize.test.ts`, `fiscalNotConfigured.test.ts`, `fiscalNotice.test.ts`, `fiscalDate.test.ts`, `fiscalIntegration.test.ts`), and the Phase E layout tests (`tests/posCheckoutPanelFit.test.ts`, `tests/virtualNumpadCompact.test.ts`, `tests/scale.test.ts`, `tests/belowLgUnreachable.test.ts`) — all confirmed present in `tests/` today.**

---

## Flag for the user — do not decide

1. **Sandbox vs production for the POC.** The repo's committed defaults currently resolve to Daraja sandbox with blank real credentials (`UnconfiguredMpesaProvider` until an admin fills them in). Confirm which environment the POC/go-live till should actually target, and whether real production Daraja credentials exist yet.
2. **Whether the Unverified manual mode should stay enabled once Daraja works reliably.** It is currently the only recovery path for a restart-orphaned STK payment (§4.4) but also the mechanism behind Part 6 #9 (Z-report can't distinguish it from confirmed payments).
3. **Whether the SMS/Gammu confirmation method should be hidden from the Admin dropdown** until its parser is real — today it's selectable and silently non-functional (Part 6 #2, Plan step 5).
4. **Whether M-Pesa config changes must apply without a restart**, or whether it's acceptable to keep the restart requirement as long as the UI says so honestly (Plan steps 2 vs 3).
5. **Whether to fix the Daraja reuse residual now.** It was previously and deliberately scoped out (`docs/phase-120.md` §10.2) as an accepted risk; this audit found it live-till-relevant given the confirmed lack of any restart-recovery path (Part 6 #4, Plan step 6).
6. **What shortcode type the target shop(s) actually have** — Paybill (currently the only type this integration supports) or Till/Buy Goods (currently unsupported and likely to fail) — needed before Plan step 7 is worth doing at all.
7. **Whether the header's M-Pesa probe should be changed to reflect the configured environment/credentials** (Plan step 4), or left as a pure network-liveness signal with different, more honest labeling instead.

---

## Rollback

This phase made no code, configuration, database, or vault changes — nothing to roll back. `docs/phase-147.md` itself can be deleted or amended freely without affecting the running system.
