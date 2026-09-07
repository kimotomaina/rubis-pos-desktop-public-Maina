# Phase 60 — Apply Authoritative-SDK Corrections to the Provider + Contract

## Why this phase exists

Every prior fiscal-integration phase worked from whatever vendor
artifact happened to be on hand — an older `FP.cs`/`FPcore.dll` drop,
then a decompiled `FPcore.jar`. A newer, more authoritative package,
`ZFP_SDK_KE_2509041522_ControlUnit`, turned up on this machine with a
`tracker/SDK_RECON.md` already produced against it (a prior session's
read-only recon, cross-referencing the shipping vendor **JS** client
— `Libs/JS/fp.js`/`fp_core.js` — against the protocol PDF, the
`Libs/FileServer/*.xml` templates, and this repo's existing
`tremol-contract.json`). That recon found the contract this codebase
had been testing against was extracted from an SDK missing 32 commands
added in later protocol versions, and — more consequentially — found
one real bug (`SellPLUfromExtDB`/`SellPLUfromExtDB_HS` mixed up as
interchangeable when they structurally aren't) and one wrong HTTP
header (`Content-Type`) that Phase 56 had inferred from decompiled
bytecode rather than confirmed against source.

This phase applies those corrections. Every change below traces to a
specific, cited line in `tracker/SDK_RECON.md`, not a fresh guess.

## Item 1 — Regenerated `tremol-contract.json` from the authoritative source

`scripts/extract-tremol-contract.mjs` now reads the `var defs = '<Defs>…'`
string literal in `Libs/JS/fp.js` (unescaping `\'` → `'`, the JS
string-escaping convention) instead of `FP.cs`'s C# verbatim string —
both forms are still supported, auto-detected by file extension, so a
future SDK update in either language needs no script change. The
extractor also now captures `<Options>` enum values on `Option`-typed
args/results, which the old extraction dropped entirely.

**Command count: 91 → 122** (exactly matching the recon's count).
32 commands added (`ReadCUinvoiceNumber`, `OpenSellAndCloseInvoice`,
various `ReadEJBy*`/`StoreEJBy*` report commands, contract/service
commands, etc.) — all from protocol versions the old SDK predated.
1 command removed: `ScanAndPrintWifiNetworks`, which doesn't exist in
the current defs (the real command is `ScanWiFiNetworks`; the protocol
PDF's own version history records `ScanAndPrintWifiNetworks` as
explicitly removed in an earlier version — the old contract was a
stale artifact).

**Corrected field values on commands this codebase actually uses**
(recon §9.1, all fixed automatically by re-extracting from the correct
source — no manual patching needed):

| Command | Field | Old contract | Corrected |
|---|---|---|---|
| `SellPLUfromExtDB` | `Price.maxLen` | 10 | **15** |
| `SellPLUfromExtDB_HS` | `Price.maxLen` | 10 | **15** |
| `SellPLUfromExtDB_HS` | arg[1] name | `reservde` *(typo)* | **`reserved`** |
| `ReadCurrentReceiptInfo` | `SubtotalAmountVATGA`…`GE.maxLen` | 11 | **13** |
| `ReadCurrentReceiptInfo` | res[14] reserved type/maxLen | `Decimal`/11 | **`OptionHardcoded`**/1 |
| `Subtotal` | `DiscAddV.maxLen` | 8 | **13** |
| `Subtotal` | `SubtotalValue.maxLen` | 10 | **13** |
| `ReadStatus` | response field count | 19 | **22** (added `Service_contract_nearly_expired`, `Expired_service_contract`, `Update_is_available`) |

**Newly captured**: `SellPLUfromExtDB.OptionVATClass` records its
complete enum — exactly one legal value, `{name: "VAT Class A", value: "A"}`
— which the old contract had no way to express at all (no `options`
key existed) and which directly drove Item 3's routing fix below.

`OpenInvoiceWithFreeCustomerData`, `OpenCreditNoteWithFreeCustomerData`,
`OpenDebitNoteWithFreeCustomerData`, `CloseReceipt`, `CancelReceipt`,
`ReadDateTime` were already byte-for-byte correct in the old contract
and needed no change.

## Item 2 — `Content-Type: text/plain`, not `application/xml`

The authoritative vendor JS client builds every request — GET or POST
— through one function, `sendReq(verb, prefix, data)`
(`fp_core.js:29-37`), which sets exactly one header:
`req.setRequestHeader("Content-Type", "text/plain")`. Phase 56's
`application/xml; charset='UTF-8'` was inferred from decompiling an
*older* compiled `FPcore.jar` and was wrong. Fixed in one place
(`FISCAL_CONTENT_TYPE` in `http-client.ts`), which propagates to both
the axios instance defaults (covering `settings()`/`clientremove` GETs)
and `postXml`'s explicit per-request override.

**Unexpected live consequence, worth recording precisely**: running
`npm run test:live` against the real server on this machine, before
this fix `ReadStatus` consistently hit the client's 5-second timeout
with no response at all. After the fix, the same call returns in
under a second — with a *new* response, `Res Code="19"`
(`ServUndefined`), body: `"The Fiscal Printer has open socket. FP
refuses new socket connection. Internal error"`. This suggests the
previous wrong `Content-Type` may have been causing the server to hang
processing the POST rather than reject it outright, and that Code 19
is a distinct, likely-transient device/session-state symptom (a
socket left open from an earlier attempt) — not diagnosed further here,
since that's live device troubleshooting outside this phase's scope.
Captured verbatim to
`tests/fixtures/wire/readstatus-live-captured-code19.xml` for the
record. `settings()` itself still returns `Code 0` with `clientID`
populated, satisfying this item's acceptance check.

## Item 3 — Corrected sell-path routing by VAT class

The recon's decisive finding (§3.3, §4b): `SellPLUfromExtDB`'s
`OptionVATClass` has **exactly one legal enum value, `"A"`** — there is
no way to express VAT class B/C/D/E through it at all, contract or no
contract. Meanwhile `SellPLUfromExtDB_HS` (§3.4) takes neither
`OptionVATClass` nor `VATGrRate`, `HSName`, nor `MeasureUnit` — only
`NamePLU`, `Price`, `HSCode`, and optional `Quantity`/`DiscAddP` — with
VAT treatment derived device-side from the HS code's programmed rate/
exempt flag (`ProgHScode`).

`RealFiscalizationProvider.resolveSellCommand` now routes each line
item: `vatClass === 'A'` → `SellPLUfromExtDB` (`buildSellPluArgs`,
unchanged shape, HS fields always present and populated with whatever
the item actually carries — never conditionally blanked); anything
else → `SellPLUfromExtDB_HS` (`buildSellPluHsArgs`, the 4-5-argument
shape with no VAT/measure/HS-name fields at all). The routing decision
carries a `// VERIFY-ON-DEVICE` comment, exactly per the phase brief —
the recon is explicit that this is the strongest available reading of
the argument lists, not a quoted vendor rule.

This resolves both Phase-56 TODOs, which are now deleted:
- **`VATGrRate` percentage-vs-fraction**: confirmed **percentage**
  (`"16.00"`, not `"0.16"`) — the recon's §4(a) cross-references three
  sibling VAT-rate fields (`ProgVATrates`, `ReadVATrates`,
  `ProgHScode.VAT_Rate`), all documented `##.##`, and notes `MaxLen="5"`
  fits `16.00` exactly.
- **Class-A empty-HS vs. omit-HS**: resolved by the routing fix itself
  — the question no longer applies the way it was framed. A class-A
  item still always sends `HSCode`/`HSName` (structurally required,
  no `Compulsory="false"` in the defs), populated or blank depending on
  whether the item itself carries an HS classification; a non-A item
  never reaches `SellPLUfromExtDB` at all, so there's no "omit for
  class A" branch left to have an opinion about.

## Item 4 — Length caps aligned to official maxLens

`Price` (`SellPLUfromExtDB`/`SellPLUfromExtDB_HS`) is documented at 15
characters (was silently uncapped in the provider — "uncapped" already
satisfies "not shorter than official," so nothing was truncating
incorrectly, but a `MAX_PRICE_LENGTH` constant now exists, referenced
in a new `formatPrice` helper that **warns rather than truncates** on
overflow — silently chopping digits off a monetary amount would corrupt
a sale, unlike text-field truncation). `RelatedInvoiceNum` (credit/debit
notes) gained its own `MAX_RELATED_INVOICE_NUM_LENGTH = 19` constant.
Every existing text-field cap (`CompanyName`, `ClientPINnum`,
`HeadQuarters`/`Address`/`PostalCodeAndCity`/`ExemptionNum`,
`TraderSystemInvNum`, `NamePLU`, `HSName`, `HSCode`, `MeasureUnit`) was
already at or above its official value — confirmed, not changed — by a
new cross-check test suite (`tremolFixtures.test.ts`) that reads every
one of these constants back out of the provider and asserts it against
`tremol-contract.json`'s recorded maxLen, so a future drift between the
two fails loudly instead of silently. The `ReadCurrentReceiptInfo`
subtotal fields and `Subtotal`'s `DiscAddV`/`SubtotalValue` (both now
13, per the corrected contract) are response-side and were never
truncated by provider code — Item 1's regeneration was the actual fix
there; a cross-check test confirms the contract values directly.

## Item 5 — ReadCurrentReceiptInfo gate re-verified, unchanged

Phase 56's summation-based gate (`sumVatGroupSubtotals`, reading
`SubtotalAmountVATGA`…`VATGE`) needed no code change — it already reads
the correct field names. Re-verified against the regenerated contract
(now maxLen 13 instead of 11, which the gate's `Number()` parsing never
cared about) — the existing read-VAT tests pass unmodified.

