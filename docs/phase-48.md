# Phase 48 — Tremol Spec Payload Mapping & Company Name UI

## Summary

The remote TSL server was throwing `HTTP 500` /
`java.lang.NullPointerException` because our XML payloads used custom
field names (`clientOrderUuid`, `taxpayerPin`, `customerName`, ...)
instead of the exact argument names the Tremol ZFP API spec requires.
Rewrote all three fiscal HTTP payloads to the spec-exact shape and
added a "Company Name" field to the checkout modal's KRA PIN section.

## Changes

- `src/main/services/integrations/etims.ts` — `FiscalInvoiceRequest`
  gained `companyName?`, `headQuarters?`, `address?`,
  `postalCodeAndCity?`, `exemptionNum?`, and `localId?: number` (used
  to build a short `TraderSystemInvNum`, not requested verbatim by the
  prompt but needed for Q2's recommended format). `FiscalInvoiceLine`
  gained `measureUnit?`, `hsCode?`, `hsName?`.
- `src/main/services/integrations/real-etims-provider.ts`:
  - `buildOpenInvoicePayload` now emits exactly `CompanyName`,
    `ClientPINnum`, `HeadQuarters`, `Address`, `PostalCodeAndCity`,
    `ExemptionNum`, `TraderSystemInvNum` — in that order, each blank
    (`''`) rather than omitted when uncaptured, matching the example
    in the prompt.
  - New `buildTraderSystemInvNum`: `INV-<localId padded to 9 digits>`
    when `localId` is available (13 chars), else the UUID with dashes
    stripped, truncated to 15 chars — both paths respect the spec's
    15-character max (`MAX_TRADER_SYSTEM_INV_NUM_LENGTH`).
  - `buildSellPluPayload` now emits `NamePLU`, `OptionVATClass`,
    `Price`, `MeasureUnit`, `HSCode`, `HSName`, `VATGrRate`,
    `Quantity` — `VATGrRate` is the line's `taxRate` as a percentage
    string (`0.16` → `'16.00'`); `MeasureUnit` defaults to `'pcs'`,
    `HSCode`/`HSName` default to `''`.
  - `CloseReceipt` now posts `{}`, serializing to
    `<Request Name="CloseReceipt"></Request>` — no child tags, per the
    spec's "Args: None". Removed the now-dead `mapPaymentMethod`/
    `PAYMENT_METHOD_CODES` and the `currency`/`receiptType` fields that
    existed only for the old `OpenInvoice` payload shape.
  - `pluCode` on `FiscalInvoiceLine` is no longer read by
    `buildSellPluPayload` (not part of the spec) but the field itself
    is left on the interface — `main/index.ts` still populates it, and
    removing it would be an unrelated, unrequested change.
- `src/main/lib/ipcValidator.ts`, `src/main/services/database.ts`,
  `src/renderer/src/stores/cartStore.ts` — added `companyName?: string`
  alongside the existing `customerPin` on the checkout request schema/
  types, so it validates and flows through the same path.
- `src/main/index.ts` — both places that build a `FiscalInvoiceRequest`
  (the normal path and the catch-block fallback) now include
  `companyName: checkout.companyName` and `localId`.
- `src/renderer/src/components/CheckoutModal.tsx` — added a "Company
  Name" text input (`h-12 text-lg px-4`, placeholder "Enter Company
  Name (Optional)") directly above "Customer KRA PIN", wired to new
  `companyName` state and included in both checkout submission paths
  (`handleSubmit` and the M-Pesa `handleMpesaPaid` callback).

## Note on `TraderSystemInvNum` length

Task 3's literal XML example shows `<TraderSystemInvNum>INV-000001</TraderSystemInvNum>`
(6-digit padding, 10 chars), while Q2's own recommended example shows
`INV-000000001` (9-digit padding, 13 chars). These two are
inconsistent with each other; I implemented Q2's explicit
recommendation (9-digit padding) since it's stated as the default to
use, and it still comfortably fits the 15-character cap either way.

## Verification

- `npm test` — 628/628 passing. `tests/realEtimsProvider.test.ts`
  rewritten: every payload assertion now checks the exact Tremol tag
  names/order; added dedicated tests for blank-field defaults,
  populated `CompanyName`/`ClientPINnum`, the `TraderSystemInvNum`
  padding/length, and the now-empty `CloseReceipt` body.
- `npm run typecheck` — clean (node + web).
