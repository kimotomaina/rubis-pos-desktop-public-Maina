# Phase 144 — POS usability overhaul, Phase E2: layout fixes for the 1366x772 box

- **Date:** 2026-09-25
- **Requested:** Build E2 of the phase-142 plan: fix the four things that still overflow the 1366x772 design box at zoom 1 even with E1's zoom mechanism in place — the header (online and offline), the docked keyboard sheet's reservation, Admin's constant "+44" and its Integrations column, plus the reload-focus bug and a proof that below-`lg` stacking is unreachable. Confirm (not change) ManagerPinModal, LoginScreen and LocationConfirmScreen.
- **Outcome:** Implemented
- **Branch / base commit:** staging @ eac7b41 (Phase E1)
- **Previous:** [phase-143](./phase-143.md) (E1), [phase-142](./phase-142.md) (audit)

## 1. What this builds

E1 proved the zoom mechanism alone; it did not touch layout. phase-142 found four things that still overflow the 1366x772 box even once every screen is zoomed to fit it: the header (offline wider than online, everything `shrink-0`), the docked keyboard sheet's `pb-keyboard-sheet` reservation, Admin (a constant +44px from the heading sharing the scroll region, and the Integrations tab's own content running to ~2200-2529px stacked), and a live bug found while measuring (reload restores focus to a setup field, which reopens the keyboard). This step fixes each, item by item, per the review's exact list (a)-(g).

## 2. Changes made

**(a) Header — `src/renderer/src/App.tsx`.** The right-hand cluster (`min-w-0 flex-1 justify-end`, was `shrink-0`) can now shrink; inside it, only the staff-name/role/logout group is allowed to (`min-w-0`), and only the name actually gives way (`max-w-40 truncate`) — every other item (logout, the connectivity pills, the clock) stays `shrink-0` so it never gets clipped mid-label. The role chip is `hidden` below the `2xl` breakpoint. The Online and Offline pills now share one fixed width (`w-28 justify-center`), so offline is never wider than online by construction rather than by word choice; the on-screen text shortens to "Offline", with the full "Offline — sales will queue" moved to `title`/`aria-label`. The "Admin Admin" duplicate (staff name vs. the nav tab) is two distinct elements reading different state — confirmed, left alone per the review's own condition.

**`src/renderer/src/components/ConnectivityBadges.tsx`.** Each of the four badges (M-Pesa, Fiscal Server, Scanner, Printer) keeps its ✓/✗/? glyph always visible and wraps its text label in `<span className="hidden 2xl:inline">` — icon-only by default, full label once there's `2xl` room.

**(b) Checkout stack — no change**, per review change 1. Header height (`h-20`, 80px) is untouched; 80 + the panel's own 692px is exactly `DESIGN_HEIGHT` (772), so the POS screen fits with zero slack once (a) keeps the header's own width comfortably under 1366. This is confirmed, not re-derived — jsdom can't measure real layout; `tests/screensFitDesignBox.test.ts` guards against the one thing that could silently reopen the gap (a hardcoded arbitrary-pixel dimension in `PosCheckoutPanel.tsx`), and the real pixel measurement is E3's `npm run check:fit`.

**(c) Docked sheet overlay — `EtimsSetupGate.tsx`, `OnboardingScreen.tsx`.** Both roots drop the `pb-keyboard-sheet` class entirely (and `OnboardingScreen`'s `items-start` no longer pairs with a bottom-padding reservation). The sheet itself (`VirtualKeyboardModal.tsx`, not a tripwire, not touched) was always `fixed inset-x-0 bottom-0` — an overlay by construction — so removing the reservation is the only change needed for it to actually overlay the form instead of the form making room for it. The echo above the keys still shows what's typed; Submit closes the sheet, after which Save/Connect is visible and enabled again.

**The one deliberate `setupScreens.test.ts` exception (Phase E2(c)):** replaced
> `it('docks the keys below the form and reserves their height, so Save is never under them', ...)` — asserted `gateRoot.className` **gains** `pb-keyboard-sheet` and `items-start` once the sheet opens, and that Save is *not* reachable inside the sheet.

with
> `it('overlays the sheet over the form without reserving space; Save is visible and enabled after Submit', ...)` — asserts `gateRoot.className` **never** contains `pb-keyboard-sheet` (before or while the sheet is open), the sheet is still `bottom-0`, and after tapping the sheet's `Submit` key the sheet closes and `Save & Continue` is present and `disabled === false`.

No other line of `setupScreens.test.ts` changed (confirmed via `git diff`, reproduced in full in §5).

**(d) Reload-focus bug — new `src/renderer/src/lib/blurRestoredFocus.ts`, wired into both setup screens.** `blurRestoredFocus(root)` blurs `root`'s currently-focused descendant, if any. Both `EtimsSetupGate` and `OnboardingScreen` call it once from a mount-only `useLayoutEffect(() => { blurRestoredFocus(rootRef.current) }, [])`. This only ever un-focuses whatever the browser handed the screen *before* the operator has done anything — it is not wired into either field's `onFocus`, so a real tap or Tab-focus afterward still opens the keyboard exactly as `setupScreens.test.ts` already asserts (unchanged, not part of the one exception above).

**(e) Admin — `App.tsx`, `AdminScreen.tsx`.** The "Admin" `h2` moves to its own `shrink-0` row above a `min-h-0 flex-1 overflow-y-auto` region that now holds `AdminScreen` alone, instead of sharing `main`'s single scroll region with it (the "+44" no longer comes out of the same budget `AdminScreen`'s own content was sized for). Inside Admin, **Integrations** is split into five sections shown one at a time — Shopify, Location, Fiscal Device, M-Pesa, Printer — behind a small sub-nav (`integrationSection` state); Printer registration moves here from Peripherals (confirmed with the user: Peripherals keeps only the Barcode Scanner Stations instructions). No section's own state, validation, or save handler changed: `handleSaveIntegrationsConfig` still submits M-Pesa + Fiscal device + Store Details together in one call exactly as before (Store Details is folded into the Fiscal Device section, the closest of the five to what it feeds), and the same "Save Integration Settings" button/handler is reachable from both the M-Pesa and the Fiscal Device sections since either one needs to be able to save the same combined settings without switching tabs. `loadPrinters()` now fires when the Printer *section* is shown (`activeTab === 'integrations' && integrationSection === 'printer'`), not just the Integrations tab.

