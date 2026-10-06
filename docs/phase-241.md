# Phase 241 — End of Day: filter the report by shift

- **Date:** 2026-10-06
- **Asked by the owner:** "Could you add ability to filter end of day reports via shift?"
- **Status:** built and tested. Not released (2.2.6 is built and unpublished; this is not in it).
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.** One new row of buttons under the End of Day title, a changed title and sentence while a shift is chosen, and the approve bar's text.
- **Not changed:** checkout, fiscal and Shopify code, the approval itself (`reports:approve-day`, `approveMpesaEntries`), the day's carry-over rule, shifts, Z reports, the Window report. Nothing is written by the filter.

## 1. Audit

- The End of Day report is built by `generateEndOfDayReport(db, localDay)` in `reports.ts`: the day's orders (`getOrdersForDateRange`), their cashiers' totals, the day's manual M-Pesa entries, and carry-over (unapproved manual entries from earlier days). It knew nothing of shifts.
- A report is for a **Nairobi calendar day**; a shift can run across midnight (a Night), so a shift filter has to be "this day **and** this shift", not a replacement for the day.
- **Approving** (`reports:approve-day`) takes the ids the screen sends and records a review for the whole day. It does not use `generateEndOfDayReport`. A limited list approved as if it were the day would record a day review that skipped the other shifts' entries, so the limited view is for reading.
- `orders.shift_id` is the only link from a sale to a shift (phase 232 gives every sale one), and a payment's shift is its order's.

## 2. What changed

| Where | What |
| --- | --- |
| [reports.ts](../src/main/services/reports.ts) | `generateEndOfDayReport(db, localDay, shiftId = null)`. With a shift: the shift's own sale ids (`getOrdersForShift`) cut the day's orders (and so the cashier rows and totals), the day's M-Pesa payments and the carry-over, all by `order_local_id`; the pending list and total cover only what is shown. A shift that does not exist throws `Shift N not found`. New fields: `shiftId` (the filter in force, or `null`) and `shiftsOfDay` (every shift with sales that day, with its window, hours and that day's sale count, whatever the filter, so the choice can be changed). Both are optional in the type, so an older answer still works. |
| [ipcValidator.ts](../src/main/lib/ipcValidator.ts), [index.ts](../src/main/index.ts), preload | `reports:end-of-day` takes an optional positive whole `shiftId`; the handler passes it on. `getEndOfDayReport(localDay?, shiftId?)`. |
| [EndOfDayPage.tsx](../src/renderer/src/pages/EndOfDayPage.tsx) | A row of buttons under the title: **All shifts** and one for each shift of the day, `#4 Night, from 17:43, open (1 sale)`. Choosing one asks for that shift; All shifts asks for the day again. Changing the day forgets the shift. While a shift is chosen: the title says `— shift #4`, the sentence says `Showing shift #4 only. To approve entries, choose All shifts.`, the tick boxes are gone, and the bar says `Shift #4 only: 1 pending entry, Ksh 60.00. Approving is done from All shifts.` with the button off (`All shifts to approve`). A call for the whole day is the call it always was (no second argument). |

Chosen design points (not asked; changeable):

1. **Day and shift together.** A Night shows its part of each day. A shift with no sales that day shows an empty report, not the whole day.
2. **Read only while limited.** Approving stays a whole-day act.
3. **Sales with no shift** have no button; they are in All shifts (phase 232 gives every sale a shift at the next start, open, close or Shift History visit, so there are normally none).

## 3. Tests

[endOfDayShiftFilter.test.ts](../tests/endOfDayShiftFilter.test.ts), 13 tests on real in-memory SQLite: three shifts around 5 Oct (a Night from 4 Oct, a Day, a Night into 6 Oct), two cashiers, manual and Daraja M-Pesa, a carry-over entry, a voided sale and a sale with no shift. The whole day is unchanged; each shift shows only its sales, cashiers and entries; carry-over belongs to its shift; a Night is cut by day; **the shifts plus the sale with no shift add back to the whole day**; voided never counted; an empty shift is empty; an unknown shift throws; the filter writes nothing; the request schema; the handler passes the shift and the approve handler knows nothing of it.

[endOfDayShiftFilterUi.test.ts](../tests/endOfDayShiftFilterUi.test.ts), 8 tests: the buttons and their text, the unchanged call for a whole day, choosing a shift, no tick boxes and a disabled approve while limited, back to All shifts, the day change forgetting the shift, no row when the day has no shifts, and an older answer with no shift list.

### Mutation checks (each restored)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | The day's orders are not cut by shift | caught, 5 tests, e.g. `shows only that shift's sales, cashiers and manual M-Pesa entries that day` |
| 2 | Carry-over not cut | caught, 3, e.g. `keeps the carry-over that belongs to the shift, and drops the rest` |
| 3 | Manual entries not cut | caught, 2, e.g. `leaves out the other shift's Daraja payment and the unattached sale` |
| 4 | A limited report can be approved (button not disabled) | caught, 1: `cannot approve a limited report…` |
| 5 | The shift is not passed to the main process | caught, 1: `reaches the report from the handler…` |

## 4. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 217 files, 3624 passed, 1 skipped (the build-freshness check), 0 failed |
| Existing tests | none changed; the earlier End of Day tests pass as they were |

## 5. For the owner to check on the till

1. End of Day shows **All shifts** and a button per shift that had sales that day.
2. Choosing a shift narrows the cashier table, the manual M-Pesa entries and the carry-over to it, and the approve button turns off.
3. All shifts brings the whole day and Approve back. Previous day and Next day reset the choice.
4. A Night that runs past midnight shows only its own part on each day.
5. Layout.

## 6. Observed but not changed

- The **printed** or exported end-of-day report: there is none (the screen is the report).
- The "Held sales discarded" block is a whole-day list and is not cut by shift (a held sale has no shift).
- Approving per shift is not offered: a day review is for the day. It could be added with its own rule for what a partial review means.

## 7. Not verified

Anything on a till; the layout of the new button row; a very long list of shifts in one day (the row wraps).

## 8. Rollback

Revert the commit. The filter disappears; nothing stored changed.
