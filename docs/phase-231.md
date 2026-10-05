# Phase 231 — One shift per window, automatic assignment, close from the window's last minute

- **Date:** 2026-10-05
- **Asked by:** Nigel and Paul (owner), the one-shift-per-window rules v1 and v2, then the rulings of 2026-10-05 21:55. Audit and revised design were reported first; this is the build.
- **Status:** built and tested. **Not released.** 2.2.5 waits for the owner's go. Nothing was installed on any till, nothing was published, the app was not started, nothing was sent to the device, Shopify or Safaricom.
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.** Screens that changed: Open Shift (Admin and cart dialog), the Admin shift status line, the cart strip, Shift History, the Z report window, and two new forms (Move a sale, the window report).
- **Not changed:** checkout, the payment gate, fiscal and Shopify code, `closeShift` itself, the overlap rule, the "voided sales never join" rule, the manager-PIN rule for corrections, and "selling is never refused". The only column of `orders` ever written is `shift_id`, and only as described in section 3.
- **Phases 223, 227 and 229 are not edited.** Section 4 lists what this phase retires from them.
- **Release number:** 2.2.5 (ruled). 2.2.4 was built (`e88078e`, record `b4232f5`) and never published or installed, so its number is not reused. `package.json` is still at 2.2.4: the bump belongs to the release.

## 1. The rules, and where each one lives

| Rule | What it is | Where |
| --- | --- | --- |
| S1 | One shift per window. The window comes from `clock_in` by `shiftWindowOf`. The check is inside the creating transaction. | `openShift` and `insertAutomaticShift` in [database.ts](../src/main/services/database.ts); the key is [shiftWindows.ts](../src/main/lib/shiftWindows.ts) `shiftWindowOf` and `sameWindow`: no second copy of the time rule. Worked out each time: no new column on `shifts`. |
| W4 | The type comes from the clock only; older shifts are shown by their window with "Labelled Day when opened". The stored row is never edited. | `openShift` stores `window.type`; [shiftLabel.ts](../src/main/lib/shiftLabel.ts) `withWindow` adds `window_type`, `window_date`, `labelled_as` for the screens; the Z report's `shiftType`, `shiftWindowLabel`, `labelledAs`. |
| S2 | No shift closes before its window's last minute, for anyone: from 17:30:00 (Day) and 08:59:00 (Night). | [shiftRules.ts](../src/main/lib/shiftRules.ts) `closeTiming`, [shiftWindows.ts](../src/main/lib/shiftWindows.ts) `windowClosableFrom`, checked in `closeShiftUnlessHeld` ([held-sales.ts](../src/main/services/held-sales.ts)), the only production caller of `closeShift`. |
| S3 | A banner from that moment on the cart and the Admin screen. Selling continues. | [WindowEndBanner.tsx](../src/renderer/src/components/WindowEndBanner.tsx), `ShiftWindowNote` in `AdminScreen.tsx`. The time is the main process's (`shifts:window-status`), not the screen's clock. |
| S4, S7, S8 | Every sale with no shift goes to the shift it belongs to, automatically, no PIN. | [autoAssign.ts](../src/main/lib/autoAssign.ts) (pure plan), `autoAssignUnattachedSales` (one `.immediate` transaction). |
| S5 | Only an admin moves a sale between shifts: PIN, reason, permanent record, both shifts recalculated, no typed figures. | `reassignSale`, `previewSaleMove`; `shifts:move-sale` re-verifies the PIN before the database is called. |
| S6 | Earlier sales in the window join the shift on opening; the float is the drawer less their cash. | `openShift`, [OpenShiftForm.tsx](../src/renderer/src/components/OpenShiftForm.tsx), [openShiftFloat.ts](../src/renderer/src/lib/openShiftFloat.ts). |
| S9 | A made shift lies inside one window. | `insertAutomaticShift` refuses a period whose ends are in different windows. (The hand-set period no longer exists, see section 4.) |
| S10 | The combined window report, screen only. No sums of starting, expected or counted cash. | [window-report.ts](../src/main/services/window-report.ts), [WindowReportModal.tsx](../src/renderer/src/components/WindowReportModal.tsx). Paper comes with the Z layout phase (232). |

### Rulings applied

