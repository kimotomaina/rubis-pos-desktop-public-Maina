# Phase 25 — KRA PIN (B2B Invoice) Support

**Date:** 2026-08-27 · **Branch:** `main` · **Previous:** [Phase 24](./phase-24.md)

## 1. Objective

eTIMS distinguishes a walk-in retail sale (B2C, no buyer identity) from
a sale invoiced against a specific customer's KRA PIN (B2B) — the
fiscal device needs a different open-invoice call for each. Checkout
had no way to capture a customer PIN at all; this phase adds the
input, threads it through checkout and the receipt, and switches
`RealFiscalizationProvider` between the two device endpoints.

## 2. Deviation from the brief: reused `buyerPin`, didn't add `customerPin` to `FiscalInvoiceRequest`

The brief asked for a new `customerPin?: string` field on
`FiscalInvoiceRequest` (`etims.ts`). That field already exists — it's
called `buyerPin`, added when the real provider was first built and
already wired into the `OpenInvoice` payload. Adding a second field
meaning the same thing would leave two names for one concept with no
way to know which a given call site should read. `FiscalInvoiceRequest`
was left untouched; `main/index.ts`'s checkout handler maps
`checkout.customerPin` (the renderer-facing name, matching the UI
label) onto `buyerPin` when building the fiscal request — one field,
two names at the two different layers where each name reads naturally.

The brief also named `shopify-types.ts` as the home for both new
fields. `FiscalInvoiceRequest` actually lives in `etims.ts` (per §2's
reasoning, unchanged); `CheckoutRequest` actually lives in
`database.ts`, not `shopify-types.ts` — `customerPin?: string` was
added there instead. `shopify-types.ts`'s `OfflineOrderPayload` did
need the field, since that's what's persisted to `payload_json` and
read back for receipt printing.

## 3. Provider logic (`real-etims-provider.ts`)

`FiscalEndpointPaths` gained `openInvoiceWithPin`, defaulting to
`/OpenInvoiceWithCustomerData` — unconfirmed against the vendor's Java
demo, same caveat as every other endpoint default in this file.
`submitInvoice` now resolves the open-invoice endpoint and payload via
two new private helpers:

- `resolveOpenInvoiceEndpoint` — `openInvoiceWithPin` when
  `request.buyerPin` is a non-blank string (trimmed), otherwise the
  existing `openInvoice`.
- `buildOpenInvoicePayload` — B2B sends `taxpayerPin: buyerPin` (no
  `buyerPin` key at all); B2C keeps sending `buyerPin: ''`, unchanged
  from before this phase. `clientOrderUuid`, `customerName`,
  `currency`, and `receiptType` are shared between both.

No admin who never uses B2B invoicing notices any difference — the
B2C path's endpoint, payload shape, and defaults are byte-for-byte
identical to before.

## 4. Checkout UI (`CheckoutModal.tsx`)

An optional "Customer KRA PIN" text input (max 11 chars, forced
uppercase) sits above the payment-method picker, visible regardless of
which method is chosen — a KRA PIN describes the buyer, not the
tender. A new `src/renderer/src/lib/kraPin.ts` holds
`isValidKraPinFormat` (one letter `P`/`A`, nine digits, one trailing
letter) as a framework-free, independently unit-tested pure function.
Per Q1, an invalid-looking PIN shows a red warning under the field but
never disables "Complete Sale" — KRA's real format has edge cases a
client-side regex can't fully capture, and refusing a legitimate
cashier over it would be worse than fiscalizing with an unverified PIN.

**Bug caught while wiring this in:** the modal's global `keydown`
listener (feeds the cash tender numpad from the physical keyboard) had
no guard against focus — it already existed before this phase, but
with no other visible text input in the cash/no-method views it never
misfired. The new PIN field sits in the same view, so typing into it
while `method === 'cash'` would have leaked digits into the tendered
amount. Fixed by ignoring the listener when `event.target` is an
`HTMLInputElement`.

## 5. Receipt (`printer.ts`)

`ReceiptOrder` gained `customerPin?: string`. `renderReceipt` prints
`Customer PIN: <pin>` right after the cashier line (Q2's "near the
top"), only when present — a B2C receipt's layout is unchanged.

## 6. Data flow, end to end

`CheckoutModal` → `cartStore.checkout()` (`CheckoutParams.customerPin`)
→ `window.api.checkout` (`CheckoutRequest.customerPin`, now zod-validated
as an unconstrained optional string — server-side validation
deliberately doesn't enforce the PIN format either, matching Q1's
"never block checkout" stance) → `orders:checkout` handler: persisted
into `OfflineOrderPayload.customerPin` via `queueOrder`, and mapped to
`buyerPin` on the `FiscalInvoiceRequest` sent to
`fiscalizationProvider.submitInvoice`. `receipt:print` reads
`payload.customerPin` back out for `renderReceipt`.

## 7. Testing

- `tests/kraPin.test.ts` (new, 10 tests) — valid P/A-prefixed PINs,
  case-insensitivity, whitespace tolerance, wrong leading letter,
  missing trailing letter, wrong length (short/long), empty string.
- `tests/realEtimsProvider.test.ts` — two new cases: a B2B submission
  asserting `openInvoiceWithPin` is called with `taxpayerPin` (and
  `openInvoice` is never called, and `buyerPin` isn't in the payload),
  and a blank-PIN submission asserting the original B2C behavior is
  unchanged.
- `tests/fiscalIntegration.test.ts` — a new "Scenario C" pair proving
  the PIN reaches `submitInvoice` as `buyerPin` end-to-end through the
  real `RubisDatabase`, and that it's `undefined` for a walk-in sale.
- `tests/etimsConfig.test.ts` — updated the default-endpoints
  assertion for the new `openInvoiceWithPin` key (six defaults now,
  not five).

## 8. Verification

- `npm run typecheck` — clean (both `node` and `web` projects).
- `npm test` — 503/503 passing (489 prior + 14 new: 10 `kraPin.test.ts`
  + 2 `realEtimsProvider.test.ts` + 2 `fiscalIntegration.test.ts`).
