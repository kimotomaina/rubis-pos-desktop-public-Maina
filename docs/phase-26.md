# Phase 26 — Order History Interactivity & PDF Receipt Fallback

**Date:** 2026-08-27 · **Branch:** `main` · **Previous:** [Phase 25](./phase-25.md)

## 1. Objective

Two gaps found before deployment: order cards in Order History were
static (no way to see what was actually in a sale without reprinting
it), and a thermal printer going offline mid-shift silently failed the
print instead of giving the cashier anything to hand the customer.
This phase makes order cards expandable to show line items, and adds
a PDF fallback receipt when the thermal printer can't be reached.

## 2. Order History (`OrderHistory.tsx`, `database.ts`)

`RubisDatabase.getOrders()`'s `SELECT` didn't include `payload_json`,
even though `OrderRow` already declared the field (used elsewhere via
`getOrder()`/`getOrdersForShift()`) — so line items were fetched by
the list view but silently absent. Added `payload_json` to the
`SELECT`, per the brief's recommended option, since it's already the
same JSON blob every other order-detail read path parses.

`OrderHistory.tsx` gained `expandedOrderId: number | null`; clicking
anywhere on a card toggles it. Expanded, the card renders each line
item as `<Qty> x <Product Name> (<Variant>) - <Line Total>`, parsed
from `payload_json.lineItems` via a `getLineItems()` helper that
returns `[]` on a missing/malformed payload rather than throwing.

Two existing interactive elements inside the card — the
Print/Retry/Void buttons and the fiscal `<details>`/QR block — needed
`e.stopPropagation()` added so the new card-wide click handler doesn't
swallow or double-fire their own click behavior. This wasn't spelled
out for the fiscal block in the brief, but leaving it unguarded would
have broken its pre-existing summary/QR toggle the moment this phase
shipped — caught while testing the interaction, not building against
a rule.

## 3. PDF fallback (`pdf-receipt.ts`, `printer.ts`)

New `src/main/services/pdf-receipt.ts` renders `generatePdfReceipt`
via `pdfkit`, laid out identically to the thermal receipt (store name,
order #, date, cashier, optional customer PIN, dashed rule, items,
dashed rule, subtotal/tax/total, payment method, footer) and saves to
`path.join(app.getPath('desktop'), 'RUBIS_Receipt_Order_<localId>.pdf')`,
returning the path.

This is the one module in `src/main/services` that imports
`electron`'s `app` directly, rather than taking a resolved path as a
constructor argument the way `database.ts`/`errorHandler.ts` do —
matching the brief's literal `path.join(app.getPath('desktop'), ...)`
call. It's still fully unit-testable: `electron`'s `app.getPath` is
undefined outside a real Electron process but is never called unless
the function actually runs, so `printer.test.ts` (which never
executes the real generator) needs no `electron` mock at all; a new
`tests/pdfReceipt.test.ts` mocks just `app.getPath` to point at the OS
temp directory and lets `pdfkit` write a real, disposable PDF.

`printer.ts`'s shared `sendToPrinter` helper gained an optional
`onOfflineFallback` callback, invoked when `isPrinterConnected()`
returns `false` or `execute()` throws a network error (`ECONNREFUSED`,
`EHOSTUNREACH`, `ETIMEDOUT` — see `isPrinterOfflineError`). Only
`printReceipt` passes one (via the new `fallBackToPdf` + injectable
`PdfReceiptGenerator` parameter, threaded through `printReceiptToType`
too); `printZReport` and `printTestPage` pass nothing and keep failing
exactly as before — there's no sensible PDF for a Z-report to fall
back to, and a test page failing is itself the useful signal. A
hardware fault that isn't a network error (out of paper, etc.) still
fails normally rather than silently masking the problem behind a PDF.

`ReceiptPrintResult` gained optional `mode?: 'pdf'` and `filePath?:
string`, set only on the fallback path — the existing
`{ printed: true, mock: false }` shape for a normal print is
unchanged.

## 4. Renderer feedback (`App.tsx`)

`handlePrintReceipt`'s success toast now checks `result.data?.mode`
first: `'pdf'` shows "Printer offline. Receipt saved to Desktop as
PDF.", otherwise falling through to the existing mock/hardware
messages unchanged.

## 5. Testing

- `tests/orderHistory.test.ts` — new case asserting `getOrders()`'s
  SQL contains `payload_json`.
- `tests/printer.test.ts` — the two tests that previously asserted an
  offline/`ECONNREFUSED` print simply fails were rewritten (the
  behavior itself changed by design) to assert the PDF fallback fires
  with an injected fake generator; a new third case confirms a PDF
  generator failure still surfaces as a normal print failure rather
  than silently succeeding.
- `tests/pdfReceipt.test.ts` (new, 3 tests) — real `pdfkit` output to
  a mocked desktop path: file exists, starts with the `%PDF-` magic
  header, and renders without error when a customer PIN is present.

## 6. Verification

- `npm run typecheck` — clean (both `node` and `web` projects).
- `npm test` — 508/508 passing (503 prior + 5 new: 1
  `orderHistory.test.ts` + 1 `printer.test.ts` + 3
  `pdfReceipt.test.ts`; two pre-existing `printer.test.ts` cases were
  rewritten in place rather than added).
