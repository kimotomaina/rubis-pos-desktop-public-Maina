# Phase 64 / Chunk 2 follow-up — bind 127.0.0.1 + demo-mode clarification

Builds on [phase-63.md](phase-63.md) (Chunk 2's mock engine). Two corrections
requested against that chunk, applied here as their own change per this
project's file-per-change convention.

## What was applied

1. **`mock-zfplab-server/engine.ts`** — `server.listen(...)` now binds
   `127.0.0.1` explicitly, instead of the `0.0.0.0` (all interfaces) Node
   defaults to when no host is given. This mock stands in for a purely
   local vendor bridge — it was never meant to be reachable from another
   machine — so `127.0.0.1` is the semantically correct bind regardless of
   sandbox behavior.
2. **`mock-zfplab-server/run.ts`** — the startup banner now spells out the
   demo-mode configuration explicitly: `VITE_USE_MOCK_ETIMS=false` (the
   **real** provider, talking real wire, pointed at this server) is
   correct; `VITE_USE_MOCK_ETIMS=true` is explicitly called out as wrong for
   this demo, since that swaps in the in-process `MockFiscalizationProvider`
   which never opens an HTTP connection to this server at all — the
   process would sit listening and receive nothing.

## Verified — and a correction to phase-63.md's diagnosis

Re-ran `npm run mock:zfplab` on the default port after the `127.0.0.1`
change: **still `EACCES: permission denied 127.0.0.1:4444`**, identical
failure. Then ran it again with `MOCK_ZFPLAB_PORT=4445` (otherwise
unchanged): **bound and served correctly**, on both the previous `0.0.0.0`
default and now `127.0.0.1`.

This isolates the cause precisely: **this sandbox blocks port 4444
specifically** (likely reserved/deny-listed by the sandbox's own policy,
independent of which interface is requested) — it is not a 0.0.0.0-vs-
127.0.0.1 problem, and the bind-address change, while correct to keep, does
not and cannot fix it. Port 4445 (and by inference any ordinary port) binds
without issue on this same machine. This corrects phase-63.md's framing,
which left the cause open as "confirm outside the sandbox" without
distinguishing which variable was actually at fault.

Full suite and typecheck re-run after both edits: **55 files / 781 tests
green**, typecheck clean (unchanged from phase-63.md — these were
non-functional corrections).

## Status

- **Applied:** `127.0.0.1` bind in `engine.ts`; clarified demo-mode banner
  in `run.ts`.
- **Root cause of the port-4444 `EACCES` narrowed:** sandbox-level block on
  port 4444 itself, not an interface/bind-address issue. **`VERIFY-ON-
  DEVICE`/verify-outside-sandbox** still stands from phase-63.md — a normal
  dev machine (no port-4444 policy, and nothing else already listening
  there) should bind cleanly now; this pass narrowed *why* it didn't here,
  it didn't newly prove it works on a real till.
- Nothing else changed.
