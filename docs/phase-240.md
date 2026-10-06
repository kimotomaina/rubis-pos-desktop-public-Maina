# Phase 240 — The Z report is scoped to one shift: confirmed, and pinned by tests

- **Date:** 2026-10-06
- **Asked by the owner:** "Could you confirm how the Z report is scoped, is it scoped per shift, can you ensure it scoped per shift?"
- **Status:** confirmed and tested. **No product code changed.** One new test file. Not released (2.2.6 is built and unpublished; this adds tests only).
- **Layout:** not applicable (no screen changed).

## 1. The answer

**Yes: a Z report is scoped by shift number and nothing else.** Read at `HEAD` = `d6844cb`:

| Part of the report | Where it is read | Scope |
| --- | --- | --- |
| Orders, revenue, by method, VAT | `generateZReport(db, shiftId, taxRate)` in `reports.ts`, from `db.getOrdersForShift(shiftId)`: `SELECT … FROM orders WHERE shift_id = ?` | the orders whose `shift_id` is this shift |
| M-Pesa by mode | `db.getMpesaPaymentsForShift(shiftId)`: payments joined to orders `WHERE o.shift_id = ?` | the same orders |
| Corrections, adjustments, merge record | `listShiftCorrections(shiftId)`, `listShiftAdjustments(shiftId)`, `getShiftMerge(shiftId)` | this shift |
| The request | `reports:z-report` takes `{ shiftId }` only (`zReportRequestSchema`); any other key is dropped | no date, range or window |
| On paper | `renderZReport(client, report, …)` prints that same report | the same |

**It is not scoped by time.** A sale is in a Z report because of its `shift_id`, not because of when it was made: a sale rung up after the shift closed is in that shift's report if it is attached to it, and a sale made inside a shift's hours but attached to another shift is in the other one. Sales with no shift are in no Z report until they are given one (phase 232), and moving a sale (phase 232, S5) or merging shifts (phase 239) moves it between reports. The "Window report" (phase 232) only adds several shifts' own Z reports together; it is a separate screen.

## 2. What was added

[zReportScope.test.ts](../tests/zReportScope.test.ts), 10 tests, real in-memory SQLite: a closed Day shift A and an open Night shift B, A's sale made after A closed, B's sale made inside A's hours, a voided sale, and a sale with no shift inside A's hours.

- A's report holds exactly A's three sales (cash 100, M-Pesa 200 by manual, card 50, revenue 350); B's holds exactly B's two (cash 300, M-Pesa 400 by Daraja); the voided and the unattached sale are in neither.
- The two reports plus the unattached sales equal every non-voided sale, once: nothing counted twice.
- A shift with no sales reports zero, not everyone's; a missing shift throws.
- A moved sale leaves the first report and joins the second; automatic assignment grows only the shift that receives the sale.
- The printed report carries the same counts.
- The request schema carries a shift number only, and `generateZReport`'s signature and both queries contain no date or range (a source check, run on the file with line endings normalised).

**Mutation check:** the orders query changed to `WHERE (shift_id = ? OR shift_id IS NULL)` (a report that leaks the unattached sales). 8 of the 10 tests failed, the first being "counts exactly the shift's own sales, whatever time they were made…". Restored; `git status` showed the source clean.

## 3. Verification

Typecheck clean. Full suite: 215 files, 3604 passed, 0 failed. Nothing was run on a till; the app was not started.

## 4. Observed but not changed

- **The Window report and End of Day are different scopes on purpose** (a window of one or more shifts; a Nairobi calendar day). Neither is a Z report; the Admin "Today's sales" card is a day figure.
- **Until sales with no shift are given one,** they are in no Z report. The automatic assignment (phase 232) does that at start, before Open Shift, after Close Shift and when Shift History opens.

## 5. Rollback

Delete the test file and this record; nothing else changed.