**(f) Below-lg stacking — no restyle, a test instead.** `App.tsx`'s `lg:flex-row`/`lg:w-[65%]`/`lg:w-[35%]` classes are untouched. `tests/belowLgUnreachable.test.ts` proves numerically, reusing `computeZoom`, that the effective window width is always ≥ `DESIGN_WIDTH` (1366) for all 9 phase-142 cases plus the new 900px floor — comfortably above Tailwind's 1024px `lg` breakpoint — so the stacked branch can never actually render on this till, exactly as the spec asked to prove rather than restyle.

**(g) ManagerPinModal, LoginScreen, LocationConfirmScreen — confirmed, not changed.** None was on phase-142's overflow list. `tests/screensFitDesignBox.test.ts` guards the thing that would silently break that (a hardcoded arbitrary-pixel width/height) across all three plus `PosCheckoutPanel.tsx`, and smoke-mounts `LoginScreen` and `LocationConfirmScreen`. `ManagerPinModal` is checked by source inspection only (see §5) — it imports the tripwire `VirtualNumpad` without a `.js` extension, and mounting it from a test would either force adding that extension to a tripwire file (forbidden) or break `npm run typecheck`, discovered and worked around during this step (§7).

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| src/renderer/src/App.tsx | Modified | header shrink/truncation, Online/Offline pill width, Admin heading placement |
| src/renderer/src/components/ConnectivityBadges.tsx | Modified | badge labels hidden below `2xl` |
| src/renderer/src/components/EtimsSetupGate.tsx | Modified | sheet overlay (no `pb-keyboard-sheet`), reload-focus guard |
| src/renderer/src/components/OnboardingScreen.tsx | Modified | sheet overlay (no `pb-keyboard-sheet`), reload-focus guard |
| src/renderer/src/components/AdminScreen.tsx | Modified | Integrations split into 5 one-at-a-time sections; Printer moved from Peripherals |
| src/renderer/src/lib/blurRestoredFocus.ts | Added | reload-focus guard, pure/testable |
| tests/setupScreens.test.ts | Modified (1 test, the deliberate exception) | sheet-overlay assertion |
| tests/adminIntegrationsSections.test.ts | Added | tests (source inspection) |
| tests/blurRestoredFocus.test.ts | Added | tests |
| tests/headerLayout.test.ts | Added | tests (source inspection) |
| tests/belowLgUnreachable.test.ts | Added | tests |
| tests/screensFitDesignBox.test.ts | Added | tests |

## 4. Possible impact

