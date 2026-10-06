# Phase 236 — Audit: the Admin section as it stands, for regrouping (read-only)

- **Date:** 2026-10-06
- **Asked by the owner:** "I wanted to group the admin section; the tabs and nested tabs can be bundled. Do an audit and let me think how we can rearrange." End of Day stays functionally what it is.
- **Status:** audit only. No code, settings or data changed. Read at `6537e31`.
- **Numbering:** 233 is the KRA-class audit, 235 the M-Pesa default tab; 234 was left for the other session (its Z layout). This is 236.

## 1. How Admin is reached, and by whom

- The header has three views: **Catalog** (the cart), **Orders** (recent orders, retry, reprint) and **Admin**. The **Admin button exists only for `role = 'admin'`** ([App.tsx:726](../src/renderer/src/App.tsx#L726)); `AdminScreen` refuses any other role ([AdminScreen.tsx:1114](../src/renderer/src/components/AdminScreen.tsx#L1114)). There are two roles only: `cashier` and `admin`.
- So **a cashier never sees any of what follows**, including Close Shift. A cashier can **open** a shift from the cart (No-shift notice → Open shift dialog, phases 227/232) but can only have one closed by an admin.
- Two deep links jump into Admin: the header status button's "unfiled sales" row → **Needs Attention**; and `adminInitialTab` also allows **Reports** ([App.tsx:495](../src/renderer/src/App.tsx#L495)).
- Every write that matters re-verifies an admin PIN in the main process (`requireAdminPin`); the role gate on the screen is UI only.

## 2. The map today (3 levels deep at most)

Admin opens on a **grid of 9 cards** (phase 167) with an **App & Updates** card underneath the grid. Breadcrumbs are one row (phase 201). Two cards open a second grid.

| Card | Level 2 | What is on it | Phase |
| --- | --- | --- | --- |
| **Overview** | — | **Today's Sales** (orders, revenue, cash, M-Pesa/card for the calendar day) · **Shift Controls** (shift status, window note, Open Shift form with float and M-Pesa opening balance, Close Shift form with counted cash and M-Pesa closing balance, Z report pop-up with Print) · **Staff** (add staff with role, reset PIN) | 150–232 |
| **Integrations** | grid of 5 | **Shopify** (store URL, Admin API token, connect & verify) · **Store Details** (legal name, phone, the slip's identity) · **Location** (the Shopify location this till sells from; drives the till code and trader invoice number) · **Fiscal Device** (ZFPLabServer address, device IP and port, password, Test Connection, default tax class, set-up status) · **M-Pesa** (how payments are confirmed: manual / send request; Daraja credentials, sandbox/production; allow manual verification; where messages arrive) | 167, 202, 204 |
| **Peripherals** | grid of 2 | **Scanner** (one paragraph of instructions for prefixing stations) · **Printers** (list, add printer, roles, test print) | 205 |
| **M-Pesa Logs** | — | every STK push and query, accepted or rejected | 148 |
| **Needs Attention** (badge) | — | **Sales needing attention** (unfiled, paid-but-stuck) · **Tax invoices not printed** · **VAT figures to reconcile** | 158–214 |
| **Stock Take** | — | start a stock take, count, approval policy, push to Shopify, past stock takes | 140s |
| **End of Day** | — | one calendar day: per-cashier totals, manual M-Pesa entries ticked against the statement, carry-overs, discarded held sales; manager PIN to approve. Fixed top, scrolling middle, pinned bar | 151–153, 217, 220 |
| **Reports** | — (six sections stacked) | **Shift History** (every shift; tap → Z report with Corrections; **Move a sale**; **Window report** when a window has two shifts) · **Sales Summary** (presets) · **Fiscal Status by Day** · **Fiscal Reconciliation** · **Invoice List** · **Export** (CSV) | 159–163, 221–232 |
| **System** | — | **Startup Configuration** (Use Mock M-Pesa; Use Mock eTIMS in dev builds only; Save & Restart) · **Reset Configuration** (clears Shopify connection and location, no undo) | 110, 170 |
| *(below the grid)* **App & Updates** | — | installed version, Check for Updates, Download, Install and restart, last update result | 205, 219, 230 |

Outside Admin but related: the cart's **No shift open** notice and **Open shift** dialog; the **Held sales** strip; the header **status button** (online, unfiled count, connectivity per integration); **Orders** (history, retry, reprint); the **Window-end banner** on the cart and Admin from the window's last minute.

## 3. What the map shows (observations, not decisions)

1. **"Overview" is three unrelated things.** A glance at today's figures, the shift open/close controls, and staff administration share one card because they were the original single Admin page. None of the three is an overview of the others.
2. **Shift work is in four places.** Open and close on *Overview*; history, the Z report, corrections, Move a sale and the window report under *Reports*; the cashier's open-shift dialog on the *cart*; and the end-of-window banner on both. A manager closing a shift and then checking it walks Overview → Admin → Reports → Shift History.
3. **M-Pesa is in four places.** Settings under *Integrations → M-Pesa*; the push log on its own top-level card *M-Pesa Logs*; the manual-entry approval inside *End of Day*; and the mock flag under *System*. The *M-Pesa Logs* card is the only top-level card devoted to one integration.
4. **The tax device is in three.** Settings under *Integrations → Fiscal Device*; the stuck sales, unprinted invoices and VAT reconciliation under *Needs Attention*; fiscal status by day, reconciliation and the invoice list under *Reports*. Needs Attention and Reports → Fiscal Reconciliation are two views of the same stored groups.
5. **Shopify is in four.** *Integrations → Shopify*, *Store Details* and *Location* (three cards for one connection); *Stock Take* pushes to it; *System → Reset Configuration* clears it.
6. **Two of the nine cards are thin.** *Peripherals → Scanner* is one paragraph of instructions; *System* is two toggles (one dev-only) and a reset button. *Peripherals* exists to hold Scanner and Printers; it is a grid of two.
7. **Daily work and one-time setup sit side by side with equal weight.** Daily: Overview (shift), Needs Attention, End of Day, Stock Take, Reports → Shift History. Setup, rarely touched after go-live: Integrations, Peripherals, System, App & Updates, Staff.
8. **Reports is a long stack, not a grid**: six sections on one scrolling page, where the other multi-part cards use a second grid. Shift History, with its three actions, is the most used and sits first; Export is last.
9. **Depth is uneven.** Integrations → Fiscal Device is three taps; Needs Attention is one; End of Day is one; Shift History is two but through "Reports".
10. **The only role split is admin or not.** Nothing inside Admin is further gated by role; the manager-PIN prompts are per action. Any regrouping that wants "cashier-visible" pieces (for example Close Shift) means a third level of access, which today does not exist.

## 4. Groupings to consider

Each keeps every function; only the doors move. None changes the main process, the database or a rule.

**A. By job: who does it and when.** Six cards.

| Card | Holds |
| --- | --- |
| **Shift** | open/close (from Overview), status and window note, Shift History, Z report, Corrections, Move a sale, Window report |
| **Money** | End of Day (unchanged inside), M-Pesa Logs, Sales Summary, Export |
| **Tax (KRA)** | Needs Attention's three lists, Fiscal Status by Day, Fiscal Reconciliation, Invoice List, Fiscal Device settings |
| **Stock & Shopify** | Stock Take, Shopify connection, Location |
| **Till setup** | Store Details, Printers, Scanner, M-Pesa settings, Startup Configuration, Reset Configuration, App & Updates |
| **Staff** | add staff, reset PIN |

Today's Sales (the glance) would go to the Admin landing page itself, above the grid, where App & Updates sits now. Deepest path: two taps everywhere. Needs Attention's badge moves to the Tax card.

**B. Daily versus setup.** Two rows on the landing page: **Every day** (Shift, Needs Attention, End of Day, Stock Take, Reports) and **Setup** (Integrations, Peripherals, Staff, System, Updates). Nothing inside the cards changes except Shift pulling its history out of Reports. Smallest change with a visible gain; keeps nine or ten cards.

**C. Tidy only.** Keep the nine cards; move Shift History (with Move a sale and Window report) from Reports into Overview beside Shift Controls; fold M-Pesa Logs into Reports; fold Peripherals into System as "Till hardware"; rename Overview to "Shift & Staff". Seven cards, same depth.

What A costs more than C: the Needs Attention deep link and badge move; `adminInitialTab` gains values; the two Integrations and Peripherals grids disappear; more tests change. What C does not fix: shift history still sits apart from the Z report's print-after-close pop-up only in name, and M-Pesa stays in three places.

## 5. What any rearrangement must respect

- **Tests that pin the layout:** 9 files, 69 references to the card list, section names or breadcrumbs (`adminScreen`, `adminBreadcrumbs`, `adminIntegrationsSections`, `adminPeripheralsUpdates`, `adminStoreDetails`, `adminShiftWindows`, `adminShiftMpesaBalance`, `adminTitleRemoved`, `endOfDayPage`), plus the card-order assertions and the 30 Close Shift / Open Shift references found in phase 235's audit. Each changes deliberately, old and new recorded.
- **The no-scroll and fit rules:** `noUnexpectedScroll.test.ts` has an allow-list per file (End of Day: 1). A card that gathers more content than today's Overview needs the same fixed-top / scrolling-middle shape phase 220 gave End of Day, or a second grid. check:fit is not run; the owner checks the till.
- **Deep links:** header status → Needs Attention; `adminInitialTab` for Reports; the cart's window-end banner mentions where to close. Each must point at the new home.
- **Breadcrumbs** already handle Admin → card → section; a third grid level is not needed by any option above.
- **Role:** everything stays admin-only unless the owner rules otherwise (§3.10).
- **The other session** works in this tree; a rearrangement touches `AdminScreen.tsx` heavily, so it should be scheduled when no other Admin work is in flight.

## 6. For the owner to decide

1. Which grouping (A, B, C, or your own), and the card names.
2. Whether **Today's Sales** belongs on the landing page, inside Shift, or inside Money.
3. Whether Needs Attention keeps its own card and badge (it is the one place a stuck sale shows) or moves under Tax.
4. Whether anything should become visible to cashiers (today: nothing in Admin is).
5. Whether Reports becomes a grid of its six sections or stays a stack.

Nothing is built until these are ruled. The build would be one phase per card moved, each with its test changes listed, so the tree is never half-moved.
