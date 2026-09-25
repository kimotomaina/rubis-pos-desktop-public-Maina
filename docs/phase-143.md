# Phase 143 — POS usability overhaul, Phase E1: the zoom mechanism + window minimums

- **Date:** 2026-09-25
- **Requested:** Build E1 of the phase-142 plan: a pure `computeZoom`, wired into the main process on five triggers so the window's zoom always fits its content to a 1366x772 design box, with the user zoom locked down and the window minimums lowered (D6). Per the review changes: the reference box is **1366×772** (the POS screen's own natural height), not 688.
- **Outcome:** Implemented
- **Branch / base commit:** staging @ f1c762d
- **Previous:** [phase-142](./phase-142.md)

## 1. What this builds, and the review change that shaped it

Phase-142 §5 used a *guessed* reference box (1366×688, "screen minus Windows chrome estimated on this machine"). The review corrected that: the reference is **1366×772**, the POS screen's own measured natural height at scale 1 (header 80 + the Cash checkout stack 692, phase-142 §3) — and, per review point 1, **the checkout stack is not restyled to fit a smaller box**. E1 therefore designs around exactly the number the app already needs, not an estimate of window chrome that varies by OS theme and title-bar style.

The invariant this phase establishes: **after zoom, the window's effective CSS viewport is always at least 1366×772, in both axes.** Every other phase-142 finding (the header's 1331px minimum, Admin's +44, the keyboard sheet) is smaller than or equal to this box, so once the invariant holds, those screens fit too — layout gaps that don't (Admin → Integrations' 2,200px column) are explicitly *not* this phase's job; they're E2/E4.

## 2. Changes made

**`src/main/lib/scale.ts`** (new) — two exports:

- **`computeZoom(contentWidth, contentHeight)`**, pure: `z = clamp(min(contentWidth/1366, contentHeight/772), 0.5, 2.5)`. Taking the *smaller* of the two axis ratios as the zoom is what guarantees *both* `contentWidth/z >= 1366` and `contentHeight/z >= 772` — the file's doc comment proves this algebraically, and `tests/scale.test.ts` proves it empirically for every case. A dimension that is non-finite (including `Infinity`, not just `NaN`) or non-positive is treated as `0` by a small `ratio()` guard, so a bad reading always degrades to the safe `MIN_ZOOM` rather than being read as "very large" and pushed toward `MAX_ZOOM`. `MIN_ZOOM`/`MAX_ZOOM` (0.5/2.5) are far outside anything the 9 supported cases ever compute (measured range ≈0.66–1.87) — they exist only so a window dragged to a pathological size gets a capped, sane zoom instead of an absurd one.
- **`applyAutoZoom(win: ZoomableWindow)`** — wires `win` so its zoom is always `computeZoom` of its *current* content bounds, on five triggers: `ready-to-show`, `resize`, `move`, `did-finish-load` (a navigation/reload resets Chromium's zoom to 1, so this must re-apply after every load, not just at window creation), and `zoom-changed` (Chromium's own page-zoom-level change — a Ctrl+scroll or pinch gesture; re-applying the *freshly recomputed* value, not a cached one, immediately undoes it). `ZoomableWindow` is a narrow interface of **named per-trigger hooks** (`onReadyToShow`, `onResize`, …) rather than a generic `on(event, …)`: `BrowserWindow.on` is overloaded per literal event name with no single signature spanning all five, so a pass-through generic `on` fought TypeScript's overload resolution for no benefit (documented in the file, and it's exactly the error the first draft hit — recorded here rather than silently fixed, since the reasoning is worth keeping). The narrow interface also means the wiring test drives a plain object literal, no Electron runtime needed.

**`src/main/index.ts`:**

- `Menu.setApplicationMenu(null)` — the actual lockdown. `autoHideMenuBar: true` (unchanged) only hides the menu *bar*; Electron's default menu still exists underneath it and still registers `Ctrl+Plus`/`Ctrl+Minus`/`Ctrl+0` as zoom accelerators regardless of whether the bar is shown. Only a null application menu removes those accelerators. There was no prior `Menu` usage in this file to conflict with.
- `mainWindow.webContents.setVisualZoomLevelLimits(1, 1)` — disables pinch-to-zoom/Ctrl+scroll visual zoom, called once per window right after creation.
- `applyAutoZoom({ … })` called once in `createWindow()`, with an adapter closure over `mainWindow` supplying the five named hooks (`mainWindow.on('ready-to-show', …)` etc.) and `getContentBounds`/`setZoomFactor`. The adapter exists purely to satisfy `ZoomableWindow`'s interface from the real `BrowserWindow`; it does no work of its own.

