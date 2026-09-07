# Phase 38 — Real M-Pesa Integration (DarajaMpesaProvider)

**Date:** 2026-09-01 · **Branch:** `main` · **Previous:** [Phase 37](./phase-37.md)

## 1. Objective

Build the real M-Pesa integration against Safaricom's Daraja API
(Sandbox), so `VITE_USE_MOCK_MPESA=false` no longer leaves `mpesaProvider`
hard-wired to `MockMpesaProvider` — the gap called out in Phase 36's
closing note and Phase 37's opening disclaimer. Scope: OAuth2
client-credentials token exchange and STK Push (Lipa Na M-Pesa
Online) initiation, implementing the existing `MpesaProvider`
interface (`src/main/services/integrations/mpesa.ts`) so checkout, the
IPC layer, and the mock provider are untouched.

## 2. New file — `src/main/services/integrations/daraja-mpesa-provider.ts`

`DarajaMpesaProvider implements MpesaProvider`:

- **`getAccessToken()`** (private) — `GET /oauth/v1/generate?grant_type=client_credentials`
  with HTTP Basic Auth (`base64(consumerKey:consumerSecret)`). The
  token is cached in memory and reused until `expires_in` (minus a
  60s safety buffer) elapses, then refetched.
- **`initiateStkPush(request)`** — normalizes the phone number to
  `2547XXXXXXXX` (strips a leading `0` or `+`), rejects anything not
  matching `^254\d{9}$` without calling Daraja, then builds the
  `Password` as `base64(Shortcode + Passkey + Timestamp)` with
  `Timestamp` in `YYYYMMDDHHmmss` local time, and posts to
  `POST /mpesa/stkpush/v1/processrequest` with the full Daraja payload
  (`BusinessShortCode`, `Password`, `Timestamp`, `TransactionType:
  "CustomerPayBillOnline"`, `Amount`, `PartyA`/`PartyB`, `PhoneNumber`,
  `CallBackURL`, `AccountReference`, `TransactionDesc`) and a `Bearer`
  token from `getAccessToken()`.
- **`verifyTransactionCode()`** — returns a failed `ServiceResult`
  ("not supported by the Daraja integration"). Daraja has no endpoint
  to look up an arbitrary transaction code after the fact — that would
  need a C2B/account-statement callback pipeline, out of scope here —
  so this deliberately reports unsupported rather than faking a check.
- Base URL switches on `environment` (`'sandbox'` →
  `https://sandbox.safaricom.co.ke`, `'production'` →
  `https://api.safaricom.co.ke`).
- `CallBackURL` defaults to the placeholder `https://example.com/callback`
  when unconfigured — Daraja requires a publicly reachable HTTPS URL,
  which a localhost till can't offer; a real webhook receiver or
  STK Push status polling is a follow-up, not built here.
- Every HTTP call is wrapped in try/catch and normalized to a
  `ServiceResult` (network failure, Daraja error response, and a
  Daraja `ResponseCode !== '0'` rejection are all distinguished in the
  error message) — no caller needs to catch.
- Accepts an injectable `httpClient?: AxiosInstance` constructor
  option (mirroring `RealFiscalizationProviderOptions`), for dependency
  injection in tests instead of `vi.mock('axios')`.

## 3. Wiring — `src/main/index.ts`

`mpesaProvider` now branches on `mockMpesaEnabled`, the same shape
already used for `fiscalizationProvider`/`mockEtimsEnabled`:

```ts
const mpesaConfig = db.getIntegrationConfig<{
  consumerKey?: string
  consumerSecret?: string
  shortcode?: string
  passkey?: string
  environment?: 'sandbox' | 'production'
  callbackUrl?: string
}>('mpesa')
const mpesaProvider: MpesaProvider = mockMpesaEnabled
  ? new MockMpesaProvider()
  : new DarajaMpesaProvider({
      consumerKey: mpesaConfig.consumerKey ?? process.env.MPESA_CONSUMER_KEY ?? '',
      consumerSecret: mpesaConfig.consumerSecret ?? process.env.MPESA_CONSUMER_SECRET ?? '',
      shortcode: mpesaConfig.shortcode ?? process.env.MPESA_SHORTCODE ?? '',
      passkey: mpesaConfig.passkey ?? process.env.MPESA_PASSKEY ?? '',
      environment:
        mpesaConfig.environment ??
        (process.env.MPESA_ENVIRONMENT === 'production' ? 'production' : 'sandbox'),
      callbackUrl: mpesaConfig.callbackUrl ?? process.env.MPESA_CALLBACK_URL
    })
```

Config is read from the `integrations` DB table first (`provider =
'mpesa'`, same table eTIMS already uses, editable from the Admin
integrations screen), falling back to `MPESA_*` env vars when no DB
row is set — `'mpesa'` was already a valid `IntegrationProviderName`
in `database.ts` before this phase, just unused by a real provider.
The doc comment above this block (previously describing M-Pesa as
"no real provider implementation yet") was updated to describe the
new branch and note that `verifyTransactionCode` now goes through
`DarajaMpesaProvider`'s unsupported-path response once mocking is off.

`.env.example` gained a documented `MPESA_*` block (consumer
key/secret, shortcode, passkey, environment, callback URL), defaulted
to Safaricom's published Sandbox shortcode (`174379`) and passkey.

## 4. Testing — `tests/darajaMpesaProvider.test.ts`

New file, 14 tests, following the existing `realEtimsProvider.test.ts`
pattern (inject a fake `AxiosInstance` via the `httpClient` option
rather than `vi.mock('axios')`):

- Constructor throws when a required credential is missing.
- `getAccessToken` calls the correct OAuth URL with the correct
  `Basic` auth header.
- Token is cached across multiple `initiateStkPush` calls (one `GET`
  for two `POST`s) and refetched once expired (`vi.useFakeTimers` +
  `setSystemTime`, driven off a short `expires_in`).
- STK Push password/timestamp are generated correctly for a fixed,
  mocked system time.
- STK Push payload fields match the Daraja spec, phone numbers with a
  leading `0` or `+254` both normalize to `254712345678`.
- Success path returns `MerchantRequestID`/`CheckoutRequestID`.
- Failure paths: invalid phone number (short-circuits before any HTTP
  call), OAuth call failure, Daraja `ResponseCode !== '0'`, and a
  thrown network error — all assert `success: false` with a
  descriptive `error`.
- `verifyTransactionCode` asserts the "not supported" `ServiceResult`.

## 5. Verification

- `npm test` — 571/571 passing (45 files), no regressions to
  checkout, fiscalization, or Shopify sync flows.
- `npm run typecheck` (`typecheck:node` + `typecheck:web`) — clean.

## 6. Follow-ups

- No real webhook receiver or STK Push status-poll exists yet —
  `CallBackURL` is a placeholder and checkout has no way to learn the
  outcome of an STK Push beyond what the initiation call itself
  returns. A later phase needs either a public callback endpoint or
  polling via Daraja's STK Push query endpoint
  (`/mpesa/stkpushquery/v1/query`).
- No Admin UI exists yet for editing the `'mpesa'` row in the
  `integrations` table — credentials currently have to be set via
  `MPESA_*` env vars or a direct DB write until one is built (eTIMS
  has the same gap).
