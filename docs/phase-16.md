# Phase 16 — Touch UI Overhaul

**Date:** 2026-08-26 · **Branch:** `main` · **Previous:** [Phase 15](./phase-15.md)

## 1. Objective

A site visit ahead of the 1-week Proof of Concept showed the existing
UI reads too small for a 15" retail touchscreen and relies on emoji
glyphs that render inconsistently across Windows font configurations.
This phase is a UI-only pass: bigger text, bigger touch targets, real
SVG icons in place of emoji, and a reusable on-screen numpad for
numeric entry. No IPC contracts, business logic, or database schema
changed.

This phase does **not** repeat Task 1 (server-side admin
authorization, `requireAdminPin`) or Task 2 (the Demo Mode banner) from
the originating brief — both shipped in [Phase 14](./phase-14.md) and
were verified still in place (`src/main/lib/requireAdminPin.ts`, the
`requireAdminPin` calls guarding `staff:create`/`staff:resetPin`/
`integrations:set-config` in `main/index.ts`, and the amber Demo Mode
banner in `App.tsx`) before any new work started.

## 2. Deliberately out of scope: native touch-keyboard automation

The originating brief also asked for a custom QWERTY `TouchKeyboard`
component and a `keyboard:show` IPC handler that shells out to
Windows' `tabtip.exe` for text fields. That was cut from this pass:
shelling out to a native Windows process is a new OS-automation
surface with no existing test coverage pattern in this codebase, and
48 hours before a live retail deployment is the wrong time to
introduce one. Numeric fields (the actual checkout-critical inputs —
cash tendered, PINs, discount/price overrides) get the new
`VirtualNumpad` instead, which is fully self-contained and unit
tested. Free-text fields (M-Pesa reference, staff names, product
search) are left to Windows' own touch keyboard.

## 3. Emoji → SVG icons

Every emoji glyph in the renderer (⚠️ 📭 🔍 🛒 ✓ ✕ 🔒 📦) is replaced
with an inline stroke-based SVG, following the hand-rolled-SVG
convention already used in `VariantModal.tsx`. The set lives in one
shared module:

```ts
// src/renderer/src/components/icons.tsx
export function SearchIcon({ className }: IconProps): JSX.Element
export function CloseIcon({ className }: IconProps): JSX.Element
export function WarningIcon({ className }: IconProps): JSX.Element
export function InboxIcon({ className }: IconProps): JSX.Element
export function CartIcon({ className }: IconProps): JSX.Element
export function CheckIcon({ className }: IconProps): JSX.Element
export function LockIcon({ className }: IconProps): JSX.Element
export function PackageIcon({ className }: IconProps): JSX.Element
```

`EmptyState`'s `icon` prop changes from `string` to `ReactNode` — every
call site now passes an icon element (e.g.
`icon={<CartIcon className="h-10 w-10" />}`) instead of an emoji
literal. This is the only prop-shape change in the phase; every other
edit is a `className` change.

## 4. Typography floor

`src/renderer/src/index.css` pins `html { font-size: 16px }` as an
explicit floor — Tailwind's `text-base` already resolves to 16px by
default, but this makes the floor a written decision rather than an
implicit default that a future global style change could quietly
erode.

Every screen's text sizes move up from there. The concrete mapping
applied (not a single global multiplier — each element was checked
against its neighbors so hierarchy stays intact):

