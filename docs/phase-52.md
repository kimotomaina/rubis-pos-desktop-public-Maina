# Phase 52 — Middleware Routing Parameters (Query Params & Headers)

## Summary

Found a real bug this time, not just a spec-compliance gap:
`RealFiscalizationProvider`'s constructor already received `deviceIp`/
`devicePort` (wired from the Admin UI through `main/index.ts` since
Phase 45) but never forwarded them into `createFiscalHttpClient` — it
only passed `baseUrl`/`password`. So even though the Admin UI, the
database, and `main/index.ts` were all correctly wired, the values
never reached an actual HTTP request. Every prior phase's payload
fixes were real bugs (missing/misnamed XML fields), but this one
means the TSL middleware likely never knew which physical device to
connect to at all, regardless of what the XML body said.

## Changes

- `src/main/services/integrations/http-client.ts` —
  `createFiscalHttpClient` now accepts `deviceIp`/`devicePort` and
  attaches them, plus `password`, to every request the returned axios
  instance makes: as query parameters (`ip`, `port`, `password`, via
  `axios.create({ params })`) and as headers (`X-Device-IP`,
  `X-Device-Port`, `X-Device-Password`). Each is sent as an empty
  string when unset rather than omitted, per Q2, and both conventions
  are covered per Q1 since we don't know which one the middleware
  actually parses.
- `src/main/services/integrations/real-etims-provider.ts` — the
  constructor now forwards `options.deviceIp`/`options.devicePort`
  into `createFiscalHttpClient` — this is the actual fix. Updated the
  file's and options interface's doc comments, which previously (and
  incorrectly, per this phase's diagnosis) described these fields as
  "informational only, never sent."
- `src/main/index.ts` — the startup log's "informational only, not
  sent to TSL" wording removed (no longer true), and a masked password
  log added: `password = **** (length N)` or `(empty)` — confirms
  Task 2's audit without printing the actual secret.
- `src/renderer/src/components/AdminScreen.tsx` — the Device IP/Port
  helper text ("Configured on the remote TSL server. Not sent in API
  requests") was actively wrong after this change; replaced with
  "Sent with every request so the TSL server knows which physical
  fiscal device to connect to."

## Task 2 audit result

Password wiring was already correct end-to-end before this phase:
Admin UI → `setIntegrationConfig('etims', { password, ... })` →
`integrations` table → `main/index.ts`'s `etimsConfig.password` →
`RealFiscalizationProvider` constructor. The break was purely the
missing `deviceIp`/`devicePort` forward described above; `password`
was already being forwarded into `createFiscalHttpClient` (as the
`X-ZFP-Password` header) before this phase — it just wasn't also going
out as `X-Device-Password` or as any query parameter.

## Verification

- `npm test` — 636/636 passing. Added to `tests/http-client.test.ts`:
  assertions that `createFiscalHttpClient`'s resulting instance carries
  the query params and `X-Device-*` headers (both populated and
  empty-string-default cases), plus tests for the new `postRawXml`
  export. Added to `tests/realEtimsProvider.test.ts`: a
  constructor-level test (via `vi.mock` on the http-client module)
  proving the provider now forwards `deviceIp`/`devicePort`/`password`
  into `createFiscalHttpClient` when no `httpClient` override is
  injected — the previously-missing behavior this phase fixes.
- `npm run typecheck` — clean (node + web).

## A note on confidence

Every phase from 45 through 51 diagnosed a real, verifiable bug (wrong
URL routing, missing spec fields, an impossible duplicate-tag
requirement). This one is different: nothing in this codebase or its
history confirms the TSL middleware actually reads `ip`/`port`/
`password` from query params or `X-Device-*` headers — that's inferred
from "NEX POS probably does this." I implemented it because it's
low-risk (adding params/headers can't break a payload that was already
failing) and directly testable, but if the 500 persists after this,
the next step should be getting an actual packet capture of NEX POS
talking to this same middleware, or the middleware's own documentation
— continuing to guess at its HTTP-level conventions one field at a
time isn't a reliable way to close this out.
