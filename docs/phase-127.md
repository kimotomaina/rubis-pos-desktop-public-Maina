# Phase 127 — POC as-built assessment (read-only)

> Skill-structured report, moved from the retired `tracker/2026-09-23-2025-poc-as-built-assessment.md`. Companion: [POC_AS_BUILT_ASSESSMENT](./POC_AS_BUILT_ASSESSMENT.md).

- **Date:** 2026-09-23 20:25
- **Requested:** Describe exactly what the unmodified build does in the live-POC scenario: real device, real KRA filing, manual M-Pesa. Judge whether each proposed change (A–F) is worth the go-live risk. State the minimum viable POC. Change nothing.
- **Outcome:** No change needed (assessment only)
- **Branch / base commit:** staging @ 8871592 (clean)

## 1. Audit

### What was examined
The whole sale path:
- checkout.ts
- real-etims-provider.ts
- http-client.ts
- fiscal-routing, fiscal-retry and fiscal-engine
- database.ts (fiscal columns, the unfiled and needs-attention queries, voidOrder, retryOrderSync)

Receipts:
- printer.ts
- pdf-receipt.ts
- the `receipt:print` handler

Manual M-Pesa:
- PaymentModal
- ManagerPinModal
- requireAdminPin
- MpesaReconciliationPage

Sync, install and setup:
- sync-engine and orders.ts
- secretStore
- updater
- App.tsx setup gates
- electron-builder.yml and .env

Past findings came from docs/phase-65, 109, 115, KNOWN_GAPS and GO_LIVE_READINESS. Four parallel read-only traces fed the work. I re-checked every claim marked material directly in the code.

### How it currently works
See docs/POC_AS_BUILT_ASSESSMENT.md, Part 1.

### Dependencies found
- **Inbound:** n/a, because nothing changed.
- **Outbound:** n/a.
- **String-based / indirect:** `VITE_TAX_RATE`, `VITE_PRINTER_INTERFACE`, `VITE_MOCK_PRINTER`, `VITE_SHOPIFY_LOCATION_ID` in `resources/.env`, all read at runtime.

### Risks and constraints identified
1. `VATGrRate="0.00"` on every class-A line. This is the only risk of a wrong filing on the first sale.
2. A stopped ZFPLabServer or a timeout goes to `needs_fixing`, which is not retried automatically.
3. Receipts print only on a manual button press.
4. The QR likely prints as a text placeholder, not a scannable code.
5. Void leaves the KRA invoice filed, and a voided sale can still be resent.
6. Discounts are not sent to the device.
7. Duplicate protection on the old defVer has never been proven on hardware.
8. Duplicate Shopify orders are possible.
9. The `release/` build is stale.

## 2. Changes made
No code changes. Added docs/POC_AS_BUILT_ASSESSMENT.md.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| docs/POC_AS_BUILT_ASSESSMENT.md | Added | none (documentation) |

## 4. Possible impact
- **Direct:** none
- **Indirect:** none
- **Data / schema / contract:** none
- **Security posture:** unchanged
- **Idempotency / re-run safety:** n/a
- **Residual risk:** every VERIFY-ON-DEVICE item in the doc, above all how the device treats `VATGrRate` and duplicate `TraderSystemInvNum`.

## 5. Verification
- Every linked source path in the doc was checked to exist.
- The key claims were re-read in the source: index.ts:513, real-etims-provider.ts:465/559-573/840/868/1503, http-client.ts:419-427, printer.ts:214-215/283-296, database.ts:1639-1665, fiscal-retry.ts:128-188.
- No tests were run, because no code changed.

## 6. Rollback
Delete docs/POC_AS_BUILT_ASSESSMENT.md.

## 7. Observed but not changed
Every item is listed in Part 2 of the doc, rows G–K, with a verdict. Also:
- No single-instance lock.
- A crash mid-fiscalization leaves `fiscal_status` NULL and invisible.
- Checkout, the engine and Resend never take turns on the device.
- Default admin PIN is 1234.
- Void has no server-side role check.
- The Reconciliation tab shows raw staff ids.
