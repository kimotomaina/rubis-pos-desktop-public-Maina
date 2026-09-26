# Phase 161 - Two small builds from docs/phase-160

Disciplined-engineering build task, two separate commits. Based on the
findings in docs/phase-160 (a discount or price override is filed with
KRA and printed on the receipt against the raw, undiscounted price).

**Hard rules observed**: no change to what is sent to the fiscal device
(`buildFiscalRequest`, `real-etims-provider.ts`, `fiscal-retry.ts`,
`fiscal-routing.ts` - all untouched, confirmed by `git status`/`git diff`
on both commits); no change to `orders.ts` or anything sent to Shopify
(untouched); the fiscal block on the receipt (CU invoice number, QR,
date) is unchanged - only the subtotal/discount/total/VAT lines above it
changed; no device command sent (never `DailyReport`); no SQL run
against real data. Every changed assertion is listed by name below, with
old -> new -> why.

- **Date:** 2026-09-26
- **Branch / base commit:** staging @ 1f80ce2 (Phase 160 - discounts and
  totals audit) before Commit 1; Commit 1 @ b14eaac before Commit 2.
- **Outcome:** Implemented, both commits.

---

## Commit 1 - Interim safeguard: hide discount/override controls in live fiscal mode

Commit: `b14eaac`.

### 1. Audit

- `src/main/services/fiscal-provider-factory.ts:49-71`
  (`resolveFiscalizationProvider`) - the one function that decides
  `RealFiscalizationProvider` vs `MockFiscalizationProvider`.
- `src/main/index.ts:786` (`fiscalizationProvider` resolved) and its
  five existing `instanceof RealFiscalizationProvider` checks elsewhere
  in the same file (`index.ts:820,843,985,1712,1976`) - the established
  pattern this codebase already uses to ask "is this the real provider?"
  without re-deriving the mock/packaged decision.
