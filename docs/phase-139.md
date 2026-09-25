# Phase 139 — POS usability overhaul, Phase C2: keyboard echo and Submit key

- **Date:** 2026-09-25
- **Requested:** Build the approved [phase-138](./phase-138.md) plan: a read-only echo of the typed value in every keyboard and keypad hosted by `VirtualKeyboardModal`, and one closing key per key set, labelled Submit.
- **Outcome:** Implemented
- **Branch / base commit:** staging @ 083691c
- **Previous:** [phase-138](./phase-138.md)

## 1. Audit

The audit is [phase-138](./phase-138.md). Nothing in it changed on re-reading, so it was built as written:

- The overlay already renders a label above the keys in both shells, so the echo slots in under it with no new layout region (§1).
- Done and the numpad's Enter both only call `keyboardStore.close()`, and neither reaches a screen's Save. So a Submit key that closes the overlay is the same action under a clearer name (§2).
- Two tripwire test files find those keys by their visible text, so the rename is done through an optional prop rather than in the components' own defaults (§3).
- Exactly two callers open the keyboard for a `type="password"` field: the Shopify Admin API token and the fiscal device password (§4).

## 2. Changes made

**`stores/keyboardStore.ts`** — one additive field, `secret?: boolean`, documented as masking the echo. The `open()` relay is untouched; the diff on this file is 7 added lines and nothing else.

**`components/VirtualKeyboard.tsx`** — new optional `doneLabel`.

```tsx
aria-label={doneLabel}
…
{doneLabel ?? 'Done'}
```

Omitted, `aria-label` is absent and the key reads `Done`, exactly as before. Passed, the key's text and its accessible name are both that value.

**`components/VirtualNumpad.tsx`** — new optional `enterLabel`, the same shape. The key still renders only when `onEnter` is given, which is what `VirtualNumpad.test.ts` pins.

**`components/VirtualKeyboardModal.tsx`:**

- **Echo.** A shared `header` fragment — the existing label `<p>`, then the echo — is rendered by both shells, so they cannot drift apart. The echo is:

  ```tsx
  <div role="textbox" aria-readonly="true" aria-labelledby={LABEL_ID} className="… h-12 …">
    {request.secret ? '•'.repeat(request.value.length) : request.value}
  </div>
  ```

  It shows `request.value`, the relay's copy, so it updates on every key. It is a `div` with no `tabIndex`, so it can never take focus or be typed into; focus is what opens this keyboard on the setup screens, and a focusable echo would loop. `h-12` is fixed, so the keys do not shift when the first character arrives. `whitespace-pre` keeps a typed space visible. `aria-labelledby` gives the box its name from the label above it.
- **Submit.** It passes `doneLabel="Submit"` and `enterLabel="Submit"`, so each overlay key set has exactly one closing key. It still calls `close()` and nothing else.
- **Doc comment.** It now states why Submit does not reach the screen's Save: the relay has already written every keystroke into the field, so there is nothing left to commit, and firing a save from a keyboard key would take the decision away from the visible button (the phase-84/86 coexistence rule).

**`components/OnboardingScreen.tsx`** — `openKeyboard` takes a fourth argument, `secret`, defaulting to `false`. Only the Admin API Access Token passes `true`.

**`components/EtimsSetupGate.tsx`** — the request passes `secret: field.type === 'password'`. That derives the mask from the field's own type rather than repeating the list, so a future secret field cannot be added as a plain-text input and masked, or the reverse.

**`index.css`** — `--spacing-keyboard-sheet` grows from 28rem to 31rem for the echo row. It still drives both `h-keyboard-sheet` (the sheet) and `pb-keyboard-sheet` (the space the setup screens reserve), so the two stay in step. The tallest key set now measures about 30.4rem inside a 31rem sheet.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| src/renderer/src/stores/keyboardStore.ts | Modified (additive, +7 lines) | request shape |
| src/renderer/src/components/VirtualKeyboard.tsx | Modified (additive) | closing key's label |
| src/renderer/src/components/VirtualNumpad.tsx | Modified (additive) | Enter key's label |
| src/renderer/src/components/VirtualKeyboardModal.tsx | Modified | echo row; Submit labels |
| src/renderer/src/components/OnboardingScreen.tsx | Modified | token echoes masked |
| src/renderer/src/components/EtimsSetupGate.tsx | Modified | password echoes masked |
| src/renderer/src/index.css | Modified (one value) | sheet height |
| tests/keyboardEchoSubmit.test.ts | Added | tests |

## 4. Possible impact

**Intended and user-visible:**

- **Every overlay keyboard and keypad now shows an echo row** above the keys, in both the docked setup sheet and the logged-in popup. That includes the checkout's Company Name and Customer KRA PIN, and the wrong-PIN correction in the fiscal notice and Needs Attention.
- **Done is renamed to Submit** in the overlay, and the numpad's Enter is Submit there too. Cashiers who know the checkout keyboard will see the new word.
- **The docked sheet is about 3rem taller.** At 1366×768 the setup forms scroll slightly further to reach Save. Accepted; Phase E revisits sheet scaling.

**Not changed:**

