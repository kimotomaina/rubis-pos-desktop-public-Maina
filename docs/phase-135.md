# Phase 135 — POS usability overhaul, Phase A: audit

- **Date:** 2026-09-25
- **Requested:** A read-only audit before a five-phase renderer usability overhaul: one light theme on every screen, paired setup fields with on-screen keyboard/keypad, a 3×3 paginated location picker, and a no-page-scroll layout that scales across 1366×768 to 2560×1440 at 100–150% Windows scaling.
- **Outcome:** No change needed (audit only). Six findings contradict the brief's premises and need a decision before Phase B (see §0).
- **Branch / base commit:** staging @ 34132a6
- **Previous:** [phase-134](./phase-134.md)

Working tree at the start: `resources/logos/logo-rubis.png` deleted, and `resources/logos/logo-rubis.jpg` and `logo-rubis1.png` untracked. These are not my changes. They are left alone and are not part of this commit.

Tripwire baseline on this commit: `fiscalEngine`, `fiscalRouting`, `mpesaPaymentGate`, `VirtualNumpad`, `VirtualKeyboard` and `keyboardStore` tests all pass (6 files, 79 tests).

## 0. Decisions needed before Phase B

| # | Brief assumes | Code says | Recommended default |
| --- | --- | --- | --- |
| D1 | The logged-in theme is red `#E31A37`, white, black and Quicksand. | The logged-in UI uses Tailwind v4's built-in `rose-600` as its primary colour (316 `rose-*` uses in 30 files), `slate-*` neutrals, and the default system font (Segoe UI on Windows). `#E31A37`, Quicksand, `@theme` and `dark:` appear nowhere in the repo. | Add brand tokens in `index.css` `@theme` and point `rose-600`/`rose-700` and `font-sans` at them. The logged-in screens then change colour and font too: one theme everywhere, with no edits to 316 class names. |
| D2 | Quicksand is available. | There is no font file, and the CSP (`default-src 'self'`, with no `font-src`) blocks Google Fonts. Tills may also be offline. | Commit the Quicksand woff2 files (SIL OFL) under `src/renderer/src/assets/fonts/`. That adds no npm dependency, where `@fontsource/quicksand` would. |
| D3 | `VirtualKeyboard` can serve the server address, store URL, token and password. | It has uppercase A–Z, 0–9 and space only. It cannot type `http://localhost:4444/`, `my-store.myshopify.com`, `shpat_…` or a mixed-case password. | Add an opt-in layout (lowercase and shift, plus a `. : / - _ @` row), selected through a new optional `KeyboardRequest` field. The default layout stays exactly as it is, so `VirtualKeyboard.test.ts` passes unmodified. |
| D4 | `VirtualNumpad`'s `allowDecimal` covers IP entry. | `appendKey` rejects a second `.`, so `192.168.1.50` cannot be typed. `VirtualNumpad` is also inline-only, with no overlay host. | Add an opt-in multi-dot mode as a new prop, with the default unchanged. Let `VirtualKeyboardModal` host `VirtualNumpad` for numeric requests, so there is still one overlay and no third keyboard. |
| D5 | Location paging matters beyond 9 locations. | Shopify is queried with `locations(first: 10)` ([shopify.ts:118](../src/main/services/shopify.ts#L118)), so at most 10 locations ever reach the renderer and more are silently dropped. How many a real Rubis account has cannot be read from code. | Tell me the real count. If it is above 10, raising the cap is a main-process query change outside this brief and needs your go-ahead. Phase D paginates whatever arrives either way. |
| D6 | The layout can reach 1366×768 at 125% and 150% by CSS alone. | `BrowserWindow` sets `minWidth: 1024, minHeight: 768` DIP ([window-factory.ts:70-71](../src/main/window-factory.ts#L70-L71)). At 1366×768 the work area is ≈ 1366×689 at 100%, 1093×614 at 125% and 911×512 at 150%, all below the minimum. Windows likely makes the window taller than the screen, pushing the bottom off-screen whatever the CSS does. This needs to be seen on a real screen. | Allow a one-line main-process change: lower the minimums to `minWidth: 900, minHeight: 500`. Otherwise drop 1366×768 at 125%/150% from the Phase E matrix. |

Two smaller points:

- The brief lists "store name" and "staff name" as setup fields. No pre-login screen has either. Onboarding asks for the store URL and the Admin API token, and staff name exists only in Admin (post-login). The field table in §2 reflects the real fields.
- The on-screen keyboard is mounted only inside the logged-in shell ([App.tsx:583](../src/renderer/src/App.tsx#L583)). Every pre-login screen returns early, so `keyboardStore.open()` currently does nothing there. `EtimsSetupGate` is `z-[100]`, which is above the keyboard's `z-[60]`, so the keyboard would render behind it. Phase C has to fix both.

## 1. Theme inventory

**Where dark comes from:** hard-coded Tailwind utilities in each component. There is no stylesheet or `dark:` variant: [index.css](../src/renderer/src/index.css) is `@import "tailwindcss"` plus `html { font-size: 16px }`. Two more dark sources sit outside the components:

- `backgroundColor: '#0f172a'` in [window-factory.ts:80](../src/main/window-factory.ts#L80), which is main-process. It flashes slate-900 before first paint.
- The loading placeholder `bg-slate-900` at [App.tsx:322](../src/renderer/src/App.tsx#L322).

| Screen | File | Theme today |
| --- | --- | --- |
| Config loading placeholder | App.tsx:322 | dark (`bg-slate-900`) |
| First-run config (Onboarding) | OnboardingScreen.tsx | dark: `bg-slate-900` page, `bg-slate-800` card, `bg-slate-900` inputs, `bg-rose-950` errors |
| Location list (inside Onboarding/Confirm/Admin) | LocationPicker.tsx | dark: `bg-emerald-950` "Connected", `bg-slate-900` rows, `bg-rose-950/40` selected |
| Login | LoginScreen.tsx | dark: `bg-slate-800` staff tiles and keypad, `bg-slate-700` empty PIN dots |
| Location confirmation (admin) | LocationConfirmScreen.tsx | dark, same as Onboarding |
| Location pending (cashier) | LocationPendingScreen.tsx | dark, same as Onboarding |
| Fiscal setup gate | EtimsSetupGate.tsx | dark: `bg-slate-900`/`800`, `bg-amber-500/20 text-amber-400` icon |
| Manager PIN (over Location confirmation) | ManagerPinModal.tsx | already light |

**Forbidden tokens for the Phase B guard** (found on the pre-login files above): `bg-slate-700`, `bg-slate-800`, `bg-slate-900`, `hover:bg-slate-600`, `hover:bg-slate-700`, `border-slate-600`, `placeholder-slate-500`, `bg-rose-950`, `bg-emerald-950`, `text-rose-300`, `text-emerald-300`, `ring-rose-900`, `text-amber-400`, `text-slate-300`, `hover:text-slate-200`. The guard should not ban `text-white` outright, because red buttons use it legitimately.

**Logged-in theme tokens:** none as a module. They are implicit Tailwind defaults:

- white/`slate-50` surfaces
- `slate-900` text
- `rose-600` primary and `rose-700` hover
- `rose-100` active-tab chip
- `slate-200` borders
- system sans font
- Tailwind's rem spacing (`--spacing: 0.25rem`)

## 2. Setup-screen field inventory (pre-login)

| Screen | Field | `<input>` today | Helper text under field | Validation message | Input aid today | Proposed aid |
| --- | --- | --- | --- | --- | --- | --- |
| Onboarding, step 1 | Shopify Store URL | `text`, `autoFocus` | none (placeholder only) | shared: "Enter both the store URL and the Admin API token", plus IPC error | none | full keyboard, text layout (D3) |
| Onboarding, step 1 | Admin API Access Token | `password` | none | shared (above) | none | full keyboard, text layout (D3) |
| Login | Staff tile to PIN | its own 3×4 keypad (not `VirtualNumpad`), plus a physical keyboard listener | none | `loginError` | built-in keypad | keep as is: it already is the numeric pad; swapping it would restyle only |
| Location confirm | location radio | radio list | none | "Select a location" and the `location:set` error | n/a | Phase D cards |
| Location confirm, then Manager PIN | PIN | `password` + inline `VirtualNumpad allowDecimal={false}` | none | "Select a manager and enter their PIN" / "Incorrect PIN" | `VirtualNumpad` | unchanged |
| Location pending | none | none | none | none | none | none |
| eTIMS gate | Fiscal server address | `text`, `autoFocus` | "Already set for this till. Only change it if…" | `baseUrl` error | none | full keyboard, text layout (D3) |
| eTIMS gate | Fiscal device IP | `text` | "The address of the control unit on the shop network." | `deviceIp` errors (empty / not an IP) | none | numeric pad with dots (D4) |
| eTIMS gate | Fiscal device port | `text inputMode=numeric` | "Usually 8000." | `devicePort` errors (empty / range) | none | numeric pad, no dot |
| eTIMS gate | Fiscal device password | `password` | "The password set on the control unit…" | none (only disables Save while empty) | none | full keyboard, text layout (D3) |

**Paired layout:**

- Onboarding: one row, store URL and token side by side.
- eTIMS gate: two rows, server address with IP, then port with password.

The onboarding subtitle under the heading is not field helper text and stays. So does LocationPicker's "Only one location exists" status line.

**Post-login aids already in place (unchanged):**

- Amount tendered: inline `VirtualNumpad` ([PosCheckoutPanel.tsx:320](../src/renderer/src/components/PosCheckoutPanel.tsx#L320)).
- Company name and KRA PIN: `keyboardStore.open()` ([PosCheckoutPanel.tsx:161-183](../src/renderer/src/components/PosCheckoutPanel.tsx#L161-L183)).
- FiscalNotice and NeedsAttention PIN correction: `keyboardStore.open()`.

**The old one-letter bug:** `keyboardStore.open()` wraps `onChange` in a relay that writes each keystroke back into `request.value` ([keyboardStore.ts:51-55](../src/renderer/src/stores/keyboardStore.ts#L51-L55)). Any new pre-login field must open through the store, never by handing a static `value` to `VirtualKeyboard` directly. Phase C's accumulation test covers this.

## 3. Location picker

- **Listing:** `location:list` ([main/index.ts:1921](../src/main/index.ts#L1921)) calls `validateAndFetchLocations`. That runs `VALIDATE_STORE_QUERY` with `locations(first: 10)` (D5). Onboarding gets the same list from `config:validate`.
- **Consumers of `LocationPicker`:** OnboardingScreen, LocationConfirmScreen and AdminScreen's Change Location, so Phase D changes all three. Its props are `{ shopName, locations, selectedLocationId, onSelect, onConfirm, confirming, confirmError, confirmLabel, onBack? }`.
- **Saving:**
  - Onboarding saves through `saveConfig` (`config:save`). This is first run, before any staff exist, so it has no PIN.
  - LocationConfirmScreen and AdminScreen go through `requestManagerPin`, then `setLocation`, which is `location:set` → `requireAdminPin`. On a change, that handler clears the product cache.
- **Phase D changes presentation only:** radio rows become 3-column cards, paged 9 at a time, with `onSelect` untouched. The card containers are `max-w-md` (448 px), which is too narrow for 3 columns, so those screens widen.

## 4. Why the logged-in page shows a horizontal and a vertical scrollbar

1. **The header is the horizontal overflow.** [App.tsx:371-466](../src/renderer/src/App.tsx#L371-L466) is a `flex justify-between` row. Both groups, and every badge inside them, are `shrink-0`. There is no wrap and no overflow control. Estimated minimum widths:

   | Part | Contents | Width |
   | --- | --- | --- |
   | Left group | logo ≈ 95 + three `px-6 text-lg` tabs ≈ 360 + gaps | ≈ 490 px |
   | Right group | name/role/log-out ≈ 230, Online pill ≈ 90 ("Offline — sales will queue" ≈ 230), unfiled badge ≈ 120, four connectivity pills ≈ 395, `font-mono` clock ≈ 110, gaps ≈ 80 | ≈ 1,025 px online (≈ 1,165 offline) |
   | Header total | both groups plus padding | **≈ 1,560 px online, ≈ 1,700 offline** |

   Any CSS viewport narrower than that overflows. That covers 1366 at 100%, 1920 at 125% (1536) and 150% (1280), and 2560 at 150% (1707) when offline.
2. **The root does not clip.** The shell `flex h-screen flex-col` ([App.tsx:368](../src/renderer/src/App.tsx#L368)) has no `overflow-hidden`, and neither do `html` or `body`. The header's overflow therefore becomes a document-level horizontal scrollbar.
3. **The horizontal scrollbar causes the vertical one.** It takes about 17 px of viewport height, so the `100vh` shell no longer fits and a vertical page scrollbar appears. Fixing the header removes both.
4. **The numpad does not cause page scroll,** but it hides Complete Sale. The checkout panel's body is `flex-1 overflow-y-auto` ([PosCheckoutPanel.tsx:279](../src/renderer/src/components/PosCheckoutPanel.tsx#L279)), so it scrolls inside the panel. Its content is about 845 px tall: customer row 61, total block 94, then method toggles, amount, change, a 5-row numpad of 352, and an 80 px Complete Sale button.

   At 1366×768 and 100%, the space below the header is about 609 px, so Complete Sale sits about 240 px below the panel fold.
5. **Below `lg` (1024 CSS px) the layout stacks,** as at 1366 and 150% (911 px). The `aside` is `w-full shrink-0` with that 845 px of content, the cart `section` is squeezed to 0, and `main`'s `overflow-hidden` clips Complete Sale entirely.
6. **The Orders and Admin views** scroll inside `main` (`flex-1 overflow-y-auto`). That is correct and not a page scroll.

The pixel figures are estimates from the class values and need confirming with DevTools on the till. The mechanism in items 1–3 does not depend on them.

## 5. Sizing today

- Everything is Tailwind's rem scale: spacing is `calc(var(--spacing) * n)` with `--spacing: 0.25rem`, and type sizes are rem. `html` is fixed at 16 px ([index.css:8-10](../src/renderer/src/index.css#L8-L10)), and phase-16 set 16 px as the text floor.
- Phase-16/17 set the touch sizes: keys `h-16`, action buttons `h-14`, cart buttons `h-11 w-11` (the 44 px floor), Complete Sale `h-20`. Those were set for a 15-inch 1080p screen.
- There is no viewport-based scaling at all.
- Fixed widths that matter: `lg:w-[65%]`/`lg:w-[35%]` (percentages, fine), `w-80` toasts (rem), and `min-w-[75vw]` on VariantModal and ZReportModal (viewport-relative, fine). No component sets a px width above 1366.

**Implication for Phase E:** the root font size is already the single lever. Setting `html { font-size }` from a clamped `--scale` scales type, spacing, the numpad and cards together.

There is a tension. Phase-16's 16 px floor means scaling can only grow the UI above 16 px on large screens. It cannot shrink below 16 px to fit 1366×768, so the smallest viewport has to fit by layout:

- a condensed or wrapping header
- a shorter numpad and checkout stack

Windows scaling reaches CSS as a smaller `innerWidth`/`innerHeight`, so `computeScale` takes CSS pixels. The 9-cell matrix is really these viewports:

| Screen | 100% | 125% | 150% |
| --- | --- | --- | --- |
| 1366×768 | 1366×768 | 1093×614 | 911×512 |
| 1920×1080 | 1920×1080 | 1536×864 | 1280×720 |
| 2560×1440 | 2560×1440 | 2048×1152 | 1707×960 |

These are screen sizes. Subtract the taskbar and title bar when the window is maximized.

## 6. Existing UI test patterns

- **Real mount:** `react-dom/client` `createRoot` plus `act` plus DOM `.click()`, found by `textContent` or `aria-label`, under jsdom ([vite.config.ts](../vite.config.ts), with `tests/setup.ts` setting `IS_REACT_ACT_ENVIRONMENT`). There is no @testing-library. `window.api` is stubbed per test (NeedsAttentionPage.test.ts), and `useKeyboardStore.setState({ request: null })` runs in `beforeEach`.
- **Grep guard:** stockTakeGuard.test.ts walks `src/**/*.ts(x)` with `readdirSync`, checks for forbidden strings against an allow-list, and asserts that the allow-list's files still exist.
- **Unit-testable:**
  - class and token presence
  - DOM structure (paired grid rows, card counts, page buttons)
  - which aid opens on focus (the store's request and its mode)
  - multi-key accumulation, validation text, and Save calling the stubbed IPC
  - `paginateLocations`, `computeScale`, and the tokens file's values
- **Human-only** (jsdom has no layout, paint or fonts):
  - the real colours and the Quicksand rendering
  - no scrollbars
  - the keyboard overlay not covering Save/Continue (a test can assert the structure behind that rule but not the geometry)
  - touch-target reachability
  - the 9-viewport matrix
  - how the window sits at each Windows scaling

## 7. Plan per phase, assuming the recommended defaults in §0

| Phase | Commit | Files | Tests |
| --- | --- | --- | --- |
| B: one theme | 1 | `index.css` (`@theme` brand tokens, Quicksand `@font-face`), a new fonts asset folder, the 6 pre-login components and App.tsx:322 changed to light classes; `window-factory.ts` `backgroundColor` if D6 allows main-process edits | pre-login guard (tokens in §1); tokens test (reads `index.css`: `#E31A37`, `#FFFFFF`, `#000000`, Quicksand); mount tests per pre-login screen for the shared root class |
| C: setup screens | 1 | `keyboardStore.ts` (optional `mode` on the request), `VirtualKeyboard.tsx` (opt-in text layout), `VirtualNumpad.tsx` (opt-in multi-dot), `VirtualKeyboardModal.tsx` (hosts the numpad for numeric modes; z-index above the gate; sheet anchored to the bottom, form padded so Save stays visible), OnboardingScreen and EtimsSetupGate (2-column grid, helper text removed, `readOnly` + open-on-focus), App.tsx (mount the modal on pre-login returns) | per-field aid mode, accumulation, no helper text, errors still render, grid rows, Save with valid input; the tripwires stay unmodified |
| D: location cards | 1 | new `lib/paginate.ts`, LocationPicker.tsx, wider containers in Onboarding and LocationConfirm | pure pagination tests (0/1/9/10/27, bounds, order); mount test (10 locations → 9 + 1, a click calls `onSelect`, then the existing set path) |
| E: no page scroll and scaling | 1, then version bump and rebuild | new `lib/scale.ts` (`computeScale`), a root `--scale` in `index.css`, a resize hook in App, App.tsx shell `overflow-hidden` plus a condensed header, a tighter PosCheckoutPanel stack; `window-factory.ts` minimums if D6 allows | `computeScale` (monotonic, clamped, exact values at the 9 viewports); shell mount (no-scroll classes; the cart and checkout panes are the only `overflow-y-auto`); post-login guard (no page-level overflow, no px width above 911) |

## 8. Changes made

None to code. This report is the only file added.

## 9. Rollback

`git revert <this commit>`, which removes the report only.

## 10. Observed but not changed

- The M-Pesa phone field ([PaymentModal.tsx:468](../src/renderer/src/components/PaymentModal.tsx#L468)) and the price and discount editors (CartLineItem, PosCheckoutPanel's discount) have no on-screen aid. They are outside this brief's field list.
- `DEFAULT_ADMIN_PIN = '1234'` is seeded on first run ([main/index.ts:204](../src/main/index.ts#L204)). This is known and documented, and noted here only because the login screen is in scope.
- The `EtimsSetupGate` password has no field-level error. Save just stays disabled while it is empty.
