# Phase 177 — Over-the-air updates via a public releases-only GitHub repo: read-only audit

- **Date:** 2026-09-29
- **Requested:** Part 1 (read-only) of switching OTA updates from the never-published private source repo to a new public, releases-only repo (`Volcha-Enterprises/rubis-pos-releases`), and confirming the NSIS uninstall path is safe to run during an update. No code changes in this part.
- **Outcome:** Audit complete. STOP for review, per the request — Part 2 not started.
- **Branch / base commit:** staging @ 587047e (feat: card tender on the live checkout panel, Option A (phase 176))

---

## 1. `build/installer.nsh` — `customUnInstall` (docs/phase-20.md)

Full file, [build/installer.nsh](../build/installer.nsh):

```nsis
; Custom NSIS hooks for the Windows installer/uninstaller.
;
; customInstall runs at the end of every install — a fresh install and
; an in-place update over an existing installation both hit this exact
; same code path, with no reliable signal to tell them apart. It is
; intentionally left as a no-op: wiping app data here would also erase
; the orders database, shift history, and Shopify configuration on
; every routine app update, not just a genuine fresh install.
;
; The clean-slate path is customUnInstall below: uninstalling wipes
; the app's entire userData directory (SQLite database, the encrypted
; credential vault, saved settings, and Chromium's own cache/session
; folders, which all live under the same directory), so installing
; again afterward starts genuinely clean without needing install-time
; deletion at all.

!macro customInstall
!macroend

!macro customUnInstall
  RMDir /r "$APPDATA\rubis-pos-desktop"
  RMDir "$APPDATA"
!macroend
```

`customUnInstall` is **not** wrapped in the electron-builder NSIS guard `${ifNot} ${isUpdated} ... ${endIf}`. It runs unconditionally, on every uninstall.

**This is the blocking finding.** electron-builder's NSIS updater does an update by silently running the *old* version's uninstaller and then installing the new version — the same uninstaller entry point a manual "Uninstall RUBIS POS" hits. `${isUpdated}` is the flag electron-builder's own NSIS include sets specifically so a `customUnInstall` macro can tell the two cases apart. Without the guard, the very first over-the-air update a till receives will run this macro, delete `$APPDATA\rubis-pos-desktop` (the SQLite order database, the keytar-backed credential vault's on-disk half, shift history, Shopify config, everything under the app's userData directory), and then install the new version into a wiped machine. The comment block above the macro (written for phase-20, when nothing was ever published) describes exactly this deletion as the intended *manual re-install* cleanup path — it was never evaluated against an automated update, because until now nothing auto-updated.

## 2. `electron-builder.yml`

Full file, [electron-builder.yml](../electron-builder.yml):

```yaml
appId: com.volcha.rubispos
productName: RUBIS POS
copyright: Copyright © 2026 Volcha Enterprises

directories:
  output: release

files:
  - out/**/*
  - package.json
  - node_modules/**/*

asarUnpack:
  - '**/*.node'

extraResources:
  - from: .env
    to: .env
  - from: resources/icons/icon.ico
    to: icons/icon.ico
  - from: resources/print-raw.ps1
    to: print-raw.ps1

win:
  target:
    - nsis
    - portable
  icon: resources/icons/icon.ico
  signtoolOptions:
    publisherName: Volcha Enterprises

nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  include: build/installer.nsh

publish:
  provider: github
  owner: Volcha-Enterprises
  repo: rubis-pos-desktop
```

