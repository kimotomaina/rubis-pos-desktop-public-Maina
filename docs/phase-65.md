# Phase 65 / Step 0 — Audit the eight VIL/TSL G03 Manual findings (READ-ONLY)

No code changed. **Update:** the manual is now located and read — see below.
(An earlier version of this report incorrectly treated it as missing; that
version never actually reached disk, so this is the first real copy.)

## The manual — found

`D:\Volcha\Projects\Rubis\ETIMS_Integration_Docs\VIL G03 INTEGRATION WORKFLOW.pdf`
(1.67 MB, dated 2025-09-04) — the "TSL G03 INTEGRATION PROGRAMMING MANUAL". Not
under either of the two curated reference folders the master brief names
(§3), which is why my first pass through `rubis-pos-desktop/docs` and the ZFP
`tracker/` folder missed it. Converted via `pdftotext -layout` (282 lines of
text; a few embedded screenshots — e.g. the sample `settings()` result and
sample invoice image — aren't text-extractable, so any claim resting on those
specific images is called out below as unconfirmed rather than guessed at).

Per the task prompt's source-authority rule, restated precisely from what's
now in hand: this document gives **workflow/intent and version-independent
requirements** (its own working demo's error-handling logic, the 9-step
command sequence, the post-implementation checklist) — all directly useful.
Its **wire specifics** (the VAT class A-E enum on one sell command) are
version-dependent and superseded by the 2509041522 PDF/defs for this
project's actual device, exactly as the task prompt anticipated. Every
finding below cites the specific manual text now, replacing the earlier
proxy citations (`docs/phase-55.md`'s secondhand account) with the primary
source directly.

---

## Finding-by-finding verdicts

### #1 — VAT-class sell-routing depends on `defVer`

**Verdict: partial.** Real, but the existing safeguard is passive — unchanged
by the manual.

- `resolveSellCommand` (`real-etims-provider.ts:727-745`) already carries a
  `// VERIFY-ON-DEVICE` comment (`:719-725`). `getSettings`
  (`http-client.ts:170-177`) already reads `<defVer>` and does
  `console.warn` only — no structured/observable state, and the mismatch
  never gates `resolveSellCommand`.
- **Confirmed by the manual**: its "Item VAT Rate (code or percentage)" list
  (workflow doc, step-2 requirements) gives all five classes —
  `'A'`=16%, `'B'`=8%, `'C'`=0%, `'D'`="usually free for any other rates",
  `'E'`=Exempt — as a flat, single-command enum with no version caveat. This
  is exactly the version-dependent behavior the task prompt describes: the
  manual (older `defVer`) shows a **different, wider** contract for the same
  sell command than the 2509041522 defs blob (`OptionVATClass` — one legal
  value, `"A"`) actually declare today. Confirms the routing genuinely is
  version-sensitive, not an invented worry.
- Recommended fix size: **small**, unchanged from the first pass — make the
  `defVer` mismatch structurally observable (not just logged); keep the
  2509041522 routing.

### #2 — Text sent to the CU is only XML-escaped, not stripped

**Verdict: mostly done already.**

- `fiscal-sanitize.ts`'s `sanitizeFiscalText` already strips everything
  outside `[A-Za-z0-9 .,-]` and is applied to `CompanyName`, `ClientPINnum`,
  `HeadQuarters`, `Address`, `PostalCodeAndCity`, `ExemptionNum`,
  `TraderSystemInvNum`, `NamePLU`, `HSName` (confirmed live in
  `buildOpenInvoiceArgs`/`buildSellPluArgs`/`buildSellPluHsArgs`/
  `buildOpenNoteArgs`).
- **Confirmed by the manual directly now** (workflow doc, setup step 3:
  "Symbols are not allowed and can make your device be blocked from
  connecting to the TIMs server... your code excludes symbols and special
  characters"; post-implementation checklist item 6: "Generate invoices with
  special characters on the **system invoice number, customer details, item
  description** (`./-#<>;:..` anything that is not alphanumeric)... code
  should be added to ensure that they are eliminated"). That's exactly
  `TraderSystemInvNum` + the customer block + `NamePLU`/`HSName` — precisely
  the fields already covered.
- **Still open**: `HSCode`/`MeasureUnit` go through a bare `.slice()`, not
  `sanitizeFiscalText` (low real risk — `HSCode`'s `XXXX.XX.XX` format is
  already inside the allow-list — but inconsistent with the checklist's
  blanket "anything that is not alphanumeric").
- Recommended fix size: **tiny** — route `HSCode`/`MeasureUnit` through the
  existing sanitizer too. No new sanitizer unit needed.

### #3 — The CU serial number is never read

**Verdict: real.**

- `protocol_description_KE_CU_2509041522.pdf` §2.4.1: command `60h`,
  arg-free, `<SerialNumber[20]><PINnumber[11]>`, `zfpdef: ReadCUnumbers()`.
  Matches `tests/fixtures/tremol-contract.json`'s `ReadCUnumbers` entry
  exactly.
- **Confirmed by the manual too**: the "INTEGRATION HIGH LEVEL FRAMEWORK"
  table lists "Control Unit Serial Number" as one of the fixed set of
  "DETAILS RECEIVED FROM CONTROL UNIT (to be printed on invoice)", alongside
  the invoice number/QR/timestamp this codebase already surfaces — and the
  9-step workflow's step 3 ("The control Unit will validate the data and
  then return... Control Serial number... to be printed on the invoice")
  repeats it. The manual's own sample-invoice image (not text-extractable)
  presumably shows the printed field, consistent with this.
- `grep -rn "ReadCUnumbers" src` returns nothing — never called.
- Recommended fix size: **small** — one `readCUNumbers()` call at session
  init (cached, once), surfaced on `FiscalInvoiceResult` as an optional
  `cuSerialNumber`; one new ground-truth fixture (contract + PDF, not
  invented), round-tripped through the real parser.

### #4 — Credit/debit notes are Open+RIN+Close, missing the line-item body

**Verdict: real.**

- `protocol_description_KE_CU_2509041522.pdf` §2.5.3/§2.5.4: both
  `Open{Credit,Debit}NoteWithFreeCustomerData` open a fiscal "**receipt**"
  (the PDF's own word, same as an invoice), with `Output data: n. a.` —
  confirming it's a receipt-opener, not a self-contained document; §2.5.5's
  sell-command note ("for correction use minus sign in the price field")
  implies reversal lines go through the ordinary sell command against the
  open note.
- **Confirmed by the manual's checklist, items 7/8/10** — genuinely new
  detail not visible from the PDF alone: credit notes need **both**
  "Partial Credit Note — where you reserve some items in previously issued
  invoice" **and** "Full Reversal"; debit notes need both "Adding items"
  **and** "Increase of items prices"; and "**Credit and Debit Notes should
  have their own unique Control Unit invoice numbers and reference the
  original invoice numbers**" (confirms `RelatedInvoiceNum` +
  a fresh `TraderSystemInvNum`, matching `CreditNoteDetails`'s existing
  shape). Item 11 additionally wants "correct labelling... Duplicate, Credit
  and Debit Notes" on the printed receipt — a print-layer detail beyond this
  chunk's scope but worth carrying into Step 5's design.
- Current `cancelInvoice` (`real-etims-provider.ts:499-526`) only sends
  `OpenCreditNoteWithFreeCustomerData` and returns — confirmed by reading
  the full method body.
- Recommended fix size: **medium** — Step 5 / Chunk 4B, as planned, now with
  the partial/full/debit-add/debit-increase four scenarios spelled out
  precisely from the checklist rather than inferred.

### #5 — STE codes matched in decimal against a hex wire

**Verdict: real — origin now fully confirmed from the primary manual, not
just a secondhand account.**

The manual's own working demo (a VB.NET exception handler, reproduced
verbatim) branches like this:

```vb
Catch ex1 As SException
If ex1.STE2 = 52 Then
    ' "Invoice Already opened or incorrect Pin. Do you wish to cancel and retry...!"
    ' -> fp.CancelReceipt() then GoTo RetryOpen
ElseIf ex1.STE2 = 0 Then      ' "Device connection error or invalid invoice number"
ElseIf ex1.STE2 = 58 Then     ' "Invalid RIN, please verify if the RIN is correct and try again"
ElseIf ex1.STE2 = 59 Then     ' "Invalid client PIN, please verify the PIN and try again"
ElseIf ex1.STE2 = 60 Then     ' "Missing defined item!"
ElseIf ex1.STE2 = 61 Then     ' "Item quantity mismatch as per original RIN"
ElseIf ex1.STE2 = 62 Then     ' "Item amount too large!"
```

This is the **exact** `52/0/58/59/60/61/62` set `mapFiscalDeviceError`
carries today (`docs/phase-55.md:76` already said this was ported "from the
manual's friendly messages" — now confirmed directly, not secondhand). Two
things follow:

1. **The vendor's own C#/VB wrapper (`FPcore.dll`) already parses `STE1`/
   `STE2` to decimal integers** before exposing them as `.STE2`/`.STE1`
   properties — `ex1.STE2 = 52` is a plain VB integer comparison, not a hex
   string compare. That confirms this codebase's plan (extract the raw hex
   attribute, then `parseInt(x, 16)`, then key the switch on the resulting
   **decimal** number) matches the vendor's own convention exactly — the
   current decimal keys (`'52'`, `'59'`, `'60'`, `'62'`) were **right all
   along**, just never fed a real value (finding 4.1b).
2. **Where the manual and the authoritative PDF's Table Errors (§1.2.1)
   disagree, the PDF wins, per the task's own rule — even though the
   current code's wording came from the manual.** Confirmed disagreement:
   decimal 58 / hex `3a` — manual: **"Invalid RIN"**; PDF's official
   Command-errors column: **"Invoice number not found!"**. Decimal 61 / hex
   `3d` — manual: "Item quantity mismatch **as per original RIN**"; PDF:
   plain "Item quantity too large!". The current code's text is the
   manual's (older, credit-note-flavoured) wording — real, but per the
   rule it should be corrected to the PDF's wording in Chunk 4A, not kept
   because a real document said it once. Decimal 52/59/60/62 already agree
   with the PDF (hex `34`="Syntax error" — command column; `3b`="Wrong
   client PIN!"; `3c`="Missing defined item!"; `3e`="Item amount too
   large!") close enough in wording that no correction is needed beyond
   what Chunk 4A already planned.
- Recommended fix size: unchanged — Chunk 4A / Step 4, as already planned.

### #6 — No reconciliation artifact (system amount vs CU-validated amount)

**Verdict: real; exact source text now in hand; scope still needs your
answer** (per the task's own Step 6 gate — asking, not building).

- Post-implementation checklist item 13, verbatim: **"Ensure there is a
  report for Reconciliation showing what amount was in the system invoice
  versus the validated amount."** Nothing in the codebase computes or
  surfaces this — the only `reconcil*`-named thing,
  `tests/reconciliation.test.ts`, is shift cash-reconciliation (till cash vs
  Z-report), an unrelated concern (confirmed by reading it).
- Is a per-invoice (or per-shift) report — system total vs the amount
  `ReadCurrentReceiptInfo`'s VAT-group sum (or `CloseReceipt`) actually
  confirmed on the device — in scope for this POC, or a wider-POS/reporting
  concern to defer to `KNOWN_GAPS.md` (now citable precisely: checklist item
  13 of the VIL G03 workflow manual)?

### #7 — Open-receipt recovery keys on the wrong STE byte

**Verdict: CORRECTED from my first pass — the manual resolves this outright,
and my earlier "worse than stated" conclusion was wrong.**

My first pass reasoned that since the PDF's Table Errors has hex `34` mean
"Opened fiscal receipt" on the **FD-errors** (device/`STE1`) column and
"Syntax error" on the **Command-errors** (`STE2`) column, and the current
code only ever reads `STE2`, the recovery might be keyed to the wrong column
entirely. **The manual's own working demo settles this directly**: its
exception handler branches on `ex1.STE2 = 52` (decimal 52 = hex `34`) for
exactly this scenario — literally titled in its own message text "**Invoice
Already opened or incorrect Pin. Do you wish to cancel and retry...!**",
followed by `fp.CancelReceipt()` then a retry. `STE1` is read only for
display in the message text, never branched on, anywhere in the demo.

**So `STE2` is correct, matching the current code's existing intent
(`openResult.code === '52'`) exactly** — there is no STE1-vs-STE2 confusion
bug. The only real defects are the already-tracked ones: (a) finding 4.1b —
`STE2` is never extracted from the XML at all today, so this check can't
fire; (b) once extracted, it must be converted hex→decimal before the
`=== '52'` comparison can ever match (see #5 above). No separate fix is
needed beyond what Chunk 4A already plans for 4.1/4.1b. The PDF's own
"opened fiscal receipt" FD-errors-column entry at hex `34` turns out to be
incidental — the manual confirms the actual working recovery path is the
command-errors reading, not the device-errors one, so `VERIFY-ON-DEVICE` can
be dropped for *this specific point* (which byte to key on) — the general
"is `52`/`34` really what a live device returns for this scenario" question
remains appropriately `VERIFY-ON-DEVICE`, same as everything else in this
error table.
- Recommended fix size: **small**, already folded into Chunk 4A — and now
  with one less open question than my first pass claimed.

### #8 — No pre-send validation layer

**Verdict: partial — now with an exact, primary-sourced spec.**

- `kraPin.ts`'s `isValidKraPinFormat` is a renderer-side "warn, don't block"
  nicety (its own doc comment says so), not invoked in
  `src/main/services/integrations/`.
- **Confirmed and precisely spec'd by the manual now**: setup step 3's
  requirements — "**All item fields required must be included. That is,
  Item description, VAT code, Quantity and Unit Price**"; "**Items without
  16% VAT code should have a HS code and HS Description. Correct HS code
  format must be entered and validated**" — plus checklist item 14's own
  question list: "What if you send a PIN without the correct number of
  digits? Or a missing HS code when the item is not 16% Vatable?" This is
  effectively the validator's acceptance test, verbatim from the primary
  source.
- Nothing today enforces either check before a device call — a non-class-A
  line's empty `HSCode` reaches `SellPLUfromExtDB_HS` unchecked
  (`(item.hsCode ?? '').slice(...)`), and no required-item-field check runs
  before `submitInvoice`'s 7-step sequence starts.
- Recommended fix size: **small**, matches the task's own Step 1 scope — a
  pure `validateFiscalInvoiceRequest`-style function, called at the top of
  `submitInvoice`, returning a typed error the existing queue/resilience
  path already knows how to surface.

---

## Summary table

| # | Finding | Verdict | Confirmed from | Fix size |
|---|---|---|---|---|
| 1 | `defVer`-gated VAT routing | Partial (passive warn only) | `http-client.ts`, `real-etims-provider.ts`, manual's flat A-E enum | Small |
| 2 | Text stripping, not just XML-escape | **Mostly done already** | `fiscal-sanitize.ts`, manual checklist item 6 | Tiny (HSCode/MeasureUnit only) |
| 3 | CU serial number never read | Real | PDF §2.4.1, contract, manual's framework table, grep | Small |
| 4 | Credit/debit notes missing line-item body | Real, scenarios now precise | PDF §2.5.3/§2.5.4, manual checklist items 7/8/10, `cancelInvoice` body | Medium (Chunk 4B, as planned) |
| 5 | STE decimal-vs-hex | Real; origin fully confirmed | manual's VB demo (verbatim), PDF §1.2.1, `phase-61/62.md` | As already planned (Chunk 4A) |
| 6 | No reconciliation artifact | Real; **scope still needs your answer** | manual checklist item 13 (verbatim) | **Needs your answer first** |
| 7 | Open-receipt recovery byte | **Resolved — STE2 confirmed correct, no bug beyond 4.1/4.1b** | manual's VB demo (verbatim) | Small, folds into Chunk 4A |
| 8 | No pre-send validation | Partial, now precisely spec'd | manual setup step 3 + checklist item 14 (verbatim), `kraPin.ts` | Small (Step 1, as planned) |

---

## What I need from you before Step 1

1. **Finding #6's scope** — build a minimal reconciliation report (checklist
   item 13), or defer to `KNOWN_GAPS.md` citing that item?
2. Confirm Step 1 scoped down to the HSCode/MeasureUnit sanitizer gap +
   the new pre-send validator (finding #8) — not a from-scratch sanitizer,
   which already exists and is unit-tested.
3. No further manual-access question — it's found and read in full.

**STOP for review**, per the task prompt.
