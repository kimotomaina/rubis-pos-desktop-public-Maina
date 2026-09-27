# Phase 164-1 — audit the end-of-sale flow; fix when a receipt counts as the "original"

Same hard rules as phase 164: no fiscal-device command added or changed,
no Shopify call, no SQL on real data. Part A changed nothing; Part B is
the one code change, with every changed existing assertion listed by
name, old value, new value, and why.

## Part A — audit (nothing changed in this part)

### 1. After Complete Sale, step by step — what does the cashier see?

**Cash**, `PosCheckoutPanel.tsx:144-154`, `handleCompleteCashSale`, calls
`checkout({ staffId, paymentMethod: 'cash', tenderedAmount, changeDue,
customerPin, companyName })`. **M-Pesa**, `:160-168`, `handleMpesaPaid`,
called by the embedded `PaymentModal` once Daraja confirms payment, calls
the same `checkout(...)` with `paymentMethod: 'mpesa'`.

Both funnel into `cartStore.ts`'s `checkout` action, `cartStore.ts:181-215`:

```
187: set({ checkoutStatus: 'submitting', checkoutError: null })
...
192:   const result = await window.api.checkout({ items, total, ...params, cartDiscount })
193:
194:   if (result.success && result.data) {
195:     const receipt = result.data
196:     set({
197:       checkoutStatus:
198:         receipt.mode === 'synced' ? 'synced' : 'queued-offline',
199:       lastReceipt: receipt
200:     })
201:     get().clearCart()
```

`window.api.checkout` invokes the `orders:checkout` IPC handler
(`main/index.ts:1082-1156`), which validates the request and calls
`runCheckout` (`checkout.ts`) directly — **no print call anywhere in this
handler**, confirmed by reading it in full.

Back in the renderer, `PosCheckoutPanel.tsx:110-118` reacts to the
terminal status:

```
110: useEffect(() => {
111:   if (checkoutStatus === 'synced' || checkoutStatus === 'queued-offline') {
112:     setTenderedInput('')
...
116:     resetCheckoutStatus()
117:   }
118: }, [checkoutStatus, resetCheckoutStatus])
```

So the panel just clears its own inputs and the cart empties
(`get().clearCart()` above) — there is no confirmation modal, no "sale
complete" screen, nothing to dismiss. The cashier is looking at an empty
cart, ready for the next sale, within one render.

The only feedback is two toast components, both mounted once at the
app's root (`App.tsx:578-579`, `<FiscalNotice />` and
`<SaleCompleteToast />`, siblings of the cart/checkout view, not scoped
to it), both reading `cartStore.lastReceipt`:

- **`FiscalNotice`** shows a (non-auto-dismissing) banner when
  `getFiscalNotice(lastReceipt)` returns non-null — i.e. `fiscalStatus`
  is `'waiting'` or `'needs_fixing'` (`fiscalNotice.ts:45-70`). For
  `'needs_fixing'` with a recognized wrong-PIN rejection, it also offers
  same-visit "Correct PIN" / "Remove PIN & Resend" / "Send to Office"
  actions (`FiscalNotice.tsx:107-181`).
- **`SaleCompleteToast`** shows a 5-second toast
  (`SALE_COMPLETE_TOAST_TIMEOUT_MS = 5000`, `toastTimeouts.ts:14`) with
  `getSaleCompleteMessage(lastReceipt)`'s text, but ONLY when
  `FiscalNotice` has nothing to say — see Q2 below.

**Is any receipt printed without the cashier going to Order History?**
No. Searched the whole repo for every entry point into printing:

