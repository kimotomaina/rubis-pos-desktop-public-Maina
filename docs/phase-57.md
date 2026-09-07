# Phase 57 (Test-Hardening T1) — Ground-Truth Fixtures + Conformance Guard

## Why this phase exists

Phase 56's post-mortem named the root failure mode behind phases 45–55:
tests mocked Tremol responses shaped to match whatever the code already
did (`SubTotal`, `Connected`, `Fiscalized` — fields that don't exist on
the real device), so a broken gate could ship and stay green for five
phases because nothing checked the *test's* assumption against the
*vendor's* actual contract. Phase 56 fixed the provider. This phase
makes that class of bug structurally impossible to reintroduce
silently, by giving every future test a single, mechanically-generated
source of truth to build fixtures from, plus a guard that fails loudly
the moment a test (or the provider) drifts from it.

This phase is deliberately foundation-only: **no provider runtime
behavior changes**. Where the guard found a real bug, it is reported
below and left failing, not patched — patching it would itself be an
instance of "adjust the check to match the code," the exact failure
mode this phase exists to close off.

## What was built, and why each piece is shaped the way it is

### 1. `tests/fixtures/tremol-contract.json` + `tests/fixtures/tremol-defs.xml`

The vendor's entire protocol is embedded as a single C# verbatim string
in `FP.cs` (`public string defs = @"<Defs>…</Defs>"`, ~1880 lines,
91 commands). Retyping any part of that by hand into a test fixture is
exactly the practice that produced `SubTotal` — a human intermediary
between the spec and the test, free to misremember a field name. So
instead:

- `scripts/extract-tremol-contract.mjs` (new, one-off — not part of the
  app build) locates the `defs` string in a given `FP.cs`, undoes the
  C# escaping (`""` → `"`), and writes the raw block verbatim to
  `tremol-defs.xml`. *Why keep the raw XML too, not just the parsed
  JSON*: so the JSON can be regenerated and diffed the next time the
  vendor ships an updated SDK, without re-locating the string in a
  `.cs` file by hand again.
