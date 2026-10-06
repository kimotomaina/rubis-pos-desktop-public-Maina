# Phase 237 — The Day shift starts at 07:00, the Night shift ends at 06:59

- **Date:** 2026-10-06
- **Asked by the owner:** "update the shift times to from 7 to 5.30, then from 5.30 to 7am; the first one was an error." Confirm first that the code can be changed that way.
- **Status:** built and tested. Not released: it goes in the next build after 2.2.5, or into 2.2.5 if that is rebuilt before publishing.
- **Layout: not checked by check:fit (owner's rule).** The only screen change is the label text (`Day shift (07:00 to 17:30)`, `Night shift (17:31 to 06:59)`), the same length as before.
- **Not changed:** any rule of phase 232 (one shift per window, close from the window's last minute, automatic assignment, Move a sale, the window report), the inclusive-minute convention, End of Day, reports, the database.

## 1. Audit: can it be changed that way? Yes.

- **The windows are four numbers in two files**: `DAY_SHIFT` and `NIGHT_SHIFT` in [src/main/lib/shiftWindows.ts](../src/main/lib/shiftWindows.ts) and the renderer twin [src/renderer/src/lib/shiftWindows.ts](../src/renderer/src/lib/shiftWindows.ts) (a copy because the renderer never value-imports from `main/`; `tests/shiftWindows.test.ts` runs both over the same inputs so they cannot drift). Everything else derives from them: `shiftTypeForTime`, `shiftWindowOf` (the bucket of a sale, phase 229), `sameWindow` (one shift per window), `windowClosableFrom` (S2), the labels, `shiftEndClock` (the "can be closed from" note), `isPastShiftEnd`, `autoAssign`, the window report and the window status the screens read. **No other `09:00` or `08:59` exists in `src/`**; the only other mentions were doc comments (`reports.ts`, `OpenShiftForm.tsx`).
- **The convention stays**: both ends inclusive by whole minute. Day is 07:00:00 to 17:30:59; Night is 17:31:00 to 06:59:59 the next morning, dated by the evening it starts. A Day shift can be closed from 17:30:00, a Night shift from **06:59:00**.
- **Stored shifts are safe.** The type is worked out from `clock_in` each time it is shown; the stored `shift_type` is only a label, and when it differs the screens say "Labelled Night when opened" (phase 232 W4). That mechanism exists for exactly this. No row is rewritten.
- **Sales between 07:00 and 09:00 with no shift** now belong to the Day window. The first-start assignment of 2.2.5 has not run on any till (the dry run is still outstanding, release-2.2.5 §3), so it will run with the corrected boundary.
- **One theoretical edge:** a shift opened between 07:00 and 09:00 *under the old rule* would now compute as that date's Day; if another Day shift was also opened later that date, the window has two shifts. Nothing breaks: the window report lists both, assignment picks the nearer, and S1 only refuses at open time. No till has run 2.2.5, so no such row exists in production data.
- **Where 09:00 came from:** phase 199 D1 recorded the client's confirmation of 17:30 as the day's end; the 09:00 start was not questioned. The owner now says it was an error.

## 2. Change

| File | Change |
| --- | --- |
| `src/main/lib/shiftWindows.ts` | `DAY_SHIFT.startMinutes` 9 × 60 → **7 × 60**; `NIGHT_SHIFT.endMinutes` 9 × 60 − 1 → **7 × 60 − 1**. Doc comments that quoted the times updated. |
| `src/renderer/src/lib/shiftWindows.ts` | the same two numbers; comments. |
| `src/main/services/reports.ts`, `src/renderer/src/components/OpenShiftForm.tsx` | one example label each, in a comment. |

## 3. Tests

**Existing tests changed, each file carrying a CHANGED note (OLD 09:00 / 08:59, NEW 07:00 / 06:59):** `shiftWindows` (the boundary table, the UTC instants 03:59:59Z / 04:00:00Z, the labels, `shiftEndClock('night')` 06:59, the constants 420 / 419, the due-note cases, the twin-agreement grid), `shiftBuckets` (case 1 at 06:59:59 / 07:00:00; the 08:30 example became 06:30 because 08:30 is now Day; case 4's UTC instants), `adminShiftWindows` (labels; the boundary cases; the banner from 06:59:00 and not at 06:58:59; "Night window ended at 06:59"), `oneShiftPerWindow` (06:59:59 is the previous Night, 07:00:00 is Day; the across-midnight sale moved from 07:30 to 06:30 so it is still Night; close allowed from 06:59:00, refused at 06:58:59; `windowClosableFrom` at 06:59; labels), `shiftZReport`, `shiftCaptureUi`, `oneShiftPerWindowUi` (labels). Times that were never boundaries (sales at 09:30, closes at 09:00, fixtures at 06:00Z = 09:00 Nairobi, which is still Day) were left as they were.

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| 16 shift and window test files | 347 passed |
| **Full suite** | **213 files, 3575 passed, 1 skipped (the pre-existing build-freshness skip), 0 failed** |
| Mutation: `DAY_SHIFT.startMinutes` back to 9 × 60 in the **main copy only**, file restored after | 12 tests fail across `shiftWindows`, `shiftBuckets`, `oneShiftPerWindow` (the renderer twin disagrees, the buckets and close times move) |

## 4. Possible impact

- **Cashier and manager:** the Day shift can be opened as Day from 07:00 (before, 07:00 to 08:59 counted as the previous Night); the Night shift can be closed from 06:59 instead of 08:59; the labels and the banner say so.
- **Reports:** a Night Z report covers 17:31 to 06:59; a Day one 07:00 to 17:30. Buckets for no-shift sales follow.
- **Existing data:** nothing rewritten; an older shift that was labelled by the old rule shows the "Labelled … when opened" note where its window changed.
- **Phase 232's dry run** (release-2.2.5 §3 gate 1) should be run with this change in, since it decides which window every historical sale joins.

## 5. Rollback

`git revert` the commit: the four numbers and the test expectations go back together. No data to undo.

## 6. Observed but not changed

- Phase 199's "Due to close at 08:59, not 09:00" note (its §102) is the same convention and now reads 06:59.
- The 2.2.5 installer built at 06:18 today (release-2.2.5 §0) does **not** carry this change. If the owner wants it in 2.2.5, that draft has to be rebuilt once more before publishing; otherwise it is the next release.
