# Phase 255 — An admin may close a shift before its end time

- **Date:** 2026-10-07
- **Asked by the owner:** "can they close afterwards? … if it is before the time, like leaving early, that should be allowed for admins or managers. I need the simplest solution." Only the affected tests to be run.
- **Status:** built and tested in one commit. Not released.
- **Standing rules kept:**
  - the app was not launched;
  - nothing was sent to the device, Shopify or Safaricom, and no sale was made;
  - no `check:fit`.

## The answer: after the end time

**Yes.** `closeTiming` (`lib/shiftRules.ts`) allows a close from the first second of the window's last minute, with no later limit:
- a Day shift from 17:30;
- a Night shift from 06:59.

A shift left open past its window can be closed at any time after. Before that minute, everyone was refused, in the main process and by a disabled Close Shift button.

## The change

**There is no manager role** (phase 254 audit): a manager is an admin. So "admins or managers" is **an admin signed in**.

| File | Change |
| --- | --- |
| [held-sales.ts](../src/main/services/held-sales.ts) | `closeShiftUnlessHeld` takes `earlyCloseAllowed` (last, default `false`). When true, the end-time check is skipped. **A held sale still stops the close**, and the figures are worked out exactly as before |
| [index.ts](../src/main/index.ts) | `shifts:close` passes `staffSession.current()?.role === 'admin'`. **The role comes from the main process's session, never from the screen**, so a cashier is refused before the end time as before |
| [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) | Close Shift is no longer disabled before the end time, because only admins see this screen. The note adds "An admin may close it early." |

**Not changed:**
- **cashiers:** "My shifts and sales" keeps Close shift off until the end time, and the main process refuses them;
- a manager's PIN typed at a cashier's till does not allow an early close: the admin logs in;
- the window rules, the Z lock and the shift arithmetic.

## Tests

Run as the owner asked: only the files the change touches. That is 15 files: everything that calls the close function, the Admin shift screen, and the text checks of the close handler. **477 passed.** Typecheck is clean and the build passed. The full suite was not run.

- **New, in `cashierEdgeCases.test.ts`** (real in-memory SQLite):
  - before the end time a cashier is refused and the shift stays open; an admin closes, with the expected cash and difference worked out as normal, and recorded as the closer;
  - a held sale still stops an admin's early close;
  - the handler passes the admin role from the session.
- **Changed in `adminShiftWindows.test.ts`** (marked CHANGED): at 12:00 and at 17:29:59, Close Shift is now on for an admin, and the note says so.

**Mutation checks**, each restored byte for byte:

| # | Mutation | Failing tests |
| --- | --- | --- |
| 1 | Let anyone close early | 1 |
| 2 | Ignore the admin's early close | 2 |

## Rollback

Revert the commit. Shifts an admin closed early stay closed, with their figures.
