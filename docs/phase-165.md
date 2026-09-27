# Phase 165 — print a receipt automatically at the end of every sale

Based on docs/phase-164-1 Part A item 4's proposal. Same hard rules as
phase 164: no fiscal-device command added or changed, no change to the
payment gate, no Shopify call, no SQL on real data. Every changed
existing assertion is listed by name, old value, new value, and why.

## 1. Trigger

`cartStore.ts`'s `checkout` action's success branch now calls a new
module-level function, `triggerAutomaticPrint(receipt.localId)`, right
after `set({ checkoutStatus, lastReceipt })` and `get().clearCart()`:

```ts
get().clearCart()
// docs/phase-165: fired after the sale is fully recorded above, not
// awaited — see triggerAutomaticPrint's doc comment for why.
triggerAutomaticPrint(receipt.localId)
```

`triggerAutomaticPrint` calls `window.api.printReceipt(localId, { auto: true })`
— the same call `App.tsx`'s manual "Print Receipt" button already made,
just with `auto: true` added. It is never awaited by `checkout()`, so a
slow or failing print can never delay or affect the sale's own outcome.

This satisfies the brief's constraints directly:

- **Not from a component watching `lastReceipt`.** There is no `useEffect`
  or store subscription anywhere reading `lastReceipt` to decide whether
  to print — the only call site is this one line inside `checkout()`'s
  own success branch.
- **Never on app start or a restored `lastReceipt`.** `lastReceipt` is not
  persisted in the first place — `cartStore.ts`'s `persist` middleware's
  `partialize: (state) => ({ items: state.items })` keeps only `items`.
  A test confirms directly: setting `lastReceipt` on the store (simulating
  what a restore would look like) triggers no print, because nothing
  reads it for that purpose.
