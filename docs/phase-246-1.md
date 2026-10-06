# Phase 246-1 — The Reports tab as a fixed scope picker over a row of section cards

- **Date:** 2026-10-06
- **Asked by the owner:** the layout of the Reports tab: the one scope picker fixed at the top; under it five cards in a row (Takings, Checks, Detail, Shifts, plus the Z report when a shift is picked), each with one headline figure; a tap opens that section alone beneath the row, with its own scroll area and its actions (Print, Approve, Move a sale) in a fixed bar at the bottom; another tap swaps it; Takings is open at first. The scope, the picker and every report call stay as built: layout only, no calculation or IPC change.
- **Status:** built and tested in one commit. Not released: no installer built. `package.json` stays at 2.2.9.
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.**
- **First rule, kept:** no report calculation moved or was rewritten, no IPC channel, schema or main-process file changed. Every report is asked for once per scope, with the same arguments as in phase 246, and tapping a card asks for nothing.

---

## Audit

- **Where the layout lives:** all of it in [ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx). In phase 246 the tab was one column of five numbered sections inside one scroll area (`reports-scroll`); the Z report sat beside the sales summary; Shift History had its own box (`h-[34rem]`) with its rows scrolling inside it.
- **The actions were not where a bar could take them:** Print Z-Report and Correct figures come from `ZReportBlock`'s footer; Approve is inside `ShiftEndOfDay`; Move a sale and the pager are inside Shift History. Each belongs to a component that owns its state, so the bar is filled by a portal, not by moving the state.
- **The headline figures need data of sections that are not open.** Unmounting a closed section would have meant asking for its report a second time to word its card. The sections are therefore kept mounted and hidden: each asks for its report once, exactly as today, and tells the page the one figure its card shows.
- **Rules in the way:** `noUnexpectedScroll.test.ts` holds `ReportsPage.tsx` at exactly 2 scroll classes (the page's own and Shift History's rows). The owner asked for that count to stay. It does: 2 is now the one scroll area every section shares, and Shift History's rows inside the Shifts section.
- **The scope list had to change.** It used to open inline and push the page down, which was fine while the page scrolled. With a page that does not scroll it would push the cards and the open section out of view, so it drops over the cards as a list of its own.
- **Tests that mount the page:** `reportsPage`, `shiftHistoryPagingUi`, `shiftCaptureUi`, `oneShiftPerWindowUi`, `frozenShiftsUi`, `autoMergeWindowsUi`. Five of them reach Shift History; they now tap its card.

## What changed

| Where | What |
| --- | --- |
| [ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx) | The tab is a column of a height it is given: the scope card (`shrink-0`), the row of cards (`role="tablist"`, `shrink-0`), then the sections. `SectionPanel`: a scroll area (`touch-scrollbar min-h-0 flex-1 overflow-y-auto`) and, below it and not in it, the fixed bar `section-actions-<key>` (`shrink-0 border-t empty:hidden`, so a section with no actions takes no room). Only the open panel has a size; the others are `hidden`. `SectionCard`: the section's name and its headline. Takings is open at first; if the Z report is open and the scope stops being a shift, the page goes back to Takings. Numbered headings and `reports-scroll` are gone. |
| [ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx), the sections | `TakingsSection` shows the sales summary only; the Z report is read once by the page (same `getZReport(shiftId)` call) for its own section and for the count note. `ZReportSection` is the same `ZReportBlock` as the Z window, with its footer in the bar. Shift History fills its section; Move a sale and the pager are in the bar. The Checks section holds End of Day, fiscal status and fiscal reconciliation, as before. |
| [SectionActions.tsx](../src/renderer/src/components/SectionActions.tsx) (new) | `SectionActions` draws its children in the bar of the section it is in, through a portal. Where there is no bar around (a component mounted alone) it draws them where it stands, so every component keeps working alone. |
| [reportHeadlines.ts](../src/renderer/src/lib/reportHeadlines.ts) (new) | The words of each card from what the main process already returned. It counts rows (`pendingIds`, the shifts in state `not-approved`) and works out nothing else. |
| [ShiftEndOfDay.tsx](../src/renderer/src/components/ShiftEndOfDay.tsx), [ShiftApprovalList.tsx](../src/renderer/src/components/ShiftApprovalList.tsx), [ZReportBlock.tsx](../src/renderer/src/components/ZReportBlock.tsx) | Each tells the page what it holds (`onReport`, `onRows`, `onReportChange`), all optional, so a card stays true after an approval or a correction. `ShiftEndOfDay`'s note and Approve are drawn through `SectionActions`; its border went, because the bar has its own. |
| [ScopePicker.tsx](../src/renderer/src/components/ScopePicker.tsx) | The list drops over the cards (`absolute inset-x-0 top-full z-30 max-h-96 overflow-y-auto`) and scrolls in its own box if it is taller than the screen. Its choices, its pager of shifts and its custom range are unchanged. |