| Search | Result |
|---|---|
| `printReceiptToType(` anywhere in `src/` | Exactly one call: `main/index.ts:2482`, inside the `receipt:print` IPC handler. |
| `window.api.printReceipt` anywhere in the renderer | Exactly one call: `App.tsx:258`, inside `handlePrintReceipt`. |
| Where `handlePrintReceipt` is wired | Exactly one prop: `onPrint={(localId) => void handlePrintReceipt(localId)}` on `<OrderHistory>` (`App.tsx:531`), which is `OrderHistory.tsx`'s "Print Receipt" button (`OrderHistory.tsx:177-186`). |
| `print`/`Receipt` anywhere in `checkout.ts` | Only a doc comment and the `CheckoutReceipt` type name — no print call. |
| `print`/`Receipt` anywhere in `cartStore.ts` | Only `lastReceipt` (the stored `CheckoutReceipt` object) and its doc comments — no print call. |
| `print`/`Receipt`/`FiscalNotice`/`SaleCompleteToast` in `PosCheckoutPanel.tsx` | No matches at all. |
| `auto.?print`/`autoPrint`/`AUTO_PRINT` (case-insensitive) anywhere in `src/` | No matches. |
| A checkbox/setting for automatic printing anywhere in `AdminScreen.tsx` | No matches — the only checkboxes there are unrelated (mock-vs-real provider toggles, etc.). |

**Conclusion**: this build has never auto-printed a receipt for any sale,
fiscalized or not. The literal first print of a freshly completed sale
and any later reprint are the same button, same handler, same IPC call
(`receipt:print`) — there is no separate "print on checkout" code path,
confirming and extending docs/phase-164's own finding from the printer
side.

### 2. `saleCompleteToast.ts:26` — when is "tax receipt issued" shown?

```
saleCompleteToast.ts:24-27
export function getSaleCompleteMessage(receipt: FiscalOutcome): string | null {
  if (getFiscalNotice(receipt)) return null
  return receipt.fiscalStatus === 'fiscalized' ? 'Sale complete - tax receipt issued.' : 'Sale complete.'
}
```

The exact condition for the "tax receipt issued" wording is
`receipt.fiscalStatus === 'fiscalized'` **AND** `getFiscalNotice(receipt)`
returns `null`. `getFiscalNotice` returns `null` only when `fiscalStatus`
is `'fiscalized'` or `null`/never-attempted (`fiscalNotice.ts:45-70`,
quoted above) — so in practice the "tax receipt issued" text is reachable
in exactly one case: `fiscalStatus === 'fiscalized'`.

**Is it shown for a `waiting` or `needs_fixing` sale?** No. For either of
those, `getFiscalNotice` returns a non-null notice, so
`getSaleCompleteMessage` returns `null` at line 25 before it ever reaches
the ternary — `SaleCompleteToast.tsx:37-38` then does nothing
(`if (!message) return`), and `FiscalNotice`'s own banner is shown
instead.

**But** — and this is the point Part B does not touch, since it's outside
this brief's fix, and is flagged here for a human — "tax receipt issued"
is **only ever a toast message**. Confirmed by reading
`SaleCompleteToast.tsx` in full: it calls `useToastStore.getState().show(...)`
and nothing else. It never calls `window.api.printReceipt` or anything
resembling it. So today, for a fiscalized cash/M-Pesa sale, the cashier
sees the words "tax receipt issued" on screen for five seconds while no
physical or PDF receipt has actually been produced, unless they
separately go to Order History and print one. The wording is accurate in
the sense that KRA has been told about the sale (fiscalization
succeeded), but it reads, to a cashier or a customer glancing at the
screen, as if a receipt has come out of the printer.

### 3. What does the thermal receipt print for the QR code? What does the PDF print?

**Thermal (`printer.ts`)** prints the QR as a raster image when the
client supports it, falling back to a plain-text placeholder:

```
printer.ts:337-351
async function printFiscalQrCode(
  client: ThermalPrinterLike,
  qrCodeBase64: string,
  invoiceNumber?: string
): Promise<void> {
  if (client.printImageBuffer) {
    try {
      await client.printImageBuffer(Buffer.from(qrCodeBase64, 'base64'))
      return
    } catch {
      // Not a decodable image — fall through to the text placeholder.
    }
  }
  client.println(`[QR CODE: ${invoiceNumber ?? qrCodeBase64.slice(0, 12)}]`)
}
```

