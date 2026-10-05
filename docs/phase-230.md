# Phase 230 — The update screens show no paths, folders or addresses

- **Date:** 2026-10-05
- **Reported by the owner:** the update section shows the path of the update. It should not.
- **Status:** built and tested. Part of release 2.2.4 (phases 227 to 230).
- **Layout: not checked by check:fit (owner's rule). For the owner to check on the till.** The only screen change is shorter text (a line lost its "Backup: <path>" ending; error messages are shorter).
- **Not changed:** the backup and install steps, their order, and the phase 219 safety checks (`installUpdate`, `installWhenQuiet`, `runPreInstallSteps`, `autoUpdater.quitAndInstall()`, no download or install without a person asking). The updater's configuration and the feed.

## 1. Audit (read-only, done first)

Every place an update screen or its messages can show a path, folder, address or file name, read at `HEAD` = `75fb885`:

| # | Where | What it showed | Source |
| --- | --- | --- | --- |
| 1 | Admin → App & Updates, after an update | `Updated A to B on <date>. Sales carried over: X of Y. Backup: <full path of the .sqlite backup>.` **This is the owner's report.** | `AdminScreen.tsx`, `formatUpdateResultLine` |
| 2 | Admin → App & Updates, the status line, state `error` | `status.message`: the raw `electron-updater` message (feed URL, status codes, file names, paths) | `updateResultText`; the message comes from `updater.ts` `initAutoUpdater`'s `error` listener |
| 3 | Admin, Download update | `result.error`: the raw message from `downloadUpdateNow` | `handleDownloadUpdate`, `updater.ts` |
| 4 | Admin, Install update and restart | `result.error`: for a failed backup, the raw `err.message` (`ENOENT: …'C:\…\backups\…sqlite'`, `disk full`) | `handleInstallUpdate`, `updateBackup.ts` `runPreInstallSteps` |
| 5 | The update prompt, a failed download | `The update could not be downloaded: <raw error>.` | `UpdatePrompt.tsx` |
| 6 | The update prompt, a failed install | `install.error`, as in 4 | `UpdatePrompt.tsx` |
| 7 | The toast, a failed install | `result.error`, as in 4 | `UpdateToast.tsx` |
| 8 | State by state | checking, up to date, available, downloading, ready: version numbers and a percentage only. The backup step has no screen of its own: its failure is row 4 and 6. | the three components |
| 9 | Console only, never shown | `Update check failed at startup: <raw>` via `console.warn` | `updater.ts` `checkForUpdateAtStartup` |

**Secrets (item 3 of the brief): none found, so no stop.**
- The app sets no token and no request header for the updater: no `setFeedURL`, `requestHeaders`, `GH_TOKEN`, `GITHUB_TOKEN` or `Authorization` in anything the updater uses (the only `Authorization` headers are Daraja's).
- The bundled `app-update.yml` holds `provider: github`, `owner`, `repo`, `updaterCacheDirName` and no token (checked in `release/win-unpacked/resources/`, key names only).
- The feed is the public repo `Volcha-Enterprises/rubis-pos-releases`, so a feed address in an error carries no credential.
- Nothing from the updater is written to `error.log` (only the crash handlers write there) or to `till.log`. Row 9 reaches the console only, which a packaged build keeps nowhere.
- A token could in principle appear in an error if a future change added one; the new log line removes tokens anyway (section 2).

## 2. What changed

| Where | Change |
| --- | --- |
| [updateErrors.ts](../src/main/services/updateErrors.ts) (new) | Plain sentences, and `createUpdateErrors`, used by `index.ts`: an `error` status becomes `The update check failed. Check the internet connection and try again.` (or, once a download has started, `The update could not be downloaded. Check the internet connection and try again.`); a failed download gets the second; a failed install (the backup step) becomes `The update could not be installed. The till is still on version X.` Two messages that are already plain and useful ("A sale is still being sent to the tax device…", "No update ready to install.") pass through. Each failure is also written to `till.log`. The same failure arriving twice within 2 s (electron-updater emits an error event and rejects) is logged once. |
| `till.log`: `update-failed` ([tillLog.ts](../src/main/services/tillLog.ts)) | New event on the fixed list, **written by the main process only**: `log:till-event` still refuses it. A line is `[time] [update-failed] check|download|install: <full technical message>`, with the message **redacted first**: bearer, basic and token values, GitHub token shapes (`ghp_…`, `github_pat_…`), credentials inside a URL (`user:pass@`), `Authorization` / API-key values and secret-looking query values (`access_token`, `token`, `key`, `secret`, `password`, `sig`, `X-Amz-…`). Redaction runs before the 200-character cap, so a token cannot survive by being cut in half. Paths and addresses stay in the log: it is for support. |
| [index.ts](../src/main/index.ts) | Every updater status goes through `updateErrors.onStatus` before it is broadcast; `updater:download` and `updater:install` answer through `updateErrors.download` and `updateErrors.install`. The sequence inside the handlers is unchanged. |
| [updateMessages.ts](../src/renderer/src/lib/updateMessages.ts) (new) | A second lock on the screen: before an update message is shown it is checked for a drive letter, a backslash, a URL or `file:` address, a slash path, a file name ending `.exe .sqlite .yml .blockmap .asar .dll .log`, or an error code (`net::…`, `ERR_…`, `ENOENT` and similar). If it holds one, a plain sentence is shown instead. Used at every place in section 1 (rows 2 to 7). |
| [AdminScreen.tsx](../src/renderer/src/components/AdminScreen.tsx) | The carried-over line no longer ends with the backup path: `Updated A to B on <date>. Sales carried over: X of Y.` (red when something did not carry over, as before). |
| [UpdatePrompt.tsx](../src/renderer/src/components/UpdatePrompt.tsx), [UpdateToast.tsx](../src/renderer/src/components/UpdateToast.tsx) | Show only the plain sentences. The prompt still adds `The till is still running version X.` |

The stored `lastUpdateResult` (with its `backupPath`) and the `updater:last-result` answer are unchanged and still carry the path; the screen just no longer shows it.

## 3. Existing assertions changed (all of them)

| Test | Old | New |
| --- | --- | --- |
| `tests/adminScreen.test.ts`, "renders the carried-over-data line for a successful update" | `toContain('C:\\backups\\pre-update-2.0.5-to-2.0.6-x.sqlite')` | Not present: no `C:\backups`, no `.sqlite`, no `Backup:` |
| `tests/updatePrompt.test.ts`, "says so in plain words when the download fails…" | `toContain('The update could not be downloaded: net::ERR_CONNECTION_RESET.')` | `toContain('The update could not be downloaded. Check the internet connection and try again.')` and no `net::`. The `still running version` line is unchanged. |
| `tests/tillLog.test.ts`, "knows three events…" | three events | four: `update-failed` is added (main process only) |

`tests/updater.test.ts` and `tests/updateBackup.test.ts` needed no change: the raw message still comes out of `initAutoUpdater` and `runPreInstallSteps`; the filter is applied in `index.ts`'s glue, which is where the screens are fed.

## 4. Tests

[updateScreens.test.ts](../tests/updateScreens.test.ts), 42 tests:

- **Every state renders no path:** the Admin panel in checking, up to date, available, downloading, ready to install, and error with a raw path and address in the message; the update prompt in offer, downloading, failed download, failed install and a message the main process already made plain; the toast after a failed install. One pattern runs over the rendered text: a drive letter, a backslash, `http`/`file:`, a slash path, a technical file name, `net::`, `ERR_`, `ENOENT`.
- **A raw updater error shows only the plain message,** from `initAutoUpdater`'s status, from the download, check and install calls, and from the toast.
- **The carried-over line** has no backup path whatever the stored result holds.
- **Main process:** an error status becomes the plain sentence and is logged once; the stage is `download` once progress or `beginDownload` says so and back to `check` on a new check; every other status passes untouched; the same failure as an event and a rejection is logged once, and again after the moment passes; a failed download and a failed install give their plain sentences and a log line; the two already-plain messages pass and log nothing.
- **Redaction:** 9 token shapes each removed; paths and addresses kept; one `update-failed` line through the real log format has no token and is one line; a token near the cap cannot survive being cut in half; the screen cannot write the event (`log:till-event` refuses it).
- **Wiring:** `index.ts` broadcasts the filtered status, filters the download and install answers, logs through the fixed event, and still calls `installWhenQuiet`, `installUpdate` and `quitAndInstall` as before.

### Mutation checks (each restored; 116 tests green after)

| # | Mutation | Test that failed |
| --- | --- | --- |
| 1 | The main process shows the raw error again (`onStatus` passes the status on) | 2: `turns an error status into the plain sentence and logs the raw one once…`; `says "download" once a download has started…` |
| 2 | **The screens show the raw error again** (the guard removed from the status line, the install error and the prompt) | 4, including `the App & Updates panel, in every state > shows no path, folder, address or file name when error, with a raw path and address in the message` and `the update prompt, in every state > a failed install (the backup step) shows a plain sentence, never the raw error` |
| 3 | The log keeps the token | 3, including `till.log gets the detail, and no token > keeps the paths and addresses support needs, and only the secret goes` |

## 5. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite | **213 files, 3569 passed, 1 skipped, 0 failed** (212 files, 3527 tests before: +1 file, +42 tests) |
| Audit: secret exposure | none found (section 1) |

Layout: not checked by check:fit (owner's rule). For the owner to check on the till.

### For the owner to check on the till
1. After an update, Admin → App & Updates reads "Updated 2.2.3 to 2.2.4 on <date>. Sales carried over: X of Y." with no folder or file name.
2. With the internet off, "Check for Updates" and "Download update" say a plain sentence, with no address or path anywhere.
3. `till.log` (in `%APPDATA%\rubis-pos-desktop\`) gets an `update-failed` line with the technical message for support.

## 6. Observed but not changed

- **The stored `backupPath` is still returned to the screen's data layer** by `updater:last-result`, just not shown. A later change could drop it from the answer; it is kept because the main process and its tests use it.
- **The startup check's failure** is still written only to the console, as before (it was never shown). It is now also reported through the `error` event path when electron-updater emits one, so it reaches `till.log`; a failure that raises no event does not.
- **The guard is pattern-based.** A message with no path, address or code that is still technical would pass; the main process's filter is the first lock and sends only fixed sentences.
- **The path-looking test pattern ignores dates** (`05/10/2026`) by requiring a letter after each slash.
- `till.log` is not rotated (known gap, phase 228); an offline till adds an `update-failed` line each time a check fails.

## 7. Not verified

- A real update through GitHub: nothing was downloaded or installed, and the updater was never run. The tests use fakes for `electron-updater`.
- That a real `electron-updater` error contains the shapes assumed here; the test strings are written to look like them.
- The layout of the shorter lines on the till.

## 8. Rollback

Revert this commit. The update screens show raw messages and the backup path again; `update-failed` stops being written (existing `till.log` lines stay). Nothing stored changed.
