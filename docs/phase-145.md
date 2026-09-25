# Phase 145 — Consolidate the header's status indicators into one button

- **Date:** 2026-09-25
- **Requested:** "In the navbar, could you have one button, which opens a dialog with all statuses in the navbar correctly" — replace the header's separate Online/Offline pill, unfiled-sales badge, and four connectivity badges (M-Pesa, Fiscal Server, Scanner, Printer) with a single button that opens a dialog listing all of them.
- **Outcome:** Implemented
- **Branch / base commit:** staging @ c93e041 (Phase E2)
- **Previous:** [phase-144](./phase-144.md) (Phase E2)

## 1. What this builds

Phase E2(a) had already made the header's status cluster shrink-and-truncate to fit 1366px (icon-only badges below `2xl`, a fixed-width Online/Offline pill, a hidden role chip). This request goes further: instead of managing five separate header items, one `NavStatusButton` replaces all of them. Its own dot carries the at-a-glance signal (the worst status among all six lines); tapping it opens a dialog listing every one by name, with the same click-through behavior each had before.

## 2. Changes made

**New `src/renderer/src/components/NavStatusButton.tsx`.** A single pill button (dot + "Status") that opens a dialog on tap, listing six rows: Online/Offline, unfiled sales (omitted while the count is still `null`, matching the old badge's own "don't flash a wrong zero" rule), M-Pesa, Fiscal Server, Barcode Scanner, and Receipt Printer. Each connectivity row's tap closes the dialog and calls `onSelectIntegration(...)` — the same prop `ConnectivityBadges` took, still opening the same `ConnectivityModal` `App.tsx` already rendered. The unfiled row's tap closes the dialog and calls `onUnfiledClick()` — the same admin-gated navigate-to-Needs-Attention handler `UnfiledSalesBadge` took. No click behavior changed; only where the trigger lives.

The button's dot picks the worst of three tiers: **red** if offline or any of M-Pesa/Fiscal/Printer is disconnected, **amber** if there are unfiled sales (and nothing worse), **green** otherwise. The barcode scanner is deliberately excluded from the red tier — an untested scanner reads "unknown" (slate), not "disconnected" (red), matching its original badge styling; a scanner nobody has tested yet isn't a fault.

**`src/renderer/src/App.tsx`.** The header's Online/Offline `<span>` markup, `<UnfiledSalesBadge>`, and `<ConnectivityBadges>` are replaced by one `<NavStatusButton>` call. `ConnectivityModal` (and its `selectedConnectivity` state) is untouched — `NavStatusButton` still opens the exact same modal for connectivity details.

**Dead-code cleanup, a direct consequence of the consolidation, not an opportunistic one:** `ConnectivityBadges.tsx` and `UnfiledSalesBadge.tsx` had no remaining callers once `NavStatusButton` took over their rendering, so both were deleted, along with `tests/UnfiledSalesBadge.test.ts` (which tested the now-deleted component in isolation). The three shared types they exported (`ConnectivityIntegration`, `ConnectivityStatusPayload`, `BarcodeStatus`, `ConnectivityCheckPayload`) still had three other importers (`ConnectivityModal.tsx`, `ConnectivityToast.tsx`, `connectivityStore.ts`) — these moved to a new `src/renderer/src/types/connectivity.ts`, and all four importers (those three plus `NavStatusButton.tsx`) now read from there instead of a UI component file.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| src/renderer/src/components/NavStatusButton.tsx | Added | the consolidated status button + dialog |
| src/renderer/src/types/connectivity.ts | Added | shared connectivity types, moved out of a UI component |
| src/renderer/src/App.tsx | Modified | header now renders one status button instead of five items |
| src/renderer/src/components/AdminScreen.tsx | Modified (1 comment) | stale doc-comment reference fixed |
| src/renderer/src/components/ConnectivityModal.tsx | Modified (1 import) | type import relocated, behavior unchanged |
| src/renderer/src/components/ConnectivityToast.tsx | Modified (1 import) | type import relocated, behavior unchanged |
| src/renderer/src/stores/connectivityStore.ts | Modified (1 import) | type import relocated, behavior unchanged |
| src/renderer/src/components/ConnectivityBadges.tsx | Deleted | no longer rendered anywhere |
| src/renderer/src/components/UnfiledSalesBadge.tsx | Deleted | no longer rendered anywhere |
| tests/UnfiledSalesBadge.test.ts | Deleted | tested the deleted component |
| tests/navStatusButton.test.ts | Added | tests |
| tests/headerLayout.test.ts | Modified | the two now-obsolete pill/badge checks replaced with one "renders NavStatusButton, not the old items" check |

## 4. Possible impact

- **Direct:** the header's status cluster is one button instead of five; a cashier now taps once to see everything, instead of reading up to five separate items (three of which were icon-only below `2xl` after E2). The at-a-glance red/amber/green dot is new — nothing before this summarized "is anything wrong" in one glance.
- **Indirect:** any muscle memory around tapping a specific connectivity badge directly now needs one extra tap (open Status, then tap the row) — a real, if minor, workflow change the user asked for directly.
- **Data / schema / contract:** none. No IPC call, handler, or save payload changed — only which component renders the same state and calls the same callbacks.
- **Security posture:** unchanged.
- **Idempotency / re-run safety:** `NavStatusButton` is stateless besides its own `open` boolean; opening/closing it any number of times is side-effect-free.
- **Residual risk:** not verified live on the running app this step (see §6) — verified instead with 15 real-DOM mount tests (`navStatusButton.test.ts`) covering every row's click behavior and the dot's tone priority, plus a production build.

## 5. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` (node and web) | clean |
| `npx vitest run` (full suite) | **105 files, 1,597 tests passed** |
| `git diff --stat` against every tripwire | empty for all 11 |
| `npx electron-vite build` | built cleanly (95 modules, down from 96 — confirms the deleted files dropped out) |
| Mutation check | caught, then restored |

**What `tests/navStatusButton.test.ts`'s 15 tests (mounted, real clicks) prove:** exactly one button renders (not five items); tapping it opens a dialog listing all six status lines; the offline message and the unfiled-count label render correctly in the dialog; the unfiled row is omitted while the count is `null`; each of the four connectivity rows closes the dialog and calls `onSelectIntegration` with the right integration key; the unfiled row closes the dialog and calls `onUnfiledClick`; the dialog closes on backdrop click and on its own close button; the button's dot picks red for offline, red for a disconnected M-Pesa/Fiscal/**Printer** (each checked independently — the mutation below caught a real gap in this), amber for unfiled-only, and green when everything is fine; and a never-tested scanner reads "unknown" (slate) rather than "disconnected" (red) on both the row and the button dot.

**Mutation check, applied then reverted** (`git diff --stat` confirmed clean restore, `925ms` rebuild after): dropped `printerConnected` from the "bad connectivity" check. The *first* version of the dot-priority test suite (4 cases: ok / offline / mpesa-down / unfiled-only) missed this — a real gap, since none of the four cases isolated the printer. A fifth case (printer-down alone) was added, which failed against the mutation as expected, then passed once the mutation was reverted. Recorded here rather than silently fixed, per the mutation-testing discipline this session has followed throughout Phase E.

## 6. What only a human can check

- The dialog and button on the real till, at both zoom extremes — this step made no live CDP check (the prior step's live-verification attempt caused an unrelated incident — see phase-144.md §8 — and no further live process launches were attempted this session as a result).
- Whether the one-extra-tap-to-drill-in tradeoff feels right in practice for a cashier during a live shift.

## 7. Rollback

`git revert <this commit>`. Restores `ConnectivityBadges.tsx`, `UnfiledSalesBadge.tsx`, and their direct header rendering; the type relocation reverts cleanly alongside it since nothing outside this commit depends on `types/connectivity.ts` yet.

## 8. Observed but not changed

- The connectivity/unfiled state computation (`mpesaConnected`, `fiscalConnected`, `printerConnected`, `describeUnfiledCount`) is duplicated between `NavStatusButton`'s button-dot logic and its dialog rows — both read the same props, so there is no drift risk, but a future change to one must remember the other reads the same values.