- `src/renderer/src/components/CartLineItem.tsx:139-163` (the "Edit
  Price"/"Discount" buttons) and `PosCheckoutPanel.tsx:219-249,315-375`
  (the "+ Discount" button and the CASH/M-PESA payment section).
- `src/renderer/src/stores/unfiledCountStore.ts` - the closest existing
  precedent for a Zustand store that reads one flag from the main
  process once at startup (`init()`'s idempotent shape).
- No existing test file for `CartLineItem` or `PosCheckoutPanel`'s
  behaviour existed before this change - only
  `tests/posCheckoutPanelFit.test.ts` (a layout-only test).

### 2. Changes made

1. **`src/main/index.ts`** - a new `fiscal:is-live` handler, placed
   beside the existing `fiscal:unfiled-count` one, returning
   `fiscalizationProvider instanceof RealFiscalizationProvider` - the
   exact instance already resolved at startup, never a second
   evaluation of `mockRequested`/`isPackaged`.
2. **`src/preload/index.ts` / `window.d.ts`** - `isFiscalLive(): Promise<ServiceResult<boolean>>`.
3. **`src/renderer/src/stores/fiscalModeStore.ts`** (new) - `fiscalLive`
   (default `false`), read once via `init()`, mirroring
   `unfiledCountStore.ts`'s idempotent-init shape. Defaults to the
   mock-mode value and keeps it on any read failure, rather than
   guessing.
4. **`src/renderer/src/App.tsx`** - calls `init()` once at startup,
   alongside the existing `initUnfiledCount()` call.
5. **`src/renderer/src/lib/checkoutMath.ts`** - new
   `hasDiscountOrOverride(items, cartDiscount)`, a pure function
   deciding whether a cart already carries a line discount, a cart
   discount, or a price override (`item.price !== item.basePrice`).
6. **`src/renderer/src/components/CartLineItem.tsx`** - the "Edit
   Price"/"Discount" buttons are hidden entirely when `fiscalLive` is
   true (product owner's default: hide the price-override control too,
   per the task brief).
7. **`src/renderer/src/components/PosCheckoutPanel.tsx`** - the "+
   Discount"/"Edit Discount" button is hidden when `fiscalLive`. When
   `fiscalLive` is true **and** the cart already has a discount/override
   (`hasDiscountOrOverride`), the entire payment section (CASH/M-PESA
   toggle, numpad, Complete Sale button, and the embedded `PaymentModal`
   for M-Pesa) is replaced with one plain notice: *"This sale has a
   discount or price override that cannot yet be filed correctly with
   KRA. Remove it from the cart before completing this sale."* Nothing
   is dropped from the cart - the discount/override stays exactly as
   entered until a person removes it. Replacing the whole section
   (rather than just disabling "Complete Sale") is what also blocks
   M-Pesa, which has no button of its own to disable - it completes
   through `PaymentModal`'s own STK-push flow.
8. **Mock mode** (`fiscalLive: false`, the default): every control stays
   exactly as before. `posCheckoutPanelFit.test.ts` was not touched and
   its 6 tests pass unmodified.

### 3. Tests

- `tests/fiscalModeStore.test.ts` (new, 5 tests) - `init()` sets the
  flag from a successful read, keeps the safe default on `false`, on a
  failed `ServiceResult`, and on a thrown IPC call; is idempotent (a
  second `init()` does not re-fetch).
- `tests/cartLineItemFiscalGate.test.ts` (new, 2 tests) - real mount,
  both controls visible in mock mode, both hidden when live.
- `tests/posCheckoutPanelFiscalGate.test.ts` (new, 6 tests) - real
  mount: the cart-level control is hidden when live with a plain cart;
  Complete Sale stays reachable when live with nothing stale; a cart
  that already has a line discount, a price override, or a cart
  discount each replace the payment section with the notice and leave
  the discount/cart data untouched (`useCartStore.getState().cartDiscount`
  asserted still set); mock mode with an already-discounted cart behaves
  exactly as before (Complete Sale reachable, no notice).
- `tests/discounts.test.ts` - 6 new tests for `hasDiscountOrOverride`
  (no discount/override; line discount; cart discount; price override;
  `basePrice` unset never counts as an override; no `cartDiscount`
  argument behaves the same as `null`).
- **Mutation checks** (introduced, verified to fail the expected new
  tests, then reverted and re-verified clean via `git diff`):
  - Inverted `CartLineItem.tsx`'s `{!fiscalLive && (...)}` to
    `{fiscalLive && (...)}`: both `cartLineItemFiscalGate.test.ts` tests
    failed as expected (mock mode lost its buttons; live mode kept
    them). Reverted; `git diff` on the file matched the intended change
    exactly.
  - Forced `PosCheckoutPanel.tsx`'s `staleDiscountOrOverride` to always
    be `false`: the three "cart already carries a discount/override/cart
    discount" tests failed as expected (`expected '...' to contain
    'cannot yet be filed correctly'`); the three tests unrelated to
    that specific condition (plain-cart hide, plain-cart Complete-Sale-
    reachable, mock-mode-with-discount) correctly kept passing,
    confirming the mutation's blast radius matched what it should
    affect. Reverted; `git diff` matched the intended change exactly.

**No existing test's assertion was changed in Commit 1** - only new
tests were added.

---

## Commit 2 - Receipt totals (docs/phase-160 Part A, go-live plan Item 3)

Commit: `41e51f4`.

### 1. Audit

- `src/main/services/printer.ts:210-270` (`renderReceipt`, before this
  change) and `src/main/services/pdf-receipt.ts:31-84`
  (`generatePdfReceipt`) - two independent copies of
  `subtotal = Σ unitPrice × quantity`, `tax = subtotal × rate`,
  `total = subtotal + tax`, neither reading `discount`/`cartDiscount` at
  all (docs/phase-160's finding).
- `src/main/services/reports.ts:129-139` (`computeVatIncluded`) and
  `reports.ts:141-153` (`formatVatRateLabel`, docs/phase-158-1) - the
  functions to reuse, not re-implement.
- `src/main/index.ts:2444-2479` (`receipt:print`) - where
  `payload.lineItems`/`payload.cartDiscount`/`order.total` were being
  read but only a stripped-down subset reached the printer.
- `src/main/services/fiscal-provider-factory.ts`'s
  `FiscalProviderLogger` - the pattern followed for the new module's
  injectable logger (defaults to `console`, swappable in tests).
- `tests/printer.test.ts`, `tests/pdfReceipt.test.ts`,
  `tests/printerRegistry.test.ts` - every existing `ReceiptOrder`
  fixture, to find every place a new required `total` field would need
  adding.

### 2. Changes made

1. **`src/main/lib/receiptTotals.ts`** (new) - `computeReceiptTotals(order, vatRate, logger?)`:
   - `rawSubtotal` = Σ `unitPrice × quantity` across `order.lineItems`.
   - `discountTotal` = every line's own discount, summed, plus the cart
     discount applied on top of the line-discounted subtotal (the same
     order docs/phase-160's `checkoutMath.ts` uses: line discounts
     first, cart discount on what's left).
   - `total` = `order.total`, always - **never recomputed** from the
     lines. This is the one property that matters most and is asserted
     directly in `receiptTotals.test.ts`.
   - `vatIncluded` = `computeVatIncluded(order.total, vatRate)`, a
     direct call into `reports.ts` - not a re-implementation.
   - If `rawSubtotal - discountTotal` differs from `order.total` by more
     than 0.01, logs one warning naming the order id and returns
     `order.total` regardless (the stored figure is always what gets
     printed - a reconciliation mismatch is a signal to investigate the
     stored data, not something to guess a "corrected" total from).
   - The one small piece of arithmetic duplicated here rather than
     imported - `discountAmount(base, discount)`, the same clamp
     `applyDiscount` (`renderer/src/lib/checkoutMath.ts`) uses - crosses
     the main/renderer boundary the same way docs/phase-158-1 already
     accepted for `formatVatRateLabel`.
2. **`src/main/services/printer.ts`**:
   - `ReceiptOrder` gains `total: number` (required) and
     `cartDiscount?: Discount`.
   - `ReceiptLineItem` gains `discount?: Discount`.
   - `renderReceipt` deletes its own subtotal/tax/total calculation
     (the old `printer.ts:211-216`) and calls `computeReceiptTotals`
     instead. Prints, in order: `Subtotal`, then `Discount: -<amount>`
     **only when `discountTotal > 0`**, then `Total` (bold, as before),
     then `` `${formatVatRateLabel(settings.taxRate)}: <amount>` ``
     (reusing docs/phase-158-1's function, not a new label string).
3. **`src/main/services/pdf-receipt.ts`** - the identical change:
   deletes its own subtotal/tax/total calculation (the old
   `pdf-receipt.ts:36-38`), calls the same `computeReceiptTotals`, prints
   the same four lines in the same order.
4. **`src/main/index.ts`**'s `receipt:print` handler - the line-item
   mapping now passes `discount: line.discount` through (was dropped);
   the order object now includes `total: order.total` and
   `cartDiscount: payload.cartDiscount` (both previously stripped).

### 3. Deliberate test changes (old -> new -> why)

Both in `tests/printer.test.ts`, both testing the same fixture
(2 x Ksh 12.50 mug + 1 x Ksh 19.99 t-shirt, no discount, 8% rate):

1. **`renderReceipt > issues the ESC/POS call sequence: header, items, totals, footer`** (`printer.test.ts:100-114`)
   - **Old**: `expect(lineTexts).toContain('Tax: Ksh 3.60')` (44.99 x
     0.08, added on top); `expect(lineTexts).toContain('Total: Ksh 48.59')`
     (subtotal + that tax).
   - **New**: no "Discount:" line present (`lineTexts.some(t =>
     t.startsWith('Discount:'))` is `false` - nothing was discounted);
     `Total: Ksh 44.99` (the order's own stored total, unchanged since
     shelf prices already include VAT and nothing was discounted);
     `VAT included (calculated at 8%): Ksh 3.33` (44.99 x 0.08 / 1.08,
     the VAT already inside 44.99, extracted rather than added).
   - **Why**: the old assertions tested the exact additive-tax bug
     docs/phase-159 found and this phase fixes. The fixture's `order`
     gained a `total: 44.99` field (the amount that would actually have
     been charged for this VAT-inclusive-price sale).
2. **`printReceipt > logs the formatted receipt to the console in mock mode`** (`printer.test.ts`)
   - **Old**: `expect(logged).toContain('Total: Ksh 48.59')`.
   - **New**: `expect(logged).toContain('Total: Ksh 44.99')`.
   - **Why**: same fixture, same reasoning as above - this test logs the
     same `renderReceipt` output through the mock-mode path.

**No other existing assertion was changed.** `tests/pdfReceipt.test.ts`
and `tests/printerRegistry.test.ts` only gained a `total` field on their
existing `ReceiptOrder` fixtures (a new required field, not a changed
expectation) plus new tests.

### 4. Tests

- **`tests/receiptTotals.test.ts`** (new, 11 tests) - the pure function,
  matching the task's exact worked examples:
  - No discount (2 x 25.00): `total: 50`, `vatIncluded: 6.90`.
  - 2 x 100.00 with a 10.00 line discount: `rawSubtotal: 200`,
    `discountTotal: 10`, `total: 190`, `vatIncluded: 26.21` at 16%.
  - 1 x 100.00 with a 10% cart discount: `rawSubtotal: 100`,
    `discountTotal: 10`, `total: 90`, `vatIncluded: 12.41`.
  - Both together (line discount then cart discount on the
    line-discounted subtotal): `rawSubtotal: 200`, `discountTotal: 29`,
    `total: 171`, `vatIncluded: 23.59`.
  - 1.00 at 16%: `vatIncluded: 0.14` (the task's own worked example).
  - `total` always equals the stored total, across five different
    stored values, none recomputed.
  - Reuses `computeVatIncluded` rather than re-implementing it,
    checked at an 8% rate that doesn't round-trip cleanly at 2dp (a
    drifted duplicate would very likely disagree here).
  - The reconciliation warning: fires exactly once, names the order id,
    and `total` still comes back as the (mismatched) stored figure; does
    **not** fire when the figures reconcile exactly, or when the
    mismatch is exactly the 0.01 tolerance boundary.
  - A discount can never reduce a line below zero.
- **`tests/printer.test.ts`** - 2 new tests: prints the discount line
  and the stored total for a discounted order (200 raw, 10 discount,
  190 total); omits the discount line entirely when nothing was
  discounted.
- **`tests/pdfReceipt.test.ts`** - 2 new tests: accepts a line discount
  and a cart discount without throwing, and still produces a valid PDF.
  **Not content-level** - `pdfkit`'s output is a compressed PDF stream
  and this project has no PDF-text-extraction dependency; the existing
  tests in this file only ever check file existence and the PDF magic
  header. The line-by-line correctness of what gets printed is covered
  exhaustively by `receiptTotals.test.ts` (the shared pure function,
  used identically by both `printer.ts` and `pdf-receipt.ts`) and by
  `printer.test.ts` (the thermal path, whose `println` calls are
  plain-text-assertable). Recorded here rather than silently claimed.
- **Mutation check** (introduced, verified to fail the expected tests,
  then reverted and re-verified clean): changed
  `computeReceiptTotals`'s return to `total: rawSubtotal + vatIncluded`
  (the exact old bug, reintroduced) - 10 of 11 `receiptTotals.test.ts`
  tests failed immediately (every one that asserts a specific `total`),
  plus both new `printer.test.ts` discount tests and the two changed
  "totals" tests. Reverted; `git diff` on `receiptTotals.ts` matched the
  original file exactly.

---

## Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/main/index.ts` | Modified (both commits) | New `fiscal:is-live` handler; `receipt:print` now passes discount/total fields through |
| `src/preload/index.ts`, `window.d.ts` | Modified | `isFiscalLive()` exposed to the renderer |
| `src/renderer/src/stores/fiscalModeStore.ts` | Added | Whether this till is running the real fiscal provider |
| `src/renderer/src/App.tsx` | Modified | Reads the flag once at startup |
| `src/renderer/src/lib/checkoutMath.ts` | Modified | `hasDiscountOrOverride` |
| `src/renderer/src/components/CartLineItem.tsx` | Modified | Hides Edit Price/Discount when live |
| `src/renderer/src/components/PosCheckoutPanel.tsx` | Modified | Hides + Discount when live; blocks checkout on a stale discount/override |
| `src/main/lib/receiptTotals.ts` | Added | Shared subtotal/discount/total/VAT for both receipt renderers |
| `src/main/services/printer.ts` | Modified | `renderReceipt`'s printed totals |
| `src/main/services/pdf-receipt.ts` | Modified | `generatePdfReceipt`'s printed totals |
| Nine test files | Modified/added | See per-commit sections above |

## Possible impact

- **Direct**: on a real (non-mock) till, cashiers can no longer add a
  new discount or price override; a cart carrying one already (e.g.
  restored from the persisted cart across a restart) blocks checkout
  with a plain notice until removed. Every printed/logged receipt now
  shows a Discount line when applicable and a corrected Total/VAT that
  matches the amount actually charged, on both the thermal and PDF
  fallback path.
- **Indirect**: none identified. Neither commit touches `checkout.ts`,
  the fiscal integration files, `orders.ts`, or the Shopify sync path.
- **Data / schema / contract**: none. No database schema change. The
  `ReceiptOrder`/`ReceiptLineItem` type changes are additive (new
  optional/required fields on main-process-internal types, not an IPC
  request schema).
- **Security posture**: unchanged.
- **Idempotency / re-run safety**: unchanged - `computeReceiptTotals` is
  a pure function; `fiscal:is-live` is a pure read.
- **Residual risk**: the reconciliation warning in
  `computeReceiptTotals` is genuinely reachable in production if stored
  order data is ever malformed or from a future code path that computes
  a discount differently - by design it still prints the stored total
  rather than blocking, so a live warning should be treated as a data
  investigation, not ignored as noise.

## Verification

- `npm run typecheck` - clean (both `typecheck:node` and
  `typecheck:web`), run after each commit's implementation.
- `npx vitest run` (full suite) - **123 test files, 1840 tests, all
  passing**, confirmed on a clean sequential run. (Two runs under
  concurrent-process load in this session hit unrelated infrastructure
  flakiness - one `tests/stockTake.test.ts` timeout that passed cleanly
  in isolation, and one run where four unrelated test files failed with
  `[vitest-worker]: Timeout calling "fetch"` while another vitest
  process was running at the same time in this same session - neither
  touches any file this phase changed, and a clean single run
  afterwards passed in full.)
- `npm run build` - succeeds; `verify-no-mock-provider.cjs` confirms
  neither mock fiscal provider is in the packaged output.
- `npm run check:fit` - **18/18 cases pass**, including the Cash/M-Pesa
  checkout panel (now carrying the live-mode gating logic) and every
  Admin Reports sub-view, at all 9 window sizes, no overflow.
- **Tripwires unmodified** - confirmed via `git status`/`git diff` on
  both commits: no file in the fiscal suite
  (`real-etims-provider.test.ts`, `fiscal-retry.test.ts`,
  `fiscal-routing.test.ts`, `fiscalValidate.test.ts`, etc.), no
  `mpesaPaymentGate`-related file, no keyboard test, and no Phase E
  layout test (`screensFitDesignBox.test.ts`,
  `posCheckoutPanelFit.test.ts`, `headerLayout.test.ts`,
  `belowLgUnreachable.test.ts`) appears in either commit's file list.

No version bump. No installer rebuild.

## Rollback

`git revert` Commit 2 (`41e51f4`) then Commit 1 (`b14eaac`), in that
order (Commit 2 does not depend on Commit 1's code, but reverting in
reverse-commit order is the simplest guaranteed-clean path). No data or
config migration is involved.

## Observed but not changed

- The reconciliation-warning threshold (0.01) and the "assign the
  rounding remainder to the last line" question docs/phase-160 Part B
  raised are for the fiscal-side fix (Part B), not this phase - Commit 2
  only changes what is printed, never what is sent to the device.
- `pdf-receipt.ts` has no automated content-level test coverage for its
  printed text (see Commit 2's Tests section) - a pre-existing property
  of this test file, not introduced here, and out of this phase's scope
  to fix (would need a PDF-text-extraction dependency).

**STOP for review.**