- The same script then parses that XML into `tremol-contract.json`:
  per command, `cmdByte`, `operation` (the vendor's own description),
  an ordered `args` list, and an ordered `response` list. 91 commands
  extracted, including all 7 named in the brief plus every device-admin
  command outside the fiscal flow (kept for completeness — a future
  phase touching, say, network settings gets the same guard for free).

`tests/tremolFixtures.test.ts` asserts the extraction actually
captured what it claims to — including two negative assertions that
exist specifically to name the two Phase-55 bugs by field name
(`ReadCurrentReceiptInfo`'s response must never contain `SubTotal`/
`Subtotal`; `ReadStatus`'s must never contain `Connected`/`Fiscalized`)
so a regression there fails a *fixture* test immediately, before it
could even reach the conformance guard.

### 2. `tests/fixtures/wire/*.xml` — real captured responses

Five files, each a verbatim response either captured live against the
running ZFPLabServer + Control Unit, or (for the healthy-`ReadStatus`
case) the VIL G03 manual's own documented example:
`settings-ok.xml`, `readstatus-code31-authfail.xml`,
`code30-socketfail.xml`, `code63-invalidpost.xml`,
`readstatus-ok-healthy.xml`. *Why these five specifically*: they cover
the one success path (`settings()` OK) and the three server-level
error codes Phase 56 built explicit handling for (30/31/63), plus the
one response shape (`ReadStatus`, healthy) that Phase 56's
`CU_fiscalized`/`Paired_with_TIMS` check depends on but had no captured
example to test against before now — every prior `ReadStatus` test
built its own inline mock.

`tremolFixtures.test.ts` also asserts `parseXmlResponse` extracts the
exact fields each of these should produce, so the parser itself is
checked against real bytes, not just against `tremol-contract.json`'s
schema.

### 3. `tests/tremolConformance.test.ts` — the actual guard

This is the deliverable. Two directions, both driving the **real**
`RealFiscalizationProvider` (a mocked `axios` transport records what it
posts; nothing about the provider is stubbed or bypassed):

- **Outgoing**: every `<Command Name="X">` the provider posts during a
  full `submitInvoice` run (happy path, and a forced-failure path that
  exercises the `CancelReceipt` rollback) must name a real vendor
  command, and every `<Arg Name="k">` inside it must be a real argument
  of that command per the contract.
- **Incoming**: a hand-maintained table (`fieldsReadPerCommand`,
  intentionally *not* auto-derived — updating it is meant to be a
  conscious, reviewable act, not something a refactor silently drifts
  out from under) lists every response field the provider's control
  flow actually branches on, per command. Each is checked against that
  command's contract response fields. A companion test asserts the
  table itself never contains `SubTotal`/`Connected`/`Fiscalized` — the
  two specific fields Phase 55 invented — as a standing tripwire.

### Finding: `cancelInvoice` posts a command that doesn't exist

Running the outgoing guard against `cancelInvoice` surfaced a real,
previously-undetected issue: it posts
`<Command Name="OpenCreditNote">`, but the vendor contract has **no**
`OpenCreditNote` command — only `OpenCreditNoteWithFreeCustomerData`
(which additionally requires `CompanyName`/`ClientPINnum`/`HeadQuarters`
/`Address`/`PostalCodeAndCity`/`ExemptionNum`/`TraderSystemInvNum`
alongside `RelatedInvoiceNum`, none of which `cancelInvoice` currently
builds). This is the same *class* of bug as the Phase-55 findings —
a plausible-sounding command/field name that was never checked against
the vendor spec — just not one Phase 56's brief happened to name.

**Left failing on purpose.** `tremolConformance.test.ts`'s
`cancelInvoice posts only contract-defined commands` test is red, and
`npm test` reports it red. Per this phase's brief ("if it FAILS, that
is a real finding — report the offending name(s) and STOP for review
rather than fixing the contract to match the code"), no provider change
was made here. The options for a future phase, in increasing order of
completeness:

1. Rename the command to `OpenCreditNoteWithFreeCustomerData` but keep
   sending only `RelatedInvoiceNum` — likely still rejected server-side
   (Code 63 or a null-pointer-style failure), since the manual's
   `ArgsFormatRaw` pattern suggests all fields are positionally
   required, mirroring `OpenInvoiceWithFreeCustomerData`'s own history.
2. Build the full `OpenCreditNoteWithFreeCustomerData` payload,
   threading the original invoice's `CompanyName`/`ClientPINnum`/etc.
   back through from wherever `cancelInvoice`'s caller has them (today
   it receives only an `invoiceNumber` string — this would need a
   larger interface change).
3. Confirm against a live device which shape it actually expects before
   changing anything — the same "don't guess the wire format" discipline
   Phase 56 established for `OpenInvoice` should apply here too.

This is intentionally not decided in this phase.

## Files added

- `scripts/extract-tremol-contract.mjs`
- `tests/fixtures/tremol-defs.xml`
- `tests/fixtures/tremol-contract.json`
- `tests/fixtures/wire/settings-ok.xml`
- `tests/fixtures/wire/readstatus-code31-authfail.xml`
- `tests/fixtures/wire/code30-socketfail.xml`
- `tests/fixtures/wire/code63-invalidpost.xml`
- `tests/fixtures/wire/readstatus-ok-healthy.xml`
- `tests/tremolFixtures.test.ts` (20 tests)
- `tests/tremolConformance.test.ts` (8 tests)

No production source file changed.

## Verification

- Contract extraction: **91 commands** captured from the vendor's
  embedded `<Defs>` block.
- `npm run typecheck` (node + web) — clean.
- `npm test` — **52 of 53 test files pass; 725 of 726 tests pass.** The
  one failure (`tremolConformance.test.ts` → `cancelInvoice posts only
  contract-defined commands`) is the intentional, reported finding
  above — not a regression, and not something this phase's brief
  permitted fixing inline. All fixture tests (Items 1–2) pass; the
  outgoing happy-path and rollback conformance checks pass; every
  incoming-field conformance check passes.