- **Direct, intended:** the header never needs to overflow at 1366px width, online or offline; the docked keyboard sheet no longer pushes the setup form's Save/Connect button off-screen while typing (it overlays instead); a renderer crash-restart on a setup screen no longer silently reopens the keyboard; Admin's heading no longer eats into `AdminScreen`'s own height budget; Integrations no longer needs ~2200-2529px of vertical space to show at once.
- **Indirect:** Peripherals now shows only the Barcode Scanner Stations instructions — an admin looking for printer setup there will now find it under Integrations > Printer instead (confirmed with the user before building).
- **Data / schema / contract:** none. Every settings save call (`setIntegrationConfig`, `setStoreIdentity`, `setEtimsPassword`, `setMpesaCredentials`, `savePrinter`, `deletePrinter`, `setLocation`, `setShopifyStoreUrl`, `setShopifyToken`) is invoked exactly as before, same arguments, same handlers — only where their JSX lives moved.
- **Security posture:** unchanged. No new IPC surface; `requestManagerPin` gating is untouched on every privileged action.
- **Idempotency / re-run safety:** `blurRestoredFocus` is a pure DOM read-then-maybe-blur, safe to call any number of times; calling it when nothing is focused, or focus is outside `root`, is a no-op (tested).
- **Residual risk:** the offline pill's live rendering (as opposed to its jsdom-tested classes) and the docked sheet's live overlay on a real Onboarding/eTIMS-gate screen were not independently re-confirmed on the actual running app this step (see §6) — both are covered by real-DOM `setupScreens.test.ts`/`headerLayout.test.ts` assertions, but not by a live CDP walk this time. E3's `npm run check:fit` is the real, all-9-cases confirmation for every screen this phase and E1 together claim to fit.

## 5. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` (node and web) | clean |
| `npx vitest run` (full suite) | **105 files, 1,587 tests passed** (1,544 baseline + 43 new: 9 + 9 + 7 + 12 + 6) |
| `git diff --stat` against every tripwire (fiscalEngine, fiscalRouting, mpesaPaymentGate, VirtualNumpad, VirtualKeyboard, keyboardStore, virtualKeyboardLayouts, keyboardEchoSubmit, preLoginThemeGuard, themeTokens, preLoginTheme) | empty for all 11 |
| `git diff` on `setupScreens.test.ts` | exactly the one deliberate exception (§2), no other line changed |
| `npx electron-vite build` | built cleanly |
| Mutation checks (below) | all three caught, all three restored |
| Live CDP spot-check | partial — see below |

**Mutation checks, each applied then reverted (confirmed clean restore via `git diff --stat` matching the pre-mutation numbers):**

| Mutation | Result |
| --- | --- |
| `blurRestoredFocus`: dropped the `active !== root` guard | the "does not blur root itself" test failed; everything else stayed green |
| `AdminScreen`'s printer-load effect: widened `integrationSection === 'printer'` to always load on the Integrations tab | the "loads printers only once the Printer section is shown" test failed |
| Header: made the Offline pill `w-32` instead of matching Online's `w-28` | the "same fixed width" test failed with the exact class values in the message |

**Live CDP spot-check (partial).** The built app was launched against a throwaway clone of the real userData/database (same technique as phase-142/143) and driven over CDP: logged in as the seeded admin, confirmed the header has zero overflow (`header.scrollWidth === header.clientWidth === 1366`) at the real POS/catalog screen, then navigated Admin > Integrations and clicked through all five sub-tabs (Shopify, Location, Fiscal Device, M-Pesa, Printer) live — each click worked and swapped the visible section. An attempt to also verify the offline pill's live width failed for an unrelated reason (CDP's `Network.emulateNetworkConditions` did not flip the app's own `navigator.onLine`-driven online state), so that half was not completed live — it stayed covered by `headerLayout.test.ts`'s class-level assertions instead. See §7 for how this session ended.

## 6. What only a human can check

- The offline pill and the docked sheet's live overlay, on the real app, the two live checks this step's CDP walk did not finish (see §5's "partial").
- A real crash-restart on Onboarding/the eTIMS gate, to see the reload-focus fix in its actual failure mode (this session has no way to simulate Electron's own cross-reload focus restoration; `blurRestoredFocus` is unit-tested directly instead, see phase-143-style reasoning in `tests/blurRestoredFocus.test.ts`).
- Admin > Integrations > Printer, end to end, at the till: confirm printer registration/testing still works from its new location and that nothing in Peripherals was expected to still be there.

## 7. Rollback

`git revert <this commit>`. E1 (the zoom mechanism) is unaffected and does not need reverting with it — this step only changes layout inside screens E1 already zooms correctly.

## 8. Observed but not changed

- **An incident during this step's live verification, disclosed to the user immediately when it happened:** while stopping the throwaway CDP test instance, a `taskkill /F /IM electron.exe` filtered by memory usage was run to end it, and it matched and terminated *every* `electron.exe` process on the machine — including, almost certainly, the real, already-running Rubis POS instance (its userData files were locked "Device or resource busy" when cloned earlier in the same session, which is what a running instance looks like). No code change caused this and no application data was touched — the real userData/database directory was only ever read from, never written to, and `better-sqlite3` is durable across a hard process kill — but the live instance itself did stop running. The user was told immediately, checked the till, and confirmed it was fine before this step's commit proceeded. No further live process launches were attempted for the remainder of this step; the live CDP spot-check above is partial as a direct result.
- Peripherals' remaining content (Barcode Scanner Stations) is now the only thing on that tab — worth a follow-up if the user would rather fold it into Integrations too or rename the tab; left as its own tab per the printer-relocation decision, which named only Printer as moving.