- **The inline numpads** keep their own labels, because they use the components' defaults: amount tendered still has no closing key at all, and ManagerPinModal and the login PIN pad are unchanged. None of them gains an echo; each already shows its value beside its own action button.
- **Behaviour of every existing caller.** They pass no new props, so they get the same key sets, the same `caps` modal at `z-[60]`, and the same `close()`.
- **Submit cannot trigger a save.** It calls `close()` only, which is asserted from both setup screens.
- **Data, schema, contract, receipts, KRA filing:** none. The values sent to `saveEtimsConfig` and `validateShopifyConfig` are built exactly as before.

**Security posture — improved on the plan, and worth stating precisely:**

- The echo is a new place a typed value appears on screen. For the two credentials it renders one `•` per character; the characters never enter the DOM, which a test asserts by searching the whole container's text.
- What it does reveal for those two fields is the length. That is the same information the masked `<input type="password">` beside it already shows.
- Every other field echoes in clear text. None is a secret: store URL, fiscal server address, device IP, port, company name, and the KRA PIN, which is printed on the receipt.

**Idempotency / re-run safety:** nothing stateful. A second `open()` still replaces the first.

**Residual risk:** jsdom does not lay out or paint, so the sheet's fit at 31rem and the echo's legibility have not been seen on a screen.

## 5. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` (node and web) | clean |
| `npx vitest run` (full suite) | 96 files, 1,451 tests passed |
| `git diff --stat -- tests/` | empty; the only change under `tests/` is the new untracked `keyboardEchoSubmit.test.ts` |
| Tripwires (fiscalEngine, fiscalRouting, mpesaPaymentGate, VirtualNumpad, VirtualKeyboard, keyboardStore, setupScreens, virtualKeyboardLayouts) | pass, files unmodified |
| `npx electron-vite build` | built; the emitted CSS carries `--spacing-keyboard-sheet: 31rem` and both utilities |

**What the 18 new tests prove** (real mount, real clicks, with the real `VirtualKeyboardModal`):

- **Echo:** empty before the first key, in a box already at full height; accumulates every key on the keyboard (`shp-1`) and on the numpad (`10.2`); follows a backspace back down; masks a `secret` request as `•••••` with `shpat` absent from the DOM; shows a non-secret request in clear text; present in both the docked and the modal shell.
- **Echo is display-only:** `role="textbox"`, `aria-readonly="true"`, no `tabIndex`, not an `<input>`; dispatching `keydown` and `input` at it and calling `focus()` changes neither the echo nor the field, and it does not become `document.activeElement`.
- **Submit:** exactly one key labelled Submit in each of the four modes, with `aria-label="Submit"`, and no key reading `Done` or `Enter` anywhere in the overlay; it clears the store request, unmounts the overlay, and leaves the field holding the full typed value; from the fiscal gate it does not call `saveEtimsConfig` or `onComplete` and the gate is still standing with its Save button; from Onboarding it does not call `validateShopifyConfig`.
- **Which fields mask:** the gate's four fields report `secret` as `false, false, false, true`; Onboarding's report `false` then `true`; typing `secret` into the password field echoes `••••••` while the field holds `secret` and stays `type="password"`.

**Mutation check.** Replacing the relay with a plain `set({ request })` — the original one-letter-at-a-time bug — failed **17 tests across 3 files**:

- `keyboardEchoSubmit`: accumulates on the keyboard; accumulates on the numpad; follows a backspace; masks a secret request; shows clear text; is read-only and not focusable; Submit keeps the typed value; does not fire the gate's Save; does not fire Connect & Verify; a password never puts its characters on screen.
- `keyboardStore`: `open()` sets the request a field supplies; BUG FIX: consecutive keystrokes accumulate.
- `setupScreens`: the IP numpad's repeated dots; both REGRESSION accumulation tests; saves valid input; Connect & Verify sends the typed values.

The relay was then restored, leaving `keyboardStore.ts`'s only diff the additive `secret` field, and the six keyboard-related files passed again (69 tests).

## 6. What only a human can check

On the till:

- **Each of the six setup fields** (Onboarding's store URL and token; the gate's server address, IP, port and password): the echo tracks every key as it is pressed.
- **The token and the device password** echo as dots, never as characters.
- **Submit** closes the keyboard and does **not** fire Connect & Verify or Save & Continue; those still need their own tap.
- **Logged in:** the checkout's Company Name and Customer KRA PIN keyboard now shows an echo row, and its Done key reads Submit.
- **1366×768:** the setup forms scroll about 3rem further to reach Save. Confirm Save is still reachable.

## 7. Rollback

`git revert <this commit>`. It is additive on top of Phase C, and Phases D and E do not build on it.

## 8. Observed but not changed

- **`CheckoutModal.tsx`** is imported by no file in `src/` or `tests/` (the other mentions are comments); PosCheckoutPanel replaced it in Phase 44. It renders a `VirtualNumpad`, so it still typechecks and still builds. Dead code, worth a separate removal.
- **The KRA PIN echo could show lower case** while the field shows the uppercased value, because the field uppercases in its own `onChange` while the echo shows the relay's copy. It cannot happen today: every KRA PIN caller uses `caps`, where each key is already upper case. Noted in phase-138 §4.
- **Phase D** is next: fetch all locations (up to 106, currently capped at 10) and page them 9 at a time.
