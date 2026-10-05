# Phase 220 — End of Day: entries scroll, the action bar is pinned; the "Admin" title goes

- **Date:** 2026-10-05
- **Requested:** the owner's End of Day design (top card fixed, middle scrolls, bottom bar pinned), pagination removed from that page, the redundant "Admin" title removed, and a read-only sweep of the other Admin pages. This replaces the earlier phase 220 brief.
- **Status:** built and tested.
- **Layout: to be checked by the owner on the till.** `check:fit` was not run and not extended (standing rule). The layout unit tests that run inside `vitest` were run.
- **Not changed:** what End of Day calculates or approves, `reports:approve-day`, `approveMpesaEntries`, the report, Close Shift, every other Admin page.

## 1. Audit

- The page ([EndOfDayPage.tsx](../src/renderer/src/pages/EndOfDayPage.tsx)) was a `space-y-4` stack in a root that never scrolled (`overflow-hidden` all the way up, [App.tsx](../src/renderer/src/App.tsx)). Three lists were paginated: manual entries and carry-over at 6 a page, discarded held sales at 3. The action bar was the last block, so on a long day it was pushed off the screen and unreachable.
- The no-scroll rule is `tests/noUnexpectedScroll.test.ts`. It **has** an allow-list (`ALLOW_LIST`, an exact count per file), so no stop was needed. `EndOfDayPage.tsx` was in `ZERO_SCROLL_FILES`.
- The "Admin" title is a plain heading in App.tsx's Admin branch, above `AdminScreen`. `AdminScreen` itself never rendered one.

## 2. What changed

| Where | Change |
| --- | --- |
| [EndOfDayPage.tsx](../src/renderer/src/pages/EndOfDayPage.tsx) | Root is `flex min-h-0 flex-1 flex-col`. **Top card** `shrink-0`. Error and notice lines `shrink-0`, under the top card (so a result is never scrolled out of sight). **Middle** `touch-scrollbar min-h-0 flex-1 space-y-4 overflow-y-auto pr-2` holds held sales discarded, Per cashier, Manual M-Pesa entries, Carry-over. **Bottom bar** `shrink-0`, after the scroll region and outside it. Pagination removed: the three `paginate` calls, their page state and setters, both page-size constants and the pagers are gone; every row renders. |
| The bar | **Two rows.** Row 1: "Approving N of M entries. N left out." and the total. Row 2: the note field (takes the width left) and the button at a fixed `w-48` on the right. The visible "Note for this review (optional)" label is gone: the field has it as `aria-label`, and the keyboard still shows the same label. The button reads `Approve` / `Record review` / `Nothing pending` / `Working…` as before (see section 6). |
| Fade | A `bg-linear-to-t from-slate-50` overlay, `pointer-events-none`, `aria-hidden`, sits over the bottom of the middle region only while more is below. New hook [useMoreBelow.ts](../src/renderer/src/lib/useMoreBelow.ts) measures after every render, on scroll and on window resize. |
| Scrollbar | New `touch-scrollbar` utility in [index.css](../src/renderer/src/index.css): 20 px wide, dark thumb on a light track, always shown. Nothing hides a scrollbar. |
| [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) | Its root gets `flex flex-col` **only when the End of Day tab is open**, so the page can take the height under the breadcrumb. Every other tab's root is byte-for-byte the class it had. |
| [App.tsx](../src/renderer/src/App.tsx) | The Admin title is removed (quoted below). The wrapper's padding goes from `px-6 pb-6` to `p-6`, so the top spacing the title row used to give is kept. About 44 px of height is returned to every Admin page. |
| [noUnexpectedScroll.test.ts](../tests/noUnexpectedScroll.test.ts) | `EndOfDayPage.tsx` moved from `ZERO_SCROLL_FILES` to `ALLOW_LIST` with count 1. Old: not listed in the allow-list, expected 0. New: `1`, with the note "End of Day entries, owner's design, 2026-10-05". No other file's entry changed. |

**The element removed** (App.tsx, the Admin branch):

```tsx
<h2 className="shrink-0 px-6 pt-6 pb-4 text-lg font-semibold text-slate-700">Admin</h2>
```

The header tab (`<button>Admin</button>`, still asserted by `headerLayout.test.ts`) and the breadcrumb's Admin crumb (reads "Back to Admin") are untouched.