### The cards and their headline figures

| Card | Headline | Comes from |
| --- | --- | --- |
| Takings | `Revenue Ksh 1,250.50` | `getSalesSummary(scope).totalRevenue` |
| Z-Report (a shift scope only) | `Cash difference -Ksh 5.00`; `Cash not counted`; `Shift open` | `getZReport(shiftId)` (`discrepancy`, `cashNotCounted`) |
| Checks, a shift | `2 entries to approve`; `Nothing to approve`; `Approved`; `Cannot approve yet` | `getShiftEndOfDayReport(shiftId)` (`pendingIds`, `approval`, `canApprove`) |
| Checks, a period or range | `2 shifts to approve`; `Nothing to approve` | `getEndOfDayShifts(scope)` (shifts in state `not-approved`) |
| Detail | `5 sales` | the same summary's `orderCount` |
| Shifts | `Shift #8 open`; `No shift open` | the first page of `getShiftsList` |

Each shows `…` until its report has come.

## Not changed

Every report function, every IPC channel and handler, the main process, the database, the Z report's content, the End of Day arithmetic, approval, the freeze rules, Shift History's pager and rows, Move a sale, Merge, the correction form, the Z report window, Export CSV, M-Pesa Logs (the latest 50, unscoped), the scope rules (R3) and the report scopes themselves. Not one file under `src/main` or `src/preload` is touched.

## Tests

[reportsCardsUi.test.ts](../tests/reportsCardsUi.test.ts), 22 tests:

- **The cards:** four for a period, five with a shift in the order Takings, Z-Report, Checks, Detail, Shifts; the picker outside the row and the sections; Takings open at first and only Takings; one section open at a time and one card selected, for every card in turn; back to Takings when the scope stops being a shift while the Z report is open; what a section holds survives a swap (an entry left out stays left out, and the bar says 1 left out); tapping every card asks no report again (the calls made were once for Today and once for the shift, and the same after the taps).
- **The headline figures:** each card as the main process returned it, including a period's Checks, the open shift, nothing open, an approved shift, and the wording of every case in the library.
- **The actions:** Print Z-Report and Correct figures, Approve, and Move a sale with the pager are each in the bar of their section and not in its scroll area; with a list of 200 entries (End of Day) the Approve bar is in the document, outside the scroll area, and the scroll area holds the 200 rows; a section with no actions has an empty bar that takes no room.
- **The scroll areas:** each section has one scroll area with the always-visible bar, the bar is its sibling, the closed sections are hidden, no `.reduce(` on the page or in the headline library, the scope list drops over the cards.

### Mutation checks (each restored; the file compared byte for byte afterwards)

| # | Mutation | Failing tests |
| --- | --- | --- |
| 1 | Two sections open at once (Checks stays open beside Takings) | 4: `opens on Takings, and only Takings`, `opens one section at a time…`, `goes back to Takings when the scope stops being a shift…`, `hides a section that is not open…` |
| 2 | The action bar inside the scroll area | 6: the Z, Checks and Shifts action tests, the 200-row Approve test, the shared scroll-area test, and Shift History's own 200-row test |
| 3 | Takings not open by default | 2: `opens on Takings, and only Takings`, `hides a section that is not open…` |
| 4 | A scroll class added to the page | 1: `noUnexpectedScroll > ReportsPage.tsx has exactly its allow-listed count` |

## Existing tests changed (each with an old/new note in the file)

