# Phase 156 — On-screen keypad for the remaining typed number fields

- **Date:** 2026-09-26
- **Requested:** Per the phase-151 Part B audit and phase-147 observations, several number fields were still plain typed inputs on a touch-only till: `CartLineItem`'s manual price override and per-line discount value, `PosCheckoutPanel`'s cart-level discount entry, `StockTakePage`'s counted quantity, second-approver KES threshold and count-expiry hours, and `PaymentModal`'s Daraja phone number. Convert each to the established `readOnly` + `useKeyboardStore` pattern, adding one small, opt-in store addition: a `'decimal'` keyboard mode (a numpad with one decimal point allowed), and move `AdminScreen`'s Starting/Ending Cash fields onto it from `'numeric'`.
- **Outcome:** Implemented.
- **Branch / base commit:** staging @ 82b6e38 (Phase 155 — Admin field keyboard conversion).
- **Standing tripwires:** unmodified and passing — `VirtualKeyboard`/`VirtualNumpad`/`keyboardStore`/`keyboardEchoSubmit`/`setupScreens`/`virtualKeyboardLayouts`, `adminScreen` (2 assertions changed, see §3 — every other assertion in it is untouched), the M-Pesa and fiscal suites, `stockTake`/`stockTakeGuard`, `paymentModal` (extended, not altered — see §3), the Phase E layout tests (`screensFitDesignBox`, `belowLgUnreachable`, `headerLayout`, `posCheckoutPanelFit`, `cartLayout`).

## 1. The `'decimal'` mode

`keyboardStore.ts`'s `KeyboardMode` gained `'decimal'` alongside the existing `'caps' | 'text' | 'numeric' | 'ip'`: `VirtualNumpad` with one decimal point allowed, distinct from `'numeric'` (no decimal point at all) and from `'ip'` (many decimal points, for a dotted address). `VirtualKeyboardModal.tsx` was updated in exactly the two places that switch on mode:

```ts
const numeric = mode === 'numeric' || mode === 'decimal' || mode === 'ip'
// …
allowDecimal={mode === 'decimal' || mode === 'ip'}
multipleDecimals={mode === 'ip'}   // unchanged — still the only mode that allows more than one
```

`AdminScreen.tsx`'s Starting Cash and Ending Cash fields (phase-155 gave them `mode: 'numeric'`, which could never enter cents) moved to `mode: 'decimal'` — the one deliberate behavioural correction in this phase, not a new field.

## 2. Field conversion

| Component | Field | Mode | Notes |
| --- | --- | --- | --- |
| `CartLineItem.tsx` | Price override | `decimal` | `type="number" min="0" step="0.01"` → `readOnly` text input, `aria-label="New price"` (no `<label>` existed to key tests off) |
| `CartLineItem.tsx` | Discount value | `decimal` | Same conversion, `aria-label="Discount amount"` |
| `PosCheckoutPanel.tsx` | Cart-level discount value | `decimal` | Identical editor to `CartLineItem`'s, same `aria-label` |
| `StockTakePage.tsx` | Counted quantity | `numeric` | Whole numbers only, matching `handleCount`'s existing `Number.isInteger` check |
| `StockTakePage.tsx` | Second-approver limit (KES) | `decimal` | Was `inputMode="decimal"` with a regex filter |
| `StockTakePage.tsx` | Count expires after (hours) | `numeric` | Was `inputMode="numeric"` with a regex filter |
| `PaymentModal.tsx` | Daraja phone number (`localPhoneInput`) | `numeric` | `type="tel"` kept (harmless, no min/step to conflict with `readOnly`); the existing `254` prefix + leading-`0` stripping stayed in the `onChange` callback, unchanged |

**Not converted, per the task:** the stock-take barcode/search box (scanner input, same reasoning as the POS search boxes) and `PaymentModal`'s M-Pesa manual/unverified code field, which was **already** on this pattern (`mode: 'caps'`, docked) from an earlier phase — nothing to do there.

Every field's validation, save payload and PIN gating are byte-for-byte unchanged — `validatePriceOverride`, `requiresManagerPinForDiscount`, `Number.isInteger` on the counted quantity, the settings' `Number.isFinite`/range checks, and `PHONE_PATTERN` all still run on the same string state, now populated by the keyboard's `onChange` instead of a native one.

**One minor, deliberate side-effect of the conversion itself:** the counted-quantity field's `onKeyDown={(e) => e.key === 'Enter' && handleCount()}` was dropped. It was a physical-keyboard convenience with nothing left to attach to on a `readOnly` field — the on-screen keyboard's own Submit key only closes the overlay (by established convention, see `VirtualKeyboardModal.tsx`'s doc comment — it deliberately never reaches a screen's own action button), so "Record count" remains the one way to submit, exactly as every other converted numeric field in phase-155 already works.