**`src/main/window-factory.ts`** (decision D6, deferred to this phase per phase-142's plan): `minWidth`/`minHeight` lowered from `1024`/`768` to **`900`/`500`**, with a comment explaining why this phase is what makes a window that small usable — `applyAutoZoom` zooms out to compensate, so the content area no longer needs to be large enough to show the unscaled layout.

**`tests/foundation.test.ts`** (not a tripwire): its two `>= 1024`/`>= 768` assertions updated to `>= 900`/`>= 500`, with a comment pointing at why.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| src/main/lib/scale.ts | Added | zoom calculation and wiring |
| src/main/index.ts | Modified | menu removed; visual zoom limits; `applyAutoZoom` wired into window creation |
| src/main/window-factory.ts | Modified (2 values) | window minimum size |
| tests/foundation.test.ts | Modified (2 assertions) | window-minimum expectations |
| tests/scale.test.ts | Added | tests |

## 4. Possible impact

- **Direct, intended:** every screen now renders zoomed to fit the window — larger on a roomy screen, smaller on a cramped one — instead of at a fixed size that could overflow. This is the mechanism only; **most screens still overflow their zoomed box** where phase-142 found a real layout problem (the header online/offline, the docked keyboard sheet, Admin) — those are E2's job, not this one's. The **POS catalog screen itself, which is the design reference, now fits exactly** at zoom 1 with no overflow of its own.
- **The window can now be resized smaller** (down to 900×500) than before. At the smallest allowed size the computed zoom is ≈0.648 (height-bound, `500/772`), still comfortably inside `(MIN_ZOOM, MAX_ZOOM)` — the app never actually hits either clamp at any size this phase's floor permits.
- **No user-driven zoom exists any more.** Ctrl+Plus/Minus/0 do nothing (no menu, no accelerators); Ctrl+scroll and pinch-to-zoom are limited to 1:1 by `setVisualZoomLevelLimits`, and even if either slipped through, `zoom-changed` immediately reverts it. This is deliberate per the review ("the zoom must not be undoable") — a cashier or a stray gesture can no longer make the till's layout diverge from what it was designed to show.
- **Receipts and PDFs are unaffected.** `pdf-receipt.ts` and `printer.ts` never reference `webContents`, `BrowserWindow`, or `printToPDF` (confirmed by source-inspection test, and true both before and after this change — this phase added nothing to either file). They build receipts directly with `pdfkit`/the thermal-printer library from data, entirely outside the renderer's zoom.
- **CSP is untouched** — no new script/style/connect source was added; `setZoomFactor`/`setVisualZoomLevelLimits`/`Menu.setApplicationMenu` are main-process Electron APIs, not renderer network requests.
- **Data / schema / contract / receipts / KRA filing:** none.
- **Security posture:** unchanged; `sandbox`/`contextIsolation`/`nodeIntegration: false`/`webSecurity` are untouched in `window-factory.ts`.
- **Idempotency / re-run safety:** `applyAutoZoom`'s handler is pure re-computation from current bounds each time it fires — calling it twice in a row (e.g. a `resize` immediately followed by `did-finish-load`) sets the same zoom factor twice, which is a harmless no-op the second time.
- **Residual risk:** the physical-size numbers in §5 assume `devicePixelRatio` equals the Windows scaling percentage exactly (100/125/150%), which phase-142 found true on the one real machine measured; E2/E3/E4 will each add their own screens to the invariant this phase only guarantees at the mechanism level.

## 5. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` (node and web) | clean |
| `npx vitest run` (full suite) | **100 files, 1,544 tests passed** |
| `git diff --stat` against every listed tripwire file (fiscalEngine, fiscalRouting, mpesaPaymentGate, VirtualNumpad, VirtualKeyboard, keyboardStore, virtualKeyboardLayouts, keyboardEchoSubmit, preLoginThemeGuard, themeTokens, preLoginTheme, **setupScreens** — all unmodified this step) | empty |
| `npx electron-vite build` | built; `out/main/index.js` contains both `setApplicationMenu` and `applyAutoZoom` |
| Live spot-check, built app over CDP (§6) | `innerWidth×innerHeight` = 1367×772 on this machine's real maximized window — the design box, hit almost exactly |
| Mutation checks (§7) | both catch, both restored |

**What the 46 new tests in `tests/scale.test.ts` prove:**

- **`computeZoom`:** is exactly 1 at the design box; matches `min(w/1366, h/772)` to 10 decimal places for **all 9 phase-142 cases** individually (not just in aggregate); is monotonically increasing in width alone and in height alone; clamps to `MIN_ZOOM`/`MAX_ZOOM` at pathological sizes while **none of the 9 real cases ever reaches either clamp**; the new 900×500 window floor computes a real, unclamped zoom (≈0.648) rather than bottoming out; every non-finite/non-positive input degrades to `MIN_ZOOM` rather than propagating `NaN`/`Infinity`.
- **The invariant itself,** algebraically derived and then checked numerically for all 9 cases plus 4 synthetic ones (including a wide-short case where width binds instead of height): `contentWidth/zoom >= 1366` and `contentHeight/zoom >= 772`, to a `1e-9` tolerance for floating-point rounding.
- **`applyAutoZoom`, against a plain fake (no Electron):** each of the five triggers independently calls `setZoomFactor` with exactly `computeZoom` of the fake's current bounds; each trigger is wired exactly once (no duplicate registration); a `resize` to a new size followed immediately by a `zoom-changed` produces the **new** size's zoom both times, not a stale cached one from wiring time; the mechanism reproduces every one of the 9 cases exactly via `ready-to-show` alone.
- **Source-inspection guards on `main/index.ts`** (the `stockTakeGuard` pattern, since `index.ts` can't be unit-imported): `Menu.setApplicationMenu(null)` is present; no menu construction anywhere carries a `zoomIn`/`zoomOut`/`resetZoom` role; `setVisualZoomLevelLimits(1, 1)` is present; `applyAutoZoom` is imported and called, and the call's own adapter body is inspected to confirm it's wired to the *real* `mainWindow`/`mainWindow.webContents`, not a stand-in.
- **Receipts confirmed untouched:** `pdf-receipt.ts` and `printer.ts` contain no `webContents`/`BrowserWindow`/`printToPDF` reference.

**Mutation checks, each applied then reverted (confirmed byte-identical via `git diff --stat` after restoring):**

| Mutation | Result |
| --- | --- |
| `computeZoom`: `Math.min` → `Math.max` (picks the *larger* axis ratio, breaking the invariant) | **23 of 46 tests failed** — every exact-value case, both floor tests, the non-finite tests, and the entire invariant suite (13 cases) |
| `applyAutoZoom`: the `zoom-changed` hook silently dropped | the 2 tests specific to that trigger failed, everything else (including the other 4 triggers) stayed green |

## 6. Live spot-check (built app, real machine)

The built `out/` app was launched with `--remote-debugging-port=9222` against a throwaway copy of the real dev database (as in phase-142; deleted afterward, app process killed afterward) and its effective viewport read over CDP a few seconds after startup, once `ready-to-show`'s `maximize()` and the `resize` it triggers had settled:

```
innerWidth x innerHeight (this machine, dpr reported 1.389): 1367x772
```

772 is exact; 1367 is 1px over 1366 — height is the binding axis here (this machine's own aspect ratio is slightly wider than the 1366:772 design box, matching phase-142's finding that height binds in every one of the 9 cases). This is a live, end-to-end confirmation that the mechanism is not just unit-tested but actually zooming the real window to the design box. It is a spot-check, not the full 9-case sweep — that sweep is E3's committed `npm run check:fit` script, run against layouts that don't yet exist (E2/E4 haven't landed).

## 7. What only a human can check

- **On the till:** confirm Ctrl+Plus/Ctrl+Minus/Ctrl+0, Ctrl+scroll, and a trackpad pinch gesture all do nothing to the app's size — the CDP check above confirms the *mechanism*, not physical input devices, which this session had none of to drive.
- **Resize the window** by hand between 900×500 and a full 2560×1440 maximize, including across a monitor with different Windows scaling, and confirm the layout visibly grows/shrinks as one image with no flash of an unzoomed frame.
- **A receipt print or PDF fallback** while the window is zoomed, to confirm (as the source-inspection test already shows structurally) that the printed output is unaffected by whatever zoom the screen happens to be at.

## 8. Rollback

`git revert <this commit>`. The app returns to a fixed zoom of 1 and the old 1024×768 window floor; every later Phase E step (E2 onward) depends on this one, so reverting it should be paired with reverting anything built after it.

## 9. Observed but not changed

- The adapter closure in `createWindow()` is the one piece of Phase E code that must exist purely to satisfy a TypeScript interface boundary — noted in §2 in case a later refactor is tempted to "simplify" it back into `applyAutoZoom(mainWindow)` directly, which reintroduces the overload-resolution error this file's own comment (and this report) documents.
- `devicePixelRatio` reported by the live spot-check (1.389) does not equal the raw Windows scaling factor once zoom is applied — expected, since `devicePixelRatio` reflects the combined effect of OS scaling and page zoom, not either alone. Nothing in this phase reads `devicePixelRatio` at runtime; it only appears in the phase-142 audit's own physical-pixel arithmetic, done outside the app.
