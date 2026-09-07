# Phase 70 / Step 0 — Failed-sales handling: audit (read-only)

Standing context: `RUBIS_ETIMS_MASTER_BRIEF.md` §0–§9, the four rules this
feature must never break, and the three-state model (`fiscalized` /
`waiting` / `needs_fixing`). Nothing was changed in this step — read-only,
as required. **STOP for review** — Step 1 does not start until you've
looked this over.

## 1. How a completed sale is saved, and where fiscal results attach

`orders` (`database.ts:219-235`) has exactly three fiscal columns, added via
`migrateOrdersFiscalColumns` (`:193-202`) for pre-existing installs:
`fiscal_invoice_number`, `fiscal_qr_code`, `fiscal_fiscalized_at` — all
`TEXT`, all nullable. **There is no fiscalization status field of any
kind.** The order's own `status` column (`pending_sync` / `synced` /
`failed` / `voided`) is the *Shopify* sync lifecycle — unrelated to
fiscalization, never touched by the fiscal path.

Today a sale is only ever in two *observable* states, both inferred rather
than stored: "fiscalized" (`fiscal_invoice_number IS NOT NULL`) or
"everything else" — and "everything else" is indistinguishable between
*currently retrying*, *permanently rejected*, and *abandoned after 10
attempts* without cross-referencing `sync_queue` (see §2). This confirms
Step 1's core premise directly: there is genuinely no three-state model
today, only a boolean fiscalized/not.

`setOrderFiscalInfo` (`:759-765`) is the only writer — called from two
places: `main/index.ts:906` (the immediate checkout attempt) and
`database.ts:696` inside `markFiscalQueueItemSynced` (a successful queued
retry). Both paths converge on the same method, which is good — Step 1
only needs one place to also write the new status.

## 2. The failure path end-to-end

`submitInvoice` → `main/index.ts`'s checkout handler (`:863-960`) → on
`{success:false}` **or a thrown exception**, unconditionally:
`db.queueFiscalInvoice(localId, fiscalRequest)` +
`fiscalEngine.onCheckoutMade()` (`:908-914` for the result-based failure,
`:931-959` for the thrown-exception fallback — note the exception path
*rebuilds* the request from scratch if `fiscalRequest` was never assigned,
but reuses the same `localId`/`clientOrderUuid`, so identity is preserved
even there).

**Confirmed: every failure is queued, with no branch on error type at
all.** `checkDeviceResponse`'s `retryable` (added `phase-69`) is computed
several layers down but never reaches this decision point — `submitInvoice`
drops it (`ServiceResult<FiscalInvoiceResult>` only carries
`success`/`data`/`error`).

