# Phase 245 — Shift History paginated and scrollable, newest first

- **Date:** 2026-10-06
- **Asked by the owner:** Shift History newest first, always; pages of 10 with Previous / Next and "Page X of Y", opening on page 1, one page from the main process; the list scrolls inside its own area while the title, Move a sale and the pager stay fixed (the End of Day pattern); nothing else changes.
- **Status:** built and tested. Not released: no installer built. Version in `package.json` is 2.2.8 (`d89c54b`).
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.**
- **Not changed:** the row contents, the buttons and tags, the Z report, Move a sale, Merge, Correct figures, the status tags, the other Reports sub-views.

## 1. Audit: what was already true

| Rule | Before this phase |
| --- | --- |
| Pages of 10, server-side, with the total | Already so (phase 158): `reports:shifts-list` takes `page`, reads `listVisibleShifts(REPORTS_PAGE_SIZE = 10, offset)` and `countVisibleShifts()`; the screen asks for one page. |
| Page 1 on open | Already so: `ShiftHistoryView` starts `page` at 1 and is mounted anew each time the sub-view is opened. Now pinned by a test. |
| Previous / Next, "Page X of Y" | Already so (the local `Pager`); it sat under the table, so it scrolled away with a long page. |
| Newest first | **Not true.** `listVisibleShifts` ordered by `id` descending, so a shift recorded later for an earlier time (the till makes such shifts, phase 232) came first, and an open shift was top only while it had the highest id. |
| Scroll area with fixed controls | **Not true.** The section grew with its rows; the title and pager scrolled with the page. |

## 2. What changed

| Where | What |
| --- | --- |
| [database.ts](../src/main/services/database.ts) | `listVisibleShifts` orders by `(status = 'open') DESC, clock_in DESC, id DESC`: the open shift first, then the time each shift began, newest first; the id only breaks a tie. `clock_in` is an ISO-8601 UTC string, so it sorts as time. `listShifts` (used by tests only) is unchanged. |
| [ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx) | Shift History's section is a column that fills the height it is given (`flex min-h-0 flex-1 flex-col`); the title row and the pager are `shrink-0`; the table sits in its own scroll area (`data-testid="shift-history-scroll"`, `touch-scrollbar`, `overflow-auto`, the always-visible 20 px scroll bar of phase 220), and the pager is outside it. The page root is that column only while Shift History is open; every other Reports sub-view keeps `space-y-4`. |
| [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) | The Reports tab gets the same column the End of Day tab already has (`flex flex-col`), so Shift History has a height to fill. |

The handler needed no change: it already returns one page and the total. To count shifts per window for the "Window report" tag it still reads the lightweight window list (id and `clock_in`) of every shift on the main-process side; that list is not sent to the screen and is not a page of shifts.

## 3. Tests

[shiftHistoryPaging.test.ts](../tests/shiftHistoryPaging.test.ts), 7 tests, real `:memory:` SQLite:
- a shuffled fixture (25 closed shifts inserted in an order that disagrees with their times, and an open shift with the oldest start and the lowest id): open first, then by time, newest first, and the order is not the id order;
- a shift recorded later for an earlier time sits where its time says; a tie breaks by id;
- pages of 10, 10 and 6 for 26 shifts, together exactly the whole list in order; the total is 26, and a page past the end is empty; a merged-away shift is left out of the pages and the total;
- the handler: page size 10, offset `(page - 1) * 10`, `listVisibleShifts(REPORTS_PAGE_SIZE, offset)`, `total: db.countVisibleShifts()`, never `listShifts`; `page` defaults to 1 and must be 1 or more.

[shiftHistoryPagingUi.test.ts](../tests/shiftHistoryPagingUi.test.ts), 8 tests, real mounts:
- opens on page 1, asks for page 1 only (one call), shows ten rows newest first; Next and Previous go a page at a time and call with 2, then 3, then 2; Previous is disabled on page 1 and Next on the last page; leaving and re-opening goes back to page 1; no pager for a single page;
- the scroll area holds the rows and nothing else; the title, Move a sale, Previous and Next are outside it and inside the section;
- the scroll area is `touch-scrollbar overflow-auto min-h-0 flex-1` in a column that fills its parent, and the Admin screen gives the Reports tab that column;
- with 200 rows rendered, Move a sale, Previous and Next are still in the document and outside the scroll area.

jsdom has no layout, so "fixed and visible" is pinned by structure and classes; the pixel result is for the owner to check on the till.

### Mutation checks (each restored; the three files compared byte for byte afterwards)

| # | Mutation | Failing tests |
| --- | --- | --- |
| 1 | Oldest first (`clock_in ASC, id ASC`) | 4: order, recorded-later, tie, pages |
| 1b | By id again (`ORDER BY s.id DESC`) | 3: order (shuffled), recorded-later, pages |
| 2 | Load all shifts (`listVisibleShifts(100000, 0)` in the handler) | 1: `the shifts-list handler > returns one page of ten and the total, never every shift` |
| 3 | The pager inside the scroll area | 2: `holds the rows and nothing else…`, `keeps the buttons in the document and outside the scroll area when 200 rows are rendered` |

### Existing tests changed (each with an old/new note in the file)

| Test | Old | New |
| --- | --- | --- |
| `autoMergeWindows.test.ts`, "shows the window once in Shift History" | the visible shifts were `[3, second]` (highest id first) | `[second, 3]`: shift 3 was made last but began on 4 Oct, so it is the older one |
| `noUnexpectedScroll.test.ts` | `ReportsPage.tsx` had no vertical scroll class | `ReportsPage.tsx` has exactly one, allow-listed like `EndOfDayPage` (phase 220) and `OrderHistory` (phase 225) |

Every other Shift History test (`oneShiftPerWindowUi`, `frozenShiftsUi`, `shiftOverrideUi`, `shiftCaptureUi` and the rest) passes unchanged.

## 4. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 225 files passed, 1 skipped (the rehearsal); 3,708 tests passed, 8 skipped (the 8 rehearsal tests). The build-freshness test, skipped when there was no fresh build, ran and passed after `npm run build` |
| `npm run build` | passed, `verify-no-mock-provider` confirmed |
| Installer | not built, by instruction |

## 5. Possible impact

- **Admin:** Shift History lists the open shift first and then the newest by time. Where the old order and the new differ is a shift made later for an earlier time, which now sits among the shifts of its own time. The list scrolls in its own box with a visible scroll bar and the title, Move a sale and the pager stay in view.
- **Reports tab:** the Admin screen's Reports tab is now a column like End of Day's. The card grid and the other sub-views are blocks as before; this is not checked on the real screen.
- **Data:** none. A read-only change plus layout.

## 6. Rollback

Revert the commit. Nothing stored changed.

## 7. Observed but not changed

- If a merge or a move leaves the page the admin was on empty (the last page shrank), the list says "No shifts recorded yet" until the admin goes back a page; the page is not pulled back. This is old behaviour.
- The handler still reads the window list of every shift on the main-process side to count shifts per window (phase 242). It is two small columns and never reaches the screen; replacing it with a count for the ten shown windows would be a separate change.
- The pager is hidden for a single page, so a lone page shows no "Page 1 of 1".

## 8. Not verified

Anything on a till; the layout, the scroll bar and the fixed controls at the till's resolution.
