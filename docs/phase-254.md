# Phase 254 — Cashiers run their own shifts, print the Z, and see their own sales and shifts

- **Date:** 2026-10-07
- **Asked by the owner:** the 01:45 file (C1 to C8, A1 to A3). The audit first, then the build, in one run.
- **Owner's additions during the run:**
  - **The Z report of an open shift is locked.** Pressing Print on it asks for the shift to be closed first.
  - "Ensure all edge cases are tested."
  - The receipts' official details: "Rubis Energy Kenya PLC", PIN P000593549A. These are **not changed**; see "For the owner".
- **Status:** built and tested in one commit. **Not released.** The release file `Rubis_POS_Release_2_2_11_Build_and_Publish.md` is not on this machine, so it was not run.
- **Standing rules kept:**
  - the app was not launched;
  - nothing was sent to the device, Shopify or Safaricom, and no sale was made;
  - no `check:fit`;
  - the 1606 copy was used only as a temp copy, and is unchanged by SHA-256.

## 1. Audit

No "Stop if" applies:
- the code has a `cashier` role;
- roles are already checked in the main process (an admin PIN, re-verified);
- opening a shift needs no stored PIN that would have to change;
- no C6 item touches the shift arithmetic.

Line numbers are those at `1036531`, before the change.

| # | Question | Answer |
| --- | --- | --- |
| 1 | Roles today | **Two roles, `admin` and `cashier`.** They are defined in `database.ts:309` (`StaffRole`) and `database.ts:1341` (`CHECK (role IN ('admin', 'cashier'))`). **There is no `manager` role.** "Manager" in the code means an admin who types their PIN.<br>**On screen:** `App.tsx:733` (Admin tab for admins only), `AdminScreen.tsx:1109` ("Access restricted"), `App.tsx:783`.<br>**In the main process:**<br>- `requireAdminPin.ts:43-57` re-verifies an admin's PIN sent with the request (role `admin`).<br>- `shift-open.ts:55` checks that the staff id named is an active admin.<br>- `database.ts:5022` (the 244 override) is admin only.<br>**There was no session:** the main process did not know who was signed in (`index.ts:3446`, `auth:logout` did nothing; `index.ts:3820` "KNOWN GAP"). |
| 2 | Shifts today | **Open:** an admin as themselves, or anyone with an admin's PIN (`shift-open.ts:47-58`). A cashier at the cart was asked for a manager's PIN (`OpenShiftDialog.tsx:62`), so **Open Shift on the cart did not work for a cashier alone.**<br>**Close:** `shifts:close` (`index.ts:3553`) had **no role check**. Only the Admin screen offered it.<br>**Correct** (`index.ts:3694`), **move** (`3611`), **merge** (`3661`), **approve M-Pesa** (`3912`): an admin PIN, re-verified.<br>**Override:** admin only, in the database (`database.ts:5022`). |
| 3 | The Z today | Viewed through `reports:z-report` (`index.ts:3736`) and printed through `receipt:print` with `isZReport` (`index.ts:3325`). **Neither checked a role.** On screen: Admin (after Close Shift) and the Reports tab only. |
| 4 | Login routing today | No routing: the screen stayed on whatever view was last open (`uiStore.ts:26` starts on `catalog`). **A cashier logging in after an admin who left the Admin tab landed on "Access restricted".** |
| 5 | Sales by cashier | `orders.staff_id` (`database.ts:1258`), written from the checkout request's `staffId`. The invoice list (`index.ts:4069`) could not be filtered by it. The Orders tab (`orders:getLocal`, `index.ts:2762`) showed **every** sale to everyone. |
| 6 | IPCs a cashier could reach that change data, and their check | **An admin PIN, re-verified:** `config:set`, `config:clear`, `store:set-identity`, `printers:save`, `printers:delete`, `location:set`, `shopify:set-store-url`, `integrations:set-config`, `secrets:set-etims-password`, `secrets:set-mpesa-credentials`, `staff:create`, `staff:resetPin`, `shifts:correct`, `shifts:move-sale`, `shifts:merge`, `reports:approve-shift`, `mpesa:reconcile`, `stocktake:commit`, `stocktake:abandon`, `stocktake:save-settings`; also the cashier-side `held:discard`, `cart:record-removals`, `fiscal:print-duplicate`.<br>**No check at all:** `shifts:close`, `config:save` (onboarding), `setup:save-etims-config`, `secrets:set-shopify-token`, `reports:export-csv` (writes a file), `printers:test`, `orders:retrySync`, `fiscal:resend`, `stocktake:open`, `stocktake:count`, `stocktake:remove`, `stocktake:submit`, and every read.<br>**Refused for everyone:** `orders:void` (`index.ts:2735`). |

