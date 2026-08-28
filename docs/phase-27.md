# Phase 27 — Fiscal Response Parsing Robustness & Debug Logging

**Date:** 2026-08-27 · **Branch:** `main` · **Previous:** [Phase 26](./phase-26.md)

## 1. Objective

Production logs showed `CloseReceipt` returning HTTP 200 but
`RealFiscalizationProvider` still failing with "Fiscal device closed
the receipt without returning an invoice number" — the device
responded successfully, but the parser's strict `closeResponse.invoiceNumber`
lookup didn't match whatever field name/shape the real ZFP Lab Server
deployment actually used. This phase makes extraction tolerant of the
casing/nesting variants observed in the wild, and logs the raw
response when extraction still comes up empty so the next variant can
be added from evidence instead of guessing again.

## 2. Resilient extraction (`real-etims-provider.ts`)

`CloseReceiptResponse` (previously just `{ invoiceNumber?, qrCode? }`)
now also declares `InvoiceNumber`, `receiptNumber`, `ReceiptNumber`,
`QrCode`, `qr_code`, and a nested `data` object covering the same
variants — every shape called out in the brief, plus `data.receiptNumber`
(lowercase) since that's the exact nested shape the brief's own test
case asks for even though its field-list only named `data.ReceiptNumber`.

Two new module-level functions, `extractInvoiceNumber` and
`extractQrCode`, walk these variants in order via `??` chains and
replace the old direct property accesses in `submitInvoice`. Per Q1,
QR code extraction got the same treatment as the invoice number,
since a device that renames one field renaming the other too is
exactly as likely.

## 3. Debug logging

When `extractInvoiceNumber` finds nothing, `submitInvoice` now calls
`console.warn('[rubis-pos] ZFP CloseReceipt response missing expected invoiceNumber. Raw response:', JSON.stringify(closeResult.data, null, 2))`
before rolling back and returning the existing failure — the response
body from the console reveals which field name the real query needs.
The failure still queues for the store-and-forward retry exactly as
before; only the diagnostic changed.

## 4. `CloseReceipt` payload — verified, not changed

Task 3 asked to confirm `CloseReceipt` sends `paymentMethod` (mapped
via `mapPaymentMethod`, defaulting to `CASH`) and `amountTendered`
(`request.amountTendered ?? request.total`). Both were already present
from the Phase 3 implementation — no change was needed here.

## 5. Testing (`tests/realEtimsProvider.test.ts`)

- "extracts the invoice number from a capitalized InvoiceNumber field"
  — `{ InvoiceNumber: 'INV-999' }` resolves successfully.
- "extracts the invoice number from a nested data.receiptNumber field"
  — `{ data: { receiptNumber: 'INV-888' } }` resolves successfully.
- "logs the raw response and fails when no known invoice-number field
  is present" — `{ success: true }` triggers `console.warn` (asserted
  via a spy, restored after) with the response JSON, and the call
  still fails with the original "without returning an invoice number"
  message.
- The pre-existing "fails and rolls back if CloseReceipt succeeds but
  omits an invoice number" test needed no change — an empty object
  still matches none of the extraction variants.

## 6. Verification

- `npm run typecheck` — clean (both `node` and `web` projects).
- `npm test` — 511/511 passing (508 prior + 3 new).