`fiscal-engine.ts`'s `tick()` (`:92-109`) then drains `sync_queue` rows
where `entity_type='etims_invoice'`, resubmitting each via the *same*
`fiscalizationProvider.submitInvoice` (`main/index.ts:595`) — so a queued
retry goes through the exact same STE1=52 one-shot recovery, rollback, etc.
as the original attempt. On failure it calls
`db.recordFiscalQueueFailure` (`database.ts:717-733`), which already has a
give-up mechanism **orthogonal to error type**: exponential backoff
(`SYNC_BACKOFF_BASE_MS=30s`, doubling, capped at 30 min —
`database.ts:162-183`), and after `SYNC_MAX_ATTEMPTS=10` attempts (a few
hours' worth) the row is marked `last_error = 'ABANDONED after N attempts:
...'` and `next_attempt_at` pushed to `Number.MAX_SAFE_INTEGER` — **never
deleted**, left for manual inspection. This means today a non-retryable
"wrong client PIN" rejection sits in the queue getting hammered every
30s–30min for hours before anyone/anything notices it's hopeless — exactly
the problem Step 1 exists to fix, and confirms the fix is "stop enqueuing
it in the first place for a data error," not "make backoff smarter."

## 3. Is `retryable` available at the decision point, and how to carry it

Not today — `submitInvoice`'s return type is the shared
`ServiceResult<FiscalInvoiceResult>` (`shopify-types.ts:149-153`), used
across Shopify sync and every other service; adding `retryable` there
would leak an eTIMS-specific concept into an unrelated shared type (used
by ~a dozen other services).

Two fiscal-specific channels already exist that don't require touching the
shared type, matching the pattern `phase-69` used internally:

- **`FiscalInvoiceResult`** (`etims.ts:112-141`) is eTIMS-specific and
  already carries several optional, provider-specific fields
  (`fiscalizedAtSource`, `cuSerialNumber`, `defVerStatus`) that are absent
  on failure paths since `data` is only populated on success. A `retryable`
  field would need to live somewhere reachable *on failure*, which
  `FiscalInvoiceResult` (nested under `data`) structurally isn't — so this
  alone isn't quite the right shape.
- **The more direct option**: `submitInvoice`'s `ServiceResult<T>` `error`
  field is a bare string today. The smallest change that gets `retryable`
  (plus the reason/kind Step 1 wants) to the checkout decision point
  without touching `ServiceResult<T>` is a **new, eTIMS-specific return
  type** for `submitInvoice` itself — e.g. widening
  `FiscalizationProvider.submitInvoice`'s signature to return a small
  discriminated result (`{ success, data } | { success: false, error,
  retryable, reason, kind }`), or simplest of all, a parallel field
  alongside `error` (`errorRetryable?: boolean`, `errorKind?: 'data' |
  'system' | 'technical'`) on a `FiscalSubmitResult` type that wraps
  `ServiceResult<FiscalInvoiceResult>` rather than replacing it. Either
  way this only touches `FiscalizationProvider`/`RealFiscalizationProvider`/
  `MockFiscalizationProvider` (3 files) plus their callers
  (`main/index.ts`, `fiscal-engine.ts` — 2 files), not the shared type.
  This is a Step 1 design decision, flagged here rather than decided
  read-only.

`checkDeviceResponse`'s internal `DeviceResult.retryable` (`phase-69`) is
the right *source* value — it already correctly encodes the STE1=52 /
STE2-business / server-transient split. The gap is purely "nothing between
`checkDeviceResponse` and `submitInvoice`'s return carries it out."

## 4. `TraderSystemInvNum` — once per sale, or per attempt?

**Once per sale — already stable, already reused verbatim on every
retry.** `buildTraderSystemInvNum` (`real-etims-provider.ts`, near
`buildOpenInvoiceArgs`) is a pure function of `request.localId` (preferred:
`INV-<localId padded to 9 digits>`) or `request.clientOrderUuid` (fallback
when no `localId`) — both stable per-sale identifiers, never regenerated.
`queueFiscalInvoice` (`database.ts:651-659`) stores the *exact*
`FiscalInvoiceRequest` object (including `localId`) verbatim in
`payload_json`; `fiscal-engine.ts`'s `tick()` reads it back unchanged and
resubmits it as-is. So every retry of the same queued item computes the
identical `TraderSystemInvNum`. This is confirmed by history, not just
inference: `docs/phase-23.md` fixed exactly this class of bug once already
(adding `clientOrderUuid`-derived identity so a retry could be recognized
as a duplicate), and `docs/phase-48.md` is where the current
`localId`-based `TraderSystemInvNum` scheme was introduced.

**This means Step 2's foundation is already in place** — it doesn't need
to *build* per-sale stability, only (a) add an explicit test proving it
(the existing tests exercise the happy path and various failures, but none
asserts "two attempts of the same queued item produce the same
`TraderSystemInvNum`"), and (b) make sure a *manual* resend (Step 3/4)
reuses the stored request rather than reconstructing a fresh one.

**Open question for Step 2, not resolved by this audit**: which STE
code(s) actually signal a duplicate-`TraderSystemInvNum` rejection. The
vendor SDK recon (`tracker/SDK_RECON.md` §5.5, protocol PDF §2.4.13)
documents `ReadCUinvoiceNumber`'s *purpose* — "Request for original invoice
number in case of open receipt rejection due to duplicate TRADER SYSTEM
INVOICE NUMBER" — but never states which `STE1`/`STE2` value that
rejection carries. It isn't obviously any of `phase-69`'s now-complete
STE2 table (52/57–64) or the STE1=52 "opened fiscal receipt" case — none
of those messages read as "duplicate invoice number." This is a real gap,
not an oversight: no fixture, no live capture, no phase has pinned it down
yet. Step 2 will need to either find/guess a specific code (risky —
guessing STE values has bitten this project before, see `phase-65.md`'s
own history) or take the safer structural route: **on any
`OpenInvoiceWithFreeCustomerData` rejection during a *retry* (not the
first live attempt), call `ReadCUinvoiceNumber` before giving up** — since
a duplicate-number rejection is specifically a retry phenomenon (the first
attempt can't collide with itself), this sidesteps needing the exact code
at all. Recommend `VERIFY-ON-DEVICE` either way. Flagging now so Step 2
isn't the first time this is discovered.

## 5. Rollback (`CancelReceipt`) on failure

Confirmed best-effort and already correctly scoped
(`real-etims-provider.ts`, `rollback()` near the end of the class): fires
`CancelReceipt`, only logs the result, never throws, never blocks. Called
on: the STE1=52 one-shot retry, a `SellPLUfromExtDB`/`_HS` failure, the
read-VAT gate failure, and a `CloseReceipt` failure. **Not** called when
`OpenInvoiceWithFreeCustomerData` itself fails non-retryably (correct — no
receipt was opened, nothing to cancel) or on `settings()`/`ReadStatus`
failure (correct, same reason, even earlier in the sequence). This means a
failed attempt never leaves a receipt open *from this codebase's own
logic* — the one remaining risk is a process crash/kill mid-receipt
(between a successful `OpenInvoice` and the next command), which the
existing STE1=52 recovery already handles defensively on the *next*
attempt (any process, since the device — not this app — is the source of
truth for "is a receipt currently open"). Nothing new needed here for Step
2 beyond relying on what already exists.

## 6. `ReadCUinvoiceNumber` availability

Confirmed present and contract-tested (`real-etims-provider.ts`, public
`readCUInvoiceNumber()`; endpoint entry already in `FiscalEndpointPaths`/
`DEFAULT_FISCAL_ENDPOINTS`) but called from nowhere in the app — exactly as
`docs/phase-60.md` ("Item 7") and `docs/KNOWN_GAPS.md` left it: "available
now... ready for that wiring," explicitly deferred to a future phase. This
is that future phase. See §4 above for the open question on *when* to call
it.

## 7. Receipt/print path

`printer.ts`'s `renderReceipt` (`:197-259`) prints the fiscal block **only
when `order.fiscalInvoiceNumber || order.fiscalQrCode`** — so an
unfiscalized sale today silently omits the block entirely. That already
satisfies Rule 2 by omission (no fake invoice number ever prints), but
**there is no "this is not a tax invoice" disclaimer** — Step 5 needs to
add one for the `waiting`/`needs_fixing` cases, not just keep the current
silence.

**No real QR-image generation exists.** `printFiscalQrCode`
(`printer.ts:273-`) takes the `qrCode` string the device/provider returned,
base64-decodes it, and passes it straight to `printImageBuffer` as if it
were already PNG bytes — falling back to a text placeholder
(`[QR CODE: ...]`) if that fails. `etims.ts`'s own doc comment on
`FiscalInvoiceResult.qrCode` says as much: "Base64-encoded placeholder for
the KRA-mandated QR code. Real QR generation (the `qrcode` package,
encoding the KRA verification URL) is planned." This matches Step 5's plan
to pull in real QR rendering — confirmed necessary, not already done.

`ReceiptOrder` (`printer.ts:42-56`) has no `cuSerialNumber` field at all —
the CU serial number (added `phase-67`, surfaced on `FiscalInvoiceResult`)
never reaches the receipt today. Step 5 needs to thread it through
(`etims.ts` → wherever `ReceiptOrder` gets built → `renderReceipt`).

**No reprint exists** — no `reprint`-named symbol anywhere in `src/`.
Step 5's reprint requirement is new functionality, not a wiring gap.

## 8. Where the cashier sees post-sale notices; admin/back-office screens

**Nowhere, for fiscalization specifically.** The checkout IPC handler's
return value (`main/index.ts:962-969`) only carries `localId`/`mode`
(Shopify sync mode)/`shopifyOrderId` — no fiscalization outcome of any kind
crosses the IPC boundary today. `OrderHistory.tsx` (`:259-`) shows a
"Fiscalized" badge with the invoice number/QR **only when
`fiscal_invoice_number` is set** — an unfiscalized order (waiting or
otherwise) shows nothing distinguishing it from one that was never even
attempted.

`AdminScreen.tsx` has an extensive eTIMS section (~`:1060-1170`), but it is
**entirely configuration** — base URL, device IP/port/password, default
VAT class, endpoint overrides, mock-vs-real toggle. No operational
visibility: no list of failed/pending sales, no queue depth, no counter.
Steps 3 and 4 are building genuinely new UI, not extending an existing
partial one.

## Adjacent, out-of-scope note

Not asked for in Step 0, but surfaced while tracing the failure path:
voiding an order (`main/index.ts:1753`, `voidOrderSchema`) does delete any
outstanding `sync_queue` row for it (`database.ts:989-992`, both
`entity_type='order'` and `'etims_invoice'`) — so voiding a `waiting`/
`needs_fixing` sale correctly stops it from being fiscalized later. But
voiding an *already-`fiscalized`* sale does **not** call `cancelInvoice`
(no credit note issued) — that's the pre-existing, already-tracked gap
from `docs/KNOWN_GAPS.md` ("credit/debit notes... not wired into any
caller"), unrelated to this feature and not something this build should
silently expand into.

## Summary of what Step 1 actually needs to build

1. A `fiscal_status` column (`fiscalized` / `waiting` / `needs_fixing`) plus
   `fiscal_error_reason` / `fiscal_error_kind` — new columns via the
   existing `migrateOrdersFiscalColumns` pattern, no new table.
2. A fiscal-specific channel (not `ServiceResult<T>`) carrying `retryable`
   + reason/kind from `checkDeviceResponse` out through `submitInvoice` to
   `main/index.ts`'s routing decision — smallest option is a small wrapper
   type per §3 above; the exact shape is a Step 1 design call.
3. The routing itself: success → `fiscalized`; retryable → `waiting` +
   enqueue (today's behavior, unchanged); non-retryable → `needs_fixing`,
   **skip `queueFiscalInvoice` entirely**.

Nothing audited here contradicts the plan in the brief. The one thing
worth deciding *before* Step 1 starts: the exact shape of the fiscal-
specific result type in §3, since `RealFiscalizationProvider`,
`MockFiscalizationProvider`, `fiscal-engine.ts`, and `main/index.ts` all
need to agree on it.

---

**STOP for review**, per this step's brief.