## Item 6 — Credit/debit note shape implemented, kept quarantined

`buildOpenCreditNoteArgs`/`buildOpenDebitNoteArgs` (sharing one
`buildOpenNoteArgs` implementation — the two commands are
byte-identical except a server-filled `InvoiceDebitNoteType`
discriminator, never sent by the caller, same convention as
`OpenInvoice`'s `reserved`/`InvoiceType`) build the real 8-field shape
the recon confirmed (§5.2): `CompanyName`, `ClientPINnum`,
`HeadQuarters`, `Address`, `PostalCodeAndCity`, `ExemptionNum`,
`RelatedInvoiceNum` (19 chars — the original invoice's `CloseReceipt`
`InvoiceNum`), `TraderSystemInvNum` (a fresh one for the note itself).

`cancelInvoice` gained an optional second parameter, `CreditNoteDetails`
(new type in `etims.ts`). **With** it, `cancelInvoice` posts the real
`OpenCreditNoteWithFreeCustomerData` command. **Without** it — the
existing behavior, since nothing in the app calls `cancelInvoice` with
this detail today — it reports the manual-credit-note-required message
*immediately, with no device call at all*, rather than the old behavior
of always posting a guessed, contract-invalid `OpenCreditNote` command
first and only falling back to the message on failure.

That change closes the Phase-58 known gap outright rather than merely
re-quarantining it: `tremolConformance.test.ts`'s credit-note test is
now a normal, green assertion — no `it.fails`. `docs/KNOWN_GAPS.md`'s
entry was rewritten to reflect what's actually still open: the
corrected shape is unverified against a live device (blocked on the
same Code 31 issue as ever), and nothing in the app constructs a
`CreditNoteDetails` yet (the original invoice's customer block isn't
persisted anywhere retrievable at refund time). Per the brief, neither
of those was addressed here — no live verification attempted, no
checkout-path wiring added.

## Item 7 — `ReadCUinvoiceNumber` added, not wired in

`RealFiscalizationProvider.readCUInvoiceNumber()` sends the
argument-free `<Command Name="ReadCUinvoiceNumber"/>` (its one arg,
`Option='I'`, is `OptionHardcoded` — server-filled, same convention as
elsewhere) and extracts `CU_InvoiceNumber` from the response. This is
the vendor's documented recovery path when `OpenInvoiceWithFreeCustomerData`
is rejected for a duplicate `TraderSystemInvNum` (recon §5.5) — not
wired into `submitInvoice`'s retry logic, since that's a future phase's
job; available now, contract-tested, ready for that wiring.

## Item 8 — `defVer` mismatch warning

`getSettings` now reads `<defVer>` off every `settings()` response and
logs a warning (never a hard failure — this is still a POC) when it's
present and differs from `EXPECTED_DEF_VERSION` (`'2509041522'`, this
build's contract version). A blank `<defVer>` — which the real captured
`settings-ok.xml` fixture actually has — is not treated as a mismatch,
since some server builds apparently don't populate it; only a present,
different value warns.

## Files changed

`scripts/extract-tremol-contract.mjs` (dual C#/JS source support, enum
capture), `tests/fixtures/tremol-contract.json` + `tremol-defs.xml`
(regenerated), `http-client.ts` (`Content-Type`, `defVer` check),
`real-etims-provider.ts` (sell routing, credit/debit note builders,
`readCUInvoiceNumber`, exported length constants), `etims.ts`
(`CreditNoteDetails`, `cancelInvoice` signature), `etimsConfig.ts`
(mirrored endpoint keys). Tests: `tremolFixtures.test.ts` (length-cap
cross-checks added), `tremolConformance.test.ts` (credit-note gap
closed to a normal assertion), `realEtimsProvider.test.ts` (SellPLU
tests split by routing path, `cancelInvoice`/`readCUInvoiceNumber`
tests rewritten/added), `http-client.test.ts`, `etimsConfig.test.ts`.
`docs/KNOWN_GAPS.md` updated, not cleared — a narrower gap remains.

**Not changed, per the brief**: the `settings()` GET string, the
bare-URL POST routing, and no vendor JS runtime was adopted into the
app — `tracker/SDK_RECON.md` §8 recommended against it (synchronous
XHR, an `eval`-based Node loader, browser-only globals) and this phase
only mined its defs blob for correctness, exactly as recommended.

## Verification

- `npm test` — **53 of 53 test files, 755 of 755 tests pass.**
- `npm run typecheck` (node + web) — clean.
- `npm run test:live` — `settings()` still returns `Code 0` with
  `clientID` populated (Item 2's explicit acceptance check).
- Sample wire output, captured from the corrected code:
  - Class A: `<Command Name="SellPLUfromExtDB"><Args><Arg Name="NamePLU" Value="Bread"/><Arg Name="OptionVATClass" Value="A"/><Arg Name="Price" Value="60"/><Arg Name="MeasureUnit" Value="pcs"/><Arg Name="HSCode" Value=""/><Arg Name="HSName" Value=""/><Arg Name="VATGrRate" Value="16.00"/><Arg Name="Quantity" Value="2"/></Args></Command>`
  - Class C (routed to `_HS`): `<Command Name="SellPLUfromExtDB_HS"><Args><Arg Name="NamePLU" Value="Maize Flour"/><Arg Name="Price" Value="150"/><Arg Name="HSCode" Value="1102.20.00"/><Arg Name="Quantity" Value="1"/></Args></Command>`
  - Credit note (with `CreditNoteDetails` supplied): `<Command Name="OpenCreditNoteWithFreeCustomerData"><Args><Arg Name="CompanyName" Value="Acme Traders Ltd"/><Arg Name="ClientPINnum" Value="P051234567Z"/><Arg Name="HeadQuarters" Value=""/><Arg Name="Address" Value=""/><Arg Name="PostalCodeAndCity" Value=""/><Arg Name="ExemptionNum" Value=""/><Arg Name="RelatedInvoiceNum" Value="KRA-0001"/><Arg Name="TraderSystemInvNum" Value="INV-000000099"/></Args></Command>`
