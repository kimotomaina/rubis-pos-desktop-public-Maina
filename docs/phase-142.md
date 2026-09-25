# Phase 142 — POS usability overhaul, Phase E: audit (why pages scroll, and how to make every screen fit)

- **Date:** 2026-09-25
- **Requested:** Read-only audit before Phase E: measure the real app's overflow on every screen across the 9 supported viewport cases, map how each screen sizes, compare scaling mechanisms, inventory the lists that need pagination, and plan the build. New requirements recorded: **no scrolling anywhere** (pre- and post-login, modals and keyboard included), fit by **scaling**, the phase-16 16px text floor **removed** in favour of a physical-pixel minimum, and long lists **paginated**.
- **Outcome:** No change needed (audit only). The user's three-scrollbar case is reproduced pixel-for-pixel (§2), every screen is measured (§3), and the recommendation is Electron's zoom factor driven from the main process (§6), with the E1–E5 plan in §8.
- **Branch / base commit:** staging @ f4b2844
- **Previous:** [phase-141](./phase-141.md)

**Phase-16 reversal, recorded as instructed:** phase-16 set 16px as the floor for on-screen text and sized everything up from it. That floor is what makes 1366×768 unfittable by shrinking, so it is now removed. The new minimum is physical: **CSS size × devicePixelRatio × zoom**, with a target of at least ~9mm for touch targets. §6 shows every numpad key stays at 61–64 physical pixels (~16mm on a 15.6" 1366×768 panel) at the smallest supported case, so removing the floor does not make anything untouchable.

## 1. Method — the real built app, driven over CDP

Following the phase-91/94 pattern: the **built** app (`out/`, the same bundles `electron-builder` packages) was launched with `--remote-debugging-port=9222` and driven over Chrome DevTools Protocol with Node 24's built-in WebSocket — no dependency added, no code changed.

- **A scratch `APPDATA`** held a byte-copy of the real dev database (which turned out to be nearly fresh: one seeded Admin, zero orders, location confirmed to *Enjoy Haile Selassie*), so every write during the walk — confirming the location, saving a dummy fiscal config — landed in scratch and the real userData was never touched. A second launch with the store-URL env var blanked produced the Onboarding screen. All measurement scripts lived in the session scratchpad, outside the repo, and were deleted afterwards; the app processes were killed at the end.
- **Live against the real store.** The location-confirm screen fetched and paged the real ~106 Rubis locations (phase-141 working in production conditions); the catalog fetched real products scoped to *Enjoy Haile Selassie*. No sale was completed, no STK push sent, nothing voided.
- **Per screen, per case:** `Emulation.setDeviceMetricsOverride` to the case's CSS viewport, then `document.documentElement` scroll-vs-client sizes (page overflow), a census of every element whose computed overflow is `auto`/`scroll` and whose content exceeds its box (inner scrollers), a count of elements extending past the viewport, and a screenshot. 194 screenshots were captured; six key ones are committed under [phase-142-shots/](./phase-142-shots/).
- **Two honest limitations.** (a) Changing `deviceScaleFactor` live wedges this headful Electron's compositor (frames stop; screenshots hang), so overrides ran with the machine's own dpr (1.5) and each case's physical sizes are arithmetic (CSS × the case's dpr) — CSS layout, which is what overflow depends on, is exact. (b) The wedge still struck occasionally between overrides; a `Page.reload` heals it, which cost a re-login mid-walk and left three small gaps (below), covered by static analysis.
- **Not measured live:** LocationPendingScreen (one static `max-w-md` card, nothing can overflow), VariantModal (the location's catalog has no multi-variant product), ZReportModal (behind the shift-close flow; `min-h-[75vh] min-w-[75vw]` from code), a 3-toast stack and FiscalNotice (need real fiscal events; ToastStack is `fixed w-80 top-4 max-h-[70vh] overflow-y-auto` — it scrolls internally by design, which the no-scroll rule must revisit), and the M-Pesa manual-entry tab (only appears after an STK attempt). The onboarding "closed" sweep was contaminated — a reload restores focus, and focus opens the docked keyboard — so its closed-state numbers are derived (content 905 − sheet 496 = 409px, which fits everywhere); the keyboard-open numbers are measured.

This machine's own display is 1280×800 CSS at dpr 1.5 with a maximized content box of 1280×730 — within 10px of the reported case.

## 2. The reported bug, reproduced exactly

At **1920×1080 @ 150% (1280×720 CSS)**, catalog view, cart with items, Cash selected — [pos-1280x720-the-reported-bug.jpg](./phase-142-shots/pos-1280x720-the-reported-bug.jpg):

- **Horizontal page scrollbar** — page content is 1331px wide against a 1280px viewport (x+51).
- **Vertical page scrollbar** — that horizontal scrollbar eats 15px of height, so the `h-screen` shell no longer fits (y+15). The 15px cascade appears in every overflowing case, confirming the phase-135 §4 mechanism.
- **Inner scrollbar on the checkout panel** — the panel body holds 692px of content in 483px of space.
- **Numpad cut mid-row and COMPLETE SALE invisible** — the button sits at 833–913px from the top of the panel's content, 193px below the fold at this height. Rects measured: Complete Sale `h=80` CSS at top 833; a numpad key `h=64`.

**The magic number is 1331px:** the page's minimum content width, measured identically at 1093, 1280 and 911-wide viewports. It is the header — logo 32+95, three nav tabs, user name + role chip + Log Out, Online pill, "All sales filed", four connectivity pills, clock, gaps and padding, every one `shrink-0`, no wrap, no clip. Anything narrower than 1331 gets the horizontal scrollbar, and the vertical one follows. 1366@100 fits with 35px of slack ([pos-1366x768-fits-width.jpg](./phase-142-shots/pos-1366x768-fits-width.jpg)) — but only while **online**: the offline pill ("Offline — sales will queue") is ~140px wider than "Online", so 1366 overflows the moment the network drops. My phase-135 estimate (~1560) was too pessimistic; the truth is 1331 online / ~1470 offline.

Below the `lg` breakpoint (1024px), the layout stacks and gets worse: at **911×512** ([pos-911x512-stacked-collapse.jpg](./phase-142-shots/pos-911x512-stacked-collapse.jpg)) the checkout panel takes the full width and the **cart, search bar and catalog are invisible** — the cart body measures 0px. A cashier cannot see what they are selling.

## 3. The overflow matrix

Page overflow is `x+/y+` beyond the viewport; "panel" = an inner scroll container with content→box heights. The full per-case JSON is summarised here; every number below is measured, not estimated.

| Screen | 1366×768 @100 | 1093×614 @125 | 911×512 @150 | 1920×1080 @100 | 1536×864 @125 | 1280×720 @150 | 2560×1440 @100 | 2048×1152 @125 | 1707×960 @150 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Login (tiles, and PIN pad) | fits | fits | **y+32, clipped** | fits | fits | fits | fits | fits | fits |
| Onboarding step 1 (keyboard closed, derived) | fits | fits | fits | fits | fits | fits | fits | fits | fits |
| Onboarding + docked keyboard | scrolls 768→905 | 614→905 | **y+16 + scrolls** | fits | 864→905 | 720→905 | fits | fits | fits |
| Location confirm (9 cards, real 106 locations) | fits (676 content) | scrolls 614→676 | scrolls 512→625 | fits | fits | scrolls 720→729 | fits | fits | fits |
| Manager PIN modal | fits | scrolls, 7 clipped | scrolls, **11 clipped** | fits | fits | scrolls, 1 clipped | fits | fits | fits |
| eTIMS gate (closed) | fits | fits | fits | fits | fits | fits | fits | fits | fits |
| eTIMS gate + docked keys (both sets) | scrolls 768→905 | 614→905 | 528→905 | fits | 864→905 | 720→905 | fits | fits | fits |
| POS, Cash (any cart) | panel 531→692 | **x+238 y+15**, panel 377→692 | **x+420 y+15, cart 0px** | fits entirely | x+0, panel 627→692 | **x+51 y+15**, panel 483→692 | fits | fits | fits |
| POS, M-Pesa (STK) | fits (panel 439) | x+238 y+15, panel 377→439 | x+420 y+15, cart 0px | fits | fits | x+51 y+15 | fits | fits | fits |
| Keyboard modal (caps, logged-in) | adds nothing; panel as above | as POS | as POS | fits | as POS | as POS | fits | fits | panel 651→692 |
| Orders (empty) | fits | x+238 y+15 | x+420 y+15 | fits | fits | x+51 y+15 | fits | fits | fits |
| Admin — every tab | **main always scrolls +44** | +44 and worse | +44 and worse | **+44** | +44 | +44 | +44 | +44 | +44 |
| Admin → Integrations | main 688→**2241** | 534→2373 | 432→2529 | 1000→**2193** | 784→2217 | 640→2241 | 1360→2193 | 1072→2193 | 880→2217 |
| Admin → Stock Take / Peripherals / System / Needs Attention / Reconciliation | +44 | up to 534→623 | up to 432→736 | +44 | +44 | +44 | +44 | +44 | +44 |

Key readings:

- **Nothing is wrong at 2560×1440 or at 1920×1080@100** except Admin's constant +44 — the app was implicitly designed for ≥1366 CSS width and ≥1000 CSS height.
- **The POS checkout stack (Cash) is 692px tall** (customer row 61 + total 94 + toggles + amount + change + numpad 352 + Complete Sale 80 + paddings). Below ~772px of viewport it scrolls; Complete Sale is the last thing in it, so it is the thing that vanishes. The M-Pesa panel is 439px and fits at 768.
- **Admin's +44 constant:** `main` (`flex-1 overflow-y-auto p-6`) always holds 44px more than it shows — the "Admin" `h2` + margin sits inside the scroller, so every Admin tab starts fractionally scrollable at every size. A trivial E2 fix.
- **Admin → Integrations is 2,193–2,529px tall** — Shopify creds, location picker, eTIMS device form, M-Pesa and printer settings stacked in one column ([admin-integrations-1280x720.jpg](./phase-142-shots/admin-integrations-1280x720.jpg)). No uniform scale fixes a 2.2k-px column; it needs sections/pagination (E4).
- **The docked keyboard sheet makes setup screens 905px tall** (form 409 + `pb-keyboard-sheet` 496) — scrolls at 5 of 9 cases, and the sheet visually covers the form's own fields ([onboarding-docked-keyboard.jpg](./phase-142-shots/onboarding-docked-keyboard.jpg)); the sheet's echo field (phase-139) is what keeps typing visible. Even scaled to the design box, 905 > 768: **the sheet needs a layout change (E2), not just scaling.**
- **The location picker's safety net works**: no page overflow anywhere; below 768px height it scrolls inside the screen root exactly as phase-141 designed ([location-confirm-1366x768.jpg](./phase-142-shots/location-confirm-1366x768.jpg) — 676px content, my 684 estimate was 8px off). Under the new no-scroll rule, those scroll cases become E2/E4 work (fewer rows per page at small heights).
- **The Manager PIN modal has no internal scroll** and its ~625px card clips at 512/614-high viewports — 11 elements (including Authorize) unreachable at 911×512.
- **Login's card clips 32px at 911×512** with no scroll fallback — the Enter button's bottom is cut.

## 4. Layout maps — what drives what

**App shell (logged in):** `div.app-theme.flex.h-screen.flex-col` (no `overflow-hidden`) → optional demo banner → `header` (`h-20 shrink-0`, flex `justify-between`, every child `shrink-0`, min content 1331px online) → `main flex-1 overflow-hidden lg:flex-row` (catalog) or `main flex-1 overflow-y-auto p-6` (Orders/Admin). Nothing clips the header's overflow, so it becomes the document's.

- **Header items** (all `shrink-0`, none can wrap or hide): logo `h-9` (rem), 3 tabs `h-14 px-6 text-lg`, name + role chip + Log Out, Online/Offline pill (state-dependent width!), UnfiledSalesBadge, 4 connectivity pills, `font-mono` clock. Everything rem-sized; borders 1px.
- **Catalog split:** `section` (search + cart table) `flex-1 min-h-0 overflow-hidden lg:w-[65%]`; `aside` checkout `w-full shrink-0 lg:w-[35%]`. Below `lg` (1024) they stack; `aside` is unconstrained in height and squeezes the `section` to zero — the 911×512 collapse.
- **Checkout stack (692px):** customer row → total block → `div.flex-1.overflow-y-auto.p-4` holding method toggles (`h-16`), amount display, change row, `VirtualNumpad` (4×`h-16` rows + 2-key row, `gap-2` → 352px), `COMPLETE SALE h-20`. The panel's scroller is the *designed* overflow home; the button lives inside it.
- **Cart table:** `div.flex-1.overflow-y-auto` + sticky `thead`; rows measured 72.3px.
- **Overlays:** keyboard modal `fixed inset-0 z-[60]` bottom-anchored `max-w-2xl` (caps ≈ 430px tall with echo); docked sheet `fixed bottom-0 z-110 h-keyboard-sheet` (496px) with `pb-keyboard-sheet` reserved by the setup screens; ManagerPinModal `fixed inset-0 z-[60] items-center max-w-sm` (~625px, no internal scroll); modals (Variant/ZReport `min-h-[75vh] min-w-[75vw] max-h-[90vh]`, internal scroll); ToastStack `fixed top-4 w-80 max-h-[70vh] overflow-y-auto z-50`.
- **Pre-login screens:** each its own `app-theme h-screen` root; Onboarding and eTIMS gate reserve the sheet height when the keyboard is open and top-align; LocationConfirm has `overflow-y-auto`; Login and LocationPending have none.
- **Units:** effectively everything is Tailwind rem (spacing, text, `w-80`, `max-w-*`); the only px are 1px borders, the `min-w-[75vw]`/`vh` modal bounds, and `BrowserWindow` `minWidth: 1024, minHeight: 768` DIP (unchanged — D6's lowering was approved but deliberately deferred to Phase E, now E5).

## 5. The budget — a reference box, and what fails at scale 1

**Reference box: 1366×688** — the smallest supported screen (1366×768 @100%) minus Windows chrome measured on this machine (~48px taskbar + ~32px title bar at 100%; the app runs maximized, not fullscreen — F11 fullscreen would return the ~80px). The runtime never assumes these numbers: computeScale reads the window's real content bounds.

| Screen | Natural size at scale 1 (CSS) | Fits 1366×688? | If not, the responsible element |
| --- | --- | --- | --- |
| POS catalog, Cash | ≥1331 × (80 header + 692 panel = 772) | **No — 84px too tall** | the checkout stack; numpad 352 + Complete Sale 80 don't leave room above |
| POS catalog, M-Pesa | 1331 × 519 | yes | — |
| Header alone | 1331 (online) / ~1470 (offline) × 80 | width only just; **offline overflows** | every header item `shrink-0`, offline pill widest |
| Login, Location pending, eTIMS closed, Orders empty, keyboard modal caps | ≤ ~640 tall | yes | — |
| Onboarding / eTIMS + docked sheet | 905 tall | **No — 217px over** | `--spacing-keyboard-sheet: 31rem` (496px) stacked under the form |
| Location confirm (9 cards) | 676 tall | yes (12px slack) | — |
| Manager PIN modal | ~625 tall | yes | — (fails only below the reference) |
| Admin, any tab | content + 44 | **No — constant +44** | the `h2` inside the scroller |
| Admin Integrations | 2,193–2,529 tall | **No — 3.2×** | one column of six unrelated settings groups |
| Cart with N lines | 72.3px per row | table is a scroller by design | becomes E4 pagination |

**Conclusion:** four screens/regions fail at scale 1 and need layout work (E2/E4) before any scaling mechanism can deliver no-scroll: the checkout stack (−84px), the header (offline width), the docked sheet (−217px), and Admin (the +44 and the Integrations column). Everything else fits at scale 1 and therefore fits everywhere once scaled.

## 6. Scaling mechanism — comparison and recommendation

**(A) Root font-size scaling** (`html { font-size: 16px × s }` from a renderer `computeScale` hook): scales all rem values, i.e. essentially every Tailwind utility. Leaves 1px borders and the few `vh/vw` values alone (fine). But it needs a resize listener + store/CSS-var plumbing in the renderer, sub-pixel rem rounding shows at fractional scales, `w-screen/h-screen`-relative maths stay unscaled, and — decisive — **it cannot be computed from a value the scale itself doesn't change**, so the hook must be written carefully against `window.innerWidth` feedback.

**(B) Electron zoom factor** (`webContents.setZoomFactor(z)` from the **main process** on window `resize`): Chromium scales *everything* — rem, px borders, images, the lot — exactly like Windows display scaling itself does, which is the semantics this till wants: "the same screen, larger or smaller".

- **Feedback-loop safe:** `z = clamp(min(contentW/1366, contentH/688))` computed from `win.getContentBounds()` (DIP — unaffected by zoom), never from `innerWidth`. Setting zoom fires a renderer resize; nothing recomputes from it.
- **Keeps the most code untouched:** *zero renderer changes* for the mechanism itself — no hook, no CSS variable, no store. The renderer keeps thinking in its design box (post-zoom `innerWidth` ≈ 1366).
- **Survives monitor moves and live rescaling:** the main process recomputes on every `resize`/`move`; Windows DPI changes arrive as those events. CSP is untouched (no new sources); receipts/PDFs are main-process and never pass through the renderer's zoom; the docked sheet and toasts are ordinary fixed-position DOM and scale with everything else.
- **Interaction to verify in the build:** `Ctrl+wheel`/`Ctrl+±` user zoom must be pinned (Electron: `webContents.setVisualZoomLevelLimits(1,1)` is already default; keyboard zoom accelerators are not registered by this app).

**Recommendation: (B), zoom factor.** (A) remains the fallback if the build turns up an Electron quirk; the E1 pure function is identical either way.

**The resulting numbers** (`z = min(w/1366, h/688)` on estimated maximized content; physical px = CSS × z × dpr):

| Case | z | Numpad key 64css → physical | Complete Sale 80css → physical |
| --- | --- | --- | --- |
| 1366×768 @100 | 1.000 | **64px** | 80px |
| 1093×614 @125 | 0.799 | 64px | 80px |
| 911×512 @150 | **0.667** | **64px** | 80px |
| 1920×1080 @100 | 1.405 | 90px | 112px |
| 1536×864 @125 | 1.124 | 90px | 112px |
| 1280×720 @150 | 0.937 | 90px | 112px |
| 2560×1440 @100 | 1.874 | 120px | 150px |
| 2048×1152 @125 | 1.499 | 120px | 150px |
| 1707×960 @150 | 1.250 | 120px | 150px |

The physical size of every control is **identical across Windows scaling settings on the same panel** — 64px ≈ 16mm on a 15.6" 1366×768 screen, comfortably above the ~9mm/34px physical floor proposed to replace phase-16's 16px CSS floor. 1366×768 meets the minimum at every Windows scale.

## 7. Pagination inventory (E4)

`lib/paginate.ts` from Phase D (`paginate` + `pageOfIndex`, any page size) is reusable for every one of these. Page sizes assume the post-zoom design box (≈1366×688); each list keeps its region's height fixed and pages instead of scrolling.

| List | Where | Space at scale 1 | Proposed page size | Behaviour notes |
| --- | --- | --- | --- | --- |
| Cart lines | PosCartTable | ~608px below search ÷ 72.3 | **7** (with header row) | **the newest line must stay visible: on add, jump to the page holding it** (default per brief; confirm) — flashId already marks it |
| Product search dropdown | PosSearchBar | overlay | cap at 6 (already short; verify `getAutocompleteMatches` cap) | keyboard highlight must stay within page |
| Order History | OrderHistory | main region | 6–8 rows | newest first; unchanged selection |
| Needs Attention | NeedsAttentionPage | main region | 5 | resend actions per row keep working per page |
| M-Pesa logs / Reconciliation | pages | main region | 8–10 rows | read-only tables |
| Stock take lines | StockTakePage | 3 tables | 8 | **counting flow relies on scanning down a list — confirm with the user before paging this one** |
| Locations | LocationPicker | done in Phase D | 9 (3×3); drop to 6 (3×2) below ~610px content height | selection already survives paging |
| Admin Integrations | AdminScreen | 2.2k px column | not a list — **split into sub-tabs/sections** (one visible at a time) | settings groups are independent |
| Toast stack | ToastStack | `max-h-[70vh]` scroller | cap visible toasts at 3, queue the rest | phase-84 column semantics kept |

## 8. The plan — E1 to E5, one commit each, independently revertible

**Tripwires for every build commit** (unmodified and passing): fiscalEngine, fiscalRouting, mpesaPaymentGate, VirtualNumpad, VirtualKeyboard, keyboardStore, setupScreens, virtualKeyboardLayouts, keyboardEchoSubmit, preLoginThemeGuard, themeTokens, preLoginTheme. No fiscal, payment or sale-path logic changes anywhere in Phase E.

- **E1 — the scale mechanism.** New pure `src/main/lib/scale.ts`: `computeZoom(contentW, contentH)` = `clamp(min(w/1366, h/688), 0.5, 2.5)`; main process applies it on `ready-to-show`, `resize` and `move` via `webContents.setZoomFactor`. Tests: pure — monotonic in both axes, clamped, exact values for all 9 cases from §6 (and that it never reads renderer state). Rollback: revert; the app renders at zoom 1 as today.
- **E2 — layout fixes for the §5 failures.** (a) Header: allow shrink/truncate (`min-w-0`, hide the role chip and compress pills below a width), so its minimum ≤1331 and the offline pill cannot widen the page; (b) checkout stack: tighten to ≤608px (numpad rows `h-14`, Complete Sale `h-16`, smaller total block) so panel + header = 688; (c) docked keyboard sheet: shrink `--spacing-keyboard-sheet` to ≤ 279px-equivalent by compacting key rows (`h-10`/`h-11`) and the echo, so form 409 + sheet ≤ 688 with Save visible; (d) Admin: move the `h2` out of the scroller (+44), and stop `lg` stacking below 1024 (the zoom keeps the effective viewport ≥1366, so the stacked branch becomes unreachable — assert that instead of restyling it); (e) ManagerPinModal and Login: fit within 688 (they already do; add the guard). Tests: mount tests asserting the new heights/classes; the existing keyboard tests unmodified.
- **E3 — no-scroll shells.** Every screen root gets `overflow-hidden` (replacing LocationConfirm's `overflow-y-auto` safety net and Onboarding's, which E2 makes unnecessary); `html/body` overflow pinned; a grep-guard test (stockTakeGuard pattern) asserting no screen root re-introduces `overflow-y-auto`/`overflow-x-auto` at page level and no component uses a fixed px width > 900. Human + CDP check: re-run this audit's measurement (a scratch script, kept outside the repo) asserting **zero page overflow and zero unexpected scroll containers on every screen in all 9 cases**; the allowed scrollers list is empty after E4.
- **E4 — pagination** per §7, reusing `paginate`/`pageOfIndex`; per-list mount tests (page sizes, Prev/Next disabled at ends, cart jumps to the newest line's page, stock-take pending user confirmation). Admin Integrations becomes sections.
- **E5 — window minimums** (approved D6): `minWidth: 900, minHeight: 500` in `window-factory.ts`, and update `foundation.test.ts`'s `>= 1024/768` assertions (not a tripwire) to the new floor. Also set `backgroundColor` stays as is (done in phase-136).

Order matters: E1 alone already fixes 5 of the 9 cases end-to-end (everything whose only failure was scale); E2 makes the remaining fit at scale 1; E3 enforces; E4 removes the last legitimate scrollers; E5 lets the window itself go where the small cases need it.

## 9. Changes made

None to code. This report and the six screenshots under `docs/phase-142-shots/` are the only additions. The measurement scripts, the scratch userData clone and the remaining 188 screenshots lived in the session scratchpad outside the repo and were deleted; the app processes were terminated.

## 10. Rollback

`git revert <this commit>` (removes the report and screenshots only).

## 11. Observed but not changed

- **A live bug found while measuring:** reloading the renderer restores focus to the last-focused setup field, and focus opens the docked keyboard — so after a crash-restart on a setup screen the keyboard is already open. Harmless today (renderer reloads are rare), worth folding into E2's sheet rework.
- **The header renders "Admin Admin"** (staff name + nav tab) — cosmetic, visible in the screenshots.
- **The search dropdown at this location returns one product**; a 40-line cart could not be staged live. Cart row height (72.3px) and the table's designed scroller make the pagination maths in §7 exact regardless.
- **ConnectivityModal measurements were inconclusive** (the census showed no change after the open click); it is `fixed inset-0 z-50` with a small card and is covered by E3's guard anyway.
- The M-Pesa **manual-entry tab** appears only after an STK attempt and was not staged (no STK was sent).
