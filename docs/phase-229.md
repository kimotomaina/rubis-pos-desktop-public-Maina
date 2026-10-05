# Phase 229 — Buckets: a sale with no shift belongs to the Day or Night window it was made in

- **Date:** 2026-10-05
- **Requested:** Nigel's decision B1 (2026-10-05, 19:50) and the phase 229 audit: past shifts were offered by calendar day, so a night was split in two at midnight, a 07:30 sale was offered with the day's, and one offer could mix Day and Night.
- **Status:** built and tested. Part of release 2.2.4 (phases 227 to 230).
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.** One extra word on each offer row, "(Day)" or "(Night)" in the form heading, and a message in place of a button.
- **Not changed:** `createRetrospectiveShift` and its single attach statement, the overlap rule, the "voided sales never join" rule, the PIN, checkout, fiscal, Shopify, payment code.
- **Not in the file I received:** the rulings on the audit's decisions (case 11 and the minute clamp). Both were built as the audit recommended; see sections 2 and 6.

## 1. The rule

- A sale's bucket is a window instance: its type and the date the window starts. Day is 09:00:00 to 17:30:59 on its own date. Night is 17:31:00 to 08:59:59 the next morning, so a night is **one** bucket dated by its evening, and 00:00 to 08:59 belongs to the previous date's night. New `shiftWindowOf` ([shiftWindows.ts](../src/main/lib/shiftWindows.ts)) uses the existing `shiftTypeForTime` boundary rule and the existing Nairobi conversion; no new time code.
- Inside a window, consecutive sales are cut into runs at any existing shift (touching counts), as in phase 227. An offer is one run.
- The offer's type is its window's. It is **not** worked out again from the period's start, and stays the window's if the period is edited.

## 2. What changed

| Where | Change |
| --- | --- |
| `listUnattachedOffers` ([past-shifts.ts](../src/main/services/past-shifts.ts)) | Groups by `(type, startDate)` instead of by calendar day. Each offer carries `shiftType`, `periodStartIso` and `periodEndIso`. `listUnattachedDays` (phase 223) is unchanged. |
| The minute clamp | The form works in whole minutes, but an offer cuts at the millisecond. A sale at 17:43:05 gave the period 17:43:00 to 17:43:59.999, which overlaps shift #1 (17:43:21 to 17:43:36), and the form would have been refused. Each offer's period is now the whole minutes its sales fall in, **held back to 1 ms from the nearest shift before and after it** (an open shift's `clock_in` too). The form sends those exact instants until the manager edits a time, then what was typed. |
| Case 11, a sale inside a shift | A sale with no shift that already sits inside an existing shift's window (should not exist; older data may hold one) gets an offer of its own with `insideShiftId`, no period and no type. It never joins a run. Shift History lists it as **"Inside shift #N: not recorded"** with no button; "Record them" and the chain skip it. It is still counted in the warning (the count is every sale with no shift). Nothing is attached: this is "report", not "repair". |
| [PastShiftForm.tsx](../src/renderer/src/components/PastShiftForm.tsx) | Starts from the offer's period and type; the heading reads "Record a shift for 2026-10-04 (Night)". |
| [ReportsPage.tsx](../src/renderer/src/pages/ReportsPage.tsx) | Each row shows its type beside the date (so two offers of one date are told apart); the case 11 row; "Record them" and the chain open the first offer that can be recorded. **Each offer's form now has its own key**: before, the next offer's form kept the last one's reason, its "Cash not counted" choice and its typed cash figures. |

## 3. Existing assertions changed (all of them)

| Test | Old | New |
| --- | --- | --- |
| `tests/shiftCapture.test.ts`, "stops at an existing shift: today's sales split around shift #1…" | Sales at 08:00, 14:00, 18:00 and 19:00 gave two offers (08:00 with 14:00, and 18:00 with 19:00) | Three: 08:00 (the night that began the 4th), 14:00 (Day), 18:00 with 19:00 (Night). The shift still separates the sides and no offer touches it. Note in the file. |

No other existing assertion changed.

## 4. Tests

[shiftBuckets.test.ts](../tests/shiftBuckets.test.ts), 25 tests, covering every case of the audit's A3 table:

- Case 1, boundaries 08:59:59 / 09:00:00 / 17:30:59 / 17:31:00. Cases 2 and 3, 23:50 and 00:10 one offer, 07:30 not with the day's. Case 4, 20:59Z and 21:00Z, 05:59:59Z and 06:00:00Z. Month and year ends. An unreadable time is refused.
- Case 5, shift #1 splits its window and no run touches it; the clamp on sales seconds from it. Case 6, a shift across windows. Case 7, an open shift: the offer ends before its `clock_in`. Case 8, a one-sale window. Cases 9 and 12, voided sales never reach the list and the count equals the sum of the offers. Case 14, windows oldest first, and a chain of **four** offers each needing its own PIN.
- Case 11: reported with the shift's id, no period, never offered; free sales either side stay offerable; the screen shows it with no button; "Record them" skips it; nothing opens when only such sales are left.
- The form sends the offer's exact period until a time is edited, and its type is the window's.

### Mutation checks (each restored; 125 tests green after)

| # | Mutation | Test that failed |
| --- | --- | --- |
| 1 | Group by calendar day instead of the window | 5, including `case 2: a night across midnight is one offer, dated by the evening` and `case 3: 07:30 is last night's…` |
| 2 | Drop the clamp | `case 5 clamp: a sale seconds from the shift gives a period held back to 1 ms…` and `case 7: with a shift open now…` |
| 3 | A sale inside a shift is offered like any other | `case 11 … is reported with that shift's id, has no period, and is never offered` and `… does not join a run…` |
| 4 | The next offer's form keeps the last one's state (no key) | `case 14: the chain reads sensibly past three offers, each its own form with its own PIN` |

## 5. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | **212 files, 3527 passed, 1 skipped, 0 failed** (211 files, 3503 tests before: +1 file, +25 tests) |

Layout: not checked by check:fit (owner's rule). For the owner to check on the till.

### For the owner to check on the till

1. Shift History → "Sales with no shift": each row shows its date and Day or Night; a night that crosses midnight is one row.
2. Open an offer next to shift #1: recording is not refused for overlap.
3. After recording, the next offer starts with an empty reason and empty cash fields.

## 6. Observed but not changed

- **The path of `till.log`, corrected.** Phase 228's record says the user-data folder is normally `%APPDATA%\RUBIS POS\`. On this PC it is `%APPDATA%\rubis-pos-desktop\` (the database is there). Use `%APPDATA%\rubis-pos-desktop\till.log`; the other folder was a guess. Phase files are not edited, so the correction is here.
- **Case 11 is reported, not repaired**, as the audit recommended. Whether to attach such a sale (a manager-PIN action recorded like a correction) is still the owner's decision. The count of these on the developer database was **not** taken: the app was running on this PC and its database was not opened.
- Every offer still needs its own PIN; with two windows a day a long backlog is many PINs.
- Two offers of one window (split by a shift) share a date and type; their time ranges differ.
- The fixed UTC+3 Nairobi offset is assumed, as everywhere in this code.

## 7. Not verified

- Anything on the till (section 5).
- A real database through the whole path; the tests use the recording fake and pure functions.

## 8. Rollback

Revert this commit. Offers go back to one per calendar day, cut at shifts, and the form to minute periods. Nothing stored changed.
