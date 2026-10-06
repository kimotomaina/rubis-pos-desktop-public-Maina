# Phase 247 — The Admin screens scroll, so every list can be reached

- **Date:** 2026-10-06
- **Asked by the owner:** make sure every Admin page that holds a list can be scrolled.
- **Status:** built and tested in one commit. Not released: no installer built. `package.json` stays at 2.2.9.
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.**

## Audit

- **The cause is one element.** `App.tsx` wraps `AdminScreen` in `<div class="min-h-0 flex-1 overflow-hidden p-6">`, inside a `<main … overflow-hidden>`. Phase 167 Part B made it `overflow-hidden` on the ground that every Admin section fits the 1366x772 design box. Anything taller than the box is cut off, and nothing in `AdminScreen` or the pages scrolls to compensate.
- **Lists that can outgrow the box:** the printers list and the Windows printer options, the staff list, the fiscal test's hops (all in `AdminScreen.tsx`); Needs Attention (unprinted sales, VAT mismatches, the unfiled rows, ten to a page), Stock Take (matches, counted lines, the preview, the history), the M-Pesa reconciliation rows. The Overview, Integrations, Peripherals and System sections are forms that grow with their messages and errors.
- **Pages that already scroll:** the Reports tab (its sections scroll in their own areas, phase 246-1; its M-Pesa Logs and invoice list are inside them), Order History (phase 225), the modals (phase 246 R1).
- **Choice made:** one scroll on the wrapper rather than one in each page. Every page, present and future, is then reachable, including the ones with no list today; the pages keep their paging (ten to a page) and their own layout. The Reports tab fills the height it is given, so it never scrolls at the wrapper and keeps its own areas.

## What changed

| Where | What |
| --- | --- |
| [App.tsx](../src/renderer/src/App.tsx) | The element that holds `AdminScreen` is `touch-scrollbar min-h-0 flex-1 overflow-y-auto p-6` (the always-visible bar of phase 220), not `overflow-hidden`. The comment that explained the old choice is replaced. |
| [noUnexpectedScroll.test.ts](../tests/noUnexpectedScroll.test.ts) | `App.tsx` moves from the "no scroll at all" list to the allow-list at exactly 1. |

Nothing else: no page, report, schema, IPC or main-process file.

## Tests

[adminScrolls.test.ts](../tests/adminScrolls.test.ts), 2 tests: the Admin wrapper in `App.tsx` scrolls vertically, has the always-visible bar and `min-h-0 flex-1`, and is not `overflow-hidden`; the Reports tab still fills the height it is given (`h-full min-h-full`, `flex flex-col`).

### Mutation check (restored; `App.tsx` compared byte for byte afterwards)

| # | Mutation | Failing tests |
| --- | --- | --- |
| 1 | The wrapper back to `overflow-hidden` | 2: `the Admin wrapper > scrolls vertically…` and `noUnexpectedScroll > App.tsx has exactly its allow-listed count` |

## Existing tests changed

| Test | Old | New |
| --- | --- | --- |
| `noUnexpectedScroll.test.ts` | `App.tsx` had no vertical scroll class | `App.tsx` has exactly 1 |

## Not verified

- **Nothing was run on a till or in the app.** jsdom has no layout, so that a long list now scrolls is pinned by the wrapper's classes, not measured.
- **The Reports tab inside a scrolling wrapper** should never show the wrapper's bar, since it fills the height exactly; a rounding of a pixel could show one. For the owner to see on the till.

## For the owner to check on the till after install

1. Admin > Needs Attention with many rows, Stock Take with a long counted list, System, Peripherals > Printers with several printers: scroll with a finger and the bar shows.
2. Admin > Reports: no bar beside the page, only inside the open section.

## Observed but not changed

- **Pages still show ten rows to a page** (Needs Attention, M-Pesa logs, Stock Take lines): scrolling reaches the pager and the rest of a page, it does not replace the paging.
- **Pop-up windows** (the manager PIN, the keyboard) are not part of this: they were made to fit or scroll in phase 246.

## Rollback

Revert the commit. It changes one class list and one test allow-list.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 231 files passed, 1 skipped (the rehearsal); 3,794 tests passed, 9 skipped (8 rehearsal, 1 build-freshness) |
| `npm run build` | passed, `verify-no-mock-provider` confirmed |
| Installer | not built |