| Test | Old | New |
| --- | --- | --- |
| `reportsPage.test.ts`, "is five numbered sections…" | five numbered headings | the picker over four cards |
| `reportsPage.test.ts`, "shows, for a shift, its Z report beside the summary…" | the Z report beside the summary, Print in the block | its own card and section, Print in the section's bar |
| `reportsPage.test.ts`, "scrolls as a whole…" | the whole page scrolled, the picker with it | the picker is outside every section, each section has its own scroll area |
| `reportsPage.test.ts` (10 more) | read Checks, Detail and Shifts without a tap | tap the card of the section first (`openSection`); no assertion changed |
| `shiftHistoryPagingUi.test.ts` (2 tests, 1 assertion) | the buttons beside the scroll area in the history's own section; the history a box of `h-[34rem]` in the tab's scroll | the buttons in the section's bar; the history `h-full min-h-0` in the section's scroll area |
| `shiftCaptureUi`, `oneShiftPerWindowUi`, `frozenShiftsUi`, `autoMergeWindowsUi`, `shiftHistoryPagingUi` | Shift History was on the page when it mounted | their open helper taps the Shifts card |
| `noUnexpectedScroll.test.ts` | no entry for the scope list | `ScopePicker.tsx` allow-listed at exactly 1; `ReportsPage.tsx` stays at 2 (only the comment changed) |
| `helpers/reportsTabApi.ts` | the stubs | and `openSection(container, key)` |

## Decisions the owner should know

1. **Closed sections are hidden, not removed.** They are mounted from the start, each asking for its report once, as before. That is how a card knows its figure while its section is shut, and it means an admin who has unticked an entry, then looks at Takings, finds the tick as it was. Closing a section does not ask again.
2. **The Z report card is second,** next to Takings, which it belongs with. It exists only while the scope is one shift.
3. **Detail's headline is the number of sales** of the scope, taken from the sales summary: the Detail section asks for nothing until a part of it is opened, so it has no report of its own to word.
4. **A period's Checks counts shifts, a shift's counts entries.** "N entries to approve" exists only for one shift (approval is per shift); for a day, week or range the figure is the number of shifts still awaiting approval.
5. **Shifts' headline reads the first page** of Shift History (newest first, the open shift on top). A later page of the history says nothing about it, so paging does not change the card.
6. **The scope list is a drop-down over the cards,** which gave `ScopePicker.tsx` one scroll class of its own (allow-listed). `ReportsPage.tsx` keeps its 2.
7. **Shifts holds a scroll inside the section's scroll.** The history fills its section, so the section's scroll area never scrolls there and the rows scroll in the history's own box, as in phase 245.
8. **Export CSV's two buttons stay in the Detail body,** not in the bar: they belong to the Export part, which is shut until opened.

## Not verified

- **Nothing was run on a till or in the app.** The heights are the open point: the scope card, the row of cards and the bar take room from a screen of 772 px, so the open section's scroll area is what is left. Whether that is enough for the Z report, End of Day and Shift History is for the owner to see on the till.
- **The scope list over the cards:** that nothing in the Admin screen's frame clips a list that drops past the picker's card is for the till.
- **The empty bar:** `empty:hidden` is Tailwind's; jsdom has no styles, so the tests pin that the bar has no children and carries the class, not that it is invisible.

## For the owner to check on the till after install

1. Reports opens on Takings, with the picker at the top and four cards under it; the picker does not scroll away when a section scrolls.
2. Pick a shift: a fifth card, Z-Report, appears second; its section shows the report with Print Z-Report and Correct figures fixed at the bottom while a long report scrolls.
3. Checks on a shift: the entries scroll, Approve and the note stay at the bottom; the card says how many entries are waiting, and says Approved after approving.
4. Tap Shifts: the open shift is named on the card; the rows scroll, Move a sale and Previous / Next stay at the bottom.
5. Tap Takings, then Checks again: an entry left unticked is still unticked.
6. Change scope: the list drops over the cards and closes when one is picked.

## Observed but not changed

- **`reports:end-of-day`, `generateEndOfDayReport` and `getEndOfDayReport`** are still unused by any screen (phase 246).
- **The invoice list and the fiscal tables** page inside their own section's scroll, as they paged inside the old page's.

## Rollback

Revert the commit. It touches only the renderer and tests; nothing was written to a database and no file under `src/main` or `src/preload` changed.

## Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 230 files passed, 1 skipped (the rehearsal); 3,792 tests passed, 9 skipped (8 rehearsal, 1 build-freshness) |
| `npm run build` | passed, `verify-no-mock-provider` confirmed |
| Rehearsal on the 1606 copy | not run: nothing it reads changed |
| Installer | not built, by instruction |
