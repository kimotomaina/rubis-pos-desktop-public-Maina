# Phase 200 — a labelled "Close keyboard" control and Escape on the keyboard overlay

- **Date:** 2026-10-02
- **Requested:** Part B of "fixed shift windows, and close buttons on keypad and keyboard dialogs": a close control only where one belongs (the keyboard overlay, both shells), not a sweep of every popup.
- **Outcome:** Implemented. Typecheck clean; vitest **181 files, 2920 tests, all passing** (180 and 2876 before, which is phase 199's total); `npm run build` passes with the no-mock check. `check:fit` not run; no device calls; no new dependency.
- **Branch / base commit:** staging on top of `bd677c7` (phase 199, committed separately).

## 1. Audit (B1), as reported before building and approved

| Surface | File | Overlay? | How it closes today | Does closing abandon anything? |
| --- | --- | --- | --- | --- |
| `VirtualKeyboardModal`, modal shell | `VirtualKeyboardModal.tsx` | Yes (`z-[60]`, backdrop) | Submit key, or a backdrop tap | No: every keystroke is already relayed into the field |
| `VirtualKeyboardModal`, docked shell | same | Bottom sheet, **no backdrop** (`z-110`) | Submit only | No |
| `ManagerPinModal` | `ManagerPinModal.tsx` | Yes (`z-[60]`) | Cancel button or backdrop; its inline numpad has no Enter key | Abandons only the gated action |
| `VariantModal`, `ZReportModal`, `ConnectivityModal` | their own files | Yes (`z-50`) | X button (`aria-label="Close"`) or backdrop | No |
| `RestartCountdownModal` | `RestartCountdownModal.tsx` | Yes (`z-[60]`, `aria-modal`) | Cancel only | Stops the countdown; saved config is kept |
| `PaymentModal`, `CardEntryPanel` | their own files | **No, inline panels** inside `PosCheckoutPanel` | Cancel and Change payment method buttons | Cancel while M-Pesa is waiting stops polling |
| `LocationPicker` | `LocationPicker.tsx` | No, a component used in three screens | n/a | n/a |
| `EtimsSetupGate` | `EtimsSetupGate.tsx` | Full-screen pre-login gate (`z-[100]`) | The form's own controls | n/a |
| `OnboardingScreen` | `OnboardingScreen.tsx` | Full-screen pre-login | The form's own controls | n/a |
| Inline `VirtualNumpad` (amount tendered in `PosCheckoutPanel`, `ManagerPinModal`) | those files | No | n/a (no Enter key) | n/a |
| `CheckoutModal` | **file no longer exists** | n/a | n/a | n/a |

The docked keyboard is used by the setup screens, the M-Pesa code field in `PaymentModal`, the card code field in `CardEntryPanel`, and End of Day twice, so the new control also shows on the live checkout screen's keyboard. Approved with the condition that it reads `Close keyboard`, in those words, not `Close` and not a bare X.

## 2. What was built

One file changed: [VirtualKeyboardModal.tsx](../src/renderer/src/components/VirtualKeyboardModal.tsx).

- **The control:** a `Close keyboard` button in the shared `header`, in the label row beside `request.label`, so one edit serves both the modal and the docked shell. Visible text is its accessible name (no `aria-label`, no icon). Not in the key grid of `VirtualKeyboard` or `VirtualNumpad`, neither of which was touched, so each key set still has exactly one Submit key and no Done or Enter.
- **Escape:** a `document` keydown listener, registered only while the keyboard is open and removed when it closes or the overlay unmounts. It prevents the default and stops propagation, so no other Escape handler also acts (the only other one in the renderer is `LoginScreen`'s window listener, and the keyboard is never open there).
- **What it calls:** `close()` and nothing else, with no argument (the click event is not passed on). `keyboardStore.close` is unchanged. The field already holds every character through the relay, so closing is not cancelling.
- **Focus is not returned to the field, deliberately.** The Admin and setup fields open the keyboard from `onFocus` as well as `onClick` (phase 139), so refocusing would reopen the keyboard at once. This departs from the brief's "focus returns to the field" and is recorded in a comment at `closeKeyboard` so nobody corrects it back; the field stays unfocused until tapped.
- **Echo unchanged:** still `role="textbox"`, `aria-readonly`, no `tabIndex`, not an input; the control sits beside the label, not in or near the echo.
- **Row height:** the control is a 40px target (`h-10`) with `-my-1`, so it takes 32px of the label row. See flag 1.

## 3. Deny list: what was not touched

Nothing was added to: the inline `VirtualNumpad` call sites; `ManagerPinModal` (it already has Cancel and a backdrop); `PaymentModal` (no code change, only a test that closing the keyboard leaves it alone); anything while a fiscal command is in flight; `LocationPicker`; `EtimsSetupGate` and `OnboardingScreen` themselves (the keyboard sheet over them gets the control, which is the point on a docked sheet with no backdrop; the screens did not change); `PosSearchBar` and `ProductSearchBar`; `RestartCountdownModal` (a countdown is probably meant to run; it has Cancel; no decision made); `CheckoutModal` (already gone). `keyboardStore.ts`, `VirtualKeyboard.tsx` and `VirtualNumpad.tsx` are byte-identical.

## 4. Tests

- **New: `tests/keyboardCloseControl.test.ts`, 44 tests**, real mount, in the style of `keyboardEchoSubmit.test.ts`:
  - **Present in both shells**, in all five modes (caps, text, numeric, decimal, ip), exactly one, named by its words, no icon, no `aria-label`; sitting in the header beside the label and not inside a key grid or flex column.
  - **Submit tripwire shape kept** with the control present: one Submit, no Done, no Enter, per mode and shell.
  - **Click closes** the overlay and the field holds everything typed; **Escape does the same** (modal and docked); every other key (Enter, a letter, Tab, space, Backspace, `Esc`) does nothing.
  - **`close()` is called with no argument** from the control and from Escape (argument counts are asserted rather than the arguments, because a React click event is too large for a failure message to print; the first version of this assertion crashed the test worker under mutation B2 for that reason).
  - **No focus moves**: a host field that opens the keyboard on focus is not refocused, the keyboard does not reopen, and `HTMLElement.focus` is never called during the close.
  - **The echo stays unfocusable** with the control beside the label.
  - **Escape scope:** it stops at the keyboard (a window listener does not see it); once the keyboard is closed, or never opened, Escape is left alone (not default-prevented, reaches the window listener); the listener is removed when the overlay unmounts while open.
  - **The host's own action is never fired:** the fiscal gate's Save (control and Escape; the gate stays standing), Onboarding's Connect & Verify (control and Escape).
  - **`PaymentModal` with M-Pesa waiting:** closing the keyboard from the control or with Escape leaves "Waiting for M-Pesa Confirmation" on screen, calls neither `onPaid` nor `onCancel`, and the poller keeps polling (`queryMpesaStatus` is called again after the next 5 seconds). The Daraja panel offers no field while it waits, so the test opens the keyboard over the waiting panel through the store.
  - **Header budget:** the control keeps `h-10` and `-my-1`.
- **Changed existing `expect()`: zero. No existing test file was touched.**
- **Standing tripwires, run unmodified and all passing:** `VirtualKeyboard.test.ts` (10), `VirtualNumpad.test.ts` (8), `keyboardStore.test.ts` (7), `keyboardEchoSubmit.test.ts` (24), `setupScreens.test.ts` (19), `virtualKeyboardLayouts.test.ts` (7); 75 tests in 6 files. Layout guards `screensFitDesignBox.test.ts` (8) and `posCheckoutPanelFit.test.ts` (6) also pass.

## 5. Mutation checks (each restored afterwards; run over the 44 new tests)

| Mutation | Failed | Which |
| --- | --- | --- |
| the control calls nothing (the brief's check) | **10** | "closes the overlay and leaves the field holding everything typed" (both shells); "calls the store's close with no argument" (both); "does not move focus anywhere" (both); the fiscal gate's Save (modal and docked); Onboarding's Connect & Verify; the `PaymentModal` waiting test with the control |
| the click event is passed on to `close` (`onClick={close}`) | **2** | "calls the store's close with no argument", both shells |
| Escape is not handled | **8** | "closes on Escape too" (both shells); "stops at the keyboard"; "calls the store's close..." (both); the fiscal gate on Escape; Onboarding; the `PaymentModal` test with Escape |
| Escape does not stop propagation | **1** | "stops at the keyboard, so another Escape handler does not also run" |
| the control also clears the field | **5** | "closes the overlay and leaves the field holding everything typed" (both); the fiscal gate Save (both shells); Onboarding |
| the control refocuses the field | **2** | "does not move focus anywhere", both shells |
| the control drops `-my-1` | **1** | "the header budget of the docked sheet" |

## 6. Verification

- `npm run typecheck`: clean. `npx vitest run`: 181 files, 2920 tests passed. `npm run build`: exit 0, "neither mock provider is in out/main".
- **Not run:** `check:fit`; a real touchscreen or till. Nothing here was looked at on a screen.

## 7. Flags

1. **The docked sheet has about 2px to spare, worked out from the classes, not measured.** The sheet is a fixed `31rem` (496px). The text keyboard is six rows of 56px plus five 6px gaps (366px); the header was a 24px label row, a 48px echo row and two 8px gaps (88px); the sheet pads 16px top and bottom: 486px, so 10px spare. A 32px label row takes 8px of that, leaving 2. The control is therefore a 40px target with a negative margin rather than a taller row, and a test pins that. If the text keyboard's bottom row looks clipped on the till, the fix is to raise `--spacing-keyboard-sheet` in `index.css` (the setup screens reserve the same height).
2. **The control now shows on the live checkout screen's docked keyboard** (the M-Pesa code field, the card code field, End of Day), not only the setup screens. It only closes the keyboard.
3. **Escape stops at the keyboard.** If the keyboard is open over a screen that has its own Escape handler, only the keyboard closes. Today the only such handler is `LoginScreen`'s, where the keyboard is never open.
4. **Escape is a physical-keyboard key.** On a touch-only till it is never pressed; the on-screen control is what a cashier uses.
5. **No focus return** (section 2). The brief's "focus returns to the field" was set aside for the stated reason, with the approval of the go-ahead message.
6. **Open from the brief, unchanged:** whether a dialog on screen while a fiscal command is in flight should block closing or cancel cleanly is a review decision; nothing was added for it. `RestartCountdownModal` was reported, not changed.

## 8. Rollback

`git revert` the phase 200 commit. Nothing is stored or migrated; the keyboard goes back to Submit and the backdrop tap as its only exits.
