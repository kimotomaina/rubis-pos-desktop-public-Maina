# Phase 219 — check for updates at startup, ask, ask again next time

- **Date:** 2026-10-04
- **Requested:** on start the till checks for an update by itself; if there is one it asks; if the user says no, nothing happens and it asks again at the next start. **Nothing installs without a yes.**
- **Status:** built. Sections 1-8 are the audit (written first, unchanged); sections 9-15 are the rulings and the build.
- **Outcome:** typecheck clean; full suite **198 files, 3274 tests, all passing** (195 and 3227 before: +3 files, +47 tests); `npm run build` passes with the no-mock check.
- **Not measured / not done:** layout (`check:fit` is not run, by the standing rule). **Nothing was run against GitHub or a real installer:** the prompt, the download and the install have not been seen on a packaged build.

## 1. Where the updater lives, and the current values

`electron-updater` 6.8.9, GitHub provider (`Volcha-Enterprises/rubis-pos-releases`, [electron-builder.yml:42](../electron-builder.yml#L42)), NSIS (`oneClick: false`).

| Setting | Value today | Where |
| --- | --- | --- |
| `autoDownload` | **`true`**, set explicitly | [updater.ts:42](../src/main/services/updater.ts#L42) |
| `autoInstallOnAppQuit` | **`true`, by default, never set anywhere in `src/`** | library default, [AppUpdater.js:114](../node_modules/electron-updater/out/AppUpdater.js#L114); the doc comment at [toastTimeouts.ts:34](../src/renderer/src/lib/toastTimeouts.ts#L34) relies on it ("installs on the app's next normal restart") |
| `allowPrerelease` | **not set; library computes `false`** for 2.1.9 (it is `true` only when the installed version has a prerelease part such as `-beta.1`) | [AppUpdater.js:218](../node_modules/electron-updater/out/AppUpdater.js#L218) |

Every call site (all of `src/`):

| Call | Where | Triggered by |
| --- | --- | --- |
| `checkForUpdates` | [index.ts:3801](../src/main/index.ts#L3801), inside the `updater:check` handler, through the wrapper in [updater.ts:76](../src/main/services/updater.ts#L76) | only the **Check for Updates** button, [AdminScreen.tsx:1219](../src/renderer/src/components/AdminScreen.tsx#L1219) |
| `downloadUpdate` | **none**: the download starts by itself because `autoDownload` is true | — |
| `quitAndInstall` | [index.ts:3828](../src/main/index.ts#L3828), inside the `updater:install` handler, **after** the phase 178 backup (`installUpdate`, [updateBackup.ts:186](../src/main/services/updateBackup.ts#L186)) | the **Install update and restart** button (enabled only after `downloaded`), and the **Restart & Install** button on the toast ([UpdateToast.tsx:69](../src/renderer/src/components/UpdateToast.tsx#L69)) |

There is **no check at startup today**. IPC channels: `updater:check`, `updater:install`, `updater:last-result`, and the broadcast `updater:status` (kinds `checking`, `available`, `downloading`, `downloaded`, `not-available`, `error`).

**Consequence of the defaults, confirmed in the library source.** Once a download finishes, `addQuitHandler` ([BaseUpdater.js:69](../node_modules/electron-updater/out/BaseUpdater.js#L69)) registers an install on app quit unless `autoInstallOnAppQuit` is false. So **today** a downloaded update installs the next time the till is closed or restarted, whoever closed it and whatever they answered, and **without the phase 178 backup** (that backup is only in `updater:install`). This is the behaviour the owner's rule forbids.

## 2. Is the existing flow check, download, install in separate steps?

Not today. It is **check → (automatic) download → install**: `autoDownload = true` fuses the first two. The panel and the toast are built on that:

- **App & Updates panel** ([AdminScreen.tsx:1308](../src/renderer/src/components/AdminScreen.tsx#L1308)): Check button; result text from `updateResultText` (`Up to date`, `Version X is ready to install`, error); a progress line for `downloading`; **Install update and restart**, enabled only when status is `downloaded`. It has **no Download button and no text for `available`**.
- **Toast** ([UpdateToast.tsx](../src/renderer/src/components/UpdateToast.tsx)): shows only `downloading` and `downloaded`; silent for everything else.

**What this means for the build.** Setting `autoDownload = false` alone **breaks the panel**: Check would end at `available`, nothing downloads, the Install button never enables. The reusable steps already exist (the `updater:status` broadcast, the progress states, and `updater:install` with its backup). The missing piece is one new step, **download on request** (`downloadUpdate`, which the library only allows after a check in the same session: it rejects with "Please check update first" otherwise). That one step is then used by both the new prompt and the panel (a **Download** button shown for `available`), so there is one flow, not two.

## 3. Dev runs

`app.isPackaged` is **not** tested in `updater.ts` or in the `updater:check` handler. The protection is the library's: `checkForUpdates()` returns `null` and logs "Skip checkForUpdates because application is not packed" when `app.isPackaged` is false and `forceDevUpdateConfig` is false ([AppUpdater.js:254-283](../node_modules/electron-updater/out/AppUpdater.js#L254)); `forceDevUpdateConfig` is not set anywhere in `src/`. So a dev run does not check today. It rests on the library, not on our code. In that case no `update-available` event fires, so the prompt could never appear in dev; the build adds our own `app.isPackaged` guard anyway so the test can assert it ("Dev: no check is made") without depending on library internals.

## 4. A draft release is invisible to the updater: confirmed, with its limit

- Unauthenticated GitHub provider: it reads the public releases feed, then (with `allowPrerelease` false) asks for the **latest release** ([GitHubProvider.js:93](../node_modules/electron-updater/out/providers/GitHubProvider.js#L93), `getLatestTagName`). GitHub shows neither drafts nor pre-releases there. `releaseType` is not overridden in `electron-builder.yml`, so `npm run dist:publish` creates a **draft** (release 2.1.6, section 6).
- It follows that the **Publish button on the GitHub release is the act that sends an update to every till.** After this phase, every till that is started after that moment will ask its user whether to update. Until Publish is pressed, nothing is offered anywhere. A release published as a **pre-release** is also not offered (while `allowPrerelease` is false).
- **Limit:** this relies on the repository being readable without a token (it is, or Check for Updates would not have worked for phase 178) and on GitHub's behaviour, which I read in the library but did not call live. The release workflow should state: publish only after the printer and fiscal checks pass on a till (release 2.1.6 said the same for the printer test).

## 5. What a restart for an install does

`quitAndInstall` (NSIS) **spawns the installer first**, then `app.quit()` on the next tick ([BaseUpdater.js:13](../node_modules/electron-updater/out/BaseUpdater.js#L13), [NsisUpdater.js:101](../node_modules/electron-updater/out/NsisUpdater.js#L101)). The quit then goes through the app's own hooks ([index.ts:1215](../src/main/index.ts#L1215), [index.ts:1253](../src/main/index.ts#L1253)): cart flush (waits at most 500 ms), ZFPLabServer session close, engines stopped, `db.close()`.

| What | Survives? | Why |
| --- | --- | --- |
| **Cart draft** (phase 197-1) | **Only if the flush wins a race** | the flush is asked for on `before-quit` and waits up to 500 ms, but the installer is already running by then and its own "is the app still running" step may end the process first. I did not time that. **The design removes the dependency: Update now is refused while the cart has items,** so there is nothing to save. |
| **Held sales** (phase 217) | **Yes** | stored in `held_sales` at the moment of hold (a committed transaction). A sale that has been **resumed** has its lines in the cart, so Update now is refused; and `recoverHeldSales` turns any `resumed` row back to `held` at the next start anyway. |
| **Fiscal queue, Shopify `sync_queue`** | **Yes (rows)** | SQLite rows written inside the checkout transaction; the queues are re-read at startup. WAL is recovered if the process is ended before `db.close()`. |
| An **in-flight** fiscal or Shopify request at the instant of the quit | **Aborted, row stays queued** | `engine.stop()` and `fiscalEngine.stop()` run at `will-quit`; the row is retried after the update. This is the same as any quit today and I did not test it here. |

Also: the **phase 178 backup** (database copy plus `pendingUpdateCheck` setting) is written by `updater:install` before `quitAndInstall`; the "Update now" path must go through that same handler so the backup is not skipped.

## 6. Two things the brief did not mention, found in the audit

1. **The payment signal does not cover checkout in flight.** `usePaymentActivityStore` (phase 217) is set only by `PaymentModal` and `CardEntryPanel` (a push waiting, a request in flight, a code or reference typed). Once COMPLETE SALE is pressed, `cartStore.checkoutStatus` is `'submitting'` ([PosCheckoutPanel.tsx:191](../src/renderer/src/components/PosCheckoutPanel.tsx#L191)) while the fiscal request and the order transaction run. Neither "cart has items" nor the payment signal is guaranteed true then: the cart is cleared inside the transaction and can be empty a moment before the result arrives. **Proposal: also refuse while `checkoutStatus === 'submitting'`** (a third refusal reason: "A sale is being completed").
2. **Phase 178 dropped an in-flight check on a premise this phase breaks.** [updateBackup.ts:134-141](../src/main/services/updateBackup.ts#L134) says the install button lives only on the Admin screen, "so nobody can be completing a sale on this till". The prompt is on the sale screen, so that premise is false from now on; item 1 is what replaces it. That comment should be updated in the build.

## 7. Open points for the owner before the build

1. **Existing test that must change.** [tests/updater.test.ts:35-39](../tests/updater.test.ts#L35) asserts `autoDownload` is `true` ("enables autoDownload and registers all six event listeners"). It cannot run unmodified under the new rule. I will change only that name and assertion (to `false`, plus `autoInstallOnAppQuit` `false`) and quote it. The other updater tests: `updater.test.ts` 11, `updateBackup.test.ts` 15, `databaseUpdateBackup.test.ts` 7, `updateReleaseConfig.test.ts` 4, `adminPeripheralsUpdates.test.ts` 10 (counted as `it` lines, 47 in all); I will run them and quote the real counts.
2. **The panel gets a Download step** (section 2), otherwise its Install button can never enable. The panel's existing text and the Install button stay as they are.
3. **Refusals:** cart has items, payment in progress, **and** sale being completed (section 6, item 1). Say if you want only the first two.
4. **"Once per app start":** I will keep the flag in the main process (a boolean in memory, never stored), so a window reload (reset configuration and onboarding both reload the window) does not count as a new start, and an unlock after logout and login on the same run does not ask again. Say if you would rather it asked at every login.
5. **Toast:** `UpdateToast` keeps working for `downloading`/`downloaded`; its **Restart & Install** button goes through the same `updater:install`. The comment at [toastTimeouts.ts:34](../src/renderer/src/lib/toastTimeouts.ts#L34) becomes false (nothing installs on quit) and is corrected.
6. **After the update, install is silent about held sales:** nothing to do; they come back as they were.

## 8. Not in scope

A check on a timer during the day. Silent or forced updates. Rollback to an older version. `check:fit`.

## 9. Rulings applied

1. `tests/updater.test.ts` changed in two lines, nothing else. Old: `it('enables autoDownload and registers all six event listeners', ...)` and `expect(autoUpdater.autoDownload).toBe(true)`. New: `it('registers all six event listeners and leaves autoDownload off', ...)` and `expect(autoUpdater.autoDownload).toBe(false)`. That fake starts at `autoDownload: false`, so the edited assertion alone cannot catch a missing setting; the real proof is in the new `updateAtStartup.test.ts`, whose fake starts from the library's own defaults (both `true`).
2. All three refusals are built, each with its own words (section 11).
3. Once per start is a flag in the main process (`createStartupUpdateCheck`), in memory only.
4. The panel has a **Download update** button and the toast comment is corrected.

## 10. What changed

| Where | Change |
| --- | --- |
| [updater.ts](../src/main/services/updater.ts) | `refuseUnrequestedUpdates` sets `autoDownload = false` and `autoInstallOnAppQuit = false`, **the only place either is set**, with the reason in its doc comment; `initAutoUpdater` calls it. New `checkForUpdateAtStartup` (no check when `!isPackaged`; a failure is logged, never shown), `createStartupUpdateCheck` (once per start), `downloadUpdateNow`. |
| [updateInstall.ts](../src/main/services/updateInstall.ts) (new) | `installWhenQuiet`: the background-work wait (section 12). |
| [fiscal-engine.ts](../src/main/services/fiscal-engine.ts), [sync-engine.ts](../src/main/services/sync-engine.ts) | `pause()`, `resume()`, `whenIdle()` (section 12). |
| [index.ts](../src/main/index.ts) | `updater:startup-check` and `updater:download` handlers; `updater:install` goes through `installWhenQuiet`; an updater `error` resumes the engines. |
| [preload](../src/preload/index.ts) | `startupUpdateCheck`, `downloadUpdate`. |
| [UpdatePrompt.tsx](../src/renderer/src/components/UpdatePrompt.tsx) (new), [updateNow.ts](../src/renderer/src/lib/updateNow.ts), [updateStatusStore.ts](../src/renderer/src/stores/updateStatusStore.ts) | the dialog, the refusal rules, the shared status. Mounted once in [App.tsx](../src/renderer/src/App.tsx), in the final return only (after login, the location gate and the fiscal setup gate). |
| [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) | the panel reads the shared status too, says "Version X is available", and has **Download update** for that state. The Check and Install buttons are as they were. |
| [UpdateToast.tsx](../src/renderer/src/components/UpdateToast.tsx), [toastTimeouts.ts](../src/renderer/src/lib/toastTimeouts.ts) | the toast is quiet while the prompt is open; a cancelled install shows its reason instead of staying on "Restarting..."; the comment that said an update installs on quit is corrected. |
| [updateBackup.ts](../src/main/services/updateBackup.ts) | comment only: the phase 178 premise ("Install is only on the Admin screen") is replaced by what now holds. |

**Behaviour changes to know about.**
- **Check for Updates** in the panel no longer downloads. It ends at "Version X is available" with a **Download update** button.
- The toast's "Update ready" appears only after a download someone asked for.
- Nothing installs when the till is closed. A downloaded update that nobody installs is simply not installed.
- The panel's and the toast's **Install** go through the same engine wait but are **not** subject to the three refusals; those belong to the prompt's Update now (as ruled).
- The `AutoUpdaterLike` type has `autoInstallOnAppQuit` as optional so `updater.test.ts`'s fake still type-checks unmodified; the real singleton always has it.

## 11. The prompt

- Mounted once per login session on the sale screen. It asks the main process, which checks **once per app start** and answers null afterwards, so a logout and login, or a window reload (reset configuration, onboarding), does not ask again. The next app start asks again, because nothing was stored. A check that failed does not use up that one chance.
- Text: "Update available: version X", "Installed version A -> new version X. The till will restart to install it.", **Later** / **Update now**.
- **Later** closes it: no download, no install, nothing written (the test checks that no setting-style call is made and that `localStorage` is unchanged). The panel still shows the update.
- **Update now** refuses, checked when pressed and again after the download, with: "There are items in the cart. Complete the sale or put it on hold, then update." / "A payment is in progress. Finish it, then update." / "A sale is being completed. Wait for it to finish, then update." Held sales do not block it. Otherwise it downloads (progress bar and percentage), then calls `updater:install`, which refuses unless `update-downloaded` has been seen.
- A failed download shows "The update could not be downloaded: <reason>. The till is still running version A." and nothing restarts. A cancelled install shows its reason in the same dialog.

## 12. Letting background work finish (the addition)

**The engines as they were.** `stop()` only cleared the interval (`clearInterval(timer)`, [fiscal-engine.ts:249](../src/main/services/fiscal-engine.ts) before this phase). The re-entrancy guard is `if (running) return` at the top of `tick()`, with `running` set for the whole pass and cleared in `finally`. So `stop()` did not stop a tick from starting: the checkout trigger (`onCheckoutMade`), the reconnect trigger (`notifyOnline`) and a manual `tick()` all start one regardless of the timer. And `running` was private, so nothing could tell whether a tick was in progress. The Shopify engine has the same shape.

**The smallest addition, in both engines:** a `paused` flag checked beside `running` (`if (paused || running) return`), a list of waiters released in `finally`, and three methods: `pause()` (every trigger becomes a no-op), `resume()`, `whenIdle()` (resolves at once if no tick is running, otherwise when the running one ends). The timer is untouched. "A tick is running" is detected by the same `running` flag the guard already used.

**`installWhenQuiet`** (the one path; `updater:install` is the only caller of `quitAndInstall`, checked by a test):
1. pause both engines;
2. wait for both to be idle, at most 60 seconds;
3. at 60 seconds: resume both, install nothing, return "A sale is still being sent to the tax device. Try again in a minute." (shown in the dialog, the panel's install error, or a toast);
4. otherwise run the phase 178 backup, then `quitAndInstall`.

If the backup fails, the engines are resumed. If the installer itself cannot start, the updater's `error` event resumes them.

**What it does not cover:**
- A sale that checkout is filing right now is not an engine tick (it holds a claim, `isClaimed`). The prompt covers it with its third refusal; the panel's and the toast's Install do not.
- A request a tick had already sent when the 60 seconds ran out is left to finish and recovers through phase 208's `needs_fixing` path.

## 13. Tests

New: `updateAtStartup.test.ts` 15, `updateInstall.test.ts` 11, `updatePrompt.test.ts` 21.

- **Startup:** both flags false after startup, from a fake holding the library's defaults; set in one place only (a scan of `src`); dev (`isPackaged` false) makes no check; a failed check logs and says nothing; once per start, and again for a new start; nothing stored.
- **Prompt:** once, after login only (the single mount in App.tsx comes after the login, location and fiscal-gate returns, and only `UpdatePrompt.tsx` calls `startupUpdateCheck`). This placement is a source-order check, not a mounted App. Also: Later; the three refusals, each with no download; download then install only after the download finishes; refused again if the cart fills during the download; failed download; held sales do not block; the toast stays quiet; the panel's Download button.
- **The wait:** waits for a running fiscal tick and installs after it; composed with the real `installUpdate`, `quitAndInstall` is not called before the tick ends; no tick starts between pause and install from either engine; cancelled at the limit with the engines resumed and the message; the 60 second value; a failed install resumes.
- **Existing tests run unmodified** (except the two lines above): `updater` 11, `updateBackup` 15, `databaseUpdateBackup` 7, `updateReleaseConfig` 4, `adminPeripheralsUpdates` 10, plus the engines' own `fiscalEngine` 23 and `syncEngine` 29. All pass.
- **Mutation checks, each restored afterwards:**
  1. `autoInstallOnAppQuit = false` removed: 3 tests fail (`updateAtStartup`).
  2. Dismissal stored by Later and honoured at the next mount: 2 fail ("stores nothing", "asks again at the next start"). With only the store and not the skip, 1 fails (the "stores nothing" one).
  3. Update now allowed with items in the cart: 3 fail.
  4. `quitAndInstall` not waiting for the engines (`installWhenQuiet` skips the wait): 3 fail.

## 14. Publish is the act that updates the tills

**Pressing Publish on the GitHub release now offers the update to every till.** Every till started after that moment asks its user once, at start, after login. Until then nothing is offered, and a draft or a pre-release is invisible. The release workflow should keep the draft until the printer and fiscal checks have passed.

## 15. Rollback

Revert this commit. The engines keep working without the new methods. `autoDownload` and `autoInstallOnAppQuit` return to the library defaults (download on check, install on quit), the behaviour this phase removed.