**Behaviour that did not change.** Approve day still approves exactly `report.pendingIds` (in the report's order, minus any ticked off); it asks for the manager PIN; a second press that the main process answers with `alreadyApproved` still shows "Already approved …"; it is disabled and reads "Nothing pending" when nothing is pending. The note field is still read-only and opens the docked on-screen keyboard.

## 3. Existing assertions changed (all of them)

| Test | Old | New |
| --- | --- | --- |
| `endOfDayPage.test.ts`: `ticks and reasons survive paging back and forth` | 7 entries; untick the first on page 1; press `Next`, see `REF6000000`, press `Previous`; the untick is still there | Renamed `shows all seven entries with no paging, and an untick keeps its choice`. Untick the first; all seven are on the page (`REF6000000` visible), no `Page 1 of`, no `Next` button; the first is unticked and the last still ticked. |
| `heldSalesUi.test.ts`: `is paginated like the page's other lists, three rows a page …` | 8 discarded sales gave 3 rows and `Page 1 of 3` | Renamed `lists every row in the scrolling part, with no paging`. 8 rows, no `Page 1 of`, and the section is inside the scroll region. |
| `noUnexpectedScroll.test.ts` | End of Day in `ZERO_SCROLL_FILES` | In `ALLOW_LIST` at 1 (section 2). The test count stays 24 (3 + 21 became 4 + 20). |

One helper changed with no assertion touched: `stubApi` in `endOfDayPage.test.ts` now also stubs `getDiscardedHeldSales` (an empty list unless a test passes one). Before, that call threw and the page showed its "could not load" section in every test.

No other assertion was changed and no unrelated test broke. `adminBreadcrumbs.test.ts` ran unmodified.

## 4. New tests

`endOfDayPage.test.ts` now has 12 more tests (14 → 26), in `EndOfDayPage layout (docs/phase-220)`:

- With **no entries** and with **50 in every list** (50 manual, 50 carry-over, 50 discarded, 50 cashiers): the bar comes after the scroll region, is not inside it, and Approve sits in the bar.
- The top card and both day buttons sit before the scroll region, outside it.
- The page root is a flex column that fills its parent; the scroll region is `flex-1 min-h-0`; the bar is `shrink-0`.
- **The scroll region is the only element whose class gives vertical overflow auto or scroll** (checked over every element of the busy page).
- A visible scrollbar class is on it, and no hiding class.
- All 100 checkboxes, 50 discarded rows and 200 table rows render in the scroll region; no `Page n of`; the bar reads "Approving 100 of 100 entries. 0 left out." and the total; the counts follow ticks (98 of 100 after two).
- Approve from the bar sends `approvedIds` equal to `report.pendingIds`, with the PIN and manager id; after approving, the reloaded day reads "Nothing pending" and the button is disabled. (The PIN dialog, "already approved" and the exclusion rules stay covered by the existing tests, which pass unchanged.)
- The note field opens the docked keyboard from the bar.
- The fade is absent at first, appears when the region has more below, and goes at the bottom (`scrollHeight`, `clientHeight` and `scrollTop` are set by hand: jsdom has no layout).

New `tests/adminTitleRemoved.test.ts`, 5 tests: App.tsx has no heading reading "Admin" and keeps the header tab button; the Admin card grid, Overview, Reports and End of Day (mounted) show no heading reading "Admin" and keep "Back to Admin" as the first crumb. The other sections were not mounted: `AdminScreen` does not render the title in any section, and the title lived in one place in App.tsx.

## 5. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean (node and web) |
| `endOfDayPage` | **26** passed (14 before) |
| `endOfDayReport` | **21** passed |
| `adminBreadcrumbs` (unmodified) | **8** passed |
| `adminPeripheralsUpdates` | **10** passed |
| `noUnexpectedScroll` | **24** passed |
| `screensFitDesignBox` | **8** passed |
| `belowLgUnreachable` | **12** passed |
| Also run: `heldSalesUi` | 37 passed |
| Full suite | **199 files, 3290 passed, 1 skipped** (3291 tests). Phase 219 left 198 files and 3274 tests, so this adds 1 file and 17 tests (12 + 5). |

**Layout: to be checked by the owner on the till.** What the unit tests cannot show: real heights, the 20 px scrollbar, the fade on screen, touch scrolling, and how the docked keyboard sits over the bar. Two things to look at specifically: the sections inside the scroll region keep `overflow-x-auto` for wide tables, which the browser turns into `overflow-y: auto` too. They are as tall as their content, so they should never scroll by themselves; if a swipe on a table ever seems to stick, that is where to look. And the scrollbar styling is the Chromium (Electron) kind; it was not seen rendered.

### For the owner to check on the till

1. Admin, End of Day, on a busy day: Approve is at the bottom and visible without scrolling.
2. Swipe the entries: only the middle moves. The top card and the bottom bar stay put.
3. Scroll to the last entry: nothing is cut off under the bottom bar.
4. Tap the note field: the keyboard opens. Close keyboard brings the bar back with the note kept.
5. No Admin page shows "Admin" except the breadcrumb and the header tab.

## 6. Observed, not changed

- **The button says "Approve", not "Approve day".** The brief names it "Approve day", but the page's label has always been `Approve` (`Record review` when every entry is left out) and the existing tests find it by that text. Changing it would change assertions the brief says not to touch, so it is unchanged. Say if you want the words changed.
- The note field has no visible label any more (the brief asked for two rows). The placeholder "e.g. checked against the statement" is what shows. If staff find it unclear, a short visible "Note" before the field costs no height.
- When the docked keyboard covers the bar (accepted in the brief), the error and notice lines under the top card stay visible, so an approval result is not hidden by it.
- `scripts/check-fit.mjs` was not opened or changed. If it still holds a case for End of Day paging or for the Admin heading, it is out of date now; that is for the owner to decide, by the standing rule.

## 7. Read-only sweep: Admin actions that sit below a list that can grow

From the code only; nothing measured, nothing fixed. "Off screen" means pushed below the visible part of an Admin page, which does not scroll (App.tsx keeps `overflow-hidden`) and has no pager of its own for that part.

| Page | Main action | Below what | Can it be pushed off screen? |
| --- | --- | --- | --- |
| **Stock Take**, commit | "Push this correction to Shopify…" and then "Yes — push to Shopify" ([StockTakePage.tsx:620](../src/renderer/src/pages/StockTakePage.tsx#L620)) | The "What this will change in Shopify" table, **one row per counted item, not paginated** (`preview.lines.map`, [line 582](../src/renderer/src/pages/StockTakePage.tsx#L582)), under the counted-lines section | **Yes, unbounded.** The counted-lines table above it is paged at 10, but the preview is not, so a count of more than a few items pushes the commit button off screen, with no way to reach it. This is the same shape as End of Day was. |
| **Stock Take**, submit | "Submit for approval", "Review against Shopify", "Discard" ([line 526](../src/renderer/src/pages/StockTakePage.tsx#L526)) | The counted-lines table, **10 rows a page** plus its pager, under the search and count entry | **Likely, bounded.** The list is capped at 10 rows, but 10 rows, the pager, the search box, match chips and the count field together are probably taller than the screen. Not measured. |
| **Reports**, export | "Export orders CSV" / "Export lines CSV" ([ReportsPage.tsx:626](../src/renderer/src/pages/ReportsPage.tsx#L626)) | Only the title, the range buttons and an optional one-line status. **No list.** | **No**, apart from a very long error message. |
| **Needs Attention**, resend | "Resend" and "Correct PIN & Resend" on each row ([NeedsAttentionPage.tsx:290](../src/renderer/src/pages/NeedsAttentionPage.tsx#L290)) | The Shopify check card, then **two unpaginated lists**: "Tax invoices not printed" (`unprinted.map`, [line 205](../src/renderer/src/pages/NeedsAttentionPage.tsx#L205)) and "VAT figures to reconcile" (`vatMismatches.map`, [line 237](../src/renderer/src/pages/NeedsAttentionPage.tsx#L237)), then the rows, 10 a page | **Yes.** The Resend buttons are per row, and the rows sit below two lists that have no limit. "Print tax invoice" is itself a button inside the unbounded first list. Even with both lists empty, 10 rows of about 100 px or more plus the card is probably taller than the screen; the lower rows' Resend buttons can be off screen. Not measured. |
| **Overview**, Shift Controls: Close Shift | "Close Shift" and then "Confirm" ([AdminScreen.tsx:2485](../src/renderer/src/components/AdminScreen.tsx#L2485)) | Today's Sales (fixed size, no list) above it; **Staff** (below it) | **Not by a list above it.** Shift Controls is the second block, after a fixed-size summary. The growing list (Staff) is below it. It would only be pushed off by the shift note, an error line, or the open form taller than expected. |
| **Overview**, Staff: add | "+ Add Staff" at the top of the Staff card, then "Create" in the form ([line 2536](../src/renderer/src/components/AdminScreen.tsx#L2536), [2577](../src/renderer/src/components/AdminScreen.tsx#L2577)) | The button is at the **top** of the card; the staff list (`staffList.map`, one row per account, unpaginated) is **below** it, as is "Reset PIN" on each row | "+ Add Staff" and "Create" are not pushed by the list (it is under them). **But the list itself can run off the bottom** (the page does not scroll), so staff at the end of a long list, and their Reset PIN, cannot be reached. Also: Staff sits under Today's Sales and Shift Controls, so even a short list starts low. |
| **Peripherals › Printers**, add | "Add Printer" ([AdminScreen.tsx:1666](../src/renderer/src/components/AdminScreen.tsx#L1666)) | The registered-printers list (`printers.map`, **unpaginated**), and on Windows the "Connection" row and the found-printers grid, all **above** the add form | **Yes, but only for a long list.** Each printer row is about 70 px; a till normally has a handful, so this is unlikely in practice. With "Windows printer" selected and many queues found, the grid grows too. The add form is the last block, so it is the first thing to leave the screen. |

**Reading of the sweep.** The two that match End of Day's problem are **Stock Take's commit** (its preview table is not paged) and **Needs Attention** (two unpaginated lists above the Resend rows). Staff has the growing list under its Add button rather than over it, but the list's own tail is unreachable. Reports export is safe. Printers is at risk only with an unusual number of printers. The owner decides which to take next; the same three-part layout (fixed top, scrolling middle, pinned bar) fits Stock Take and Needs Attention directly.

## 8. Rollback

Revert this commit. End of Day goes back to the stacked, paged page; the "Admin" title returns; `noUnexpectedScroll` lists End of Day as zero again. Nothing stored, no setting, no IPC and no schema changed.
