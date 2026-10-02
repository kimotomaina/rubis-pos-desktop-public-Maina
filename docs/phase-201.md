# Phase 201 — Admin breadcrumbs on one row

- **Date:** 2026-10-03
- **Requested:** in the Admin page, show the breadcrumbs as a row (the "Back to Admin" and "Back to Integrations" links were stacked one above the other).
- **Outcome:** Implemented. Typecheck clean; vitest **182 files, 2928 tests, all passing** (181 and 2920 before); `npm run build` passes with the no-mock check. `check:fit` not run; no device calls.
- **Branch / base commit:** staging on top of `b6be387` (phase 200).

## 1. What was built

- New [Breadcrumbs.tsx](../src/renderer/src/components/Breadcrumbs.tsx): one `nav` with one `ol` on one row (`Admin › Integrations › Fiscal Device`). Each ancestor is a 56px-high button; the last item is plain text with `aria-current="page"`. An ancestor shows only its name but reads "Back to <name>" to a screen reader and in its `textContent`, the same words the old buttons had.
- [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx): the single "Back to Admin" button and the separate "Back to Integrations" button inside Integrations are replaced by one `Breadcrumbs` at the top, built from where the grids have been drilled to:
  - Admin card grid: no breadcrumb (unchanged).
  - A section (Overview, Reports and so on): `Admin › Section`.
  - Integrations grid: `Admin › Integrations`. Inside a section: `Admin › Integrations › Fiscal Device`.
- The Admin crumb also clears the open Integrations section, so after jumping straight from `Fiscal Device` to Admin, opening Integrations again starts at its grid, not inside the old section. Before, "Back to Admin" could not be tapped from inside a section, so this case did not arise.
- `BackButton.tsx` is unchanged and still used by the Reports page.

## 2. Tests

- **New: `tests/adminBreadcrumbs.test.ts`, 8 tests**, real mount: no breadcrumb on the Admin grid; `Admin › Overview`; all three levels on one `ol` (flex, not a column, three children, one `nav`); `Admin › Integrations` on the Integrations grid; visible text is the section name only and the current page is marked; the Integrations crumb goes back one level; the Admin crumb goes to the top grid and Integrations then opens at its grid; a section with no sub-level goes back to Admin.
- **Changed existing `expect()`: zero. No existing test file was touched.** `adminIntegrationsSections.test.ts` clicks "Back to Integrations" by exact text, which the new crumb still has.
- **Mutation:** the Admin crumb no longer clears the section: **1 failed** ("goes straight to the Admin grid from the Admin crumb, and Integrations then opens at its own grid"). Restored.

## 3. Flags

- **The Reports page still stacks.** Inside Reports, its own sub-views (Shifts, Sales Summary and so on) keep their separate "Back to Reports" button below the new row, because that state lives in `ReportsPage`. Making it one row (`Admin › Reports › Shifts`) means lifting that state into the Admin screen or passing the crumb down; not done, say if you want it.
- **Not seen on a screen.** The row is 56px high where the two stacked buttons were about 144px, so the Admin pages gain about 88px. Layout guards (`screensFitDesignBox`, `posCheckoutPanelFit`) pass.
- **The first crumb has no arrow icon,** unlike the old buttons; the `›` separators carry the direction.

## 4. Rollback

`git revert` the phase 201 commit. Nothing is stored or migrated.