**Findings that shaped the build:**
- **The manager PIN prompt checks a PIN through `auth:login`** (`ManagerPinModal.tsx:62`). A session started by every `auth:login` would have turned a cashier's till into the manager's the moment a manager authorised something. So the session starts only when the login screen asks for it.
- **The cashier's own screen calls PIN-gated channels:** a held sale's discard, a cart removal, the ETR copy. A manager types their PIN there. "Refused for a cashier" therefore means the cashier's own authority is not enough. Those channels stay open to a cashier's session, and the PIN stays their authority, as before.
- **Onboarding saves the Shopify connection before anyone can sign in** (`config:save`, no PIN by design). "Nobody signed in" is handled apart from "a cashier signed in".
- **About 16 test files read `index.ts` by the text `ipcMain.handle(`.** So the gate goes in under the name `ipcMain` rather than renaming 120 registrations.

## 2. What was built

| Rule | How |
| --- | --- |
| **Role gate** (build 1, 6, 7) | New [lib/roleGate.ts](../src/main/lib/roleGate.ts).<br>`index.ts` imports Electron's `ipcMain` as `electronIpcMain`, and `const ipcMain = gateIpcMain(electronIpcMain, staffSession)`. **Every one of the 122 handlers goes through it unchanged in text.**<br>- An admin may call every channel (C7).<br>- A cashier may call only `CASHIER_CHANNELS` (47 channels: selling, held sales, Orders, shifts open/close/current/window, the Z, "My shifts and sales", the update prompt).<br>- **Anything else, including any handler added later, is refused before it runs**, with "This needs a manager." (deny by default).<br>- Nobody signed in: the cashier's list plus onboarding's `config:validate` and `config:save`. |
| **The session** | `auth:login` with `session: true` (the login screen only) ends any earlier session, then signs the staff member in if the PIN is right ([auth.ts](../src/main/services/auth.ts) `loginWithSession`). Without the flag, it is a PIN check that changes no session. `auth:logout` signs out. The preload sends the manager prompt's request byte for byte as before. |
| **C1** | [shift-open.ts](../src/main/services/shift-open.ts): whoever is signed in opens the shift **as themselves**, with no PIN, recorded under **the session's** id, never the id the screen sends.<br>- An inactive account is refused.<br>- **Starting at 0 stays an admin's choice:** a cashier asking for it gets "This needs a manager."<br>- A manager's PIN still opens under the manager.<br>- With nobody signed in, the rule from before: an admin's id. |
| **C2** | Any signed-in cashier closes the till's open shift (A1).<br>- `closed_by_staff_id` is a new nullable column, check-then-add, safe to run twice. It holds **the session's** staff member.<br>- The close is passed the closer only when there is one, so every existing call is identical.<br>- **No figure depends on it:** a test closes two identical shifts, one with a closer and one without, and the figures are equal. |
| **C3 and A1** | The Z names the closer as "Closed by: …", on screen and on paper, **only when one was recorded**, so every earlier shift's Z reads and prints exactly as before. `zReportRefusal` in the main process, for the view and the print:<br>- a cashier gets the Z of a **closed** shift they opened or closed, and no other;<br>- an admin gets any. |
| **The Z lock** (owner, mid-run) | **An open shift's Z is locked.**<br>- **Nobody prints it, admin included**, refused in the main process with "This shift is still open. Close the shift first: its Z report is locked until then."<br>- A cashier does not see it either.<br>- An admin still sees its running figures on the Reports tab (C7), but **Print asks for the close instead of printing**: "Shift #N is still open. Close the shift first (Admin, Shift Controls)…". Nothing is sent to the printer.<br>- On the cashier's page, the open shift's **Print Z** shows the same prompt beside its **Close shift** button.<br>- Once closed, the Z prints, as often as wanted. |
| **C4** | `authStore.login`: a cashier always lands on the catalogue. An admin lands where the screen was, as today, unless that was a cashier's page (admins have no tab for it). A failed login changes nothing. |
| **C5** | New tab **"My shifts and sales"** for cashiers ([MyShiftsPage.tsx](../src/renderer/src/pages/MyShiftsPage.tsx)), view only:<br>- **My shifts:** the till's open shift on top with **Close shift** (counted cash, M-Pesa at end, card at end; held until the window end, as on Admin; a held sale stops it) and **Print Z**; then the cashier's shifts, newest first, with **Z report**, which shows Print and never Correct figures.<br>- **My sales:** time, trader invoice #, CU invoice # or status, total, payment. The invoice list's columns, without the cashier column.<br>- Both read through [services/my-shifts.ts](../src/main/services/my-shifts.ts), using the existing reads with a staff filter added. **The id is the session's; the request carries only a page**, and a staff id sent with it is dropped. |
| **C6** | Every listed action is off the cashier list, so it is refused by role in the main process:<br>- correct and its override, move and its override, merge;<br>- the M-Pesa approvals;<br>- export;<br>- every setting, staff, printer, integration and location write;<br>- void;<br>- **every report that shows other cashiers' sales:** invoice list, sales summary, end of day, Shift History, the fiscal lists, the M-Pesa logs.<br>**The Orders tab now shows a cashier their own sales only** (`orderHistoryFor`). |
| **C8** | Shift arithmetic, window rules, auto-assign, payment gates, the 249 key, split payments, the discount and the sync are not touched. The Z keeps its layout plus the "Closed by" line (A1). |