`StockTakePage.tsx` gained a small `openField` helper identical in shape to `AdminScreen.tsx`'s own (three fields don't justify importing across files, and the two components are otherwise unrelated). `CartLineItem.tsx` and `PosCheckoutPanel.tsx` call `useKeyboardStore.getState().open(...)` inline instead, matching how those two components already open the customer-KRA-PIN/company-name/M-Pesa-code keyboards elsewhere in the same files.

## 3. Tests

### `tests/keyboardEchoSubmit.test.ts` — `'decimal'` mode coverage (new)

Two new describe blocks mount the real `VirtualKeyboardModal`: **`decimal mode`** confirms it renders the numpad (not the alphanumeric keyboard), accepts one decimal point, and ignores a second — and **`numeric and ip modes are unaffected by adding decimal`** confirms `'numeric'` still has no decimal key at all and `'ip'` still allows the decimal key more than once. 24/24 tests pass (20 pre-existing + 4 new).

### `tests/priceDiscountKeypad.test.ts` (new) — `CartLineItem` + `PosCheckoutPanel`

Real mount (`react-dom/client`), matching `cartLayout.test.ts`/`posCheckoutPanelFit.test.ts`'s own style. Covers: the price and discount fields are `readOnly` and open the keyboard in `decimal` mode; typing a new price and tapping Save sends the same numeric value `onSetPrice` always received; typing a discount under the 10% manager-PIN threshold and tapping Apply sends the same `Discount` object as before, for both `CartLineItem` (`onSetDiscount`) and `PosCheckoutPanel` (`cartStore`'s real `setCartDiscount`); one character-by-character accumulation test on the price field. 7/7 pass.

### `tests/stockTakePageKeypad.test.ts` (new) — `StockTakePage`

First real mount of this page (no prior UI test existed — `stockTake.test.ts`/`stockTakeGuard.test.ts` test the backend service and a source-guard, not the component). Covers: the threshold and expiry fields' mode (table-driven); the scan/search box stays a plain, non-`readOnly` input with no keyboard wiring; the counted-quantity field's mode and label once a session is open and a product is matched; typing a count and tapping "Record count" sends the same integer `recordStockTakeCount` payload as before; typing a new threshold and authorizing through the real `ManagerPinModal` (digit taps + Authorize) sends the same `saveStockTakeSettings` payload as before; one character-by-character accumulation test. 7/7 pass.

### `tests/paymentModal.test.ts` — extended, not altered

A new `Daraja phone number field` describe block: the field is `readOnly` and opens the keyboard in `numeric` mode; typing a number with a leading `0` (stripped exactly as the old `onChange` did) and tapping "Send Request" calls `initiateMpesaStkPush` with the same `254`-prefixed `phoneNumber` as before; one character-by-character accumulation test. No existing assertion in this file was changed — 12/12 pass (9 pre-existing + 3 new).

### `tests/adminScreen.test.ts` — one deliberate change, recorded

**DELIBERATE TEST CHANGE:** phase-155 asserted Ending Cash's keyboard request had `mode: 'numeric'`. Since Starting/Ending Cash moved to `'decimal'` in this phase (§1), that assertion is now wrong on its face — a cash amount needs cents.
- **Old:** `expect(useKeyboardStore.getState().request?.mode).toBe('numeric')`
- **New:** `expect(useKeyboardStore.getState().request?.mode).toBe('decimal')`
- **Why:** the field itself changed mode; the test is asserting the corrected, intended behaviour, not working around a change that didn't need to happen.

### The relay mutation check (required by the task)

Every single-shot test above (`onChange('750.50')`, `onChange('QDF73HK9LM')`-style, etc.) passes whether or not `keyboardStore.ts`'s relay keeps `request.value` in sync with what was actually typed — that accumulation contract is `tests/keyboardStore.test.ts`'s own "BUG FIX" tripwire's job. To make sure this phase's new character-by-character tests are not vacuous with respect to it, the relay's `set(...)` line was temporarily removed from `keyboardStore.ts` and the following were re-run together:

```
tests/keyboardStore.test.ts
tests/priceDiscountKeypad.test.ts
tests/stockTakePageKeypad.test.ts
tests/paymentModal.test.ts
tests/adminScreen.test.ts
```

