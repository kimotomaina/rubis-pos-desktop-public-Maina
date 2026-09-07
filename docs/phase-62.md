# Phase 62 / Chunk 1 — Materialize the wire fixtures

Builds on [phase-61.md](phase-61.md) (Chunk 0's audit), whose Step-0 finding
this chunk relies on: **ENVELOPE_A is confirmed** — root `<Res Code="0">` with
one child `<Res Name="X" Value="Y" Type="T"/>` per field
(`fp_core.js:83-147`). No placeholder skin remained to resolve.

## What was applied

Nine new fixtures in `tests/fixtures/wire/`, each carrying a header comment
citing its ground-truth source (never derived from our own parser):

- `success-ack.xml` — bare `<Res Code="0"/>`, the ack shape for
  `OpenInvoiceWithFreeCustomerData`/`SellPLUfromExtDB(_HS)`/
  `OpenCreditNoteWithFreeCustomerData`.
- `readstatus-fiscalized-full.xml` — all 22 named status flags from
  `tremol-contract.json`, in the vendor's declared order, with
  `CU_fiscalized`/`CU_produced`/`Paired_with_TIMS` = 1 and everything else = 0.
- `readcurrentreceiptinfo-ok.xml` — one open class-A receipt, two 60.00 lines
  (`SubtotalAmountVATGA` = 120.00), using the contract's actual field names
  (`OptionIsReceiptOpened`, `OptionReceiptFormat`, `OptionClientReceipt`,
  `OptionPowerDownInReceipt`) and `Type="OptionHardcoded"` reserved fields.
- `closereceipt-ok.xml` — `InvoiceNum` (19 digits) + `QRcode` (exactly 128
  chars, visibly synthetic `MOCK-QR-` prefix).
- `readdatetime-ok.xml` — single `DateTime` field, `dd-MM-yyyy HH:mm:ss`.
- `readcuinvoicenumber-ok.xml` — hardcoded `Option='I'` + `CU_InvoiceNumber`
  (19 digits).
- `code53-settingsmissing.xml`, `code40-invoicenotfound.xml`,
  `code19-opensocket.xml` — server/device error envelopes in the
  `<Err Source Type><Message>…</Message></Err>` nesting the real captures use
  (not the sibling shape Appendix A originally showed).

New `tests/wireFixtures.test.ts` (13 tests) round-trips every fixture through
the **real** production `parseXmlResponse` (`xml-utils.ts`) — proving the
fixtures are well-formed and that the parser reads the confirmed field names
correctly, not a re-derivation of the parser's own behavior.

The three real captures already present — `settings-ok.xml`,
`readstatus-ok-healthy.xml`, `readstatus-live-captured-code19.xml` — were left
**untouched**, per the brief.

## Corrections applied vs. the brief's Appendix A

1. Contract field names win: `OptionIsReceiptOpened` etc., not the
   un-prefixed PDF names (phase-61.md finding 4.4).
2. Error envelope nests `<Message>` inside `<Err>`, matching the real
   captures, not siblings (phase-61.md §2).
3. Every reserved field carries a skip-triggering `Type`
   (`Reserve`/`OptionHardcoded`) so the parser's skip rule is actually
   exercised, not merely assumed.
4. `QRcode` padded to exactly 128 characters (verified by script, not by eye).

## Clarified, not a defect

The vendor JS client's scalar-vs-object response rule (phase-61.md §2 —
`analyzeResponse` returns a bare scalar for a single-*child* response) does
**not** apply to this codebase's own `parseXmlResponse`, which always returns
a flat `Record<string, string>` — phase 60 explicitly did not adopt the
vendor JS runtime. Noted in `wireFixtures.test.ts`'s file header so a future
reader doesn't try to assert scalar behavior against the wrong parser.

## Escalated finding — 4.1b: `parseXmlResponse` never extracts STE1/STE2/FPLibErrorCode at all

Found while writing the `code40-invoicenotfound.xml` round-trip test — not a
hypothetical; a real assertion failed first, then was corrected to document
reality rather than loosened to hide it (anti-circularity rule, brief §0.3).

A real Code-40 response carries `STE1`/`STE2`/`FPLibErrorCode` as **attributes
on `<Err>`** (confirmed `fp_core.js:71-75`): e.g.
`<Err Source="Device" Type="FPException" STE1="30" STE2="3a" FPLibErrorCode="00">`.
`parseXmlResponse` (`xml-utils.ts:126-157`) has exactly two extraction passes:

1. `namedValuePattern` — matches `Name="…" Value="…"` pairs. `STE1`/`STE2` are
   bare attribute names, not `Name=`/`Value=` pairs, so this pass never sees
   them.
2. `elementPattern` — matches `<tag>text</tag>` leaf elements. `<Err>` isn't a
   leaf (it contains `<Message>`), so its own attributes are never read
   either.

**`STE1`, `STE2`, and `FPLibErrorCode` are never populated on the parsed
record — full stop, independent of radix.** This means `checkDeviceResponse`
(`real-etims-provider.ts:265`) always falls back to the envelope code `"40"`
itself, and `mapFiscalDeviceError('40', rawMessage)` has no `'40'` case, so it
always hits `default` and reports the device's raw `Message` — readable, but
**no STE2-keyed distinction (retryable vs not, which friendly message) is
possible today, for any device business error, at any radix.** Fixing
phase-61.md's 4.1 (the hex/decimal mismatch) alone would accomplish nothing
without first adding an `<Err …>`-attribute extraction pass to
`parseXmlResponse`.

**Verified in this pass:** `tests/wireFixtures.test.ts`'s
`code40-invoicenotfound.xml` test asserts `parsed.STE2`/`STE1`/
`FPLibErrorCode` are `undefined` against the real parser — green, confirming
the gap rather than guessing at it. The fixture itself is unmodified ground
truth; only the test's expectation reflects reality.

**Chunk 4 must now do three things for STE handling, not two:**
(a) add an `<Err …>` attribute-extraction pass to `parseXmlResponse`
(`STE1`/`STE2`/`FPLibErrorCode`, lower-cased hex strings); (b) re-key
`mapFiscalDeviceError`/`checkDeviceResponse` on the resulting hex values
against the PDF §1.2.1 table (superseding 4.1's original "just fix the
radix" framing); (c) re-verify the Code-52-equivalent "cancel and retry"
recovery actually fires once `STE1 = 34` ("opened fiscal receipt") is
readable.

## Verification

- `npx vitest run tests/wireFixtures.test.ts tests/tremolFixtures.test.ts` —
  green (13 + 38 tests).
- `npx vitest run` (full suite) — **54 files / 768 tests pass** (755 prior +
  13 new, 0 removed).
- `npm run typecheck` — clean (node + web).

## Status

- **Applied:** 9 new fixture files + 1 new test file, listed above.
- **New escalated finding, not yet in `KNOWN_GAPS.md`:** 4.1b (STE
  attributes never extracted by the parser) — supersedes part of phase-61.md's
  4.1 and changes Chunk 4's scope.
- Nothing else changed; Chunk 2/3 not started.

**STOP for review** before Chunk 2's Apply — 4.1b is a scope change to Chunk 4
worth confirming before building the mock engine on top of it.
