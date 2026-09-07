# Phase 53 — Fix Empty Routing Parameters in HTTP Request

## Summary

`deviceIp`/`devicePort` were reaching the middleware as empty strings
despite the startup log claiming a default was in effect. The bug
wasn't where the prompt's hypothesis pointed (there is no per-request
DB read in `submitInvoice` — the provider builds its HTTP client once
at construction and never touches config again), but the underlying
symptom and Q1's prescribed fix were exactly right: nothing in the
call chain ever applied a real default when the value was missing.

## Actual root cause

`main/index.ts`'s startup log did:
```ts
deviceIp = ${etimsConfig.deviceIp ?? '(default) 154.79.253.236'}
```
That fallback exists **only inside the log string**. Two lines above,
the real value handed to `RealFiscalizationProvider` was the raw,
possibly-`undefined` `etimsConfig.deviceIp` — no fallback applied. From
there, `createFiscalHttpClient` did `options.deviceIp ?? ''`, collapsing
`undefined` straight to `''`. So the log printed "(default)
154.79.253.236" while the actual outgoing request carried `ip: ''` —
the log was lying about what was sent, which is exactly what threw
Phase 52's diagnosis off.

## Changes

- `src/main/services/integrations/http-client.ts` — added
  `DEFAULT_DEVICE_IP` (`'154.79.253.236'`) and `DEFAULT_DEVICE_PORT`
  (`'8000'`) exports. `createFiscalHttpClient` now computes
  `options.deviceIp?.trim() || DEFAULT_DEVICE_IP` and the port
  equivalent — a blank or missing value falls back to the real
  default, not `''`. `password` is unchanged (still `''` when unset,
  per Q1 — there's no sensible non-secret default for a password).
- `src/main/index.ts` — imports those same constants and uses them in
  the startup log (`||` instead of `??`, so a blank-string DB value
  also shows "(default)" — matching what `createFiscalHttpClient`
  actually does with it) instead of hardcoded literal strings that
  could silently drift out of sync with the real defaults again.

## Verification

- `npm test` — 640/640 passing. Updated
  `tests/http-client.test.ts`'s "empty strings" test (now asserts the
  real default IP/port are used, both when unset and when configured
  as a blank string) and added `tests/realEtimsProvider.test.ts` tests
  that inspect the actual `AxiosInstance` `createFiscalHttpClient`
  returns (via `vi.mocked(...).mock.results`) to confirm its
  `defaults.params`/`defaults.headers` carry the exact configured
  `ip`/`port`/`password`, and that they're never empty even with no
  config at all.
- `npm run typecheck` — clean (node + web).
