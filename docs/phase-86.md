# Phase 86 — Task 3: on-screen alphanumeric keyboard, Apply

Builds the keyboard `docs/phase-85.md` scoped, to the modal-overlay
design and the three settled decisions from the Apply brief: modal
placement, one shared component, real-mount testing.

## What was built

### The key grid — `components/VirtualKeyboard.tsx`

Fully controlled, exactly matching `VirtualNumpad`'s contract:
`{ value, onChange, onDone, maxLength? }`. No validation, no field
awareness — it only ever calls `onChange(value + char)`, so it composes
with whatever a field already does (`.toUpperCase()`,
`isValidKraPinFormat`, `maxLength`) without knowing any of it exists.

Layout: a digit row (`1`-`9`, `0`) above three QWERTY letter rows, then
backspace / Space / Done. **Uppercase-only, no shift/caps key** — the
choice called out for the report: both KRA PIN fields already uppercase
every keystroke themselves, and an all-caps company name on a receipt
is a normal, unremarkable convention. Adding real case state (tracking
shift, a second label set per key) would be non-trivial complexity for a
distinction that's a wash for the fields this actually serves. Written
directly on the component as the reasoning, not just here.

`maxLength` disables every appending key (not just silently no-oping
taps) once the limit is reached, and disables Space too — a space is
just another character. Backspace disables itself at an empty value.

### The shared instance — `stores/keyboardStore.ts` + `components/VirtualKeyboardModal.tsx`

`PosCheckoutPanel.tsx`'s two fields and `FiscalNotice.tsx`'s one live in
different parts of the tree (siblings, not parent/child) — the same
problem `toastStore.ts` solved for toasts. `keyboardStore` holds a
single `request: { value, onChange, label, maxLength? } | null`;
`open(request)` sets it (a second `open()` while one is already showing
replaces it — there is only ever one keyboard), `close()` clears it.

`VirtualKeyboardModal` is mounted once at the `App.tsx` root (alongside
`ToastStack` and the toast producers), reads the store, renders nothing
when `request` is `null`. When open: `fixed inset-0 z-[60]` — above
`ToastStack`'s `z-50` on purpose, so opening the keyboard from inside a
fiscal-notice toast draws it cleanly over the whole toast column, never
behind or beside it. Backdrop tap or Done both call the same `close()`,
matching this app's existing modal convention (`VariantModal`'s
backdrop-click-to-close pattern).

**The coexistence guarantee is structural, not just visual**:
`keyboardStore` has zero reference to `toastStore` or to
`FiscalNotice`'s own dismissal state (`dismissedLocalId`, etc.) —
`close()` takes no arguments and touches nothing but its own `request`
field. So closing the keyboard cannot dismiss the fiscal notice that
opened it, structurally, the same way phase-84's toast dismissal
couldn't touch the database: there's no code path from one to the
other. `tests/keyboardStore.test.ts` exercises this directly (`close()`
takes zero arguments, touches only its own state). When the keyboard
closes, the fiscal notice is exactly as it was the whole time — its own
React state never stopped running underneath, it was just visually
covered.

### Wiring — three call sites, one component

- **`PosCheckoutPanel.tsx`** — company-name and customer-KRA-PIN fields
  are now `readOnly` (there's no physical keyboard to defer to, so
  nothing should try) with an `onClick` that calls `keyboardStore`'s
  `open()` bound to that field's own `value`/`setState`. The PIN field's
  `onChange` wraps `setCustomerPin` in the same `.toUpperCase()` the
  plain input used to apply directly, and passes `maxLength:
  KRA_PIN_MAX_LENGTH` — identical behavior, new entry method. Removed
  the now-meaningless `autoFocus` (a readOnly field has nothing to focus
  a nonexistent keyboard onto).
- **`FiscalNotice.tsx`** — the wrong-PIN correction input, same
  treatment (`readOnly`, `onClick` opens the keyboard bound to
  `pinInput`/`setPinInput`, same uppercase wrap, same `maxLength`). The
  `Save & Resend` button's `disabled={!pinFormatValid || resending}`
  gate is completely unchanged — `pinFormatValid` is still computed from
  `pinInput` exactly as before, and the keyboard is just a new way
  `pinInput` gets its characters. Confirmed by reading the surrounding
  code: nothing about the validation gate was touched, only how
  keystrokes arrive.
- Every other text field (M-Pesa reference, product search, discount)
  is untouched, exactly as scoped — `keyboardStore`/`VirtualKeyboard`
  are general enough that wiring one of those later is one `open()` call
  at its own field, not a redesign.

### Not touched

`VirtualNumpad.tsx` itself and everything it already serves (Amount
Tendered, `ManagerPinModal`), and nothing in fiscalization/checkout/IPC
— confirmed by grep: no edits outside `src/renderer/src` in this phase.

## Tests

- **`tests/VirtualKeyboard.test.ts`** (new, 10 tests, real-mounted with
  `react-dom/client` and driven by real `button.click()` calls,
  matching `VirtualNumpad.test.ts`'s established pattern — this project's
  documented exception to "no component-render tests," not covered by
  that convention): a digit key appends; a letter key appends; Space
  appends a space; backspace removes the last character and disables
  itself at an empty value; Done fires `onDone`; a key press past
  `maxLength` is a no-op; every appending key (digit, letter, Space) is
  actually `disabled` at the limit, not just silently ignored; the
  component is fully controlled (renders only what it's given, holds no
  divergent internal copy); exactly one Done key and one backspace key
  render (no accidental duplicates from the row-mapping).
- **`tests/keyboardStore.test.ts`** (new, 5 tests): closed by default;
  `open()` sets the request; a second `open()` replaces rather than
  queuing (only one keyboard instance can ever be showing); `close()`
  clears it; `close()`'s structural independence from any other store
  (zero arguments, touches only its own field) — the basis for the
  coexistence guarantee above.
- Existing suites (`kraPin.test.ts`, `fiscalNotice.test.ts`,
  `VirtualNumpad.test.ts`, …) — all pass unmodified. Validation logic
  didn't move; only how characters reach the same `onChange` calls did.

### What the tests can't cover — the visual check

Real screen, on the actual touch-only till, before calling this done:

1. Open the keyboard from **the fiscal-notice PIN field specifically**
   (trigger a wrong-PIN rejection in mock mode, tap the readonly PIN
   input) — confirm it draws cleanly over the toast stack, not beside or
   behind it.
2. Type a corrected PIN entirely by touch, tap **Done**.
3. Confirm the fiscal notice is back exactly as it was — message,
   [Correct PIN]/[Remove PIN & Resend]/[Send to Office] buttons all
   present and working, and that **Save & Resend** actually resends
   using the value just typed (the structural argument above says this
   must work; a live tap-through is the real proof).
4. Confirm the checkout-panel company-name and PIN fields open/close the
   same keyboard correctly and that typing lands in the right field when
   switching between them.
5. General touch-target sizing/reachability on the real 1920×1080
   screen — the key sizes were chosen to match `VirtualNumpad`'s
   established scale, but only a real finger on the real screen confirms
   they're actually comfortable.

## Verification

- `npx vitest run`: **66 files / 987 tests** (972 going in + 15 new), 0
  failures.
- `npm run typecheck` (node + web): clean.
- No modification outside `src/renderer/src` — this is a renderer-only
  addition, same boundary the toast-stack work (phase-84) held.

Holding here for the visual check and for review before the master
brief's close-out step.