| Element class | Before | After |
| --- | --- | --- |
| Product title / price | `text-base` / `text-sm` | `text-xl` / `text-xl font-bold` |
| Cart item name / line total | `text-sm` / `text-base` | `text-lg` / `text-lg` |
| Cart total | `text-xl` | `text-2xl font-bold` |
| Checkout button | `text-xl h-auto` | `text-xl font-bold h-16` |
| Checkout modal total | — | `text-3xl font-bold` (already in place) |
| Payment method buttons | `py-6 text-lg` | `h-14 text-lg` |
| Numpad keys | `py-3 text-xl` | `h-16 w-full text-2xl` |
| Admin section headers (`h3`) | `text-base font-semibold` | `text-2xl font-bold` |
| Admin subsection headers (`h4`) | `text-base font-semibold` | `text-xl font-semibold` |
| Admin form labels | `text-xs`/`text-sm` | `text-lg` |
| Admin/cart form inputs | `text-base`, no fixed height | `h-12`, `text-lg`, `focus:ring-4` |
| Shift cash-amount inputs | `text-lg` | `text-xl` (matches the spec's explicit "cash amounts" call-out) |
| Order History: order id / status badge | `font-medium` / `text-sm px-2.5 py-0.5` | `text-lg font-semibold` / `text-base px-4 py-2` |
| Login/PIN pad keys | `py-4 text-2xl` | `h-16 w-16 rounded-full text-2xl` |
| Header / nav tabs | `h-16` / `px-4 py-2 text-base` | `h-20` / `h-14 px-6 text-lg` |

## 5. Touch target sizing

- Product cards: fixed `h-64`, `p-6` (was `min-h-[160px]`, `p-4`).
- Cart line item: quantity steppers are now `h-12 w-12` (was
  unconstrained `px-2 py-1`); the remove button is a `h-10 w-10`
  circular red button (was a bare `✕` glyph with no hit-target
  padding).
- All Admin/cart/checkout `<input>`/`<select>` elements are now at
  least `h-11`/`h-12`, comfortably above the 44×44px WCAG AA touch
  target minimum, and gained a `focus:ring-4 focus:ring-rose-100` state
  so a finger tap's focus is visible on a bright retail floor.

## 6. `VirtualNumpad`

```ts
// src/renderer/src/components/VirtualNumpad.tsx
interface VirtualNumpadProps {
  value: string
  onChange: (value: string) => void
  onEnter?: () => void
  allowDecimal?: boolean
}
export default function VirtualNumpad(props: VirtualNumpadProps): JSX.Element
```

Fully controlled — the caller owns `value` and receives the next
string on every keypress via `onChange`, so it composes with whatever
parsing/validation the field already does (`parseFloat`, `.trim()`,
etc.) without the component needing to know about it. A 3-column grid
of `1`–`9`, `.`, `0`, and `⌫` (`h-16`, `text-2xl`, matching the spec),
plus a `Clear` key and an optional `Enter` key that only renders when
`onEnter` is supplied.

Wired into:

- **`CheckoutModal.tsx`** — replaces the inline `AMOUNT_KEYS` grid for
  "Amount Tendered" (cash checkout). No `onEnter` is passed here since
  the "Complete Sale" button directly below already serves that role;
  adding a second submit action on the pad would be a redundant,
  potentially confusing control.
- **`ManagerPinModal.tsx`** — added *alongside* the existing
  `<input type="password">` (`allowDecimal={false}`), not in place of
  it, so PIN entry still works by physical keyboard/paste exactly as
  before. This is the safest way to add a touch affordance to an
  existing, already-shipped authorization gate 48 hours before launch.

`LoginScreen.tsx`'s PIN pad and CheckoutModal's own cash numpad
predate this component; `LoginScreen`'s pad keeps its own
phone-keypad key order (`1 2 3 / 4 5 6 / 7 8 9 / — 0 ⌫`) rather than
being swapped to `VirtualNumpad`, since changing key order on the
cashier's very first, highest-frequency screen carries more regression
risk than the touch-target win justifies this close to launch — it
only got the `h-16 w-16` circular sizing bump, not a component swap.

## 7. Testing

`tests/VirtualNumpad.test.ts` (new, 8 tests) mounts the component with
`react-dom/client` directly and drives it with real `button.click()`
calls, matching this project's existing "inject the real thing, mock
only I/O" style (`useBarcodeScanner.test.ts`). Covers: digit append,
single decimal point (and rejecting a second one), `allowDecimal`
disabling the decimal key, backspace, Clear, and the conditional
rendering/firing of the Enter key.

No other test file needed changes — this phase only touched
`className` strings, JSX icon markup, and one `EmptyState` prop shape
(`icon: string` → `icon: ReactNode`), and no existing test asserted on
any of those. `requireAdminPin.test.ts` (Phase 14) already covers the
three cases Task 6 of the brief asked for — a valid admin PIN
succeeding, a valid cashier PIN being rejected, and an unknown
`managerId` being rejected — so it was left unchanged.

## 8. Verification

- `npm run typecheck` — clean (both `node` and `web` projects).
- `npm test` — 399/399 passing across 34 files (391 pre-existing +
  8 new `VirtualNumpad` tests).