- **Publish block** ([electron-builder.yml:38-41](../electron-builder.yml#L38-L41)): points at `Volcha-Enterprises/rubis-pos-desktop` — the private source repo, per docs/phase-105.md ("not published"). This is what Part 2 item 2 repoints.
- **nsis block** ([electron-builder.yml:32-36](../electron-builder.yml#L32-L36)): `oneClick: false`, `allowToChangeInstallationDirectory: true`, `createDesktopShortcut: true`, `include: build/installer.nsh`. No `deleteAppDataOnUninstall` key is present anywhere in the file (electron-builder's own built-in app-data-deletion prompt is not enabled; the deletion that matters here is the custom `RMDir` in the included `.nsh`, item 1 above).
- **win.target** ([electron-builder.yml:25-27](../electron-builder.yml#L25-L27)): `nsis` and `portable`. The `portable` target produces a standalone `.exe` with no installer/uninstaller and is unrelated to the update/uninstall path — it is not built by `npm run dist` today (see item 3) but is a configured target electron-builder would produce if asked to build all `win.target` entries.
- **artifactName**: not set anywhere in the file — electron-builder's default naming applies (e.g. `RUBIS POS Setup ${version}.exe`), matching what the runbook in item 8 of the request expects.

## 3. `package.json`

Full file, [package.json](../package.json).

- **version**: `2.0.4` ([package.json:3](../package.json#L3)).
- **repository**: `git+https://github.com/Volcha-Enterprises/rubis-pos-desktop.git` ([package.json:11-14](../package.json#L11-L14)).
- **homepage**: `https://github.com/Volcha-Enterprises/rubis-pos-desktop#readme` ([package.json:7](../package.json#L7)).
- **dist script**: `"dist": "npm run build && electron-builder --win"` ([package.json:39](../package.json#L39)), with guards `"predist": "npm run check-node-version && npm run check-env"` ([package.json:38](../package.json#L38)) and `"postdist": "node scripts/verify-dist.cjs"` ([package.json:40](../package.json#L40)).
- **dist:dir script**: `"dist:dir": "npm run build && electron-builder --win --dir"` ([package.json:42](../package.json#L42)), with the matching `predist:dir`/`postdist:dir` guard pair ([package.json:41](../package.json#L41), [package.json:43](../package.json#L43)) running the same `check-node-version`/`check-env`/`verify-dist.cjs` checks as `dist`.
- `verify-dist.cjs` ([scripts/verify-dist.cjs](../scripts/verify-dist.cjs)) is the only postbuild/postdist guard touching packaging; it asserts `.env` was actually copied into every `*-unpacked` directory under `release/` (phase-16) and has no publish-related logic — it does not need to change for this phase.
- No script anywhere in `package.json` currently passes `--publish` — confirmed by reading every script value; `dist` and `dist:dir` are the only electron-builder invocations and neither includes the flag.

## 4. `src/main/services/updater.ts` and its wiring in `src/main/index.ts`

[src/main/services/updater.ts](../src/main/services/updater.ts) (full file, 83 lines) exports `initAutoUpdater` and `checkForUpdates`, both operating on an injected `AutoUpdaterLike` (real `electron-updater` singleton in prod, a recording fake in tests — same DI pattern as `printer.ts`).

- **autoDownload**: set to `true` inside `initAutoUpdater` — [updater.ts:42](../src/main/services/updater.ts#L42): `autoUpdater.autoDownload = true`.
- **Check on launch**: confirmed absent. `initAutoUpdater(autoUpdater, ...)` is called once at [src/main/index.ts:3384](../src/main/index.ts#L3384) — it only registers the six event listeners (`checking-for-update`, `update-available`, `update-not-available`, `download-progress`, `update-downloaded`, `error`); it does not itself call `checkForUpdates`. The only call to `checkForUpdates(autoUpdater)` in the whole codebase is inside the `updater:check` IPC handler at [src/main/index.ts:3390-3393](../src/main/index.ts#L3390-L3393), and that handler's own comment states it is "invoked from the Admin screen's 'Check for Updates' button" ([src/main/index.ts:3386-3389](../src/main/index.ts#L3386-L3389)). docs/phase-132.md §4 holds: nothing checks for updates on app launch.
- **`updater:install`** ([src/main/index.ts:3398-3401](../src/main/index.ts#L3398-L3401)): calls `autoUpdater.quitAndInstall()` and returns `{ success: true }`. Nothing else.
- **allowPrerelease / channel**: not set anywhere. Neither `updater.ts` nor the `initAutoUpdater` call site in `index.ts` sets `autoUpdater.allowPrerelease` or `autoUpdater.channel` — grepped both files for `allowPrerelease` and `channel` and found no match outside of an unrelated IPC broadcast helper literally named `channel` ([src/main/index.ts:993](../src/main/index.ts#L993), a parameter name, not the updater setting).

## 5. Version display (docs/phase-132.md §1)

- `window.api.getAppVersion` exists in the preload and is typed: [src/preload/index.ts:100](../src/preload/index.ts#L100) (`getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version')`) and [src/preload/window.d.ts:93](../src/preload/window.d.ts#L93) (`getAppVersion: () => Promise<string>`). Backed by [src/main/index.ts:3378](../src/main/index.ts#L3378): `ipcMain.handle('app:get-version', () => app.getVersion())`.
- No renderer code calls `getAppVersion()` today — confirmed by grepping the whole `src/` tree for `getAppVersion`; only the two preload declarations above match. docs/phase-132.md §1 still holds.
- The Admin section named "App & Updates" already exists at [src/renderer/src/components/AdminScreen.tsx:2334-2348](../src/renderer/src/components/AdminScreen.tsx#L2334-L2348) — currently just the "Check for Updates" button and `updateCheckMessage`. This is where a one-line "Installed version: x.y.z" belongs in Part 2.

## 6. The baked feed (`resources/app-update.yml`)

`resources/app-update.yml` does not exist in the repo — confirmed, no match for that path anywhere under the project. This is expected: electron-builder's `nsis`/`publish` config generates `app-update.yml` at build time from `publish:` and bakes it into the packaged app's `resources/` folder (not into the source tree), which is exactly the mechanism the request describes. Consequence: any till already running a 2.0.x build has that generated file baked in pointing at `Volcha-Enterprises/rubis-pos-desktop` (today's `publish.repo`). Repointing `electron-builder.yml` in Part 2 only affects the *next* build — existing installs keep checking the old repo (where nothing was ever published, so `Check for Updates` on them today and after Part 2, until reinstalled, both resolve to "no update found") until a build made after the repoint is installed on them once by hand.

## 7. `.gitignore`

Full file, [.gitignore](../.gitignore).

- `release/` is ignored — [.gitignore:7](../.gitignore#L7).
- Files a `--publish` run would create or modify **inside the repo**: none identified. electron-builder writes its output (installer `.exe`, `.blockmap`, `latest.yml`, the unpacked dirs) to `release/`, which is already ignored, and uploads the GitHub release assets over the network — it does not write anywhere else in the source tree. `resources/app-update.yml` (item 6) is generated into the packaged app's resources during the build, not into the repo's own `resources/` directory. No config file, lockfile, or cache in the repo root is touched by a publish run.

## 8. `tests/updater.test.ts`

[tests/updater.test.ts](../tests/updater.test.ts) (full file, 141 lines). Uses a hand-built recording fake implementing `AutoUpdaterLike` (`electron-updater` itself is never imported or touched).

`describe('initAutoUpdater', ...)`:
- enables `autoDownload` and registers all six event listeners (`checking-for-update`, `update-available`, `update-not-available`, `download-progress`, `update-downloaded`, `error`).
- emits `{ kind: 'checking' }` on `checking-for-update`.
- emits `{ kind: 'available', version: '1.2.0' }` on `update-available` with `{ version: '1.2.0' }`.
- falls back to `{ kind: 'available', version: 'unknown' }` when `update-available` fires with no version.
- emits `{ kind: 'not-available' }` on `update-not-available`.
- emits `{ kind: 'downloading', percent: 42.5 }` on `download-progress` with `{ percent: 42.5 }`.
- emits `{ kind: 'downloaded', version: '1.3.0' }` on `update-downloaded` with `{ version: '1.3.0' }`.
- emits `{ kind: 'error', message: 'feed unreachable' }` on `error` with an `Error`.
- falls back to `{ kind: 'error', message: 'Update check failed' }` on `error` with a non-`Error` value.

`describe('checkForUpdates', ...)`:
- calls `autoUpdater.checkForUpdates()` once.
- resolves (does not throw) when `checkForUpdates()` rejects.

None of these assertions concern `electron-builder.yml`, `installer.nsh`, or the version display — Part 2's new tests (yml provider/owner/repo/no-token check, `.nsh` `isUpdated` guard check, Admin "Installed version" render) are additive; nothing here is expected to change per item 4's confirmation that `autoDownload`/launch-check behaviour is unchanged.

---

## Summary of findings requiring Part 2 action

1. **Blocking:** `build/installer.nsh`'s `customUnInstall` has no `${ifNot} ${isUpdated}` guard — the very first OTA update would wipe the database and vault. Must be fixed before any publish config is usable.
2. `electron-builder.yml`'s `publish.repo` still points at the private source repo `rubis-pos-desktop`; needs repointing to `rubis-pos-releases`.
3. No script passes `--publish` yet; `dist:publish` needs adding, reusing the same guards as `dist`.
4. No renderer surface shows the installed version yet; a one-line addition to the existing "App & Updates" Admin section closes that gap.
5. Tills on 2.0.x have the old repo baked into their packaged `app-update.yml` and will not see any update — including a Part-2 build — until that build is installed on them once by hand.

Nothing else audited above blocks Part 2 as scoped in the request.

**STOP — awaiting review before Part 2.**