| # | Ruling | Built as |
| --- | --- | --- |
| 1 | S2 literal | Close from 17:30:00 and 08:59:00. A sale in the last minute after a close joins that shift under S4(1); S7 shows the difference until a correction. Tested at 17:29:59, 17:30:00, 08:58:59, 08:59:00, a Night opened at 02:00, and a shift opened in its last minute. |
| 2 | Two shifts in one window | The nearest shift in time; on a tie the lower id. The adjustment's reason says "the nearest of 2 shifts in their window". |
| 3 | S5 no typed figures | The form shows both shifts' expected cash and difference before the PIN. A recount comes afterwards, by correction. |
| 4 | S6 below the earlier cash | Recount for everyone; an admin may tick "Start at 0. The Ksh X missing will show as a shortage when the shift closes." The tick, the drawer count and the shortfall go into the opening record. M-Pesa: the balance now less the earlier M-Pesa sales; below 0 asks for a recount or a blank. |
| 5 | Remove the manual past-shift flow | Section 4. The database insert that auto-assign uses stays (`insertAutomaticShift`). |
| 6 | `staff_id = 0` | Audited first, section 2. |
| 7 | 2.2.5 | Not bumped yet. |
| 8 | Case 11 | Settled by S8. |

## 2. Ruling 6: nothing breaks on `staff_id = 0` (audited before it was used)

`shifts.staff_id` has no foreign key ([database.ts](../src/main/services/database.ts) `SCHEMA.shifts`). Every reader of a shift's `staff_id` in `src`:

| Reader | What it does with 0 |
| --- | --- |
| `generateZReport`, `staffName` | `db.getStaffById(0)?.name ?? 'Unknown'`: "Unknown". The report's own lines say "CREATED AUTOMATICALLY" instead of "Opened by" for these shifts. |
| `ReportsPage` Shift History | `staffName(shift.staff_id)` would read "Staff #0"; the screen now shows "Created automatically" for 0. |
| SQL | No query joins `shifts` to `staff`. Every `FROM shifts` is a plain select (`getOpenShift`, `getShiftById`, `listShifts`, `countShifts`, `listShiftWindows`). End of Day, exports and reconciliation read `orders`, not `shifts.staff_id`. |
| `createdByName` | `created_by_staff_id` is NULL for these shifts, which the report already reads as "no name". |

No staff row can have id 0 (`staff.id` is `AUTOINCREMENT`, from 1). No stop was needed.

## 3. What changed

### Tables (additive, safe to run twice)

- **`shift_adjustments`**: one append-only record each time sales join or leave a shift. Columns: `shift_id`, `kind` (`opening`, `auto`, `reassign_in`, `reassign_out`), `at`, `by_staff_id` (NULL when the till did it), `reason`, `peer_shift_id`, the sales count and totals (total, cash, M-Pesa, card), first and last sale time, `opening_drawer_cash`, and a snapshot of the figures once the record was written (starting, counted, expected, difference, and the four M-Pesa figures), NULL for an open shift or one whose cash was not counted.
- **`shift_adjustment_sales`**: `(adjustment_id, order_id)`, primary key on both.
- `BEFORE UPDATE` and `BEFORE DELETE` triggers that abort, on both. `shifts` and `orders` got no new column.
- A reassignment is two records, one on each shift (`reassign_out`, `reassign_in`), with the same who, when and reason, each naming the other shift. That is the permanent "sale, from, to, who, when, reason" record.
- **Record times:** each is `max(now, newest correction or adjustment of that shift + 1 ms)`. The newest record is unambiguous even if the clock was set back. `addShiftCorrection` uses the same rule.

### What runs, and when (S4)

`autoAssignUnattachedSales(nowMs)` reads every non-voided sale with no shift and plans each one:

