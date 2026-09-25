# Phase 138 — POS usability overhaul, Phase C2: audit (keyboard echo and Submit key)

- **Date:** 2026-09-25
- **Requested:** Audit only. Every keyboard and keypad hosted by `VirtualKeyboardModal` should show a read-only echo of the value typed so far, and have a Submit key that closes it without firing the screen's Save.
- **Outcome:** No change needed (audit only). One constraint shapes the build (§3); the plan is in §5.
- **Branch / base commit:** staging @ 9928ff1
- **Previous:** [phase-137](./phase-137.md)

## 1. How the overlay renders its title today

[VirtualKeyboardModal.tsx](../src/renderer/src/components/VirtualKeyboardModal.tsx) builds the key set once (`keys`), then wraps it in one of two shells. Both render the same header, a single `<p className="mb-2 … text-slate-700">{request.label}</p>` above the keys.

That header is the natural home for the echo. It already sits above the keys in both shells, so the echo goes directly under it with no new layout region.

- **Modal** (the logged-in default): `fixed inset-0 z-[60]` backdrop, then a `max-w-2xl` white card containing the header and the keys.
- **Docked** (setup screens): a `fixed inset-x-0 bottom-0 z-110 h-keyboard-sheet` sheet containing the header and the keys.

## 2. What "Done" and "Enter" do today

- **VirtualKeyboard's Done** (`caps` and `text` layouts): it calls `onDone`, which the modal wires to `keyboardStore.close()`. `close()` only sets `request` to `null`. The field already holds every keystroke, because the `open()` relay writes it on every key, so nothing is committed at close time.
- **VirtualNumpad's Enter:** it renders only when `onEnter` is passed. The modal passes `onEnter={close}` for `numeric`/`ip`, so it does exactly what Done does. The inline numpads pass no `onEnter` and have no Enter key: amount tendered in PosCheckoutPanel and CheckoutModal, and ManagerPinModal.
- **Neither key reaches a screen's Save/Continue.** They only close the keyboard. Onboarding's Connect & Verify and the gate's Save & Continue are separate buttons in the screen, outside the sheet (phase-137).

## 3. The constraint: the tripwire tests find these keys by their text

| Tripwire test | Depends on |
| --- | --- |
| `VirtualKeyboard.test.ts:102` | `clickKey('Done')` (matches `textContent === 'Done'`) |
| `VirtualKeyboard.test.ts:153` | exactly one key whose text is `Done` |
| `VirtualNumpad.test.ts:114, 123` | a key whose text is `Enter`, present only with `onEnter` |

Renaming Done or Enter to Submit inside the components would break two tripwire files that must stay unmodified. Adding a separate Submit key next to them would leave two keys doing the same thing under different names, which the brief forbids.

**Resolution:** a new optional label prop on each component. `VirtualKeyboard` gets `doneLabel`, defaulting to `'Done'`. `VirtualNumpad` gets `enterLabel`, defaulting to `'Enter'`.

- When the prop is passed, the key shows that text and carries `aria-label` set to the same value.
- When it is omitted, the markup is byte-for-byte what it is today.
- `VirtualKeyboardModal`, the only host covered by this requirement, passes `'Submit'` to both.

So every overlay key set has exactly one closing key, labelled Submit (`aria-label="Submit"`). The components' own defaults, and the tripwire tests that pin them, are unchanged.

## 4. Echo for password and token fields

Two callers open the keyboard for a `type="password"` input:

- **Onboarding:** Admin API Access Token.
- **Fiscal setup gate:** Fiscal device password.

Today the overlay never shows the value, so nothing leaks. The echo would change that.

**Default, per the brief:** a new optional `KeyboardRequest.secret`. When it is set, the echo renders one `•` per character, so the same length and never the characters. Only those two callers pass it.

Every other caller echoes in clear text: company name, customer KRA PIN, the corrected KRA PIN in FiscalNotice and NeedsAttention, store URL, server address, IP and port. None of these are secrets. The KRA PIN is printed on the receipt.

**Echo element:** a `<div role="textbox" aria-readonly="true">` rather than a `readOnly <input>`.

- A read-only input can still take focus, and focus is what opens the keyboard elsewhere on these screens. A div with no `tabIndex` can never be focused or typed into.
- It renders `request.value`, the relay's copy. That value is updated on every key, and before any field-side transform. The KRA PIN fields uppercase in their own `onChange`, so their echo shows what was typed, and the field shows the uppercased form.

This is a known quirk, not a bug. For the KRA PIN fields, the echo can show lower case while the field shows upper case. That can only happen in `text` layout, and no KRA PIN caller uses `text`: they all use `caps`, where every key is already upper case. So in practice the two always match.

## 5. Plan (one commit)

| File | Change |
| --- | --- |
| `stores/keyboardStore.ts` | add `secret?: boolean` to `KeyboardRequest` (additive; the `open()` relay is not touched) |
| `components/VirtualKeyboard.tsx` | add `doneLabel?: string` (default `'Done'`), with `aria-label` only when passed |
| `components/VirtualNumpad.tsx` | add `enterLabel?: string` (default `'Enter'`), with `aria-label` only when passed |
| `components/VirtualKeyboardModal.tsx` | render the echo under the label in both shells; pass `doneLabel`/`enterLabel="Submit"` |
| `components/OnboardingScreen.tsx`, `components/EtimsSetupGate.tsx` | pass `secret: true` for the token and password fields |
| `index.css` | grow `--spacing-keyboard-sheet` from 28rem to 31rem (about 3.5rem for the echo row) |

**Tests,** as a new file of real mounts and clicks:

- the echo shows the accumulated value after multi-key typing, on the keyboard and the numpad
- the echo is masked for `secret` and in clear text otherwise
- the echo is a non-focusable read-only element
- Submit closes the overlay (`request` is `null`), the field keeps the full value, and the screen's Save is not called
- there is exactly one closing key per key set, and no Done or Enter remains in the overlay
- the `text` and `numeric` modes, and the modal and docked shells

At the end, repeat the mutation check: break the relay, watch the accumulation tests fail, then restore it.

**Impact to note for the build:**

- **Sheet height:** the docked sheet grows by about 3rem. On short screens, the setup forms scroll a little further to reach Save. Phase E's layout work is post-login only, so this stays scroll-not-fit at 1366×768.
- **Logged-in users:** they will see the key rename from Done to Submit, plus the new echo line in the checkout's Company Name and KRA PIN keyboard.

## 6. Changes made

None. This report is the only file added.

## 7. Rollback

`git revert <this commit>`.

## 8. Observed but not changed

- **Inline numpads have no echo or Submit:** amount tendered, ManagerPinModal, and the Login PIN pad. They are outside this requirement, because they are not hosted by the overlay, and each already shows its value (the `Ksh …` display, the PIN input, the PIN dots) next to its own action button.
- **`CheckoutModal.tsx` still renders a `VirtualNumpad`,** but no file in `src/` or `tests/` imports it; the other mentions are only in comments. PosCheckoutPanel replaced it in Phase 44. It is dead code, worth removing in a separate change.
