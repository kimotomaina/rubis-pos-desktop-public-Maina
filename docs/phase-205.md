# Phase 205 — App & Updates to the main Admin page; Peripherals as Scanner and Printers

- **Date:** 2026-10-03
- **Requested:** move the updates panel from Overview to the main Admin page; move Printer into Peripherals; give Peripherals two cards, Scanner and Printers.
- **Outcome:** Implemented. Typecheck clean; vitest **184 files, 2947 tests, all passing** (183 and 2936 before); `npm run build` passes with the no-mock check. `check:fit` not run; no device calls.
- **Branch / base commit:** staging on top of `f241538` (phase 204).

## 1. What changed

All in [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx), moved verbatim except for re-indenting:

- **App & Updates** (installed version, Check for Updates, download progress, Install update and restart, last update result) is now under the card grid on the main Admin page, and appears only there. Overview keeps Today's Sales, Shift Controls and Staff. The update status, version and last-result subscriptions were already set up when the screen mounts, so nothing about them changed.
- **Peripherals** opens to a grid of two cards, Scanner then Printers, like Integrations. **Scanner** holds the Barcode Scanner Stations instructions, unchanged. **Printers** holds the whole printer registration section (the list, Add Printer, the Windows queue picker, test and delete), unchanged, with the same handlers.
- **Integrations** loses its Printer card; it is now Shopify, Store Details, Location, Fiscal Device, M-Pesa.
- Printers load when Peripherals > Printers is the section showing, not before (previously when Integrations > Printer was).
- **Breadcrumbs** extend to `Admin › Peripherals › Printers` and `… › Scanner`; the Admin crumb also clears the open Peripherals section, so the next visit starts at its grid.
- The Scanner card borrows the search icon; there is no dedicated scanner icon.

## 2. Tests

- **New: `tests/adminPeripheralsUpdates.test.ts`, 10 tests:** App & Updates is on the main page with its buttons; it is not on Overview or any other section; Overview keeps its sections; Check for Updates works from the main page; Peripherals opens to exactly Scanner then Printers with no content or printer load until one is tapped; Scanner shows the instructions; Printers shows the registration and loads printers once; no Printer card on Integrations; the breadcrumb row and going back a level; Peripherals restarts at its grid after leaving from inside a section.
- **Existing tests changed, because the places changed (assertions about fields, the Windows route, the save payload and the update panel text are untouched; each change carries an old/new note in the file):**
  - `tests/adminScreen.test.ts`: the Printer tests now go `Peripherals` then `Printers` (were `Integrations` then `Printer`); the App & Updates tests no longer click `Overview` first.
  - `tests/adminIntegrationsSections.test.ts`: the card-order test is five cards and asserts no Printer card; the Printer card dropped from the card loop and the title test; the printer-loading test now drives Peripherals; two source-slice tests that ended at the printer section now end at the end of the block; the printer handlers' call signatures are asserted under Peripherals instead of Integrations; the Peripherals describe now asserts the printer section is there.
- No mutation check: moves, with both ends asserted.

## 3. Flags

- Not seen on a screen. The main Admin page is now the card grid with the update panel below it.
- The update panel's small heading style (`text-base`) was kept as it was; on the main page it sits under the larger cards.

## 4. Rollback

`git revert` the phase 205 commit. Nothing is stored or migrated.
