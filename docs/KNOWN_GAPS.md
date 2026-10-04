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

## Fiscal device daily closure (`DailyReport`) is never sent, and waits on VIL

Found in the docs/phase-157 Reports audit, built on in docs/phase-158.
The device's daily-closure command family - `DailyReport` (which zeroes
and records the day in fiscal memory, preceded by an Electronic Journal
report) and its read-only companions `ReadDailyAmountsByVAT`,
`ReadEODAmounts`, `ReadEODAmountsByDate`, `ReadFirstEODDate` - is not
wired into this app at all. `FiscalEndpointPaths`
(`real-etims-provider.ts`) declares twelve commands; none of these five
is among them, and no command in this family is ever sent.

**Update (docs/phase-162)**: the condition itself is now named. Before
this, `checkDeviceResponse` (`real-etims-provider.ts`) only named one
`STE1` value (`52`, "Opened fiscal receipt"); `STE1 = 0x3b` (59 decimal -
"24 hours block, missing Z report", per the protocol) fell through to
whatever `STE2` mapped to instead, which is an unrelated business code
(`STE2 = '59'` happens to mean "Wrong client PIN" - a coincidental
overlap in a different byte column), so a cashier hitting this condition
would have seen a misleading message. `checkDeviceResponse` now checks
`STE1 = 59` on its own, before `STE2`'s table, and reports a plain
cashier-facing reason ("The fiscal device needs its daily closure before
it can file sales...") with `kind: 'technical'`, `retryable: true` - the
sale is queued and retried automatically, the same as any other
transient fiscal condition, never tagged as a wrong-PIN data issue. This
is a naming/classification fix only; nothing changed about which
commands are sent, and the daily closure itself still isn't wired in -
see below.

**What's still open**: whether and how the daily closure should ever
run is explicitly a VIL/TSL decision (per the client's own POC scope),
not an engineering one - sending `DailyReport` zeroes fiscal memory and
"cannot be undone" (docs/phase-157's own framing). No command in this
family has been sent, in testing or otherwise, and none should be until
VIL confirms the cadence and who is authorized to trigger it.
`VERIFY-ON-DEVICE`: what `STE2` (if any) actually accompanies a real
`STE1 = 0x3b` response (the new check does not depend on it, but it has
still never been observed), and the exact cashier-facing wording KRA
expects for it - the protocol PDF section for this was not available to
check this against.

**Blast radius**: none today - nothing in this codebase can reach
`DailyReport`. The `STE1 = 0x3b` classification fix affects any sale a
real device rejects with that code: it is now queued for automatic
retry with a plain reason, rather than shown as a wrong-PIN/other STE2
business rejection.

## Fiscal reconciliation report (system amount vs device-validated amount) - built, with two residual caveats

Found in the docs/phase-157 Reports audit. At the time, nothing in the
fiscal submission path ever read back a monetary total from the device
to compare against the order's own `total` - only the invoice number, QR
code, and (best-effort, unpersisted) CU serial were ever read back.

**Update (docs/phase-163, docs/phase-163-1)**: built. `submitInvoice`'s
existing Step 5 (`ReadCurrentReceiptInfo`, the "read VAT" validation
gate) already reads the device's five per-VAT-group amounts; docs/
phase-163 stores them verbatim (`orders.fiscal_vat_groups_json`) and adds
`generateFiscalReconciliation` (a read-only report comparing each
fiscalised order's charged total against the sum of those amounts:
matched, mismatch, or no-device-figure) plus a Reports sub-view, CSV
columns, and a "VAT from device groups" Sales Summary figure. No new
device command was needed - VIL checklist item 13 turned out not to
require the protocol re-examination this entry originally called for.

**Two residual caveats, not further reduced by docs/phase-163-1**:

1. **VAT-group `'D'` is excluded from every derived VAT figure.** The
   confirmed VIL manual table (docs/phase-65) gives `'D'` no single rate
   - "usually free for any other rates" - so `deriveGroupVat` reports its
   VAT as `'not-known'` rather than guessing one, and the Sales Summary's
   "VAT from device groups" total simply omits `'D'`'s contribution
   (docs/phase-163-1 added the coverage caption - "from N of M sales;
   group D not included" - specifically so this omission is visible next
   to the figure, not silent).
2. **The report is only as good as what the device actually returns at
   Step 5.** "Matched" and "mismatch" are both computed purely from the
   device's own reported figures - a device that returns a subtly wrong
   but well-formed number would be reported as a confident match or
   mismatch with no way for this build to detect the difference, since
   there is no independent source to check it against. This is the
   report doing its job (comparing till vs device), not a defect in it,
   but it means the report cannot itself vouch for the device's own
   accuracy - only for whether the till and the device agree.

**Blast radius**: read-only reporting output. No fiscal filing, command,
argument, or sequence is affected by either caveat.

## No profit/margin reporting - no cost data exists anywhere, and Shopify's own route is undocumented

Found in the docs/phase-157 Reports audit (Part 2's cost-price search:
`grep -rniE "\bcost(Price|PerItem|_price)?\b|unitCost" src` returns
nothing but two unrelated prose comments). Neither the local schema nor
any Shopify query this app makes carries a cost figure, so no report -
till-side or otherwise - can compute margin today.

Shopify does hold cost per item, on `InventoryItem.unitCost` (a
`MoneyV2`, requiring the "View product costs" permission once granular
product permissions are enabled - checked against `shopify.dev`'s
`InventoryItem` reference on 2026-09-26) - but this app has never read
or requested that field or permission. Separately, Shopify's own
`orderCreate` mutation reference does not state, either way, whether an
order created through the Admin API (as every sale from this till is)
appears in Shopify's built-in profit/analytics reports the same way a
checkout-created order does - **not in the official documentation**,
checked 2026-09-26.

**What's still open**: a product-owner decision on whether profit is
ever reported for this POC, and if so, where - Shopify (contingent on
the merchant actually maintaining `unitCost` there, and on confirming
Shopify's own orderCreate-sourced orders actually surface in its profit
reports, which is unconfirmed) or not at all. The till should not become
a second source of cost/margin truth either way (Shopify is the only
stock ledger - a project rule, not a preference).

**Blast radius**: none - no report claims to show profit or margin
today.

## Refunds, voids and credit notes are absent from every report

Found in the docs/phase-157 Reports audit. Void was deliberately removed
from the till's UI in Phase 131 (`orders:void`'s handler in `index.ts`
now refuses every call: "Void was removed from the till because a sale
may already be filed with KRA and the till cannot issue the credit note
that would reverse it. The channel stays registered so a stale renderer
gets a plain refusal, not a missing-handler error.") - the backend
plumbing (`voids.ts`, the `orders` table's `voided` status) still exists
and is exercised by tests, but nothing in the renderer can reach it.
Credit notes are further along at the fiscal-provider level (see this
file's own "credit/debit notes" entry above) but are, likewise, wired to
no caller. Because neither path is reachable, no report - including the
new docs/phase-158 Reports tab - can show a refund, a void, or a credit
note happening, only their complete absence.

**What's still open**: a product decision on whether/how refunds should
work on this till at all, given a fiscalised sale cannot be reversed
without a credit note this app doesn't yet issue live. Until that
decision is made, no report can be built for data that structurally
cannot exist.

**Blast radius**: none - this is an absence, not a behaviour to protect.

## `reports:*` read channels have no server-side role check (docs/phase-158)

The Admin Reports tab (and the older Z-report/daily-summary/end-of-day
screens) are reachable in the renderer only when `currentStaff.role ===
'admin'` (`App.tsx`), but every `reports:*` **read** IPC channel
(`z-report`, `daily-summary`, `end-of-day`, and the five docs/phase-158
additions - `shifts-list`, `sales-summary`, `fiscal-by-day`,
`invoice-list`, `export-csv`) has no matching check in the main process.
This was investigated explicitly for docs/phase-158: the main process
has **no concept of a currently logged-in staff member at all** - every
privileged write re-verifies a manager PIN passed explicitly on that
request (`requireAdminPin.ts`), which works for a write but has nothing
to check a read against, since a read carries no PIN. Inventing a
session, or bolting a PIN prompt onto a read, was explicitly ruled out
for docs/phase-158 rather than done as a workaround.

**What's still open**: whether this POC needs a real session concept in
the main process (so a read can be gated the same way a write is) is a
product/engineering decision, not something to guess at. Until then, any
`reports:*` read is reachable by any authenticated renderer script
regardless of which screen is showing - a low-severity gap today (the
data is read-only and store-internal), but one that should not silently
widen as more `reports:*` reads are added.

**Blast radius**: `reports:*` read channels only. No write channel is
affected - `reports:approve-day` already re-verifies an admin PIN
server-side and is unchanged.

## Reports VAT uses one rate per order, not per line

Found in docs/phase-157, corrected from additive to extractive in
docs/phase-158, noted as still approximate in docs/phase-158-1.
`computeVatIncluded` (`reports.ts`) extracts VAT from an order's `total`
at the store's single configured rate. This is correct today because
every item on the till currently carries the same VAT treatment. It
becomes wrong the moment a basket mixes VAT classes - a zero-rated or
exempt item alongside a standard-rated one - since one rate applied to
the whole order total would misstate the VAT on that order.

**What's still open**: VAT on reports uses one rate per order; wrong for
mixed baskets once per-item VAT classes arrive (Item 3). Fix: per-line
VAT or device figures (G8) - either compute VAT per line item once each
line carries its own rate, or read the device's own per-VAT-group
totals back after fiscalisation (docs/phase-157 Part 3, G8) rather than
recomputing an approximation on the till side at all.

**Blast radius**: every Z-report, daily summary, sales summary, and
`orders.csv` VAT figure - all read-only reporting output. No fiscal
filing is affected; the device's own submitted totals are unrelated to
this approximation and remain correct regardless of it.

## Server-side discount refusal (docs/phase-161-1) does not detect a price override

Found while building docs/phase-161-1's `orders:checkout` belt-and-braces
check. The renderer's own safeguard (`fiscalModeStore.ts`, docs/
phase-161) hides the price-override control on a live till, and the new
server-side check (`requestHasDiscount.ts`) refuses a request carrying a
line or cart discount - but it does not, and cannot soundly, detect a
price override.

`cartItemSchema` (`ipcValidator.ts`) does carry a `basePrice` field
alongside `price`, so an `item.price !== item.basePrice` check is
possible to write. It was deliberately not written: both `price` and
`basePrice` are entirely renderer-supplied and unverified against the
till's real catalog data, so a request could set `price` to any value
while also setting `basePrice` to match it - defeating this specific
check without needing to touch `discount`/`cartDiscount` at all.
Checking it would give a false sense of a closed loophole rather than
actually closing one.

**What's still open**: a genuine server-side override check needs the
main process to know the variant's real catalog price independently of
what the request claims (e.g. looked up from the last-synced product
cache) - not proposed or built here. Until then, the only defence
against a live-mode price override is the renderer hiding the control
(`fiscalModeStore.ts`) and the underlying receipt/fiscal mismatch itself
being fixed properly (docs/phase-160 Part B).

**Blast radius**: a compromised or buggy renderer on a live till could
still submit an overridden price - the same risk docs/phase-160 already
described, just not closed by this server-side check specifically. A
correctly-behaving renderer (the actual, non-adversarial case this app
runs today) cannot reach this at all, since `fiscalModeStore.ts` already
hides the control.

## Duplicate-recovery support helpers are unused (phase 208)

`resolveDuplicateRecoverySupport` and `DuplicateRecoverySupport` in `http-client.ts` have no caller in `src/` since phase 208 removed the `ReadCUinvoiceNumber` recovery, and no test references them either. They are left in place for a later cleanup; phase 208 did not need to touch them.

## voidLocalOrder has no caller (phase 209)

`voidLocalOrder` in `services/voids.ts` has no caller since phase 131 disabled voiding; remove in a later cleanup.

## A Shopify push with no location is retried, then abandoned (phase 210)

A sale is refused at checkout when the till has no location, so an order with no location should not exist. If one does (a sale queued before phase 210 on a till whose location was since cleared), `pushOrderToShopify` fails it. A failed push counts an attempt like any other: after `SYNC_MAX_ATTEMPTS` (10, about 2.5 hours) the order is set `failed` and its queue row deleted (`recordQueueFailure`), and `sync_queue.last_error` is not shown anywhere in the app. The same is true of the existing "Shopify credentials missing" refusal. A deferral that counts no attempt, and a visible reason, are not built. Also not known: what Shopify does with an order fulfilled from a location that holds no stock of a "deny" variant (phase 210, section 3).

## Two tills at one location can produce the same trader invoice number (phase 211)

The trader system invoice number is `L` + the location id in base 36 + a time-based sequence. Two tills in the same shop get the same location code, and each till's sequence comes from its own clock and its own last value, so two sales in the same second, one at each till, would produce the same number on a control unit they share. The monotonic guard works inside one till's database only. What the device does with a duplicate `TraderSystemInvNum` has never been captured. Today each shop has one till, so this does not arise. Revisit when a second till joins a shop; an 8-character location code leaves no spare character for a till marker. Also: a wiped database loses `last_trader_seq`, so a wiped till whose clock is set behind its earlier sales could repeat a number. A clock before 2026-01-01 counts as 0.

## A 58mm printer cannot print TOTAL KSH and its amount on one large line (phase 216)

A double-size line holds half as many characters as a normal one: 24 at 48 columns, 21 at 42, 16 at 32. At 32 columns (a 58mm printer) `TOTAL KSH` and an amount such as `1,650.00` are 17 characters, so the row does not fit one large line. It prints as two large lines, the label first and the amount padded to the right edge beneath it (`keyValueLines`, `columnsFor`). The design mock-up's single large line is reproduced at 48 and 42 only. The owner accepted this as a known limit of 58mm printers. A smaller type size for that one row would remove it; not built. The same limit applies to the PDF fallback at 32 columns.

## The End of Day page already runs past the design box when it has data (phase 217)

Measured by `check:fit` on this PC's data at 1366x768 @150%: with no held sales discarded, the End of Day "Approve" button sits at y 857 in a 772px window, so it is clipped by the Admin content wrapper (`overflow-hidden`, no scroll). `check:fit`'s census cannot see this, because it only looks for page scroll and `auto`/`scroll` containers, not content clipped by an `overflow-hidden` box; its End of Day line passes. Phase 217 added a list of discarded held sales to this page, shown only when there is one and kept to three rows a page, so it adds nothing on a day with none. It does not fix the overflow.

## A full cart page runs past the window when the offline-catalogue badge shows (phase 217)

With 7 cart lines (`CART_LINES_PER_PAGE`) and the "Cached catalog (offline)" badge showing, the cart footer (Clear cart, Hold sale, the pager) ends at y 801 in a 772px window at 1366x768 @150%, so it is clipped. The held-sales strip keeps this no worse (6 lines a page while it shows: 795). Not fixed. The same blind spot as above applies: the census does not flag it.
