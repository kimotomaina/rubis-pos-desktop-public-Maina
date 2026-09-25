# Phase 136 — POS usability overhaul, Phase B: one theme

- **Date:** 2026-09-25
- **Requested:** Replace the dark styling on every pre-login screen with the logged-in theme, and make the Enjoy brand (red `#E31A37`, white, black, Quicksand) the single source both sides read. Decisions D1, D2 and D6 from [phase-135](./phase-135.md) were approved as recommended.
- **Outcome:** Implemented
- **Branch / base commit:** staging @ 37edc7b
- **Previous:** [phase-135](./phase-135.md)

## 1. Audit

The audit is [phase-135 §1](./phase-135.md#1-theme-inventory). One more finding came up here: `AdminScreen`'s Change Location panel wrapped `LocationPicker` in a `bg-slate-800` box ([AdminScreen.tsx:1581](../src/renderer/src/components/AdminScreen.tsx#L1581)). The box existed only because the picker was dark, and a light picker inside it would be unreadable, so it changes in this phase too.

The dark classes that remain after login are deliberate accents, not a theme. They are left alone:

- `bg-slate-800` secondary buttons on the Stock Take and M-Pesa Reconciliation pages
- the `info` toast tone
- the update progress track

## 2. Changes made

**`src/renderer/src/index.css`** is now the single theme source:

- `@font-face` for Quicksand. The variable woff2 files cover weights 300–700, with latin and latin-ext subsets. They load from `assets/fonts/`, because the CSP allows no external font source and a till may be offline.
- `@theme static` declares `--color-brand-red: #E31A37`, `--color-brand-white: #FFFFFF` and `--color-brand-black: #000000`.
- `--color-rose-600` points at the brand red. That step is what every primary button already uses, so none of the 316 `rose-*` class usages needed renaming.
- `--color-rose-700` (hover and pressed) is `color-mix` of the brand red with 20% of the brand black. It is derived from the two brand colours, not a new colour.
- `--font-sans` is Quicksand.
- `static` is required. Without it, Tailwind drops tokens that no utility names directly, and the rose steps reach the brand values only through `var()`.
- A new `app-theme` utility (slate-50 background, slate-900 text, sans font) is the shared root class.

**Pre-login screens** now use `app-theme` on their root, plus the logged-in patterns: white cards with a slate-200 border, slate-300 inputs with a rose focus ring, rose-50/rose-700 error chips, and slate-100 keypad keys.

| File | Change |
| --- | --- |
| OnboardingScreen.tsx | root, card, labels, inputs, error chip |
| LoginScreen.tsx | root, staff tiles, keypad keys, PIN dots, error text |
| LocationConfirmScreen.tsx | root, card, error chip; its `//` comment became JSDoc |
| LocationPendingScreen.tsx | root, card; Log Out became a light secondary button |
| LocationPicker.tsx | Connected chip, location rows, error chip, Back link |
| EtimsSetupGate.tsx | root, card, amber icon, labels, inputs, helper and error text; its `//` comment became JSDoc |

The helper text stays until Phase C, and the layout is unchanged.

**App.tsx:**

- The config-loading placeholder and the logged-in shell both use `app-theme`. The shell previously wrote the same colours by hand as `bg-slate-50 text-slate-900`.
- Six JSX comments that only restated the markup were removed.
- The two informative ones became `/** */` comments.

**AdminScreen.tsx:** the Change Location wrapper is now light (one line).

**window-factory.ts** (main process, approved under D6): `backgroundColor` changes from `#0f172a` to `#f8fafc` (slate-50), so no dark frame flashes before first paint. Its `//` comment became JSDoc.

**Import extensions:** the five pre-login components got `.js` extensions on their relative imports, the convention newer components (PosCheckoutPanel) already follow. The node typecheck also covers `tests/`, so any test that mounts these screens pulls them into that stricter program.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| src/renderer/src/index.css | Modified | colours and font of every screen |
| src/renderer/src/assets/fonts/ (2 × woff2, OFL.txt) | Added | the Quicksand font and its licence |
| OnboardingScreen, LoginScreen, LocationConfirmScreen, LocationPendingScreen, LocationPicker, EtimsSetupGate | Modified | appearance only |
| src/renderer/src/App.tsx | Modified | root class; comments |
| src/renderer/src/components/AdminScreen.tsx | Modified (1 line) | Change Location panel appearance |
| src/main/window-factory.ts | Modified (1 value) | window colour before first paint |
| tests/preLoginThemeGuard.test.ts, themeTokens.test.ts, preLoginTheme.test.ts, assets.d.ts | Added | tests |

## 4. Possible impact

- **Direct, intended, app-wide:**
  - Every primary red changes from Tailwind's `rose-600` (≈ `#ec003f`) to `#E31A37`, and hover goes to `#b6152c`.
  - Every screen changes from Segoe UI to Quicksand.
  - Quicksand stops at weight 700, so `font-extrabold` text (TOTAL, COMPLETE SALE) renders at 700 instead of 800.
  - Glyphs Quicksand lacks (`⌫ ✓ ✗ ←`) fall back to the system font.
- **Indirect:** Quicksand's letter widths differ from Segoe UI's, so the header's overflow width ([phase-135 §4](./phase-135.md#4-why-the-logged-in-page-shows-a-horizontal-and-a-vertical-scrollbar)) moves slightly. Phase E fixes the overflow itself.
- **Behaviour:** none. No handler, prop, state, IPC call or validation changed.
- **Data / schema / contract / receipts / KRA filing:** none. Receipts are printed and generated as PDFs in the main process and do not use this CSS.
- **Security posture:** unchanged. The font is served from `'self'` and the CSP is untouched.
- **Idempotency / re-run safety:** there is nothing stateful.
- **Residual risk:** jsdom does not render, so the real colours, the font and contrast have not been seen on a screen yet.

## 5. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` (node and web) | clean |
| `npx vitest run` (full suite) | 93 files, 1,407 tests passed |
| Tripwires: fiscalEngine, fiscalRouting, mpesaPaymentGate, VirtualNumpad, VirtualKeyboard | pass, unmodified |
| `npx electron-vite build`, then the emitted CSS was inspected | `bg-rose-600` resolves through `var(--color-rose-600)` and `var(--color-brand-red)` to `#e31a37`; `app-theme` is emitted; both Quicksand woff2 files are bundled into `out/renderer/assets/` |

**What the new tests prove:**

- **preLoginThemeGuard** (grep guard, same pattern as `stockTakeGuard`):
  - None of the 8 pre-login files contains any of the 14 dark classes phase-135 found. At HEAD~ the same check finds 29 hits across 7 files, so it fails on the old code.
  - The guarded files still exist.
  - App.tsx has at least 2 `app-theme` roots.
  - The window background is `#f8fafc`.
- **themeTokens:**
  - The brand values are exact.
  - `rose-600` points at the brand red, and `rose-700` is derived only from brand red and black.
  - Quicksand is the sans font, and `@theme static` is present.
  - Every `url()` in the CSS exists on disk, and OFL.txt is present.
  - `app-theme` is defined.
- **preLoginTheme** (real mount): Onboarding, Login, LocationConfirm, LocationPending and EtimsSetupGate each render with `app-theme` on their root element.

## 6. What only a human can check

Look at each of these screens on the till:

- **Onboarding:** both steps.
- **Login:** the tile list and the PIN pad.
- **Location confirm:** also check the Manager PIN over it.
- **Location pending.**
- **Fiscal setup gate.**
- **The logged-in POS:** the header, the cart, and Complete Sale in the new red.
- **Admin → Change Location.**

Check all of the following:

- Nothing is dark.
- The red matches the brand.
- Quicksand is rendering (rounded letterforms, not Segoe).
- The logo reads well on the light background.
- The launch has no dark flash.

## 7. Rollback

`git revert <this commit>`. It is independent of later phases.

## 8. Observed but not changed

- `EtimsSetupGate` uses `z-[100]`. The IDE suggests the canonical `z-100`. That is cosmetic and was left alone.
- D5 (how many locations the real Rubis account has) is still open. It matters for Phase D.