1. inside an existing shift's times: that shift (S8);
2. else the shift of its window; with two shifts in the window, the nearest in time, lower id on a tie;
3. else, for a window that has **ended** (the sale's window is not the window of now): a new shift made for it, closed, `kind = 'retrospective'`, `cash_not_counted = 1`, `staff_id = 0`, reason "Created automatically for sales with no shift", period = the whole minutes from the first sale to the last, held 1 ms off a shift that ends before or starts after;
4. else (the current window has no shift yet): the sales **wait**; they join the shift the moment it opens (S6).

One `.immediate` transaction; every attach is the guarded `UPDATE orders SET shift_id = ? WHERE local_id = ? AND shift_id IS NULL AND status <> 'voided'` and must change exactly one row, or the whole run is rolled back. A re-entrancy flag makes a run that starts during another do nothing. A sale whose time cannot be read is skipped. For a joined **closed, counted** shift (S7) the record keeps the latest typed figures (the newest of the shift's own, its corrections' and its adjustments') and recalculates expected cash and the differences from the live sales: the counted cash is kept, so a difference shows. A shift that was open, or whose cash was not counted, gets a record with no figures.

It runs: at app start; right before Open Shift and right after a successful Close Shift (`assignSalesToShifts` in `index.ts`); and when Shift History opens (`shifts:auto-assign`, called by the screen). It does **not** run after each sale: checkout is untouched. A failure goes to `till.log` as `auto-assign-failed` (main process only, the screen cannot write it), the person is never blocked, and the sales stay as they were until the next run. Four triggers are enough: the current window's waiting sales are handled by the Open Shift that follows, and an ended window is handled by the next start, open, close or Shift History visit.

### Open Shift (S1, W4, S6)

`openShift(staffId, drawerCash, mpesaBalanceNow, { earlierShown, startAtZero }, nowMs)`, one `.immediate` transaction: refuse if a shift is open; refuse if the window of now already has a shift (open or closed); the type is the window's; the earlier sales are the current window's sales with no shift, outside every shift's times. If the form showed other sales than are there now, nothing is opened. The shift is inserted, the earlier sales are attached (guarded, one change each), and one `opening` record is written with the drawer count. The old third argument (the type) is gone; `shiftOpenSchema` still accepts `shiftType` and ignores it.

Wording on the form (Admin screen and cart dialog, one component):

- `Night shift (17:31 to 08:59)`: the window, as text, with no buttons.
- `3 earlier sales in this window (cash Ksh 1,200.00) will join this shift.`
- Field `Cash in the drawer now`; below it `Starting cash will be recorded as Ksh 3,300.00 (drawer Ksh 4,500.00 less earlier cash sales Ksh 1,200.00).`
- Below the earlier cash: `The drawer (Ksh 800.00) holds less than the cash sales already made in this window (Ksh 1,200.00). Count the drawer again.` Confirm is off. For an admin: the tick above.
- If the window already has its shift: `Night shift, 5 Oct 2026 already has shift #1. A window has one shift.` Confirm is off.

### Close and the banner (S2, S3)

`Close Shift` is off, with `Day shift can be closed from 17:30. Selling can carry on.`, until the window's last minute begins; the main process refuses with the same words. From then the Admin screen and the cart (in the "No shift open" strip's slot, so the cart does not grow; the two never show together) say `Day window ended at 17:30. Count the drawer and close shift #5.` The screens ask `shifts:window-status` every 15 seconds, so the banner can be up to 15 seconds late; the close itself is decided by the main process.

### Z report

For a shift with no adjustments the report is exactly what it was. Otherwise: the original figures stay; each record is listed under them with the corrections, oldest first; a line `Sales at close: N orders, Ksh X` says what the shift held when it closed (the live sales less those that joined later, plus those moved out; sales that came with the shift at opening are not "added later"); `Labelled Day when opened` when the stored label differs from the window; `CREATED AUTOMATICALLY` in place of "Opened by" for a shift the till made. Main and renderer twins (`zReportAdjustments.ts`) are tested against each other.

### Move a sale (S5)

Shift History has a **Move a sale** button: order number and target shift number, **Check** (read-only: the sale, both shifts' expected cash and difference afterwards), a tick if the sale was made in a different window from that shift and outside its times, a reason, then the admin's PIN. The handler re-verifies the PIN before the database is called. The move is one `UPDATE ... WHERE shift_id = <the shift it was read in>` that must change exactly one row, plus the two records, in one transaction. A voided sale, a sale with no shift, the same shift, a missing sale or shift, and a blank reason are refused, writing nothing. Running it twice: the second is refused ("already in shift #N").

## 4. Retired (ruling 5), and why

The till now gives every sale its shift by itself, so a person working through a list is room for error.

| Retired | |
| --- | --- |
| UI | The "Sales with no shift" list and button in Shift History, `PastShiftForm`, the "N sales have no shift. Record them now?" prompts on Open and Close Shift (Admin), the dialog's "N sales have no shift" line with its "Record them" button, the hand-over to Reports (`recordUnattached`), `nairobiMinuteText` and the period helpers. |
| IPC | `shifts:unattached-days`, `shifts:past-preview`, `shifts:create-past`, and their preload methods and schemas. |
| Code | `src/main/services/past-shifts.ts` (`listUnattachedDays`, `listUnattachedOffers`, `previewPastShift`), `createRetrospectiveShift` and its helpers, `listUnattachedSalesInPeriod`. |
| Kept | `listUnattachedSales`, `listShiftWindows`, `findOverlappingShift` and `parsePastShiftPeriod` in `lib/pastShift.js` (the overlap rule is still enforced when a shift is made automatically), the `kind = 'retrospective'` and `cash_not_counted` columns, the Z report's retrospective lines, `addShiftCorrection` (the way a manager gives an automatic shift its real counts). |

Phase 229's period clamp survives inside `planAutoAssignment` (`periodFor`).

## 5. Existing assertions changed (all of them; each carries an old/new note in its file)

| Test | Old | New |
| --- | --- | --- |
| `shifts.test.ts` "opens a shift with the given starting cash…" | params `[1, clock_in, 100]`, no clock | `openShift(1, 100, null, {}, nowMs)`; params `[1, clock_in, 100, 'day', null]` |
| `shifts.test.ts` "openShift persists shift_type", "a call that names no shift…", "rejects a shift type that is not day or night…" | type from the screen; omitted when not named; bad type rejected | the type is the clock's and always written; replaced by "openShift stores the window of the clock" (day, night). The rejection has no equivalent: there is no type parameter. |
| `shiftMpesaBalances.test.ts` three openShift tests | `openShift(1, 100, 'day', 2500)`, statements with and without `shift_type` and the M-Pesa column | `openShift(1, 100, 2500, {}, nowMs)`; one statement, `null` for not recorded. The expected SQL string for the first test is unchanged. |
| `shiftMpesaBalances.test.ts` "passes the counted balance through the held-sales guard" | fake with two methods | fake also has `getShiftById` |
| `adminShiftMpesaBalance.test.ts` three tests | `openShift(1, 250, type, balance)` | `openShift(1, 250, balance, options)`; no type is sent |
| `adminShiftWindows.test.ts` "Open Shift: the suggested shift" (7 tests) | preselect, switch both ways, send the chosen type | the window is shown as text; no radio buttons; nothing about the type is sent; a window that has its shift refuses. The boundary results (day at 17:30:59 and 09:00:00, night at 17:31:00 and 08:59:59) are unchanged and now run through the main process's `getShiftWindowStatus`. |
| `adminShiftWindows.test.ts` due-to-close note (4 changed, 2 new) | note from 17:31:00 ("due to close at 17:30"); none at 17:30:59 | banner from 17:30:00 ("Day window ended at 17:30. Count the drawer and close shift #5."); Close Shift off before; from 08:59:00 for a Night. Still closes a shift past its window. |
| `adminShiftWindows.test.ts` "shows nothing about a window for a shift opened before shift types existed" | nothing | the shift's window, no "labelled" note |
| `shiftZReport.test.ts` three shift-field tests, and the "every other figure" test | stored type and label as given; null when none | the window of `clock_in`; `labelledAs` when the stored label differs; a shift with no label shows its window |
| `reports.test.ts`, `vatClassReceiptReports.test.ts`, `shiftMpesaBalances.test.ts`, `shiftZReport.test.ts`, `shiftCorrections.test.ts`, `pastShift.test.ts`, `shiftCapture.test.ts` fakes | no adjustment methods | `listShiftAdjustments` and `listAdjustmentSales` stubs added (fixtures, not assertions); two recording fakes answer `MAX(at)` with one row |
| `reportsDatabase.test.ts` (three), `heldSales.test.ts` (two) | two or five shifts opened one after another at the real clock; closed at once | each in its own window (an explicit clock); closed three days on, after the window ended |
| `shiftCaptureUi.test.ts` cart dialog | "suggests the shift from the time… either can be changed"; `openShift(1, 250, 'night')`; "N sales have no shift" with Record them | the window shown, never chosen; `openShift(1, 250, undefined, { earlierShown, startAtZero })`; the earlier-sales line, the float line, the drawer-below case and the admin tick |
| `shiftCaptureUi.test.ts` "the cart drops a line while it shows" | `(shouldShowNoShiftNotice(shiftPresence) ? 1 : 0)` | `(shouldShowNoShiftNotice(shiftPresence) \|\| showWindowEndBanner ? 1 : 0)` |
| `shiftCapture.test.ts` open tests | `openShift(1, 250, 'night', null)` | `openShift(1, 250, null, { earlierShown: undefined, startAtZero: undefined })` |
| `tillLog.test.ts` | four events | five (`auto-assign-failed`) |
| **Removed with the manual flow** | `pastShiftForm.test.ts`, `shiftCaptureAdmin.test.ts` (whole files); the D1 and D2 groups and two handler tests in `shiftCapture.test.ts`; the offers, form and chain tests in `shiftBuckets.test.ts` (the five `shiftWindowOf` tests stay); the PastShiftForm and chain tests in `shiftCaptureUi.test.ts`; `createRetrospectiveShift`, `listUnattachedDays`, `previewPastShift` and request-schema tests in `pastShift.test.ts` (the period, overlap and Z-report tests stay) | their questions are asked of the automatic assignment in `oneShiftPerWindow.test.ts` |

`tests/updateBackup.test.ts` (the known failure) passed in this run.

## 6. Tests

[oneShiftPerWindow.test.ts](../tests/oneShiftPerWindow.test.ts), 73 tests, **real in-memory SQLite** for every database step:

- S1: refused inside the transaction (closed and open holder, an older pair, a third), nothing written; the window by the clock at 08:59:59 and 09:00:00.
- W4: the type is the clock's, including through the admin check with a request that says `day` at 17:43; an older shift shown by its window.
- The append-only triggers on both tables.
- S4: shift #1 case (start 0, counted 3,790, sales 1,000 and 2,790 join, difference 0); a shortfall; no figures for a not-counted or open shift; a shift made for an ended window; a Night across midnight; the current window waits; S8; the clamp; two shifts, nearest, tie, reason; voided and already-attached sales untouched; an unreadable time skipped; **idempotent (second and third run change no row)**; a run during a run does nothing; **all or nothing** (a failure part-way leaves no shift, no record, no attach); the guarded UPDATE refusing a sale that gained a shift; the failure logged as `auto-assign-failed`.
- S6: the subtraction, the stale-count refusal, the below-zero refusal, the admin tick written into the record, M-Pesa, and the same figures on the screen.
- S2 at both boundaries and the other cases; the status the screens read equals what is enforced; the close handler goes through the guard.
- S5: the move, the two records, both shifts' figures, the preview writes nothing, the tick, every refusal, **run twice**, all or nothing, only S5 moves a sale, the PIN before the database call.
- The Z report: originals kept, sales at close, moved in and out, opening not "added later", unchanged report for a shift with no adjustments, "created automatically", the twin tests, corrections and adjustments merged by time.
- Corrections and adjustments in either order; record times after the newest record even with the clock set back.
- S10: the combined report, no cash sums, not-counted shifts apart.
- Handlers: start, before open, after close; the failure wrapper; the three IPCs gone; checkout untouched; `orders.shift_id` written only from NULL or from the shift it was read in.

[oneShiftPerWindowUi.test.ts](../tests/oneShiftPerWindowUi.test.ts), 16 tests: Shift History (assign before list, no list of sales with no shift, still shows when the run fails, window and label, "Created automatically", the window report), Move a sale (preview, reason then PIN, no figure sent, the tick, a problem shown, numbers first), the Z report window, the cart banner.

### Mutation checks (each restored; the suite was green after)

| # | Mutation | Test that failed |
| --- | --- | --- |
| 1 | Allow a second shift in a window | 3: `refuses a second shift in a window that already has one, closed or open, and writes nothing`; `leaves an older pair in one window exactly as it is, and still refuses a third`; `is refused when the window already has its shift…` |
| 2 | Move a sale without the admin PIN (the `requireAdminPin` block removed from `shifts:move-sale`) | 1: `is admin-gated in the main process: the PIN is re-verified before anything is written` |
| 3 | An automatic run takes a sale that already has a shift (`listUnattachedSales` drops `shift_id IS NULL`) | 7, including `never takes a voided sale, and never touches a sale that already has a shift`; `is idempotent…`; `is the only way a sale leaves a shift: automatic assignment never moves one` |
| 3b | The guarded `UPDATE` loses its `shift_id IS NULL` | 2: `refuses to attach a sale that gained a shift during the run…`; `only ever writes shift_id on orders, and only from NULL…` |
| 4 | Take the type from the screen (the request's `shiftType` reaches the INSERT) | 3: `ignores a type the screen sends: a request that says day at 17:43 stores night`; two `shifts:open` tests in `shiftCapture.test.ts` |
| 5 | Drop the `changes === 1` check on attach | 1: `refuses to attach a sale that gained a shift during the run…` |
| 6 | Allow a close before the window ends | 3: `allows a Day shift from 17:30:00 and not at 17:29:59`; the Night 08:58:59 case; the 02:00 case |
| 7 | S6 stores the drawer count without subtracting | 4, including `stores the starting cash as the drawer less the earlier cash sales, and records who joined` |
| 8 | A made shift does not take its sales (so a second run would make another) | 4, including `is idempotent: a second run, and a third, change no row anywhere` |

The first attempt at mutation 4 changed only the database and was not caught; that was not a real mutation (nothing passed the type in). It was redone through both files, as above, and caught. A mutation of "the PIN" for the open path does not apply: `openShiftChecked` is unchanged and still covered by its own tests.

## 7. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | **213 files, 3575 passed, 0 failed** (before: 213 files, 3569 passed, 1 skipped). The skipped test was `manualVerificationWording.test.ts`'s build-freshness check, which runs only when `out/` is fresh; `npm run build` was run first, so it ran and passed. |
| `npm run build` | passed, including "Confirmed: neither mock provider is in out/main." |
| Mutation checks | 9 of 9 caught |

`npm run dist` was not run: no installer was asked for.

## 8. For the owner to check on the till

1. **Close Shift before the window's last minute** is off, with the words above; at 17:30 (Day) or 08:59 (Night) the banner appears on the cart and the Admin screen and Close Shift works.
2. **Open Shift in a window that already has a shift** says so and cannot be confirmed.
3. **Open Shift with earlier sales** shows the count, the cash, and the starting cash it will record.
4. **Shift History** lists shifts by window ("Night", "Labelled Day when opened"), shifts the till made say "Created automatically", and an older pair has a "Window report" button.
5. **A shift's Z report** after sales joined it lists them under the originals.
6. Layout of all of the above.

## 9. Observed but not changed

- **My audit said the database was not in WAL mode. It is.** `init()` sets `journal_mode = WAL` ([database.ts](../src/main/services/database.ts), `init`). A copy of `rubis-pos.db` taken for the dry run must include `rubis-pos.db-wal` and `rubis-pos.db-shm` if they exist next to it (closing the app normally checkpoints and removes them). The read-only query in the audit is unaffected.
- **There is no way to close a shift early** (S2, ruled). A shift opened by mistake, with a wrong float, stays open until its window's last minute; the figures are fixed afterwards by correction. A shift opened to test something on a till stays open too.
- **The banner can be 15 seconds late** (polling). The close is decided by the main process, so it can never be wrong.
- **The renderer's `isPastShiftEnd` and its twin tests are unused by the screens now.** Left in place; delete with their tests in a cleanup. `parsePastShiftPeriod` is likewise used only by its tests.
- **Sales in a window with no shift and no later Open Shift wait.** They are given a shift at the next start, open, close or Shift History visit, not on the clock. Reports that count "sales with no shift" can show them until then.
- **The "No shift open" bar now reads "Sales made now join the shift of this window."** (it said "belong to no shift"). No test pinned the old words.
- **`createdAutomatically` is read from `staff_id === 0`.** There is no separate flag; the shift's `reason` and `kind` agree with it.
- **A correction made on an automatic shift** adds the real counts (the first correction on a not-counted shift is already allowed). Until then the Z says "Cash not counted".
- **The window report has no paper form** (screen only, by design); each shift's own Z still prints.

## 10. Not verified

- Anything on the till, and the live database: every test uses a fresh in-memory database built from the schema. The dry run on a copy of the live data (below) is the next step.
- Layout (owner's rule).
- That electron's packaged SQLite behaves as the test one does for `.immediate` transactions: the same `better-sqlite3` is used, but the test run is node's build.
- A real Close Shift, Open Shift or Move a sale through the running app, and the first-start run on real data.

## 11. Rollback

Revert this commit. The two new tables stay, unused, with their rows; no shift, order or sale is changed by the revert. Sales that were attached stay attached; shifts made automatically stay (closed, cash not counted). The manual past-shift flow returns with the revert.
