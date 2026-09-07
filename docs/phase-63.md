# Phase 63 / Chunk 2 — Mock ZFPLabServer engine + standalone runner

Builds on [phase-62.md](phase-62.md) (Chunk 1's fixtures) — this chunk serves
those exact files, adding no new response shapes of its own. Per the revised
roadmap in the master brief, Chunk 2 was done next (independent of Chunk 4A),
before Chunk 4A and Chunk 3.

## What was applied

- **`mock-zfplab-server/engine.ts`** — the one and only server implementation
  (`createMockZfpLabServer`), used both by the standalone runner below and by
  Chunk 3's future in-process boot (`port: 0` for an ephemeral port). Handles:
  - `GET /settings(...)` → `settings-ok.xml` verbatim, regardless of the
    ip/port/password sent (there's no mock device to authenticate against,
    only a mock bridge).
  - `GET /clientremove(who=me)` → `success-ack.xml`.
  - `POST /` with `<Command Name="X">` → the fixture from a command→fixture
    map matching Appendix A of the brief (`ReadStatus` →
    `readstatus-fiscalized-full.xml`, `CloseReceipt` → `closereceipt-ok.xml`,
    etc.), all files read from `tests/fixtures/wire/` — no inlined XML.
  - A POST body with no recognizable `<Command Name="…">` → the real
    `code63-invalidpost.xml` fixture (matches confirmed server behavior).
  - Any command not in the map → `success-ack.xml` with a console warning
    (keeps the demo alive rather than hanging/404ing on one of the
    contract's 122 commands this codebase doesn't otherwise use).
  - Every response is HTTP 200 — protocol/business errors live inside the
    `<Res Code>` body, never as a non-2xx status, matching
    `http-client.ts#describeFiscalHttpError`'s existing assumption.
  - **Fault injection**, one-shot by default or `{ persistent: true }`:
    `setFault(commandOrPseudoCommand, fixtureFileName, opts)` — can point at
    *any* fixture, success or error, including the Appendix-A-documented
    Code-53 scenario ("served on the first command then success").
  - **Request log** (`server.requests`): every request in arrival order with
    method/url/body/parsed command name/fixture served, for Chunk 3's
    assertions.
- **`mock-zfplab-server/run.ts`** — `npm run mock:zfplab`, starts the same
  engine on port 4444 (overridable via `MOCK_ZFPLAB_PORT`), prints the
  required "MOCK — synthetic, NOT KRA-registered" banner, and handles
  SIGINT/SIGTERM for a clean shutdown.
- **`tests/mockZfplabServer.test.ts`** (13 tests) — the engine's own
  correctness: routing, fault injection (one-shot, persistent, the Code-53
  scenario), the request log, and the malformed-POST → Code-63 path. Boots
  on `port: 0` per the robust-test standard (§9.5) — no fixed-port
  dependency, so this suite runs safely alongside a real `npm run
  mock:zfplab` or a live device.
- **Wiring:** `package.json` gained `"mock:zfplab": "vite-node
  mock-zfplab-server/run.ts"` (reusing the already-installed `vite-node` —
  no new dependency); `tsconfig.node.json`'s `include` gained
  `mock-zfplab-server/**/*` so `npm run typecheck` covers it.

## Verified

- **Manual HTTP smoke test** (`curl`, on an alternate port — see note below):
  `settings()` → `Code="0"` with `clientID`; `ReadStatus` → the full 22-flag
  body; `OpenInvoiceWithFreeCustomerData` → bare ack; `CloseReceipt` →
  `InvoiceNum`/`QRcode`; a malformed POST body → `Code="63"`; an unrecognized
  GET path → a safe-default ack rather than hanging.
- **Automated:** `npx vitest run tests/mockZfplabServer.test.ts` — 13/13
  green. Full suite: **55 files / 781 tests** (768 prior + 13 new, 0
  removed). `npm run typecheck` — clean (node + web), now covering the new
  `mock-zfplab-server/` folder.

## Note: port 4444 is not bindable in this dev/sandbox environment

`npm run mock:zfplab` on the default port failed with `EACCES: permission
denied 0.0.0.0:4444` in this session's sandbox. Re-ran with
`MOCK_ZFPLAB_PORT=48444` to prove the engine itself (banner, routing,
shutdown) — that passed. This is an environment restriction here, not a code
defect: the automated test suite avoids it entirely by using `port: 0`
(ephemeral, OS-assigned). **`VERIFY-ON-DEVICE`/verify-in-a-normal-shell:**
confirm `npm run mock:zfplab` binds port 4444 cleanly outside this sandbox
(a normal dev machine, where nothing else is listening on 4444) before
relying on it for the Chunk 2 acceptance demo end-to-end (POS → mock →
fiscalized receipt) — the engine's behavior is proven; only the literal
port-4444 bind in *this* environment wasn't.

## Status

- **Applied:** `mock-zfplab-server/engine.ts`, `mock-zfplab-server/run.ts`,
  `tests/mockZfplabServer.test.ts`, plus the two config edits
  (`package.json`, `tsconfig.node.json`).
- **Not yet done:** the full "POS pointed at the mock renders a fiscalized
  receipt" acceptance check requires launching the actual Electron app
  against this server — not attempted in this pass (this chunk built and
  proved the server in isolation; wiring the running POS app to it, and
  confirming port 4444 binds outside the sandbox, is the remaining
  acceptance step).
- Nothing else changed. Chunk 4A (error taxonomy) and Chunk 3 (full-stack
  integration test against this engine) are next, per the revised roadmap.
