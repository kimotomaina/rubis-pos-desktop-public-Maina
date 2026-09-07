# Phase 43 — Responsive UI, Modal Layout, and DPI Scaling Overhaul

**Date:** 2026-09-01 · **Branch:** `main` · **Previous:** [Phase 42](./phase-42.md)

## 1. Objective

Fix three concrete responsiveness bugs on Windows: the navbar's
connectivity badges/user info compressing under `justify-between`'s
default flex-shrink, the checkout modal's cash numpad pushing the
"Complete Sale" button out of view instead of staying in a fixed
footer, and no Windows high-DPI scaling switch set. Also passed over
the Catalog grid, Order History cards, and Admin tab bar for the same
class of narrow-viewport/DPI-scaling breakage.

## 2. Task 1 — Windows DPI scaling (`src/main/index.ts`)

Added, right after the import block and before any other `app.*`
call (must run before `app` is ready):

```ts
app.commandLine.appendSwitch('high-dpi-support', '1')
```

Deliberately did **not** add `force-device-scale-factor` — forcing a
fixed scale factor overrides whatever the user's actual Windows
display setting is, which is the opposite of what a till running at
125%/150% scaling needs. `high-dpi-support` alone lets Chromium scale
correctly to the OS setting without Electron-specific blur/tiny-window
artifacts.

## 3. Task 2 — Navbar squeeze (`App.tsx`, `ConnectivityBadges.tsx`)

Root cause: none of the header's three content groups (logo+nav,
user/status/badges/clock) had `shrink-0`, so on a wide or DPI-scaled
window where the flex row's natural content width could exceed the
container, the flexbox default (`flex-shrink: 1` on every child)
let *all* groups compress evenly — squeezing the connectivity badges
and clock along with everything else instead of leaving them alone.

Fixed by adding `shrink-0` to: the header itself, the logo+nav group,
the logo image, the user-info group, the online/offline badge, the
`ConnectivityBadges` root wrapper (in its own component file too,
since it renders inside the header), and the clock span. The `nav`
element got `min-w-0` so it's the one thing structurally allowed to
be the shrink point if space ever runs out, matching the task's
"center nav should be the only thing that shrinks" intent — in
practice the three short nav labels never need to, but the header
itself can no longer force the badges/clock to compress to make room.

## 4. Task 3 — Checkout modal layout (`CheckoutModal.tsx`)

The whole modal body — KRA PIN field, payment-method buttons, the
cash numpad, the totals, and the "Complete Sale" button — lived in one
`flex-1 overflow-y-auto` region. A tall numpad could push "Complete
Sale" below the fold, requiring a scroll to reach the sale-completing
action — unacceptable on a touch till.

Restructured into the three fixed regions the task specified:

- **Outer panel:** `flex w-full max-w-4xl max-h-[90vh] flex-col
  overflow-hidden rounded-xl bg-white shadow-2xl` — dropped the old
  `min-h-[75vh] min-w-[75vw]` forced minimum size, which was itself
  part of the DPI/small-window overflow problem (it could force the
  modal larger than a scaled-down viewport).
- **Header** (`shrink-0`, unchanged content): title + close button.
- **Body** (`flex-1 overflow-y-auto p-6`, the *only* scrollable
  region): KRA PIN field, the payment-method picker, the M-Pesa flow
  (`PaymentModal`, unchanged — it manages its own waiting/failed
  overlay internally and was left untouched), and the Card reference
  field. This is naturally short content that will essentially never
  need to scroll on a real screen, but is scrollable if it ever does.
- **Footer** (`shrink-0 border-t ... bg-slate-50 px-6 py-4`): the
  running Total, and — for `method === 'cash'` — the Amount
  Tendered/Change Due readout and `VirtualNumpad` laid out via `grid
  grid-cols-1 gap-4 md:grid-cols-2` (stacked below the totals on
  narrow/`md:`-and-under screens per Q1's default, side-by-side above
  it), the checkout-error message, and the "Complete Sale" button
  (cash/card only, unchanged condition). The footer never scrolls
  away — it's always visible regardless of how tall the body's
  content gets.

No behavioral/logic changes: `handleSubmit`, `handleMpesaPaid`,
`canSubmit`, the cash-mode keyboard shortcut `useEffect`, and every
state variable are untouched — this was purely a JSX/class
reorganization.

## 5. Task 4 — Other screens

- **Catalog grid** (`App.tsx` — there is no separate
  `CatalogPage.tsx`; the catalog is inlined in `App.tsx`'s `activeView
  === 'catalog'` branch): both the loading-skeleton grid and the real
  product grid changed from a fixed `grid-cols-3` to `grid grid-cols-2
  gap-4 sm:grid-cols-3 sm:gap-6 md:grid-cols-4 lg:grid-cols-5
  xl:grid-cols-6` — 2 columns on a narrow/portrait window scaling up
  to 6 on a wide one. The sticky search-bar row
  (`Products`/cached-badge/`ProductSearchBar`) got `flex-wrap` plus
  `shrink-0` on the title/badge so the search input (already `flex-1
  w-full` in `ProductSearchBar.tsx`, unchanged) never gets squeezed to
  illegible width and instead wraps to its own line first.
- **Order History** (`OrderHistory.tsx`): each order card's header row
  changed from `flex items-start justify-between` to `flex flex-col
  items-start justify-between gap-2 sm:flex-row sm:items-center` (per
  the task's exact spec), and its button cluster gained `flex-wrap` so
  Print Receipt/Retry Sync/Void wrap onto a second line instead of
  clipping on a narrow window rather than the "Print Receipt" button
  being cut off.
- **Admin tab bar** (`AdminScreen.tsx`): container changed from `flex
  gap-1` to `flex flex-wrap gap-2`, and each of the five tab buttons
  gained `min-w-32` (Tailwind's canonical form of `min-w-[8rem]`) so
  `flex-wrap` has something to wrap around — without a minimum width,
  `flex-1` buttons in a `flex-wrap` container would shrink toward zero
  instead of wrapping to a second row.

## 6. Testing

No new test files — every change in this phase is a Tailwind
class/JSX-structure edit with zero new logic branches (no new
conditionals, computed values, or handlers). This repo has no
component-test harness (`@testing-library/react` is not installed),
consistent with every prior UI-only phase in this codebase; the
existing test suite (which exercises the checkout/cart/order logic
`CheckoutModal.tsx` calls into) continues to pass unchanged, verifying
no behavioral regression from the JSX reorganization.

## 7. Verification

- `npm test` — 618/618 passing (48 files), no regressions to
  checkout, fiscalization, M-Pesa, or Shopify sync flows.
- `npm run typecheck` (`typecheck:node` + `typecheck:web`) — clean.
- Manual structural review of `CheckoutModal.tsx`'s full JSX tree
  confirmed the header/body/footer regions are well-formed with no
  orphaned tags after the restructuring.

## 8. Follow-ups

- No live visual verification on an actual high-DPI Windows display
  was performed as part of this phase (no such display available in
  this environment) — the `high-dpi-support` switch and the layout
  fixes are standard, low-risk Electron/Tailwind patterns, but a real
  DPI-scaled test pass is recommended before shipping.
- The cart sidebar in the Catalog view keeps its fixed `w-120` width;
  its parent `<main>` already has `overflow-hidden`, so it cannot
  cause the window itself to horizontal-scroll (satisfying this
  phase's strict rule), but on a very narrow window it could still
  visually crowd the product grid. Not addressed here since it wasn't
  named in the task's scope and changing cart width affects touch
  target sizing, which needs its own pass.