Called only when `order.fiscalQrCode` is present, after the CU block's
text lines (`printer.ts:306-314`).

**PDF (`pdf-receipt.ts`)** prints no QR code at all — grepped the whole
file for `QR`/`fiscalQrCode`: the only matches are a comment stating this
explicitly (`pdf-receipt.ts:104`, "No QR image in the PDF fallback — it
never carried one before this phase either"). This was already true
before docs/phase-164 (the PDF fallback had no fiscal block whatsoever
until that phase) and is unchanged by it — a QR image in a PDF would need
a QR-generation/rendering step this project doesn't have, and is out of
scope here.

### 4. Proposed smallest auto-print design (not built)

**Trigger.** Add one small renderer component, mounted alongside
`FiscalNotice`/`SaleCompleteToast` in `App.tsx`, reading
`cartStore.lastReceipt` the same way both of them already do, firing
**once per `localId`** via the same de-duplication pattern
`SaleCompleteToast.tsx:31-35` already uses (`useRef<number | null>`, so a
same-visit PIN-correction resend — which also updates `lastReceipt` via
`applyFiscalResendResult` — never re-triggers a second print for the same
sale). On a new `localId`, it calls `window.api.printReceipt(lastReceipt.localId)`
— **exactly the same call `handlePrintReceipt` already makes**, through
the same single `receipt:print` IPC handler. No new IPC channel, no new
main-process entry point for the trigger itself.

**Why the renderer, not the main process.** `runCheckout`
(`checkout.ts`) already returns before anyone knows the final rendered
line items in the shape `printer.ts` wants, and the renderer already has
`window.api.printReceipt(localId)` fully built, tested, and (as of
docs/phase-164/164-1) correctly gated for duplicates and CU-block
content. Printing from inside `orders:checkout` itself would add printer
latency to the checkout round-trip and duplicate logic that already
exists one layer up — the smaller change is to fire the existing call
automatically instead of waiting for a click.

**What each outcome prints**, using data already available by the time
`lastReceipt` updates (`fiscalStatus`, from the SAME `CheckoutReceipt`
`FiscalNotice`/`SaleCompleteToast` already read):

- **Fiscalized** (`fiscalStatus === 'fiscalized'`): the full receipt,
  exactly as printed today — no new logic needed. By the time this fires,
  `orders.fiscal_invoice_number` is already set (fiscalization completed
  synchronously during `runCheckout`), so `receipt:print`'s existing
  `db.getOrder(localId)` read-back already returns a row
  `buildFiscalBlockLines` renders the CU block for, unchanged from
  docs/phase-164.
- **Not yet fiscalized** (`'waiting'`, `'needs_fixing'`, or `null`/never
  attempted — the fiscal device could still be reached moments after this
  print, so `fiscal_invoice_number` may still be `null` at print time):
  needs a **new, deliberately different receipt** — a slip, not a tax
  invoice. Smallest change: one new optional field on `ReceiptOrder`,
  e.g. `fiscalPending?: boolean`, set by the caller
  (`main/index.ts`) from `fiscalizationProvider instanceof
  RealFiscalizationProvider && order.fiscal_status !== 'fiscalized'` —
  gated on the real provider so a mock/non-eTIMS deployment, where no tax
  invoice is ever coming, doesn't print a promise it will never keep.
  When set, `renderReceipt`/`generatePdfReceipt` print one prominent line
  — e.g. `"Sale record - tax invoice to follow"` — in the exact position
  the CU block would otherwise occupy (which is already empty for an
  unfiled order, since `buildFiscalBlockLines` already returns `[]`
  there), and print everything else (items, totals, payment) exactly as
  today, so the customer still leaves with proof of what they paid.
- **Printer offline**: `printReceipt`'s existing offline detection
  (`printer.ts`'s `sendToPrinter`) already falls back to the PDF
  generator automatically (docs/phase-96 onward) — nothing new needed for
  the fallback itself to fire. But `receipt:print`'s existing
  `openPdfFallbackIfPresent` (`main/index.ts:2428-2435`) forcibly opens
  that PDF in the OS's default viewer (`shell.openPath`) on every call.
  Firing that from an AUTOMATIC trigger, rather than a deliberate button
  press, means a PDF viewer window would pop up unprompted after every
  single sale for as long as the printer stays offline — potentially a
  stack of windows during a busy shift with a broken printer. **This
  needs a decision**: either accept it (identical to today's manual
  behaviour), or suppress the auto-open specifically for the auto-print
  trigger (still save the PDF silently; the cashier opens it deliberately
  from Order History if a copy is needed while the printer is down). The
  smaller, less disruptive default is the latter — flagged here for the
  product owner rather than assumed.
- Per Commit 2/phase-164-1's write-once rule, none of this changes
  whether a print is stamped DUPLICATE: the auto-print becomes the
  sale's first physical print (and, once fiscalized, the one that
  actually marks `receipt_printed_at` — see Part B), so a later manual
  reprint from Order History is correctly labelled a duplicate, exactly
  as if the cashier had pressed "Print Receipt" themselves the first
  time.

This is a proposal only — nothing above was built in this phase.

## Part B — fix when a receipt counts as the "original"

### Audit

Docs/phase-164's `main/index.ts:2523-2525` (pre-phase-164-1) marked a
receipt printed on ANY success, PDF fallback included, and regardless of
fiscal status:

```
if (result.success) {
  db.markReceiptPrinted(localId)
}
```

This meant a PDF fallback, or a plain print of a still-`waiting` sale,
could each independently claim to be "the original" — so the eventual
first REAL, FISCALISED physical print (the actual tax document) could be
wrongly stamped DUPLICATE.

### Changes made

- **`src/main/services/printer.ts`**: new exported pure function
  `shouldMarkReceiptPrinted(result, fiscalInvoiceNumber): boolean` —
  `result.success && result.data?.mode !== 'pdf' && !!fiscalInvoiceNumber`.
  Extracted (rather than left inline in the IPC handler) specifically so
  this exact gating is directly testable — `main/index.ts`'s IPC wiring
  itself is not unit tested anywhere in this codebase (confirmed again in
  this phase's own audit), matching how `routeFiscalOutcome`
  (`fiscal-routing.ts`) and `buildFiscalBlockLines`
  (`receiptFiscalBlock.ts`) are already extracted for the same reason.
  Mock-mode prints (`data.mock === true`, no `mode` field) count as
  physical here — mock mode stands in for the real printer, not the PDF
  fallback; flagged below in case that reading isn't what was intended.
- **`src/main/index.ts`**: the `receipt:print` handler now calls
  `db.markReceiptPrinted(localId)` only when
  `shouldMarkReceiptPrinted(result, order.fiscal_invoice_number)` is
  true, instead of on any `result.success`.
- **`src/main/services/database.ts`**: doc comments only, no schema
  change (per the brief). `OrderRow.receipt_printed_at`,
  `hasReceiptPrinted` and `markReceiptPrinted` now document the narrowed
  meaning — "the fiscal receipt physically printed at" — explaining that
  a PDF fallback or a plain/unfiled print never sets it. The migration
  function's comment (`migrateOrdersReceiptColumns`) was also corrected —
  it previously said the column "applies to every sale receipt,
  fiscalized or not", which was true under docs/phase-164's original
  meaning but is no longer accurate.

### Tests

- **`tests/printer.test.ts`** — new `describe('shouldMarkReceiptPrinted (docs/phase-164-1)')`:
  physical + fiscalised → true; mock + fiscalised → true (documents the
  mock-mode reading above); PDF fallback + fiscalised → false; physical +
  unfiled (`undefined`/`null` invoice number) → false; failed print →
  false.
- **`tests/receiptPrintTracking.test.ts`** — new
  `describe('the receipt:print decision sequence (docs/phase-164-1)')`,
  against a real in-memory `RubisDatabase`, replicating `main/index.ts`'s
  exact "peek `hasReceiptPrinted`, then only mark when
  `shouldMarkReceiptPrinted` says so" sequence (the handler itself isn't
  unit-testable, so the test wires the same two functions together the
  handler does):
  - **A PDF fallback leaves it unmarked; the next physical print is still
    the original** — as required.
  - **An unfiled order's physical print leaves it unmarked** — as
    required.
  - **After filing, the first physical print is the original and the
    second is a DUPLICATE** — as required: prints once while unfiled
    (stays unmarked), fiscalizes the order, prints physically (original,
    `isDuplicate: false`, now marked), prints again
    (`isDuplicate: true`).
  - The **existing** `describe('RubisDatabase.hasReceiptPrinted / markReceiptPrinted')`
    tests (write-once, unaffected-by-a-different-order, etc.) needed no
    changes at all and still pass — Part B only changed WHEN the caller
    decides to call `markReceiptPrinted`, never what that method itself
    does.
- **No existing assertion changed.** Every test in `tests/printer.test.ts`
  and `tests/receiptPrintTracking.test.ts` from docs/phase-164 passes
  unmodified; this phase only added new tests plus the doc-comment-only
  changes in `database.ts`.

**Mutation test**: temporarily removed the `result.data?.mode !== 'pdf'`
condition from `shouldMarkReceiptPrinted` (so it marked on a PDF fallback
too). Ran `tests/printer.test.ts` and `tests/receiptPrintTracking.test.ts`
— exactly two tests failed: `shouldMarkReceiptPrinted`'s own "is false for
a PDF fallback print" test, and the sequence test's "a PDF fallback
leaves the receipt unmarked" test. Every other test, including the
"after filing..." and unfiled-order sequence tests, stayed green.
Restored, re-verified green.

## The four rules

Unaffected. Part A was read-only. Part B's only production change is the
gating condition on when one existing method (`markReceiptPrinted`) is
called — no fiscal-device command, no change to filed data, no Shopify
call, no SQL against real data.

## Verify

```
$ npm run typecheck
(clean)

$ npx vitest run
Test Files: 128 passed (128)
Tests: 1955 passed (1955)

$ npm run build
(succeeds; verify-no-mock-provider.cjs confirmed clean)

$ npm run check:fit
All 18 case(s) fit with no overflow.
```

## Rollback

`git revert` this phase's commit. No schema change — the column and its
write-once mechanics are unchanged; only the caller's gating condition
and doc comments moved.

## Observed but not changed

- **The "tax receipt issued" toast wording** (Part A, Q2): technically
  accurate (fiscalization succeeded) but easy to misread as "a receipt
  has been printed", which today is never true unless the cashier
  separately visits Order History. Left as is — the auto-print proposal
  in Part A, if built, would make the wording true in practice without
  needing to change the copy itself.
- **The auto-print design itself** is proposed, not built, per the
  brief's Part A instruction. The two open decisions flagged above (the
  exact slip wording/gating for a not-yet-fiscalized sale, and whether an
  automatic PDF fallback should force-open a viewer window) are for a
  human to settle before implementation.
- **Mock-mode counts as "physical"** in `shouldMarkReceiptPrinted`. If a
  demo/training till running in mock mode should never mark a receipt
  printed (since nothing physical happens), this one condition
  (`result.data?.mode !== 'pdf'`) would need a `!result.data?.mock`
  alongside it — flagged rather than assumed, since the brief's wording
  ("physical, not PDF fallback") didn't mention mock mode either way.

STOP for review, per the brief.
