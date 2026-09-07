# Known Gaps

Tracked, deliberate gaps between current behavior and full correctness
— each one deferred for a stated reason, not forgotten. When a gap is
closed, delete its entry here in the same change that closes it.

## eTIMS: credit/debit notes are unverified against a live device, and not wired into any caller

Resolved in Phase 60: `RealFiscalizationProvider.cancelInvoice` now
requires the original invoice's full customer block
(`CreditNoteDetails` — `companyName`/`buyerPin`/`headQuarters`/
`address`/`postalCodeAndCity`/`exemptionNum`/`relatedInvoiceNum`/
`traderSystemInvNum`) and, when given one, posts the real
`OpenCreditNoteWithFreeCustomerData` command with its 8 caller-supplied
fields — confirmed against the authoritative vendor SDK
(`ZFP_SDK_KE_2509041522_ControlUnit`, `tracker/SDK_RECON.md` §5), not
guessed. Without `details`, it reports the manual-credit-note fallback
immediately and posts nothing. The earlier gap (a guessed, contract-
invalid `OpenCreditNote` command) is closed —
`tests/tremolConformance.test.ts` now asserts this as a normal, green
check rather than a tracked `it.fails`.

**What's still open**: (1) the corrected 8-field shape has not been
confirmed against a live device — the Code 31 TCP-password issue
(tracked outside this repo's docs) still blocks reaching one; (2)
`cancelInvoice` is not called from anywhere in the app yet — no
checkout/refund path currently constructs a `CreditNoteDetails` (the
original invoice's customer block would need to be persisted somewhere
retrievable at refund time, which doesn't exist today). Per Phase 60's
brief, this is deliberate — do not wire it into the live checkout path
or attempt live verification without a working device.

**Blast radius**: `cancelInvoice` only, and only once something calls
it. `submitInvoice` (the checkout-path fiscal flow) is unaffected and
fully conformance-checked.

## eTIMS: the fiscal-text allow-list and pre-send validation are `VERIFY-ON-DEVICE`

Phase 66 (Step 1 of the VIL/TSL G03 manual reconciliation) closed two
small gaps `docs/phase-65.md` found: `HSCode`/`MeasureUnit` now go
through `sanitizeFiscalText` like every other free-text field (not a
bare `.slice()`), and a new `fiscal-validate.ts` (`validateFiscalInvoiceRequest`,
called at the top of `submitInvoice`) fails fast — before any device
call — when a required item field is missing, a non-class-A line lacks
`HSCode`/`HSName`, or a supplied buyer PIN isn't 11 characters in KRA
format. Both are sourced from the VIL G03 manual's own setup step 3 and
post-implementation checklist item 14, not guessed.

**What's still open**: the sanitizer's allow-list (`[A-Za-z0-9 .,-]`)
is a reasonable default — the manual warns generically that "symbols"
can block a request from reaching TIMS, without enumerating exactly
which ones are safe — but the exact safe set is unproven against a real
Control Unit. If a live device rejects a legitimate value containing
`.`/`,`/`-` (or accepts something outside this set that the allow-list
currently strips), the allow-list itself — not the presence of a
sanitizer — is what needs adjusting. `VERIFY-ON-DEVICE`: run a live
sale with company/item names containing each allowed punctuation mark
and confirm TIMS accepts the invoice.

**Blast radius**: `submitInvoice` only. A request that fails the new
validator returns immediately with a typed error (surfaced like any
other `ServiceResult` failure — cashier-visible / queued per the
existing resilience contract), never reaching the device.

## eTIMS: duplicate-filing recovery (`ReadCUinvoiceNumber`) is wired but unverified against a live device

Resolved (mechanism) in Phases 74–76 (the "never file a tax invoice
twice" step, Rule 1). `docs/phase-70.md`'s audit ("§4", "§6") had left
two open items: `TraderSystemInvNum` stability across retries was
correct but untested (closed by Phase 74 — see `tests/
realEtimsProvider.test.ts`'s "SAME TraderSystemInvNum" tests), and
`readCUInvoiceNumber()` existed but was called from nowhere (closed by
Phase 75). The audit also flagged a real gap: no phase had pinned down
*which* STE code signals a duplicate-`TraderSystemInvNum` rejection.
Phase 75 took the audit's own recommended structural route instead of
guessing a code — `FiscalInvoiceRequest.isRetry` marks any
non-first-attempt submission, and `submitInvoice` now calls
`ReadCUinvoiceNumber` before concluding failure on *any*
`OpenInvoiceWithFreeCustomerData` rejection during a retry/resend,
regardless of its STE code. Phase 76 additionally reclassified a
queued retry that comes back non-retryable (`data`/`system`) to
`needs_fixing` (removed from `sync_queue`, no longer retried forever)
and added `resendFiscalization` (`fiscal-retry.ts`) — the manual resend
entry point Steps 3/4 will call, which loads the order's STORED fiscal
request (`orders.fiscal_request_json`) rather than reconstructing one,
and goes through the same recovery/safety gate as the background queue.

**What's still open (`VERIFY-ON-DEVICE`)**:

1. The entire `isRetry` → `ReadCUinvoiceNumber` recovery path
   (`real-etims-provider.ts#submitInvoice`). No live
   duplicate-`TraderSystemInvNum` rejection has ever been captured —
   this is built from `ReadCUinvoiceNumber`'s documented *purpose*
   (protocol PDF §2.4.13 / `tracker/SDK_RECON.md` §5.5: "Request for
   original invoice number in case of open receipt rejection due to
   duplicate TRADER SYSTEM INVOICE NUMBER"), not an observed response.
   Confirm against a live device: (a) that a duplicate
   `TraderSystemInvNum` actually causes `OpenInvoice` to fail rather
   than silently refiling, and (b) that `ReadCUinvoiceNumber` reliably
   returns the correct prior invoice number in that situation, not some
   unrelated or stale value.
2. A recovered sale's QR code is permanently empty (`qrCode: ''`) —
   `QRcode` is only ever returned by `CloseReceipt`, which a recovered
   attempt never sends. This is a deliberate, approved design decision
   (Phase 75), not a device fact to verify — but it means a receipt for
   a recovered sale can never show a QR code. Receipt-wording handling
   for an empty QR is deferred to a later step of this feature (Step 5)
   and is not itself blocked on live-device access.

**Blast radius**: `submitInvoice`'s retry/resend path only — a first
checkout attempt is structurally unaffected (`isRetry` is never set),
confirmed by `tests/realEtimsProvider.test.ts`'s first-attempt tests.

## eTIMS: a `defVer` mismatch is observable, but a real one only warns — go-live block policy undecided

Phase 68 (Step 3 of the VIL/TSL G03 manual reconciliation, finding #1)
closed the "passive warn only" gap `docs/phase-65.md` found: `settings()`'s
`<defVer>` echo is now a structured three-state comparison
(`checkDefVersion` in `http-client.ts` — `'match'` / `'mismatch'` /
`'unknown'`, where a blank `<defVer>` is `'unknown'`, not a mismatch — the
real captured `settings-ok.xml` fixture itself has an empty `<defVer>`).
The state is cached once per session (piggybacking `ensureSettings`'s
existing `settingsPromise`) and surfaced two ways: `FiscalInvoiceResult.defVerStatus`
on every `submitInvoice` result (the same "field on a result" channel
already used for `cuSerialNumber`/`fiscalizedAtSource`), and one prominent
structured `console.warn` from `getSettings` on an actual `'mismatch'`.
`resolveSellCommand`'s VAT-class routing (`SellPLUfromExtDB` for class A
vs `SellPLUfromExtDB_HS` otherwise) now carries a code comment stating it
is valid only for `defVer=2509041522` and depends on this check.

**What's still open**: on a real `'mismatch'`, this build still **proceeds
with the sale** — it does not block. Per the VIL manual, an older `defVer`
(`2112311201`) exposes a wider `SellPLUfromExtDB` (VAT classes A-E on one
command) than the 2509041522 defs this build targets (`OptionVATClass`
restricted to `"A"`, with `_HS` for B/C/D/E) — a real mismatch means the
routing this build sends may not match what the connected server/device
actually expects, which could surface as device-level rejections rather
than a clean, typed error. `VERIFY-ON-DEVICE`: whether a real mismatch
should **warn-and-proceed** (current behavior) or **hard-block** the sale
is a go-live decision, deliberately not made in this POC — record the
decision here (and remove this gap) once a live device confirms which
`defVer` the production Control Unit actually reports.

**Update (go-live prep, Phase 92)**: the guard has never actually fired
in this codebase's own hands, not just against a live device. The
captured `settings-ok.xml` fixture (`tests/fixtures/wire/settings-ok.xml`
— the response every mock-server test and `npm run mock:zfplab` itself
serves) has `<defVer></defVer>` blank, so `checkDefVersion` evaluates
`'unknown'` on every test run and every demo. Whether a real Control Unit
echoes `2509041522`, some other value, or nothing at all is still
completely open — the warn-vs-block policy question above assumes a real
`'mismatch'` is something that will actually happen; it is equally
possible a real device also reports a blank `<defVer>`, in which case
this gap resolves itself as moot. `VERIFY-ON-DEVICE`: the first live
`settings()` call settles both questions at once — what the device
reports, and therefore whether the warn/block decision above is even
needed.

**Blast radius**: `submitInvoice` only, and only when the connected
server's `defVer` is present and differs from `2509041522`. No behavior
change on `'match'` or `'unknown'` (the common case, including every
existing fixture/mock).

## eTIMS: the invoice's customer address block ships blank on every sale

Found during go-live prep's audit (`docs/phase-89.md` §2) — not
introduced or changed by go-live prep itself, just never previously
flagged here. `OpenInvoiceWithFreeCustomerData`'s seven caller-supplied
arguments include `HeadQuarters`/`Address`/`PostalCodeAndCity`/
`ExemptionNum` — the buyer's details on a B2B invoice — but no caller
populates any of them. `checkout.ts`'s `buildFiscalRequest` sets only
`companyName` and the buyer PIN; `real-etims-provider.ts#buildOpenInvoiceArgs`
(`:1055`) sends the remaining four through `sanitizeFiscalText` exactly
as documented — "Uncaptured fields keep their `<Arg>` element with an
empty value rather than being omitted, matching the vendor client" — so
every invoice this app has ever fiscalized carries `Value=""` on all
four.

This matches the vendor client's own convention (`fp_core.js`'s arg
builder sends `Value=""` for an explicit empty string; only `null`/
`undefined` is omitted entirely — `tracker/SDK_RECON.md` §2.2), so it is
not a wire-format bug. What is unverified is whether TIMS *accepts* a
blank `HeadQuarters`/`Address`/`PostalCodeAndCity`/`ExemptionNum` when a
buyer PIN is present. The machine definitions mark all seven args
compulsory, but per the SDK's own compulsory/optional mechanism that
means "the argument must be present", not "non-empty" — the protocol PDF
and the defs blob are both silent on whether TIMS itself further requires
non-blank values for a B2B invoice.

**What's still open**: deliberately out of scope for go-live
(`docs/phase-92.md`, close-out) — capturing these four fields would mean
four more taps on a touch till on every sale to satisfy a requirement
that may not exist, at a branch where most sales are walk-in B2C with no
PIN at all. `VERIFY-ON-DEVICE`: the first real B2B invoice submitted with
a customer PIN is the test. If TIMS rejects or flags it for the blank
fields, wiring up capture (new checkout UI fields, `buildFiscalRequest`,
`FiscalInvoiceRequest`) is a contained follow-up, not a rework.

**Blast radius**: every B2B invoice (one carrying a `buyerPin`) submitted
by `submitInvoice`. A B2C walk-in sale (no PIN) is unaffected either way
— KRA does not require these fields on a B2C receipt.
