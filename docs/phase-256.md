# Phase 256 — Open and close the shift wherever shifts or a Z report are shown, one way everywhere

- **Date:** 2026-10-07
- **Asked by the owner** (after trying the till as Admin and as CHEA):
  - "On the reports side, as an admin, could you have the closing shift functionality in that page too."
  - "Ensure any screen or dialog where you can see the shifts or print the z report, the actions of opening and closing a shift can be done with the necessary data integrity, roles and permissions and process flows to ensure minimal user error."
  - Only the affected tests to be run.
- **Status:** built and tested in one commit. Not released.
- **Standing rules kept:**
  - the app was not launched by me;
  - nothing was sent to the device, Shopify or Safaricom, and no sale was made;
  - no `check:fit`.

## One close flow, one open flow

**Close:** new [CloseShiftDialog.tsx](../src/renderer/src/components/CloseShiftDialog.tsx), used by every screen that closes a shift.

1. **The figures:**
   - counted cash, required, 0 or more;
   - the M-Pesa balance and the card settlement, optional, "Not recorded" when blank and never 0.
2. **Review:** the three figures as they will be recorded, and a reminder that a closed shift cannot be opened again (only an admin can correct its figures). Before the window's end, an admin is told again that the close is early. **Back** returns to the figures, kept as typed.
3. **Close shift:**
   - the button is off while the close is on its way, so it cannot be sent twice;
   - a refusal from the main process is shown and the figures stay for another try;
   - after the close, the caller is handed the shift's Z, which the close has unlocked.

**Before anything is typed:**
- **a held sale stops the close**, for everyone;
- **a cashier before the window's end** sees why, with only OK;
- **an admin before the window's end** is told it is early and may go on (phase 255).

**The main process still checks every rule on the close itself** (phases 254 and 255):
- who is signed in, and the closer recorded from the session;
- the window's end, which only an admin may close before;
- held sales;
- that the shift is still open.

The screen's rules are there to stop a mistake before it is typed; the main process's are the ones that cannot be skipped.

**Open:** the existing [OpenShiftDialog.tsx](../src/renderer/src/components/OpenShiftDialog.tsx), unchanged. It applies the window rules: one shift per window, the earlier sales shown, and start at 0 for an admin only.

**Which shift is open** is always taken from the main process (`shifts:window-status`), never from the rows on screen. While that answer has not come, neither Open nor Close is offered.

## Where each action now is

| Screen | Open | Close | Print Z |
| --- | --- | --- | --- |
| Admin > Overview, Shift Controls | as before (the same form and rules) | **Close Shift now opens the shared dialog** in place of the inline form | the Z opens after the close, as before |
| **Admin > Reports, Shift History** (new) | **Open shift** in the bar, with no shift open | **Close shift** on the open shift's row, and **Close shift #N** in the bar | Z report on every row, as before |
| Z report, in a window or on the Reports tab, for an admin | — | Print on an open shift: "Close the shift first…" with **Close shift**. After the close, the report becomes the closed shift's and Print works | locked while open (phase 254) |
| Cashier, My shifts and sales | **Open shift**, with no shift open (new) | Close shift: **the shared dialog** in place of the page's own form; off until the window's end | Print Z on the open shift asks for the close; closed shifts' Z as before |
| Cart, No shift open | as before | — | — |

**Roles are unchanged:**
- the Reports tab is an admin's;
- a cashier opens and closes from the cart and from My shifts and sales;
- the main process's role gate refuses everything else (phase 254).

## Tests

Run as the owner asked: **every test file that mounts a screen touched here, or scans the renderer's files.** That is 27 files mounting the screens (536 tests) and 16 that scan the source (286 tests, 1 skipped): **all passed.** Typecheck is clean and the build passed. The full suite was not run.

**New:** [shiftActions.test.ts](../tests/shiftActions.test.ts) (10). Real stores and a real mount of the Reports page and the dialog.

On **Shift History**:
- the open row has Close shift and the bar names the open shift;
- closing there goes through figures, review and close; the Z opens, closed by the admin, and prints; the list is read again;
- the row's Close shift opens the dialog, not the Z;
- with no shift open, Open shift opens the shared dialog;
- with no answer from the main process, neither is offered.

The **dialog by role:**
- an admin before the window's end is told so twice and may close;
- a cashier before it gets the reason and OK, with no form;
- a cashier after it closes normally;
- a held sale stops an admin too;
- a Z that cannot be read after the close is handed back as none, and the close stands.

**[cashierScreens.test.ts](../tests/cashierScreens.test.ts), rewritten for the dialog and added to:**
- the review shows the figures, and nothing is sent before Close shift;
- Back keeps the figures; Cancel closes nothing;
- a negative cash figure is refused at Review;
- blank figures show as Not recorded and send the call they always sent;
- a refused close keeps the figures;
- **Close shift cannot be sent twice**;
- Open shift is offered with no shift open;
- on an admin's Z window, Print on an open shift closes it there and the closed Z prints.

### Existing tests changed

Each change is marked CHANGED in the file.

- **`adminShiftMpesaBalance.test.ts`, `adminShiftWindows.test.ts`, `adminScreen.test.ts`:** Confirm closed the shift on the Admin overview. It is now Review, then Close shift. Every expected call is unchanged, including the call the till always sent with blank figures (phase 246, R5).

### Mutation checks

Each was restored and compared byte for byte afterwards.

| # | Mutation | Failing tests |
| --- | --- | --- |
| 1 | Skip the review: Review closes at once | 12 |
| 2 | Let a cashier close before the window's end on screen | 1 |
| 3 | Ignore held sales in the dialog | 2 |
| 4 | Reports bar offers Open shift while one is open | 1 |
| 5 | Send a blank M-Pesa or card figure as 0 | 11 |

## Observed

- **The close request still accepts a negative counted cash** (`shiftCloseSchema`). Phase 227 kept that on purpose (`ipcValidator.test.ts` "still accepts a negative closing figure"), so it is left. Every screen refuses one, at Review.
- On the Admin overview, the open form stays inline, as before. It is the same form, with the same rules, as the open dialog.

## Not verified

- **On a till:** the dialog, the new buttons on Shift History and the Open shift on the cashier's page have not been seen there, and are not measured (no `check:fit`).

## Rollback

Revert the commit. It changes screens only: no data, no main-process rule.
