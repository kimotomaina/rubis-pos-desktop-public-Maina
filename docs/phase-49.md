# Phase 49 — Complete Tremol XML Payload & UI Wiring

## Summary

Two issues: `OpenInvoiceWithFreeCustomerData` was still missing spec
fields (`reserved` ×3, `InvoiceType`) the Java TSL server's raw
deserializer requires present-or-null-pointers on, and the "Company
Name" field added in Phase 48 was wired into a component
(`CheckoutModal.tsx`) that the app doesn't actually render — the live
checkout UI is `PosCheckoutPanel.tsx` (Phase 44's always-visible
panel), which never had the field at all.

## Root cause of the "Company Name" bug

`App.tsx` renders `PosCheckoutPanel`, not `CheckoutModal` —
`CheckoutModal.tsx` has no import/usage anywhere in the app and is
dead code left over from before Phase 44. Editing it in Phase 48 had
zero effect on the running app, which is why the logs kept showing
`<CompanyName></CompanyName>` empty regardless of what was typed.
`CheckoutModal.tsx` was left as-is (still dead, still unused) since
removing it wasn't asked for and it's technically harmless.

## Changes

- `src/renderer/src/components/PosCheckoutPanel.tsx` — this is the
  actual fix for Company Name. Added `companyName` state; the existing
  "Add/Edit KRA PIN" toggle now expands into a stacked two-field panel
  (Company Name above, KRA PIN below, both `h-11`), and the collapsed
  summary shows `Customer: <PIN> · <CompanyName>` when a company name
  is present. `companyName` is included in both `checkout()` calls
  (cash and M-Pesa) and cleared on the same post-checkout reset as
  `customerPin`.
- `src/main/services/integrations/real-etims-provider.ts` —
  `buildOpenInvoicePayload` now emits, in order: `reserved1` (`'1'`),
  `reserved2` (`'     0'`, five spaces then `0`, per the spec's literal
  default), `reserved3` (`'0'`), `InvoiceType` (`'1'`), then the seven
  fields from Phase 48. Named `reserved1`–`reserved3` rather than three
  sibling `<reserved>` tags because our serializer maps a plain JS
  object to XML — three same-named keys would collapse to one. If the
  live TSL server rejects the numbered tags and needs true XML-level
  duplicates, that would require a small serializer change (a
  repeated-tag escape hatch) rather than a payload-object change; flag
  it if the 500 persists specifically on this shape.
  `buildSellPluPayload` gained `DiscAddP`, defaulted to `'0'` (a
  numeric field — blank would reintroduce the same null/parse-failure
  class of bug). `CloseReceipt` was already `{}` since Phase 48 (Task
  2's "Args: None" requirement was already met).
- `src/main/services/integrations/etims.ts` — `FiscalInvoiceLine`
  gained `discAddP?: string`.
- Verified (no changes needed) — `src/main/index.ts`,
  `src/main/lib/ipcValidator.ts`, `src/main/services/database.ts`,
  `src/renderer/src/stores/cartStore.ts` already wire `companyName`
  from the checkout payload into `fiscalRequest.companyName` correctly
  since Phase 48; the only broken link was the UI component itself.

## Verification

- `npm test` — 628/628 passing. `tests/realEtimsProvider.test.ts`'s
  exact-payload assertions updated for `reserved1`–`reserved3`,
  `InvoiceType`, and `DiscAddP`.
- `npm run typecheck` — clean (node + web).
