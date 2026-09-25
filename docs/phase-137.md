# Phase 137 — POS usability overhaul, Phase C: setup screens

- **Date:** 2026-09-25
- **Requested:** On the pre-login setup screens, put fields two per row, remove the helper text under fields, keep the validation errors, and open the on-screen keyboard or numpad on focus. Build in the two phase-135 findings (the keyboard was not mounted before login, and it would have drawn behind the fiscal setup gate), plus D3 and D4.
- **Outcome:** Implemented
- **Branch / base commit:** staging @ d4ecc5a
- **Previous:** [phase-136](./phase-136.md)

## 1. Audit

The field inventory is [phase-135 §2](./phase-135.md#2-setup-screen-field-inventory-pre-login). Only two screens have text fields before login:

- OnboardingScreen (step 1)
- EtimsSetupGate

LoginScreen already has its own PIN keypad. ManagerPinModal already has an inline `VirtualNumpad`. The location screens have no fields. None of those changed.

**The coexistence rule (phase-84/86).** Closing the keyboard must never disturb the screen underneath. `close()` touches only `keyboardStore.request`, and that is unchanged. The brief adds that the overlay must not cover the Save button.

The existing overlay is `fixed inset-0` with a dimmed backdrop, so it covers the whole screen, Save included. The logged-in fields keep that behaviour exactly. The setup screens use a new docked mode instead (§2).

## 2. Changes made

**`stores/keyboardStore.ts`** gains two optional `KeyboardRequest` fields. Existing callers pass neither, so they behave exactly as before.

- `mode`: `caps` (the default), `text`, `numeric` or `ip`.
- `docked`: draws the keys as a bottom sheet with no backdrop.

The `open()` relay, which fixed the one-letter-at-a-time bug, is untouched.

**`components/VirtualKeyboard.tsx`** gets an opt-in `layout="text"` (D3):

- lower case by default, with a Shift toggle (`aria-label="Shift"`)
- a symbol row: `- _ . : / @ # $ ! ?`

The default `caps` layout renders exactly as before. The file doc explains when each layout applies.

**`components/VirtualNumpad.tsx`** gets an opt-in `multipleDecimals` prop (D4), so IP addresses can be typed. The default still ignores a second `.`, and `allowDecimal={false}` still wins.

**`components/VirtualKeyboardModal.tsx`:**

- **Key sets:** it hosts both key sets, so there is no third keyboard. `caps` and `text` render `VirtualKeyboard`. `numeric` and `ip` render `VirtualNumpad`, whose Enter key closes it the way Done does.
- **Default (modal) mode:** unchanged, at `z-[60]` with a backdrop.
- **Docked mode:** `fixed inset-x-0 bottom-0`, no backdrop, `h-keyboard-sheet` tall, at `z-110`. That is above EtimsSetupGate's `z-[100]` (finding 2).

**`main.tsx` and `App.tsx`:** `VirtualKeyboardModal` moved from inside App's logged-in shell to the React root, beside `<App />` (finding 1). App returns early for every pre-login screen, so the keyboard never existed there before. The logged-in callers (PosCheckoutPanel, FiscalNotice, NeedsAttention) reach the same single instance.

**`index.css`:** a new token, `--spacing-keyboard-sheet: 28rem`. It generates both `h-keyboard-sheet` (the sheet) and `pb-keyboard-sheet` (the space a setup screen reserves), so the two cannot drift apart. The `text` keyboard's six rows plus the label and padding come to about 26.9rem.

**`components/OnboardingScreen.tsx`:**

- **Layout:** store URL and token sit in one `grid-cols-2` row, and the card widened from `max-w-md` to `max-w-2xl`.
- **Inputs:** both are `readOnly`, with `id`/`htmlFor` label pairs, and open the docked `text` keyboard on focus or tap. `autoFocus` was removed, so the keyboard doesn't pop up the moment the screen loads.
- **Keyboard space:** while the sheet is open, the page top-aligns and reserves the sheet's height.
- **Connect & Verify:** closes the keyboard first.

There was no helper text under these fields. The validation message is unchanged.

**`components/EtimsSetupGate.tsx`:**

- **Fields:** the four fields come from one `FIELDS` table and render in a `grid-cols-2`. Row 1 is server address and IP; row 2 is port and password.
- **Helper text:** all four lines are removed.
- **Validation:** each field's error still renders inside its own cell.
- **Aids:** the server address and password open the `text` keyboard, the IP opens the `ip` numpad, and the port opens the `numeric` numpad.
- **Inputs:** all are `readOnly`. `autoFocus` and `inputMode` were removed.
- **Keyboard space:** while the sheet is open, the gate top-aligns and reserves the sheet's height.
- **Save & Continue:** closes the keyboard first.

The validation and save logic are otherwise untouched.

| Screen | Field | Opens |
| --- | --- | --- |
| Onboarding | Shopify Store URL | keyboard, `text` |
| Onboarding | Admin API Access Token | keyboard, `text` |
| eTIMS gate | Fiscal server address | keyboard, `text` |
| eTIMS gate | Fiscal device IP address | numpad, `ip` (repeatable `.`) |
| eTIMS gate | Fiscal device port | numpad, `numeric` (no `.`) |
| eTIMS gate | Fiscal device password | keyboard, `text` |

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| src/renderer/src/stores/keyboardStore.ts | Modified (additive) | keyboard request shape |
| src/renderer/src/components/VirtualKeyboard.tsx | Modified (additive) | new `text` layout |
| src/renderer/src/components/VirtualNumpad.tsx | Modified (additive) | new `multipleDecimals` |
| src/renderer/src/components/VirtualKeyboardModal.tsx | Modified | numpad hosting, docked sheet |
| src/renderer/src/main.tsx, App.tsx | Modified | where the keyboard is mounted |
| src/renderer/src/index.css | Modified | sheet height token |
| src/renderer/src/components/OnboardingScreen.tsx | Modified | step-1 layout and input |
| src/renderer/src/components/EtimsSetupGate.tsx | Modified | layout, helper text, input |
| tests/virtualKeyboardLayouts.test.ts, tests/setupScreens.test.ts | Added | tests |

## 4. Possible impact

- **Direct:** the two setup screens are driven entirely by on-screen keys, with the fields in pairs.
- **A physical keyboard no longer types into these six fields,** because they are `readOnly`, the same choice phase-86 made for the checkout fields. A technician with a USB keyboard must use the on-screen keys.

  If both input paths wrote to a field, the keyboard's copy of the value would go stale after any physical typing. The next on-screen key would then append to that stale copy, which is the same class of bug as the one-letter bug. If physical typing is needed back, it needs its own design.
- **Logged-in callers:** no change. They pass neither `mode` nor `docked`, so they get the same `caps` modal at `z-[60]`. Its mount moved from App's shell to the React root. It is still one instance, and it is still after the app in the DOM, so it still draws over ManagerPinModal (also `z-[60]`).
- **Data / schema / contract / receipts / KRA filing:** none. The values saved through `saveEtimsConfig` and `validateShopifyConfig` are built exactly as before.
- **Security posture:** unchanged. The password fields stay `type="password"`, and the sheet never shows the value.
- **Idempotency / re-run safety:** there is nothing stateful. A second `open()` replaces the first, as before.
- **Residual risk:**
  - On short viewports, the sheet's reserved 28rem plus the form is taller than the window. At 1366×768, the page scrolls instead of fitting.
  - The geometry has not been seen on a screen.

## 5. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npx vitest run` | 95 files, 1,433 tests passed |
| Tripwires: fiscalEngine, fiscalRouting, mpesaPaymentGate, VirtualNumpad, VirtualKeyboard, plus keyboardStore | pass, files unmodified |
| `npx electron-vite build` | built; the CSS has `h-keyboard-sheet`, `pb-keyboard-sheet` and `z-110` |
| Mutation check | the store relay was replaced with a plain `set({ request })` (the old bug), then restored. Both REGRESSION tests and 3 save-path tests failed under it. |

**What the new tests prove (real mount, real clicks):**

- **setupScreens**, for each screen, with the real `VirtualKeyboardModal` mounted beside it:
  - The fields sit in the paired grid, in order: 4 cells for the gate, 2 for Onboarding.
  - No field cell has helper text.
  - Tapping each field opens the mapped mode, docked. Focus alone also opens it.
  - Port shows a numpad with its decimal key disabled, and the IP numpad takes repeated dots (`10.0.0.5`).
  - Multi-key typing accumulates: `pass9`, `a-b.co`, `shpat_1`.
  - The pre-filled server address is edited from its current value.
  - The docked sheet is `bottom-0` and `h-keyboard-sheet`, and the screen root gains `pb-keyboard-sheet`. Save is outside the sheet, and there is no backdrop.
  - The sheet is `z-110` over the gate's `z-[100]`.
  - A bad IP shows its error in its own cell and blocks saving. An empty Onboarding field shows its error.
  - Valid input saves the exact typed values, closes the keyboard, and lifts the gate or calls Connect.
- **virtualKeyboardLayouts:**
  - The `text` layout types lower case, Shift toggles upper case, and the six URL/token symbols type.
  - The `caps` default has no Shift and no symbols.
  - `multipleDecimals` repeats `.`, the default still does not, and `allowDecimal={false}` still wins.

## 6. What only a human can check

On the till:

- **Onboarding:** tap each field. The keyboard appears docked at the bottom, and the card with Connect & Verify stays visible above it.
- **Store URL:** type a real one (`xxx.myshopify.com`) and a `shpat_` token.
- **Fiscal gate:** do the same. The IP and port show the numpad, and the server address and password show the keyboard.
- **Save & Continue:** still visible and tappable while the keys are open.
- **Short screens:** at 1366×768, the page scrolls to reach Save rather than hiding it.
- **Logged in:** the checkout's Company Name and KRA PIN fields and the fiscal notice PIN correction still open the same dark-backdrop keyboard as before.

## 7. Rollback

`git revert <this commit>`. Phase B does not depend on it, and Phases D and E do not build on it.

## 8. Observed but not changed

- **For Phase D, per the user's instruction:** locations are paginated at 9 per page, always. The Shopify query's `locations(first: 10)` cap ([shopify.ts:118](../src/main/services/shopify.ts#L118)) is addressed there.
- **LoginScreen:** keeps its own PIN keypad rather than `VirtualNumpad`. It already does the job, and swapping it would only restyle it.
