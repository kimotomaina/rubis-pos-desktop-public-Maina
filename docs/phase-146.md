# Phase 146 — Fix: the checkout panel fits 1366x772 with no inner scroll

- **Date:** 2026-09-26
- **Requested:** The POS screen still scrolled inside the checkout panel — the numpad's Clear row was cut and Complete Sale was hidden — because the 1366x772 reference box assumed the checkout stack needed 692px, when 692px was only the scroll body; the customer row and TOTAL block sit above it. Correct the phase-142 §5 / phase-143 §1 budget, keep the 772 box, and make the checkout aside actually fit it — layout only, no payment/checkout/numpad-input/sale-path logic changes.
- **Outcome:** Implemented
- **Branch / base commit:** staging @ a658946 (Phase 145)
- **Previous:** [phase-145](./phase-145.md)

## 1. Measure first (Step 1)

Before changing anything, this step needed a way to measure the real, built app's layout at zoom 1 in the 1366x772 box — `jsdom` cannot compute real layout, and a live CDP walkthrough was the tool this whole effort has used since phase-142. Per the instruction to route around the phase-144 incident, **the E3 fit-check script was built first** (`scripts/check-fit.mjs`, `npm run check:fit` — see §4) and used for this measurement, so the measurement tool and the regression check are the same script.

**Measured breakdown** (built app, real window, header height confirmed unchanged at 80px):

| Region | Height (CSS px) |
| --- | --- |
| Header | 80 |
| Customer row (`border-b p-4`) | 57 |
| TOTAL block (`border-b bg-slate-50 p-4`) | 101 |
| Checkout scroll body — **visible** (`clientHeight`) | 542 (at the window measured) |
| Checkout scroll body — **natural** (`scrollHeight`) | 692 |
| **Measured overflow** | **150px**, identical in every one of the 9 supported cases (confirming the zoom invariant: the shortfall is a fixed CSS-space problem, not a per-display one) |

**The correction to phase-142 §5 / phase-143 §1:** both treated 692px as the *whole* checkout aside's natural height. It is only the scroll body's — the customer row (57) and TOTAL block (101) sit above it, so the aside's true natural height is **57 + 101 + 692 = 850px** (matching this step's own request framing of "~927px" once the 80px header is folded in: 80 + 850 ≈ 930, the small difference being rounding in the original estimate). Against the guaranteed-minimum budget (772 − 80 header = 692px available for the whole aside), the real shortfall at the tightest case is **850 − 692 = 158px**, not the 150px measured at the specific (slightly taller than minimum) window used for the live measurement above.

M-Pesa mode was never affected — `PaymentModal` is more compact than the Cash numpad flow and already fit.

## 2. Tightening (Step 2), in order, with each step's saving

| Step | Change | File | Saving |
| --- | --- | --- | --- |
| (a) | Merged the customer row into the TOTAL block's header line — "TOTAL" / "Walk-in · Add KRA PIN" (tap to edit) / "+ Discount" all on one row; the expanded company-name/KRA-PIN editor still renders in the same place when active | `PosCheckoutPanel.tsx` | 57+101=158px → 89px combined (**69px**) |
| (b) | TOTAL block padding `p-4`→`p-3`; total amount `text-4xl`→`text-3xl` | `PosCheckoutPanel.tsx` | folded into (a)'s combined 89px |
| (c) | Method toggles `h-16`→`h-14` | `PosCheckoutPanel.tsx` | 8px |
| (d) | Amount Tendered's label and display merged onto one row (label left, smaller display right, in a single pill); Change Due kept as its own compact row | `PosCheckoutPanel.tsx` | ~96px → ~44px (**52px**) |
| (e) | Numpad: new optional `size` prop on `VirtualNumpad` (`'default'` \| `'compact'`), default unchanged; `PosCheckoutPanel` passes `size="compact"` (`h-16`→`h-12` keys). Folding Clear into the digit grid was considered and skipped — 13 keys don't divide evenly into a 3-column grid without an uneven row, and the height saving from `h-12` alone was already sufficient | `VirtualNumpad.tsx`, `PosCheckoutPanel.tsx` | ~40px |
| (f) | Complete Sale `h-20`→`h-16` | `PosCheckoutPanel.tsx` | 16px |
| — | Scroll-body padding `p-4`→`p-2` and the toggle row's `mb-4`→`mb-2` (found, after (a)-(f), to still leave zero *measured* slack at the exact worst case — see §5's note on why `scrollHeight` alone understated the real margin) | `PosCheckoutPanel.tsx` | 12px, for comfortable margin |

Combined, the checkout body's real content need drops from 850px to comfortably under the 692px budget — confirmed empirically (§5), not just by arithmetic, since `getBoundingClientRect`/`scrollHeight` interactions with a `flex-1` sibling are easy to misread (see §5).

## 3. Remove the inner scroll (Step 3)

