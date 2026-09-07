# Phase 66 / Step 1 — Finish sanitisation + add pre-send validation (findings #2, #8)

Builds on [phase-65.md](phase-65.md)'s audit, which found the sanitizer
already mostly built (Phase 55) and scoped this step down to two small
gaps rather than a from-scratch sanitizer — confirmed and applied as
scoped, no surprises in the Apply.

## Audit (read-only, immediately before applying)

Re-confirmed the exact current state before touching anything:
`fiscal-sanitize.ts`'s `sanitizeFiscalText` was applied to `CompanyName`,
`ClientPINnum`, `HeadQuarters`/`Address`/`PostalCodeAndCity`/`ExemptionNum`,
`TraderSystemInvNum`, `NamePLU`, `HSName` — but `HSCode`
(`real-etims-provider.ts:768`, `:786` pre-edit) and `MeasureUnit` (`:767`
pre-edit) went through a bare `.slice(0, MAX_LEN)`. No pre-send validator
existed anywhere in `src/main/services/integrations/`;
`src/renderer/src/lib/kraPin.ts`'s `isValidKraPinFormat` is a
renderer-only, non-blocking UI check, confirmed unreferenced from main.

## Applied

1. **Sanitizer gap closed** (`real-etims-provider.ts`, `buildSellPluArgs`/
   `buildSellPluHsArgs`): `HSCode` and `MeasureUnit` now go through
   `sanitizeFiscalText` instead of `.slice()`. The allow-list
   (`[A-Za-z0-9 .,-]`) already keeps `.`, so `HSCode`'s `XXXX.XX.XX` format
   is unaffected; `MeasureUnit` values (`kg`/`ltr`/`pcs`) are unaffected too.
2. **New module `fiscal-validate.ts`** — one pure function,
   `validateFiscalInvoiceRequest(request)`, mirroring `fiscal-sanitize.ts`'s
   shape/location (SRP: sanitize and validate stay separate small units,
   both behind the provider). Checks, per the VIL manual's own setup step 3
   + checklist item 14 (cited in the module's doc comment):
   - Each line: non-blank `description`; `quantity > 0` and finite;
     `unitPrice >= 0` and finite (a `0` price is allowed — a promotional
     giveaway line is legitimate; only `NaN`/missing/negative reject);
     `vatClass` (defaulting to `'A'`) must be one of `A`/`B`/`C`/`D`/`E`;
     a non-`A` class requires non-blank `HSCode` **and** `HSName`.
   - `buyerPin`, when present and non-blank, must match the 11-character
     KRA format `<letter><9 digits><letter>` (a small duplicated regex, not
     an import of the renderer's `kraPin.ts` — deliberately: that module
     lives in the renderer bundle, this runs in main, and a one-line regex
     costs less than a cross-process dependency, same reasoning
     `etimsConfig.ts`'s doc comment already gives in the opposite
     direction).
   Returns the first failure's message (or `undefined`), which
   `submitInvoice` (`:347-350`) now returns immediately as
   `{ success: false, error }` — before `settings()`, before any device
   round-trip — right after the existing `clientOrderUuid`/empty-`items`
   guards.
3. **`VERIFY-ON-DEVICE` note added** on the allow-list itself
   (`fiscal-sanitize.ts`'s `ALLOWED_FISCAL_CHARS_PATTERN` doc comment) —
   one place, not repeated at every call site — plus a matching
   `docs/KNOWN_GAPS.md` entry (new; nothing here was previously tracked as
   a gap, since Phase 55 had already built the sanitizer without
   flagging its allow-list as unproven).

## Fixing tests that exercised the now-closed gap

Six existing tests in `realEtimsProvider.test.ts` and two in
`tremolConformance.test.ts` used non-class-A fixture items with no
`HSCode`/`HSName` — exactly the input finding #8 says should now be
rejected. Per the anti-circularity rule, the fix was to make the *test
inputs* realistic (add a valid `hsCode`/`hsName` where the test was
actually about something else — routing shape, `NamePLU` truncation,
`DiscAddP`, rollback-on-device-failure), **not** to loosen the new
validator. One test (`'sends an empty HSCode when the item carries none'`)
existed specifically to document the *old, now-closed* permissive
behavior — repurposed to assert the new fail-fast rejection instead
(`'rejects a non-A item with no HSCode — pre-send validation, finding #8'`),
asserting `post` is never even called. One test used a garbage PIN
(`'BAD'`) purely as bait for a mocked device-side STE-59 response — given
a validly-shaped PIN instead so the request reaches the (mocked) device,
preserving what it actually tests. One test used an oversized garbage PIN
(`'P'.repeat(30)`) to test the provider's `MAX_CLIENT_PIN_LENGTH` (14)
truncation — that code path is now genuinely unreachable through the
public API (anything long enough to need truncating fails the 11-character
format check first), so the test was split: `CompanyName` truncation kept
as its own test, and a new test documents the `ClientPINnum` truncation is
now defense-in-depth only, asserting the validation error fires instead.

## Verification

- `npx vitest run` (full suite): **56 files / 806 tests** (768 prior + new
  `fiscalValidate.test.ts` (22 tests) + 2 new provider-level sanitize tests
  − the one repurposed test − net: 806, 0 unexplained regressions).
- `npm run typecheck` (node + web): clean.

## Status

- **Applied:** `fiscal-validate.ts` (new), two sanitizer-routing edits in
  `real-etims-provider.ts`, one doc-comment `VERIFY-ON-DEVICE` addition in
  `fiscal-sanitize.ts`, one new `docs/KNOWN_GAPS.md` entry.
- **Test changes:** `tests/fiscalValidate.test.ts` (new, 22 tests); targeted
  fixture/assertion fixes in `tests/realEtimsProvider.test.ts` (8 tests
  touched — none weakened, all now exercise realistic or explicitly
  re-scoped behavior) and `tests/tremolConformance.test.ts` (shared
  `SAMPLE_REQUEST` fixture given a valid HS code/name).
- **New `VERIFY-ON-DEVICE`:** the sanitizer's allow-list itself (was
  already implicit in Phase 55's work; now explicit and tracked).
- No STOP required for this step — proceeding to Step 2 (CU serial number).