## 3. Tests

| File | Tests | What |
| --- | --- | --- |
| [roleGate.test.ts](../tests/roleGate.test.ts) | 23 | **Each C6 item, as a cashier:**<br>- refused with "This needs a manager.";<br>- **its handler never runs and every table's row count is unchanged** (real `:memory:` SQLite, with stand-in handlers that write).<br>**Further:**<br>- an admin passes all 122 channels;<br>- deny by default;<br>- every listed channel is registered;<br>- `index.ts` registers nothing on Electron's `ipcMain` directly, and no channel twice;<br>- the session copies who signed in |
| [loginSession.test.ts](../tests/loginSession.test.ts) | 3 | **The preload:**<br>- the manager PIN check's request is byte for byte as before;<br>- the login screen's carries `session: true`;<br>- the "My" requests send only the page |
| [cashierShifts.test.ts](../tests/cashierShifts.test.ts) | 17 | - a cashier opens with starting cash and M-Pesa, under their own id, whatever id the screen sent;<br>- start-at-0 refused;<br>- **close with counted figures: opener and closer recorded, figures identical to a close before the phase**;<br>- closing before window end refused, nothing changed;<br>- the Z names both, and prints "Closed by" right under "Opened by";<br>- a shift closed with no closer prints as before;<br>- which Z a cashier may see and print; the open-shift lock;<br>- the checks come before the Z is built, for view and print;<br>- My shifts and My sales by the session's id, **though the request names another cashier**;<br>- the Order History;<br>- the column added to a database made before the phase, twice |
| [cashierEdgeCases.test.ts](../tests/cashierEdgeCases.test.ts) | 25 | **The session:**<br>- a wrong PIN signs out the earlier session;<br>- an inactive account cannot sign in;<br>- a manager PIN check, right or wrong, leaves the cashier signed in.<br>**The gate:**<br>- passes event and arguments untouched;<br>- decides at call time;<br>- A3: receipt reprint unchanged.<br>**Opening:**<br>- a manager PIN at a cashier's till, and a wrong one;<br>- an inactive cashier;<br>- an admin's start at 0;<br>- nobody signed in.<br>**Closing:**<br>- a held sale;<br>- a shift already closed keeps its first closer;<br>- an unknown closer reads "Unknown".<br>**The lock** with nobody signed in, and the Z unlocking at close.<br>**My shifts:** paging; a merged shift left out; a cashier with no shifts.<br>**My sales:** paging; a split sale; a malformed page.<br>**Older sales with no cashier:** the admin's alone; limit and offset kept |
| [cashierScreens.test.ts](../tests/cashierScreens.test.ts) | 21 | **Real stores and a real mount. Login:**<br>- a cashier lands on the catalogue from every view;<br>- an admin lands where the screen was;<br>- a failed login changes nothing.<br>**The page:**<br>- lists, Close shift, Print Z on the open shift asks for the close and reads nothing;<br>- close with figures, then the Z with Print and no Correct figures;<br>- a missing cash figure and a bad M-Pesa figure refused;<br>- blanks sent as not recorded;<br>- a held sale;<br>- a refused close keeps the form;<br>- the empty states;<br>- the window-end hold;<br>- a refused Z.<br>**On an admin screen**, Print on an open shift's Z asks for the close and prints nothing |
| [cashierReach.test.ts](../tests/cashierReach.test.ts) | 117 | **Every `window.api` call in every renderer file a cashier can reach** (all but the listed admin-only screens, so a new screen is checked by default) is mapped through the preload to its channel, and must be on the cashier list. So the gate cannot break a cashier's screen. Checked with a mutation: removing two channels from the list failed it, naming the two files |

