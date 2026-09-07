# Phase 59 (Test-Hardening T2) — Live Smoke Test Against the Real ZFPLabServer

## Why this phase exists

Phases 56–58 rebuilt and conformance-checked the entire fiscal
integration against ground truth decompiled from the vendor's SDK — but
every one of those checks runs against a *mocked* `axios` instance.
Nothing in the suite had ever actually sent a byte over the wire to a
real, running ZFPLabServer. This phase closes that specific gap with a
smoke test that dials real HTTP — not to replace the mocked suite (it
can't run in CI, on a machine without the vendor server installed, or
without a Control Unit on the network), but to answer one question the
mocked suite structurally cannot: does the real server actually accept
what this codebase sends?

**No provider code changes** — this phase is test infrastructure only.

## What was built

### `vite.config.ts` / `vitest.live.config.ts` / `package.json`

`tests/live/**` is excluded from the default Vitest config (spreading
Vitest's own `defaultExclude` rather than replacing it, so
`node_modules`/`dist`/etc. stay excluded too) and picked up only by a
separate `vitest.live.config.ts`, run via the new `npm run test:live`
script. The opt-in is the config selection itself: `vitest.live.config.ts`
sets `LIVE_ZFP=1` through Vitest's own `test.env` option — the
documented, cross-platform way to inject an env var into a test run,
avoiding `set FOO=1 &&` (cmd-only) vs `FOO=1` (POSIX-only) shell syntax
divergence in `package.json`. The test file's own
`describe.skipIf(process.env.LIVE_ZFP !== '1')` is a second, independent
gate, in case the file is ever invoked some other way.

### `tests/live/zfplabServer.live.test.ts`

Two tests, both driving the *real* `createFiscalHttpClient`/`getSettings`/
`postXml` — no axios mock:

1. **`settings()` is accepted by the real server.** Asserts `Res
   Code="0"` and a non-blank `clientID` come back — proof the literal,
   unencoded `settings(ip=…,port=…,password=…,tcp=1)` GET string Phase
   56 reconstructed from decompiled bytecode is actually correct
   against a live server, not just plausible-looking.
2. **`ReadStatus` is server-accepted.** Sends the real
   `<Command Name="ReadStatus"/>` envelope and classifies the result:
   `Code 0` (device authed) and `Code 31` (device TCP-auth pending) are
   both **passes** — the point is proving the *server* accepted the
   request's format and forwarded it far enough to get a
   device-specific answer, not requiring the physical device itself to
   be reachable. `Code 63` (malformed request) or any transport failure
   fails the test, with a message built to say *which* — "server not
   running" vs. "server accepted the request but the physical device
   didn't answer in time" are deliberately distinguished (see below for
   why that distinction turned out to matter on the first real run).

Every real response is captured verbatim into `tests/fixtures/wire/`:
`readstatus-live-captured-code0.xml`, `-code31.xml`, or `-code63.xml`
depending on outcome, and a `Code 0` result additionally overwrites
`readstatus-ok-healthy.xml` — permanently replacing that
manually-sourced (from the manual's own documented example) fixture
with a real device response, the moment one is ever captured.

## What the first real run found

Running `npm run test:live` on this machine (ZFPLabServer actually
installed and running) produced:

```
[LIVE-ZFP] PASS — settings(): Code 0, clientID=Localhost
[LIVE-ZFP] FAIL — ReadStatus: server accepted the request but did not
  respond within 5000ms (production's own per-request timeout) — the
  server itself is very likely running (see the settings() result
  above) and is blocked waiting on its own TCP connection to the
  physical device at 154.79.253.236:8000. This is a device-
  reachability symptom, not a wire-format bug.
```

Two things worth recording precisely, because both are new information
this phase surfaced that no prior phase had:

1. **`settings()` is confirmed correct against a real server.** This
   was, until this run, a decompiled-bytecode inference (Phase 56) that
   had never been checked against an actual ZFPLabServer. It's now
   verified: the exact literal string, the exact GET semantics, the
   exact response shape (`<Res Code="0"><settings>…<clientID>…`) all
   match.
2. **`ReadStatus` produced neither `Code 0` nor `Code 31` — it timed
   out.** This is a *different* symptom from the Code 31
   ("Missing password authentication answer") captured in
   `tests/fixtures/wire/readstatus-code31-authfail.xml` and tracked as
   the device's known blocker. A Code 31 means the server reached the
   device and the device answered "wrong password" quickly. A timeout
   means the server's own attempt to open a TCP socket to
   `154.79.253.236:8000` never completed within production's 5-second
   request budget — which reads as either the device being fully
   unreachable right now (network path down, device powered off) rather
   than merely rejecting the password, or a slow/retrying connect on
   the server's side. This test doesn't diagnose which — that's a live
   network/device investigation, out of scope for a test-infrastructure
   phase — but it does mean **the currently-documented Code 31 gap
   description may be stale**: the live device's failure mode today is
   a timeout, not a fast auth rejection. Worth a manual check before
   assuming Code 31 is still the accurate diagnosis.

This is exactly the kind of fact the mocked suite could never have
produced on its own, and exactly why this test doesn't try to force
a pass by waiting longer or treating a timeout as equivalent to
Code 31 — production's real timeout is 5 seconds
(`ETIMS_REQUEST_TIMEOUT_MS`, hardcoded per-request in `postXml`/
`getSettings` regardless of `createFiscalHttpClient`'s configured
`timeoutMs`, which — a secondary, minor finding — is therefore
currently dead configuration for both call sites; not fixed here, as
it's a production behavior change outside this phase's test-only
scope), so a checkout in the field would see the exact same timeout
this test just did.

## Files added / changed

- `vite.config.ts` — added `exclude: [...defaultExclude, 'tests/live/**']`.
- `vitest.live.config.ts` (new) — separate config, `LIVE_ZFP=1` via
  `test.env`, `environment: 'node'`, 15s test timeout.
- `package.json` — added `"test:live": "vitest run --config vitest.live.config.ts"`.
- `tests/live/zfplabServer.live.test.ts` (new) — 2 tests.

No production source file changed.

## Verification

- `npm test` (default) — unchanged: **53 of 53 test files, 726 of 726
  tests pass.** `tests/live/**` does not appear in the run at all
  (excluded, not skipped-and-counted).
- `npm run typecheck` (node + web) — clean.
- `npm run test:live` against the real, running ZFPLabServer on this
  machine — 1 of 2 tests pass (`settings()`); `ReadStatus` fails with
  the timeout described above, reported unambiguously rather than
  mis-attributed to a wrong wire format or a down server. No fixture
  was captured this run (a client-side timeout has no response body to
  capture) — `tests/fixtures/wire/readstatus-ok-healthy.xml` remains
  the manual-sourced fixture from Phase 57 until a run actually reaches
  `Code 0` or `Code 31`.