Result: **exactly the five accumulation tests failed** — `keyboardStore.test.ts`'s own tripwire, `adminScreen.test.ts`'s phase-155 accumulation test, and the four new character-by-character tests in `priceDiscountKeypad.test.ts`, `stockTakePageKeypad.test.ts` (×1) and `paymentModal.test.ts` — while every single-shot test in the same five files kept passing. The relay was then restored; `git diff -- src/renderer/src/stores/keyboardStore.ts` showed only the intended `'decimal'`-mode doc-comment/type-union change, confirming the mutation left no residue.

## 4. Affected files

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/renderer/src/stores/keyboardStore.ts` | Modified | New `'decimal'` `KeyboardMode` |
| `src/renderer/src/components/VirtualKeyboardModal.tsx` | Modified | Routes `'decimal'` to the numpad with one decimal point |
| `src/renderer/src/components/AdminScreen.tsx` | Modified | Starting/Ending Cash moved from `'numeric'` to `'decimal'` |
| `src/renderer/src/components/CartLineItem.tsx` | Modified | Price override + discount fields converted to the keyboard pattern |
| `src/renderer/src/components/PosCheckoutPanel.tsx` | Modified | Cart-level discount field converted |
| `src/renderer/src/pages/StockTakePage.tsx` | Modified | Counted quantity, threshold, expiry-hours fields converted; new local `openField` helper |
| `src/renderer/src/components/PaymentModal.tsx` | Modified | Daraja phone-number field converted |
| `tests/keyboardEchoSubmit.test.ts` | Modified | `'decimal'` mode coverage added |
| `tests/priceDiscountKeypad.test.ts` | Added | Real-mount coverage of `CartLineItem`/`PosCheckoutPanel`'s converted fields |
| `tests/stockTakePageKeypad.test.ts` | Added | First real-mount coverage of `StockTakePage`, covering its converted fields |
| `tests/paymentModal.test.ts` | Modified | Phone-number field coverage added |
| `tests/adminScreen.test.ts` | Modified | One mode assertion corrected (§3) |

## 5. Possible impact

- **Direct:** a cashier/manager entering a price override, a discount, a stock count, a stock-take policy figure, or a customer's phone number now uses the same on-screen keyboard already used everywhere else on this till, instead of relying on the OS's own (often absent, on a kiosk) software keyboard.
- **Indirect:** none — every field's own validation, save payload and PIN gating are the same code, reached via `onClick`/`onFocus` instead of `onChange`. `savePrice`, `applyDiscountEdit`, `applyCartDiscount`, `handleCount`, `handleAuthorized`'s `'settings'` branch, and `handleSendStkPush` were not touched.
- **Data / schema / contract:** none.
- **Security posture:** unchanged — none of these fields are secrets.
- **Idempotency / re-run safety:** n/a — no state-changing logic changed, only how a human enters a value.
- **Residual risk:** the counted-quantity field's physical-Enter-to-submit shortcut is gone (§2) — a low-risk, deliberate consequence of the field no longer accepting direct typing, consistent with how every other converted field in this project already works.

## 6. Verification

- `npm run typecheck` — clean, run after the mode addition and again after every group of field conversions.
- `npx vitest run tests/keyboardEchoSubmit.test.ts` — **24/24 passed**.
- `npx vitest run tests/priceDiscountKeypad.test.ts` — **7/7 passed**.
- `npx vitest run tests/stockTakePageKeypad.test.ts` — **7/7 passed**.
- `npx vitest run tests/paymentModal.test.ts` — **12/12 passed**.
- `npx vitest run tests/adminScreen.test.ts` — **26/26 passed** (with the corrected mode assertion).
- Full suite: `npx vitest run` — **113 test files, 1733 tests passed**, zero failures (up from phase-155's 111/1710: +2 files, +23 tests).
- `npm run build` — succeeds.
- The relay mutation check (§3) performed and reverted; `git diff -- src/renderer/src/stores/keyboardStore.ts` confirmed clean (only the intended `'decimal'`-mode change) before committing.
- `git status --short` confirmed exactly the 12 files in §4 were touched.

## 7. Rollback

`git revert` of this commit restores every field's plain `onChange`/`inputMode`/`type="number"`, removes the `'decimal'` `KeyboardMode` and its handling in `VirtualKeyboardModal.tsx`, and moves `AdminScreen`'s cash fields back to `'numeric'`. Nothing outside this commit depends on any of these fields being `readOnly`.

## 8. What only a human can check

- On the actual touchscreen till: override a price, apply a discount, count one stock item, and enter Ending Cash with cents, all using the on-screen keypad — the task's own suggested check.
- The decimal point key on a `decimal`-mode field behaves as expected on real touch hardware (single tap, no double-registration).

---

**STOP.**
