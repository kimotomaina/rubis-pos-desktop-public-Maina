# Phase 58 (Test-Hardening T1.5) — Quarantine the Credit-Note Conformance Gap

## Why this phase exists

Phase 57 built the conformance guard and it did exactly its job on the
first real run: it caught `cancelInvoice` posting
`<Command Name="OpenCreditNote">`, a command that doesn't exist in the
vendor contract. That finding was correct, and Phase 57 deliberately
left the test red rather than guess a fix — but a red `npm test` isn't
a stable place to leave the suite sitting indefinitely. A permanently
red run trains everyone to ignore red, which is worse than the gap it
was reporting. This phase's job is narrow: turn "red and ignorable"
into "green and impossible to silently forget."

**No provider code changes.** The wire output of `cancelInvoice` is
exactly what Phase 57 found it to be — still wrong, still not fixed,
still not fixable without a live device to verify the corrected payload
against (the device TCP-password handshake, Code 31, remains an
external, unresolved blocker). This phase only changes how that known
state is *represented* in the test suite.

## What changed, and why

### `tests/tremolConformance.test.ts`

The failing assertion is now wrapped in `it.fails(...)` with the exact
title requested: `"KNOWN GAP (needs live device): cancelInvoice must
post OpenCreditNoteWithFreeCustomerData with full customer payload +
RIN — see phase-58"`.

*Why `it.fails` and not `.skip` or `.todo`*: `.skip` and `.todo` both
stop the assertion from running at all — the gap would be invisible to
`npm test` output, indistinguishable from "nobody got around to writing
this test yet." `it.fails` still *runs* the assertion every time the
suite runs; it only inverts the pass/fail bit, so:

- today, the assertion fails (wrong command name) → `it.fails` reports
  **pass** → suite stays green.
- the moment `cancelInvoice` is fixed to post a contract-valid command
  → the assertion starts passing → `it.fails` reports **fail** → the
  suite goes red, forcing whoever fixed it to also flip this back to a
  plain `it` and delete the `KNOWN_GAPS.md` entry.

That second property is the reason this was worth doing carefully
rather than just deleting the test or asserting the opposite: the test
still does real work in both directions. It can't silently rot into
irrelevance the way a `.skip`'d test can.

### `docs/KNOWN_GAPS.md` (new)

A single entry for this gap: what's wrong (`OpenCreditNote` vs.
`OpenCreditNoteWithFreeCustomerData` + the missing customer-payload
fields), why it's deferred (needs both an interface change to thread
the original invoice's customer fields through `cancelInvoice`, and a
live device to confirm the corrected payload actually works — see
`docs/phase-56.md` for why this codebase no longer guesses wire
formats), what test tracks it, and — the part worth calling out
explicitly — the blast radius: **only refunds are affected.** The
checkout-path fiscal flow (`OpenInvoice` → `SellPLU` →
`ReadCurrentReceiptInfo` → `CloseReceipt` → `ReadDateTime`) is fully
conformance-checked and green; this gap sits entirely in a path that
never runs during a normal sale, and its existing failure mode is a
clear "issue a manual credit note" message, not silent data loss.

This file is meant to accumulate — future deferred-for-a-reason gaps
belong here too, each deleted in the same change that closes it, so
the file stays a live list rather than a graveyard.

## Files changed

- `tests/tremolConformance.test.ts` — one test converted from a plain
  failing `it` to `it.fails(...)` with the tracking title; file-level
  doc comment updated to point at `docs/KNOWN_GAPS.md`.
- `docs/KNOWN_GAPS.md` (new) — one entry.

No production source file changed.

## Verification

- `npm test` — **53 of 53 test files pass; 726 of 726 tests pass.**
  (The credit-note gap is the reason 8/8 tests pass in
  `tremolConformance.test.ts` rather than 7/8 — `it.fails` counts as a
  pass when its wrapped assertion fails, which is the whole mechanism.)
- `npm run typecheck` (node + web) — clean.
- Every other conformance check from Phase 57 remains fully enforced:
  the fiscal sales path's outgoing commands/args and incoming response
  fields are still checked against the vendor contract on every run,
  unweakened by this phase.