### Existing tests changed

Each change is marked CHANGED in the file.

- **`shiftCaptureUi.test.ts`:** the cart dialog no longer takes `requestManagerPin`. "Asks a cashier for a manager PIN" and "opens nothing while the PIN has not been given" became "opens the shift for a cashier as themselves, with no PIN" (C1).
- **`shiftCapture.test.ts`, `oneShiftPerWindow.test.ts`:** the `shifts:open` text check now expects `openShiftChecked(db, validation.data, staffSession.current())`.
- **`rehearsal/paulCopy.test.ts`:** shift #8's byte comparison leaves out `closed_by_staff_id`, and checks it reads NULL, as phase 246 did for the card columns.

### Mutation checks

Each was restored and compared byte for byte afterwards.

| # | Mutation | Failing tests |
| --- | --- | --- |
| 1a | Remove the correction's role check: `shifts:correct` added to the cashier list | 3 |
| 1b | The same, by registering `shifts:correct` on Electron's `ipcMain`, past the gate | 2 |
| 2 | Route a cashier to Admin after login | 4 |
| 3 | Trust the cashier id sent from the screen in My sales | 1 |
| 4a | Let a cashier print another cashier's Z: the print path's check removed | 1 |
| 4b | The same, with the rule loosened | 1 |
| 5 | Unlock the open shift's Z for printing | 3 |
| 6 | Print on an open shift's Z goes to the printer instead of asking for the close | 1 |
| 7 | A manager PIN check at a cashier's till starts the manager's session | 1 |
| 8 | Two channels removed from the cashier list (the reach test) | 2 |

## 4. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | 249 files passed, 2 skipped (the copy rehearsals); 4,182 tests passed, 9 skipped |
| Copy rehearsals and golden, on a temp copy of the 1606 copy | 9 of 9: payment figures to the cent and the orders CSV byte for byte. The copy is unchanged by SHA-256 (`a3def016…`) |
| Mutation checks | 10 of 10 caught, every file restored byte for byte |
| `npm run build` | passed |

## For the owner

- **On the till after the update:** the five checks in your file. Add a sixth: with a shift open, **Print Z asks you to close the shift first**, for an admin too.
- **The receipt's name and PIN are a setting, not code.** An admin types them on each till in **Admin > Store details**:
  - the large top line is "Store name";
  - "Legal name" prints under it;
  - "KRA PIN" prints as `PIN: …`.

  This phase changed nothing there. To print "Rubis Energy Kenya PLC" and P000593549A, either:
  - (a) enter them in Store details on each till, or
  - (b) order a change that fixes them in the code, so no till can print anything else.

  I did not read either till's current values. The PIN on the paper should also match the PIN the fiscal device is registered under, which I have not checked: no device is connected.

## Observed

- **The cashier recorded on a sale still comes from the screen** (the checkout's `staffId`), as before. "My sales" trusts what was recorded at checkout; C8 kept the payment path unchanged.
- **The main process keeps the session until logout or a new login.** If the window were reloaded mid-session, it would hold the last person until the next login. Packaged builds block DevTools (`index.ts:460`). The till offers no reload.
- **With nobody signed in, the PIN-gated channels refuse as before, and onboarding's `config:save` works as before.** The gate adds no PIN to onboarding.
- **The eTIMS setup gate (`setup:save-etims-config`) is now refused to a cashier:** "change settings". On a till whose fiscal setup is unfinished, an admin must log in to finish it. Both live tills are set up.
- **`secrets:set-shopify-token` had no PIN.** It is now refused to a cashier; for an admin it is unchanged.

## Not verified

- **The app was not launched.** The new tab, the page and the lock prompt have not been seen on a till, and are not measured (no `check:fit`).
- **The printed "Closed by" line was checked through the printer code with a fake printer**, not on paper.
- **The receipt identity values** on either till.

## Rollback

Revert the commit.
- `closed_by_staff_id` stays in the database as an unused nullable column. Older builds read rows by name and ignore it.
- Shifts closed in the meantime keep their figures. Only the "Closed by" line goes.
