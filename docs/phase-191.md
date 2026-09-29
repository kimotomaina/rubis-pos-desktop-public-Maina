# Phase 191 — Paste into the setup and admin fields; hold an icon to see a password

- **Date:** 2026-09-29
- **Requested:** Allow pasting into the input fields on the setup and admin pages, and add an icon to view password inputs that only shows while it is held.
- **Outcome:** Done, and verified by tests. Not checked on a real screen or with a real Ctrl+V (§4).
- **Branch / base commit:** staging @ a1d5030. No device calls.

## 1. Why paste did nothing

Every setup and admin field is a `readOnly` input that opens the on-screen keyboard (`VirtualKeyboardModal`). A read-only input refuses a native paste, and the app also removes Electron's menu (`Menu.setApplicationMenu(null)`), which is where the Edit shortcuts normally live. So the fix had to go through the keyboard overlay that all these fields share.

## 2. What changed

| File | Change |
| --- | --- |
| `lib/pasteText.ts` (new) | `pasteIntoValue(current, pasted, mode, maxLength)`: adds the clipboard text after the current value and cuts it to what typing it on that keyboard could have produced. Line breaks and tabs are dropped and the ends trimmed (a copied token usually drags a trailing newline). `caps` upper-cases; `numeric` keeps digits; `decimal` one point; `ip` digits and points; `maxLength` is respected. |
| `VirtualKeyboardModal.tsx` | A **Paste** key beside the echo (reads the clipboard) and a `paste` listener, so **Ctrl+V** also works while the keyboard is open. A short status line beside the label says "Nothing to paste" or "Could not read the clipboard". The echo row keeps its fixed height, so the keys don't move and the docked sheet is unchanged. For a secret field the echo shows the characters **only while the eye is held**. |
| `HoldToReveal.tsx` (new) | `useHoldToReveal`, `HoldToRevealButton` and `PasswordField` (an input with the eye inside its right edge). The secret is visible only while pressed. It hides on release, on a cancelled pointer, on lost pointer capture, when focus leaves the icon, when the window loses focus, and when the keyboard closes mid-hold. Space or Enter held on the icon works too, and the long-press context menu is suppressed. |
| `icons.tsx` | `EyeIcon` and `EyeOffIcon` (shown while held). |
| `AdminScreen.tsx` | The four credential inputs use `PasswordField`: Shopify token, M-Pesa consumer secret, M-Pesa passkey and fiscal device password. |
| `OnboardingScreen.tsx`, `EtimsSetupGate.tsx` | The Shopify token and the fiscal device password use it too. The gate's address, IP and port stay plain. |

**PIN fields** (new staff PIN, reset PIN, manager PIN, login) have no icon on the input: they are short numeric fields, and the reset-PIN input is too narrow to hold one. When you tap one, its keyboard's echo does have the eye, so a PIN can still be checked as it is typed.

## 3. Tests

- **New: `tests/pasteAndReveal.test.ts`, 26 tests.**
  - `pasteIntoValue` for every mode, the limit and empty input.
  - The Paste key: cleaned text is added, the limit applies, a read failure and an empty clipboard are reported and change nothing.
  - Ctrl+V: takes the event over while open and does nothing once closed.
  - Hold to show: shown only while held, and hidden again on pointer cancel, lost capture, focus loss, window blur and keyboard release. The context menu is suppressed, a hold cannot leak into the next request, and no eye appears on a non-secret field.
  - The onboarding token and fiscal-gate password inputs have the eye and stay masked and read-only, and tapping still opens the keyboard with the secret flag. The address, IP and port fields have no eye.
- **Changed existing test:** `tests/adminScreen.test.ts`, `inputByLabel` helper. It assumed the input is the label's next sibling; it now also looks inside a wrapper `div`. No expected value changed.
- **Mutation checks: 14, each applied, run and reverted**, each caught by at least one test (release, window blur, lost capture, focus loss, context menu, never-reveal, stuck-on-close, ignore-hold, eye-on-every-field, Ctrl+V not taken over, limit ignored, no trim, no upper-case, eye on every gate field).
- **Phase-186 test fixed:** `fiscalOfflineEndurance.test.ts`'s 72-hour test failed twice when the whole suite ran in parallel, on the default 5 s timeout (it runs 8,640 passes and takes about 0.8 s alone). It now has an explicit 60 s timeout. Not a logic change.
- **Full run:** type check clean, **154 files, 2,369 tests, all passing twice**, and the build succeeds.

## 4. Not verified

- **Real screen:** I have not seen these on the till's screen. The echo row keeps its old height, so `check:fit` should be unaffected, but that check was not run here. Look at the setup gate and the Admin > Integrations password fields once.
- **Real clipboard:** the Paste key uses the browser clipboard call, which Electron allows here (no permission handler is set), and Ctrl+V uses the `paste` event. Tests fake both. If Ctrl+V does nothing on the till, the Paste key is the path that does not depend on it.

## 5. Rollback

`git revert` this commit. No stored data or setting changed.
