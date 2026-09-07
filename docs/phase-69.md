# Phase 69 / Step 4 — Fiscal error taxonomy (findings #5, #7, plus 4.1b root cause)

Builds on the audits in `docs/phase-61.md` (finding 4.1: hex-vs-decimal STE2
mismatch), `docs/phase-62.md` (escalated finding 4.1b: `parseXmlResponse` never
extracts `STE1`/`STE2`/`FPLibErrorCode` at all), and `docs/phase-65.md`
(findings #5/#7). Steps 0–3 (phase-65..68) are done. **This step STOPS for
review** — Step 5 (error taxonomy's next consumer, Chunk 3) does not start
until you say so.

Source authority: protocol PDF §1.2.1 ("Table Errors"), device target
`2509041522`. The VIL manual's VB demo is older and used only to understand
intent; where it and the PDF disagree, the PDF wins.

## Audit (read-only, before applying)

- **`parseXmlResponse` (`xml-utils.ts`)**: confirmed exactly two extraction
  passes existed — `Name="…" Value="…"` pairs, and leaf-`<tag>text</tag>`
  elements. `STE1`/`STE2`/`FPLibErrorCode` are **attributes on `<Err …>`**
  (`<Err … STE1="30" STE2="3a" FPLibErrorCode="00">`), which neither pass
  reads. `tests/wireFixtures.test.ts`'s `code40-invoicenotfound.xml` test
  asserted this gap directly (`parsed.STE2` etc. all `undefined`) — a real,
  verified defect, not a guess.
- **`mapFiscalServerError`/`mapFiscalDeviceError`/`checkDeviceResponse`
  (`real-etims-provider.ts`)**: confirmed `mapFiscalDeviceError` keyed on
  decimal strings (`'52' '58' '59' '60' '61' '62'`) while the wire sends hex
  (`fp_core.js:71-75` does `parseInt(x, 16)`); confirmed `checkDeviceResponse`
  passed `data.STE2` through **raw and unconverted**, and — since `STE2` was
  never extracted at all (4.1b) — always fell back to the envelope `<Res
  Code>` itself. Confirmed the open-receipt recovery
  (`openResult.code === '52'`) was correspondingly dead: `data.STE2` was
  always `undefined`, so `deviceCode` was always the envelope code, never a
  device STE value.
- **Read `fp_core.js` directly** (`Libs/JS/fp_core.js:64-81`,
  `throwOnServerError`): confirmed the wire's actual structure — `STE1`/
  `STE2`/`FPLibErrorCode` are read **only when the envelope `<Res Code>` is
  exactly `40`** ("command error"). Every other non-zero code (30, 31, 53,
  63, 19, …) is a plain transport/session error with `errMsg` + `resCode`
  only, no STE bytes at all. This means the codebase's earlier decimal keys
  (`'52'`, `'58'`, …) were never valid as literal `<Res Code>` values on the
  real wire in the first place — they only make sense as **decimal-converted
  `STE2` values nested inside a `Code 40` envelope**. Several existing tests
  (`xmlDeviceError` helper) had been asserting against a shape
  (`<Res Code="52">` with `<STE1>`/`<STE2>` as **child elements**) that
  cannot occur on the real wire; this step corrects those fixtures too, not
  just the production code (anti-circularity: the tests were the thing
  wrong, not the wire).
- **Extracted and read the actual PDF** (`pdftotext -layout` — no PDF
  renderer was available in this environment, so the previous phases' cited
  fragments were independently re-verified against the full extracted text,
  not taken on faith): §1.2.1 "Table Errors" transcribed in full below.
  This **directly settles** the one point phase-65.md had gotten wrong:
  `STE1 = 0x34` ("Opened fiscal receipt", FD-errors column) is a completely
  different condition from `STE2 = 0x34` ("Syntax error", command-errors
  column) — phase-65.md's later "resolved, STE2 confirmed correct" verdict
  (based on the older VIL manual's VB demo branching on `ex1.STE2 = 52`) is
  **superseded here**: the manual predates this device's defs and is wrong
  on this point. `docs/phase-62.md` had already flagged this as the correct
  open question ("re-verify the Code-52-equivalent recovery... once `STE1 =
  34` is readable") — this step resolves it from the primary source.
- **Code 19**: confirmed no case in `mapFiscalServerError` → fell through to
  the device-error branch → `mapFiscalDeviceError('19', …)` → `default` →
  reported as a non-retryable business error, which is wrong; Code 19
  (`ServUndefined`, "FP refuses new socket connection") is transient.
- **Code 30/31**: confirmed already mapped in `mapFiscalServerError`, but
  both were `retryable: false` — per this step's classification they are
  transient/technical (heal once the device/config issue clears), so this
  was also a defect, not just a missing case.
- **Dead timeout**: confirmed `createFiscalHttpClient`'s `timeoutMs` option
  sets `client.defaults.timeout`, but both `postXml` and `sendGet` hardcoded
  `timeout: ETIMS_REQUEST_TIMEOUT_MS` on every per-request config — and
  axios's per-request `timeout` always wins over the instance default — so
  `timeoutMs` was unreachable in every real code path.

## Protocol PDF §1.2.1 — "Table Errors" (transcribed verbatim from `pdftotext -layout`)

| Hex | FD errors (STE1) | Hex | Command errors (STE2) |
|---|---|---|---|
| 30 | OK | 30 | OK |
| 31 | Not used | 31 | Invalid command |
| 32 | Registers overflow | 32 | Illegal command |
| 33 | Clock failure or incorrect date&time | 33 | Z daily report is not zero |
| **34** | **Opened fiscal receipt** | **34** | **Syntax error** |
| 35 | Not used | 35 | Input registers overflow |
| 36 | Not used | 36 | Zero input registers |
| 37 | Not used | 37 | Unavailable transaction for correction |
| 38 | Not used | 38 | Insufficient amount on hand |
| 39 | Incorrect password | 39 | Conflict in tax group |
| 3a | Not used | 3a | Invoice number not found! |
| 3b | 24hours block - missing Z report | 3b | Wrong client PIN! |
| 3c | Not used | 3c | Missing defined item! |
| 3d | Interrupt power supply in fiscal receipt (one time until status is read) | 3d | Item quantity too large! |
| 3e | Overflow EJ | 3e | Item amount too large! |
| 3f | Insufficient conditions | 3f | Amount exceeds original invoice |
| — | — | 40 | HS code is not valid |

Bolded row: **the same hex byte (`0x34`) means two unrelated things depending
on which column/byte it's in** — this is the entire basis of finding #7.

## Applied

1. **`xml-utils.ts` — extraction (fixes 4.1b)**: added three new regex passes
   to `parseXmlResponse`, mirroring the existing `errSourceMatch` style,
   reading `STE1`, `STE2`, `FPLibErrorCode` off `<Err …>` as **raw hex
   strings** (no radix conversion here — that's the caller's job, matching
   `fp_core.js`'s own separation of "read the attribute" from
   "`parseInt(x, 16)`"). `tests/wireFixtures.test.ts`'s `code40` test flipped
   from asserting `undefined` to asserting the real extracted values
   (`STE1='30'`, `STE2='3a'`, `FPLibErrorCode='00'`).
2. **`real-etims-provider.ts` — convert, don't re-key**: `checkDeviceResponse`
   now special-cases `<Res Code="40">` (`RES_CODE_COMMAND_ERROR`): it
   `parseInt(x, 16)`s `STE1`/`STE2`, logs **both** in full (plus
   `FPLibErrorCode`) as one structured `console.warn` regardless of which
   byte this build acts on (so the first live Code 40 settles any remaining
   doubt), then:
   - if `STE1 === 52` (hex `0x34`) → the one-shot open-receipt recovery,
     reporting a dedicated sentinel `code: 'openedFiscalReceipt'` (never the
     bare decimal `'52'`, precisely so it can never collide with `STE2`
     decimal `52` — see point 4);
   - else if `STE2` is present → looked up in the now-complete
     `mapFiscalDeviceError` command-errors table (below);
   - else → falls back to the raw `<Message>` text, `retryable: false`.
   The pre-existing decimal-key **convention** (`'52'`, `'58'`, …) is kept
   exactly as-is — only the *radix* and the *values reaching it* changed,
   per the task's explicit instruction not to re-key.
3. **`mapFiscalDeviceError` — corrected to the full PDF column**: replaced
   the old 6-entry, partly-mis-worded table with all 9 command-errors codes,
   `retryable: false` throughout (every one is a data problem — resending
   identical data fails identically). Two wording corrections from the
   manual's stale text, per the PDF: decimal 58 is "Invoice number not
   found" (was "Invalid RIN"), decimal 61 is "Item quantity too large" (was
   "Item quantity mismatch"). Decimal 52's meaning changed entirely: it is
   now "Syntax error" (STE2 column) — the old "Invoice already opened,
   retryable" entry for `'52'` was flat wrong (that condition is `STE1 =
   52`, a different byte, handled separately — see point 4). Decimal 0 (an
   entry with no basis in the real hex table) was removed.
4. **Open-receipt recovery re-keyed to STE1 (finding #7)**: `submitInvoice`'s
   retry check changed from `openResult.code === '52'` to `openResult.code
   === CODE_OPENED_FISCAL_RECEIPT` — a string sentinel, deliberately **not**
   the decimal number `52`, so it can never be confused with `STE2 = 52`
   ("Syntax error", a plain non-retryable business rejection sharing the
   same hex byte `0x34`). A new test proves the two cannot cross-fire: a
   bare `STE2 = 52` fails immediately (no `CancelReceipt`, no retry), while
   `STE1 = 52` (any `STE2`) triggers the one-shot cancel-and-retry.
5. **Retryability made explicit**: `FiscalDeviceErrorInfo`'s `retryable`
   field is now actually threaded through — `DeviceResult` (the internal
   type `checkDeviceResponse`/`sendCommand` pass around) gained a
   `retryable?: boolean` alongside its existing `code?: string`, populated
   from whichever map/branch produced the result. **Scope boundary, called
   out explicitly for this review**: `retryable` is not yet propagated past
   `real-etims-provider.ts` — `submitInvoice`'s public return type
   (`ServiceResult<FiscalInvoiceResult>`) has no `retryable` field, and
   neither does the shared `ServiceResult<T>` interface (used well beyond
   eTIMS). `fiscal-engine.ts`/`main/index.ts`'s checkout flow still queues
   **every** `submitInvoice` failure unconditionally (this was already true
   before this step — see `main/index.ts`'s `db.queueFiscalInvoice` call,
   unconditioned on error type). Wiring `retryable` into an actual
   cashier-visible-vs-queued UI decision was not in this step's audit/apply
   list, needs no mock server either way, and reads like exactly the kind of
   thing Chunk 3 (the ordering dependency named in this step's own brief)
   would consume — flagging it here rather than silently expanding scope.
6. **Code 19 (finding, item f)**: added an explicit `'19'` case to
   `mapFiscalServerError` (`retryable: true`, message about the open-socket
   condition retrying automatically) so it's no longer misclassified as a
   non-retryable business error. Codes 30 and 31 changed from
   `retryable: false` to `retryable: true` per the explicit "transient,
   heals when config fixed" classification — they were previously the wrong
   polarity for the queue-vs-cashier-visible split this step defines. Code
   63 (`ZFPLabServer rejected the request format`) stays `retryable: false`
   — a malformed request the server itself rejected outright is a code bug,
   not a transient condition. Code 53 unchanged (`retryable: true`,
   pre-existing correct behavior — the settings-missing re-handshake).
7. **Dead timeout (item g)**: added a `resolveTimeout(client)` helper in
   `http-client.ts` (`client.defaults.timeout ?? ETIMS_REQUEST_TIMEOUT_MS`)
   and made both `postXml` and `sendGet` call it instead of hardcoding the
   constant. `FiscalHttpClientOptions.timeoutMs` (already correctly wired to
   `client.defaults.timeout` by `createFiscalHttpClient`, but previously
   dead past that point) is now live end-to-end for any caller that builds
   a client with an explicit `timeoutMs` and passes it through — the
   default behavior (no override) is unchanged, since `client.defaults.timeout`
   is `undefined` in that case and the fallback constant applies exactly as
   before.
8. **Test-fixture correction, not just production code**: `xmlDeviceError`
   (renamed `xmlCommandError`) in `tests/realEtimsProvider.test.ts` was
   itself wrong — it built `<Res Code="{ste2}">` with `<STE1>`/`<STE2>` as
   child elements, a shape confirmed (via `fp_core.js`) to never occur on
   the real wire. Rewritten to build the real `<Res Code="40">` + hex-
   attribute shape, and every call site updated to pass decimal STE2 (and,
   for the two open-receipt tests, decimal STE1) values. One stray real
   shape in `tests/tremolConformance.test.ts` (a `SellPLUfromExtDB` failure
   fixture using the same stale shape) was corrected the same way, even
   though it wasn't failing — it doesn't assert exact message text, but
   leaving an incorrect wire shape in place would have kept misleading the
   next reader.

## Full resolved STE table, as implemented

| Hex | Decimal | Byte | Message (as implemented) | Retryable | Disposition |
|---|---|---|---|---|---|
| 34 | 52 | **STE1** | "Opened fiscal receipt — cancelling and retrying" | `true` | One-shot cancel (`CancelReceipt`) + retry within the same `submitInvoice` call, not a queue loop |
| 34 | 52 | STE2 | "Syntax error" | `false` | Cashier-visible |
| 39 | 57 | STE2 | "Conflict in tax group" | `false` | Cashier-visible |
| 3a | 58 | STE2 | "Invoice number not found" | `false` | Cashier-visible |
| 3b | 59 | STE2 | "Wrong client PIN" | `false` | Cashier-visible |
| 3c | 60 | STE2 | "Missing defined item" | `false` | Cashier-visible |
| 3d | 61 | STE2 | "Item quantity too large" | `false` | Cashier-visible |
| 3e | 62 | STE2 | "Item amount too large" | `false` | Cashier-visible |
| 3f | 63 | STE2 | "Amount exceeds original invoice" | `false` | Cashier-visible |
| 40 | 64 | STE2 | "HS code is not valid" | `false` | Cashier-visible |
| n/a | 19 | `<Res Code>` | "Fiscal device has an open socket from another connection — will retry automatically" | `true` | Queue (`fiscalization_pending`) |
| n/a | 30 | `<Res Code>` | "ZFPLabServer cannot reach the fiscal device …" | `true` | Queue |
| n/a | 31 | `<Res Code>` | "Fiscal device rejected the TCP password …" | `true` | Queue |
| n/a | 53 | `<Res Code>` | "Fiscal session not initialized — reconnecting …" | `true` | Automatic re-`settings()` + retry-once inside `sendCommand`, not a queue loop |
| n/a | 63 | `<Res Code>` | "ZFPLabServer rejected the request format" | `false` | Cashier-visible (malformed request — a code bug, not transient) |

"Cashier-visible" above describes the intended disposition per this step's
classification (`retryable: false` = don't loop, the data must change); as
noted in Applied point 5, wiring that into an actual queue-vs-toast decision
in `main/index.ts`/`fiscal-engine.ts` is explicitly deferred, not done in
this step.

## Tests added/changed

- `tests/wireFixtures.test.ts`: `code40-invoicenotfound.xml` test flipped
  from asserting `undefined` to asserting real extracted hex values.
- `tests/realEtimsProvider.test.ts`:
  - `mapFiscalServerError`: added `'19'` to the message-mapping `it.each`;
    replaced the old "only 53 is retryable" test with one asserting the
    correct four-way split (19/30/31/53 retryable, 63 not).
  - `mapFiscalDeviceError`: replaced the old 7-case table with all 9 PDF
    command-errors codes, each asserted non-retryable with the corrected
    message (including the two wording fixes, 58 and 61).
  - `OpenInvoiceWithFreeCustomerData payload`: the two "Code 52" tests
    rewritten to use `STE1 = 52` (not `STE2`) for the open-receipt
    scenario; a **new** test proves a bare `STE2 = 52` ("Syntax error")
    does *not* trigger the recovery (no retry, no `CancelReceipt`, fails
    immediately); the "invalid PIN" test's expected message updated to
    "Wrong client PIN".
  - `xmlDeviceError` renamed `xmlCommandError`, rebuilt to the real Code-40
    wire shape; every call site (STE2 58/59/60/62/64, plus the two STE1=52
    cases) updated accordingly.
- `tests/tremolConformance.test.ts`: one stale-shape fixture corrected to
  the real Code-40 shape (no assertion change needed — it doesn't check
  exact message text).
- `tests/http-client.test.ts`: two new tests proving `postXml` honors a
  custom instance timeout and falls back to `ETIMS_REQUEST_TIMEOUT_MS` when
  none is set; one new test doing the same for `sendGet` (via
  `closeDeviceConnection`).
- Whole suite: **56 files / 829 tests** (822 prior + 7 net new — several
  old tests were rewritten in place rather than added alongside, per
  anti-circularity: the old assertions encoded the wrong shape/mapping and
  were corrected, not preserved).

## Verification

- `npx vitest run` (full suite): **56 files / 829 tests**, 0 unexplained
  regressions. Every test that changed did so because it encoded the old,
  now-corrected (wrong) behavior or an unrealistic wire shape — none were
  loosened to hide a defect.
- `npm run typecheck` (node + web): clean.

## VERIFY-ON-DEVICE

- **The open-receipt byte itself.** This step's STE1-vs-STE2 conclusion is
  now grounded directly in the primary PDF source (transcribed above, via
  `pdftotext`, not a renderer-dependent read) plus `fp_core.js`'s own
  Code-40-only STE extraction — about as settled as it can get without a
  live device. But no live Code-40 has ever been captured in this project
  (Code 31/19 have blocked reaching an open device session so far — see
  `docs/phase-65.md`). The new `console.warn` in `checkDeviceResponse` logs
  **both** `STE1` and `STE2` (plus `FPLibErrorCode`) on every real Code 40,
  specifically so the first live one is unambiguous even if this analysis
  is somehow wrong.
- **`FPLibErrorCode`'s meaning and value range** — extracted and logged, but
  what it actually signifies beyond the two STE bytes is not in the PDF
  excerpt reviewed and is not acted on anywhere in this codebase yet.
- **Whether the real device actually emits decimal 57/63/64 (0x39/0x3f/0x40)**
  — these three were not previously audited in any prior phase (only
  52/58/59/60/61/62 had live-adjacent scrutiny); they're taken directly
  from the PDF table but have no fixture or capture precedent in this
  project.
- Everything else already tracked (defVer gating, VAT-class routing,
  credit/debit notes, etc.) is unaffected by this step.

## KNOWN_GAPS.md

Not touched this step — the retryable-vs-queue *wiring* gap (Applied point
5) is a new scope boundary worth tracking, but since this step already
STOPS for review, recording it in `KNOWN_GAPS.md` is left for your call: say
the word and it's added, or fold it into Chunk 3's own scope note instead.

## Status

**STOP** — per this step's brief, Chunk 3 does not start until you've
reviewed this. In particular, worth confirming before proceeding:

1. The STE1=52/STE2=52 split and the full corrected STE2 table (both now
   traced to the actual PDF text above, not a secondhand citation).
2. The `retryable` scope boundary (Applied point 5) — computed and exposed
   internally, not yet wired into the checkout/queue decision.
3. Whether the retryable-vs-queue wiring gap should go into
   `KNOWN_GAPS.md` now or wait for Chunk 3.