- **A same-visit resend never prints again.** `applyFiscalResendResult`
  (called by `FiscalNotice`'s "Correct PIN"/"Remove PIN" actions) only
  ever calls `set(...)` to merge the new fiscal outcome into
  `lastReceipt` — it has no code path into `triggerAutomaticPrint` at
  all. Confirmed by a test.
- **A print failure never affects the sale.** See the bug found and fixed
  below.

## A bug found while testing this

`triggerAutomaticPrint`'s first version wrapped only the RETURNED PROMISE
in a `.catch()`:

```ts
window.api.printReceipt(localId, { auto: true }).then(...).catch(() => {})
```

Running the existing `tests/cartCheckout.test.ts` suite (checkout-flow
tests that predate this phase and don't mock `printReceipt`, since it
never used to be called during checkout) exposed the problem: calling
`window.api.printReceipt` when it's undefined throws SYNCHRONOUSLY, before
a promise is ever returned. `.catch()` only ever sees a promise that was
successfully returned in the first place — it does nothing for a
synchronous throw. That throw propagated straight up into `checkout()`'s
own `try` block and was caught by `checkout()`'s own `catch`, which then
overwrote the already-correct `checkoutStatus` (`'synced'`/`'queued-offline'`)
with `'error'` — exactly the failure mode rule 1's last bullet exists to
prevent, just triggered a different way than "the promise rejects".

**Fix**: wrapped the whole call (not just the `.then()/.catch()` chain) in
its own `try`/`catch` inside `triggerAutomaticPrint`, so neither a
synchronous throw nor a rejected promise can ever reach `checkout()`'s
own try block. This fix alone made every one of `tests/cartCheckout.test.ts`'s
existing tests pass again, unmodified — no assertion there needed to
change, since the fix was in the print trigger's own robustness, not in
what those tests expect from checkout.

In the real app this specific failure mode (a synchronous throw from
`window.api.printReceipt`) is unlikely — the preload bridge always defines
it, and `ipcRenderer.invoke` rejects rather than throwing synchronously —
but the brief's own rule ("a print failure never changes checkoutStatus")
does not carve out an exception for how the failure happens, so the fix
covers both.

## 2. Not-yet-filed slip

`ReceiptFiscalBlockOrder` (`receiptFiscalBlock.ts`) gained `fiscalPending?: boolean`,
alongside two new exported wording constants:

```ts
export const FISCAL_PENDING_HEADER = 'SALE RECORD - TAX INVOICE TO FOLLOW'
export const NOT_A_TAX_INVOICE_LINE = 'Not a tax invoice'
```

`buildFiscalBlockLines` now returns `[NOT_A_TAX_INVOICE_LINE]` instead of
`[]` when `fiscalPending` is set and there is no `fiscalInvoiceNumber` yet
— once an invoice number exists, `fiscalPending` is ignored and the real
CU block always wins (a fiscalised order can never show slip wording).

`ReceiptOrder` (`printer.ts`) gained the same `fiscalPending?: boolean`.
`renderReceipt` and `generatePdfReceipt` both print `FISCAL_PENDING_HEADER`
near the top (after any DUPLICATE stamp, before the store name) when
`order.fiscalPending && !order.fiscalInvoiceNumber` — the same guard as
the slip line, so the two can never disagree. Items, totals and payment
print exactly as they do today; nothing else in the layout changes.

`main/index.ts`'s `receipt:print` handler computes `fiscalPending` with a
new, directly testable pure function (the exact formula the brief gave,
unconditional on `auto` — it reads the same on a manual Order History
print of a still-unfiled sale as it does on the automatic one):

```ts
export function shouldShowFiscalPendingSlip(
  isRealProvider: boolean,
  fiscalStatus: FiscalStatus | null
): boolean {
  return isRealProvider && fiscalStatus !== 'fiscalized'
}
```

called as `shouldShowFiscalPendingSlip(fiscalizationProvider instanceof RealFiscalizationProvider, order.fiscal_status)`.
Extracted into `printer.ts` (not left inline) for the same reason as
docs/phase-164-1's `shouldMarkReceiptPrinted` — `main/index.ts`'s IPC
wiring itself is not unit tested anywhere in this codebase.

`shouldMarkReceiptPrinted` needed no change: it already gates on
`fiscalInvoiceNumber` being present, which a not-yet-filed print never
has — so the slip print is already left unmarked, exactly as the brief
asked.

## 3. Printer offline during an automatic print

`receiptPrintRequestSchema` (new, `ipcValidator.ts`) validates the
`receipt:print` request — this channel previously took its payload with
no zod schema at all, typed only by the handler's own inline TypeScript
shape:

```ts
export const receiptPrintRequestSchema = z.object({
  localId: z.number().int().positive().optional(),
  shiftId: z.number().int().positive().optional(),
  isZReport: z.boolean().optional(),
  printerType: z.enum(['receipt', 'kitchen', 'label']).optional(),
  auto: z.boolean().optional()
})
```

The handler now validates the request through it before anything else,
and destructures `auto` off the validated data. A second new pure
function decides whether to open the PDF viewer:

```ts
export function shouldOpenPdfFallbackViewer(auto: boolean | undefined): boolean {
  return !auto
}
```

```ts
return shouldOpenPdfFallbackViewer(auto) ? openPdfFallbackIfPresent(result) : result
```

The PDF is always saved by `printReceipt`'s existing offline fallback
(unchanged) — only whether it gets force-opened in a viewer differs. A
manual print (`auto` omitted, as `App.tsx`'s call still does) keeps
opening it exactly as before this phase.

The preload bridge's `printReceipt` signature changed from
`(localId, printerType?)` to `(localId, options?: { printerType?; auto? })`
— its only caller before this phase, `App.tsx:258`, calls it with no
second argument at all, so this is not a breaking change for it.

The renderer's side of "one toast": a new pure function,
`getAutoPrintOfflineMessage` (`autoPrintToast.ts`), returns the toast text
only when the automatic print's result has `mode: 'pdf'`, `null`
otherwise (including for an outright failure — no toast for that,
matching the brief's "never blocks" spirit). `triggerAutomaticPrint`
shows it via the shared toast store when non-null.

## 4. `saleCompleteToast` wording

`getSaleCompleteMessage` (`saleCompleteToast.ts:26`): the fiscalised
branch's text changed from `'Sale complete - tax receipt issued.'` to
`'Sale complete - filed with KRA.'`. The condition itself
(`fiscalStatus === 'fiscalized'` and `getFiscalNotice` returns `null`) is
unchanged — only the wording.

**Changed existing assertion** — `tests/saleCompleteToast.test.ts`:

- Test name: `'says the tax receipt was issued when the sale fiscalized'`
  → `'says the sale was filed with KRA when it fiscalized'`.
- Assertion: `toBe('Sale complete - tax receipt issued.')` →
  `toBe('Sale complete - filed with KRA.')`.
- **Why**: docs/phase-164-1's own audit (Part A, Q2) found the old
  wording implied a receipt had been printed, which was never
  necessarily true — this phase makes that true in practice (an automatic
  print now happens), but the wording itself is corrected regardless to
  state only what is actually known at that point: fiscalization
  succeeded, not that paper came out of a printer.

This is the only existing assertion changed anywhere in this phase.

## Tests

- **`tests/cartStore.test.ts`** (new describe block,
  `'Cart Store — automatic receipt print (docs/phase-165)'`):
  - Prints exactly once per checkout, parametrised over cash and mpesa —
    `printReceipt` called once, with `(localId, { auto: true })`.
  - Setting `lastReceipt` directly (no `checkout()` call) never prints —
    proves there is no separate watcher.
  - `applyFiscalResendResult` never prints.
  - A rejected `printReceipt` promise leaves `checkoutStatus`, `items` and
    `checkoutError` exactly as the successful checkout already set them,
    both immediately and after the rejection has actually settled.
  - Shows the "printer offline" toast when the result has `mode: 'pdf'`;
    shows no toast for a genuine physical/mock success.
- **`tests/autoPrintToast.test.ts`** (new): `getAutoPrintOfflineMessage`'s
  four cases (PDF fallback, physical, mock, outright failure).
- **`tests/receiptFiscalBlock.test.ts`**: new cases for `fiscalPending`
  (slip line when set and unfiled; nothing when unset and unfiled; ignored
  once fiscalised) and the two new wording constants' exact strings.
- **`tests/printer.test.ts`**: new `describe` blocks for
  `shouldShowFiscalPendingSlip` (real/mock × every `FiscalStatus` value),
  `shouldOpenPdfFallbackViewer` (`auto` true/false/undefined), and
  `renderReceipt`'s actual output (header position, slip line, no `CU `
  lines, ignored once fiscalised, absent when `fiscalPending` is unset).
- **`tests/pdfReceipt.test.ts`**: existence-only tests (per this file's
  established convention — PDF text isn't assertable) for `fiscalPending`
  alone and alongside a `fiscalInvoiceNumber`.
- **`tests/ipcValidator.test.ts`**: new `describe` block for
  `receiptPrintRequestSchema` — accepts every valid shape (bare sale
  receipt, `auto: true`, Z-report, explicit `printerType`, empty),
  rejects a bad `localId`/`printerType`/`auto`.
- **`tests/receiptPrintTracking.test.ts`** (new describe block,
  `'the automatic end-of-sale print across a sale that files later'`): a
  real in-memory database narrative — auto-print while waiting
  (`fiscalPending: true`, unmarked) → the sale files → the next print
  (`fiscalPending: false`) is the ORIGINAL → a further print is a
  DUPLICATE. A second test confirms the mock provider never shows
  `fiscalPending`, whatever the fiscal status.
- **`tests/cartCheckout.test.ts`**: unmodified — see "a bug found" above.

**Mutation test**: temporarily replaced `triggerAutomaticPrint(receipt.localId)`
in `checkout()`'s success branch with a direct
`await window.api.printReceipt(receipt.localId, { auto: true })` (bypassing
the trigger function's own try/catch entirely). Ran `tests/cartStore.test.ts`
— the named target test ("a print that throws never changes
checkoutStatus...") failed exactly as expected
(`expected 'error' to be 'synced'`); the toast test also failed as a side
effect of bypassing the same code path. Restored, re-verified both green.

## The four rules

Unaffected. No fiscal-device command was added or changed (the printed
CU block's content and gating are unchanged from docs/phase-164/164-1;
this phase only decides WHEN a print happens and what a not-yet-filed
one says). No change to the payment gate (`PosCheckoutPanel.tsx`/
`checkout.ts`'s payment logic — untouched). No Shopify call. No SQL
against real data — all tests use `:memory:` databases or pure functions.

## Verify

```
$ npm run typecheck
(clean)

$ npx vitest run
Test Files: 129 passed (129)
Tests: 1992 passed (1992)

$ npm run build
(succeeds; verify-no-mock-provider.cjs confirmed clean)

$ npm run check:fit
All 18 case(s) fit with no overflow.
```

## Rollback

`git revert` this phase's commit. No schema change, no new IPC channel —
only the existing `receipt:print` channel's request shape gained an
optional `auto` field (backward compatible: any caller that omits it
keeps today's manual behaviour).

## Observed but not changed

- **The PDF-viewer-suppression only affects the automatic print's own
  call.** If a cashier later goes to Order History and prints the same
  sale manually while it's still unfiled, that print still opens the PDF
  viewer on an offline printer (today's behaviour, deliberately
  unchanged per the brief).
- **Mock-mode counts as a genuine print** for `getAutoPrintOfflineMessage`
  (no toast shown), matching docs/phase-164-1's existing reading of
  mock mode for `shouldMarkReceiptPrinted` — consistent, not new.
- **`window.api.printReceipt`'s options-object signature** is a shape
  change (from a second positional `printerType` argument to an options
  object). Its only caller (`App.tsx`) already worked with either shape
  since it never passed a second argument; if some other caller is added
  later expecting the old positional form, it will need updating — noted
  since this is a preload-bridge contract, not purely an internal detail.

STOP for review, per the brief.