`PosCheckoutPanel`'s checkout body: `overflow-y-auto` → `overflow-hidden`. Complete Sale is now fully visible at zoom 1 in the 1366x772 box, in both Cash and M-Pesa, confirmed by `npm run check:fit` (§5) rather than assumed.

## 4. The committed fit-check script (`scripts/check-fit.mjs`, `npm run check:fit`)

Built ahead of the formal Phase E3 step (per this step's own instruction) since it was needed for measurement here. It drives the **built** app over CDP, exactly as the phase-142 audit did, and asserts zero page overflow and zero unexpected inner scroll containers, in both Cash and M-Pesa, for all 9 supported-display cases (reused verbatim from `tests/scale.test.ts`/`tests/belowLgUnreachable.test.ts`). It currently covers the POS/catalog screen only — the screen this fix needed — with an empty `SCROLL_ALLOW_LIST` ready for the rest of Phase E3 to extend to other screens.

**Two things had to be solved that weren't obvious going in:**

- **Electron's CDP has no `Browser.setWindowBounds`.** The original plan (resize one running window through all 9 cases, matching phase-142's method) failed silently — `Browser.getWindowForTarget` works, but `setWindowBounds`/`getWindowBounds` return `"wasn't found"` on a desktop `BrowserWindow` in this Electron version. The script instead relaunches the app once per case, with a new environment variable `RUBIS_CHECK_FIT_SIZE` (`src/main/index.ts`'s `parseCheckFitSize`) that sets the window's *initial* content size instead of maximizing. This is a narrow, inert-by-default hook: absent the variable (every real launch), the window maximizes exactly as it always has. Both scenarios (Cash, M-Pesa) are measured within the same launch, so this costs 9 relaunches, not 18.
- **Safety, directly addressing the phase-144 incident:** the script tracks the exact PID it spawns and only ever signals that PID's own process tree (`taskkill /PID <pid> /T /F` on Windows), never an image-name-wide kill. It never touches the real userData directory — it copies only the app's own state (the SQLite database, the credential vault, and `Local State` for the vault's decryption key) into a throwaway directory per case, never Chromium's cache (which may be locked by an already-running real instance and is irrelevant here). This was verified directly during this step: the user's own real, already-running instance (4 `electron.exe` processes, confirmed by PID before and after every run in this step) was never touched across roughly a dozen script runs.

**Usage:** `npm run build` once, then `npm run check:fit` (it checks whatever is currently in `out/`, it does not rebuild for you). `CHECK_FIT_DEBUG=1` prints the app's own stdout/stderr; `CHECK_FIT_SIZES=1` writes each case's key sizes to the output folder; `CHECK_FIT_MEASURE=1` writes one detailed child-by-child height breakdown for Cash at the worst case — all three are debugging aids, not part of the pass/fail result.

## 5. Touch floor (physical px, all 9 cases)

CSS heights after tightening: digit/backspace/decimal/Clear keys **48px**, method toggles **56px**, Complete Sale **64px** — uniform across all 9 cases (fixed CSS layout; only the zoom factor converting CSS→physical changes per case).

| Case | Zoom | Digit key (phys. px) | Toggle (phys. px) | Complete Sale (phys. px) |
| --- | --- | --- | --- | --- |
| 1366x768 @100% | 0.9948 | 47.8 | 55.7 | 63.7 |
| 1366x768 @125% | 0.7953 | 47.7 | 55.7 | 63.6 |
| 1366x768 @150% | 0.6632 | 47.8 | 55.7 | 63.7 |
| 1920x1080 @100% | 1.3990 | 67.2 | 78.3 | 89.5 |
| 1920x1080 @125% | 1.1192 | 67.2 | 78.3 | 89.5 |
| 1920x1080 @150% | 0.9326 | 67.2 | 78.3 | 89.5 |
| 2560x1440 @100% | 1.8653 | 89.5 | 104.5 | 119.4 |
| 2560x1440 @125% | 1.4922 | 89.5 | 104.5 | 119.4 |
| 2560x1440 @150% | 1.2435 | 89.5 | 104.5 | 119.4 |

Smallest value anywhere: **47.7 physical px** (a digit key at 1366x768 @125%) — 13.7px above the 34px floor, with no case anywhere close to it.

**A measurement pitfall worth recording:** `scrollHeight` on the checkout body (`overflow-hidden`, sized by `flex-1`) equals `max(content height, own allotted height)` — so once content fits, `scrollHeight` reports the *container's* height, not the content's, and reads as "zero slack" even when the real margin is large. Reading each child's own `getBoundingClientRect()` instead (bypassing the parent's clipping) found the true content height at the worst case (1366x768 @150%, 692px available) is **≈512px — 91px of real margin**, not the ~0px `scrollHeight` first suggested. The extra `p-2`/`mb-2` pass in §2's table was applied before this was understood; it's harmless (still passes every test, still well within the touch floor) and left in rather than reverted to avoid another rebuild/measure cycle for a change that cost nothing.

## 6. Tests

| File | Covers |
| --- | --- |
| `tests/virtualNumpadCompact.test.ts` (new, 4 tests) | Default `size` unchanged (`h-16`); compact renders `h-12` and nothing else differs in the class list; every key still types at compact size, including with `onEnter` |
| `tests/posCheckoutPanelFit.test.ts` (new, 6 tests) | `PosCheckoutPanel` passes `size="compact"`; the checkout body has no `overflow-y-auto` (and does have `overflow-hidden`); the merged row shows "TOTAL" + "Walk-in"/"Add KRA PIN"; tapping it still opens the KRA PIN keyboard (`useKeyboardStore` request); tapping "+ Discount" still opens the discount entry (Apply button present); Complete Sale is present and reachable |
| `tests/VirtualNumpad.test.ts` (tripwire, unmodified) | Still passes — proves the default numpad (no `size` prop, every existing caller) renders and behaves exactly as before |

**`PaymentModal.tsx` and `ManagerPinModal.tsx` each needed one import fixed** (`from './ManagerPinModal'` → `'./ManagerPinModal.js'`, `from './VirtualNumpad'` → `'./VirtualNumpad.js'`, plus `../lib/currency`/`../lib/mpesaPaymentPoller` in `PaymentModal.tsx`) to make `PosCheckoutPanel` mountable at all — `tests/**` compiles under `tsconfig.node.json`'s NodeNext resolution, which requires the extension on every relative import it reaches, and `PosCheckoutPanel` statically imports `PaymentModal` regardless of which payment method is selected at runtime (the same issue phase-144 hit with `AdminScreen.tsx`, documented there). Neither file's behavior changed — confirmed by the full suite and by `ManagerPinModal`/`PaymentModal` having no dedicated tests that could regress silently on a path-only edit.

**Mutation checks, each applied then reverted** (`git diff --stat` confirmed clean restore, full suite + typecheck re-run clean after):

| Mutation | Result |
| --- | --- |
| `VirtualNumpad`: ignored the `size` prop, always used `'default'` | 2 of 4 `virtualNumpadCompact.test.ts` tests failed (compact-height and default-vs-compact-diff) |
| `PosCheckoutPanel`: reverted `overflow-hidden` back to `overflow-y-auto` | the "no longer reserves an inner scroll region" test failed |

## 7. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` (node and web) | clean |
| `npx vitest run` (full suite) | **107 files, 1,607 tests passed** (1,597 baseline + 10 new) |
| `git diff --stat` against every tripwire (fiscalEngine, fiscalRouting, mpesaPaymentGate, VirtualNumpad **test file**, VirtualKeyboard, keyboardStore, setupScreens, virtualKeyboardLayouts, keyboardEchoSubmit, preLoginThemeGuard, themeTokens, preLoginTheme, scale, navStatusButton, headerLayout) | empty for all 15 |
| `npx electron-vite build` | built cleanly |
| `npm run check:fit` (the real, pixel-accurate proof) | **✔ All 18 cases (9 sizes × Cash/M-Pesa) fit with zero page overflow and zero unexpected inner scroll containers** |
| Mutation checks | both caught, both restored |
| Process safety | the user's 4 pre-existing real `electron.exe` processes (same PIDs) were confirmed untouched before and after every one of this step's ~12 script runs |

## 8. What only a human can check

- A full cash sale at the till at 150% Windows scaling: the whole numpad, Clear, and Complete Sale visible with no scrollbar; keys comfortable to tap; a sale completes normally end to end (this session did not complete a real sale — no payment/checkout logic changed, so none was needed for this fix, but it's the natural final confirmation before shipping).
- The merged TOTAL row's tap target at the smallest window (1366x768 @150%) — it's a text button (not a fixed-size box), and while its physical text height comfortably clears typical tap-target guidance, a human's own thumb is the real test.

## 9. Rollback

`git revert <this commit>`. This does not touch Phase E1's zoom mechanism or Phase E2's other layout fixes — reverting restores the pre-existing scrollable checkout panel and removes `scripts/check-fit.mjs`/`RUBIS_CHECK_FIT_SIZE` cleanly.

## 10. Observed but not changed

- The Complete Sale button and the numpad's Clear key both ended up needing a height reduction (steps (e)/(f)) that hadn't been budgeted for in the original phase-142/143 plan at all — a reminder that a reference box derived from a "should be about this tall" estimate needs the same live-measurement discipline as everything else in this project, not just a one-time audit.
- `scripts/check-fit.mjs` uses a fixed CDP port (9455, changed once during this session after 9411 started returning a Windows `WSAEACCES` bind error — likely a transient OS port-exclusion artifact from rapid repeated launches, not a bug in the script). A future hardening could pick an ephemeral port automatically; not done here since a fixed port matches the existing `--remote-debugging-port` convention used throughout this project's manual CDP work and a collision only ever affects this one developer-run script.
