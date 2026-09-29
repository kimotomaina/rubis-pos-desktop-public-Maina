# Phase 177 — Over-the-air updates via a public releases-only GitHub repo: read-only audit

- **Date:** 2026-09-29
- **Requested:** Part 1 (read-only) of switching OTA updates from the never-published private source repo to a new public, releases-only repo (`Volcha-Enterprises/rubis-pos-releases`), and confirming the NSIS uninstall path is safe to run during an update. Part 2: apply the fix and the publish wiring the audit called for.
- **Outcome:** Part 1 audit complete, reviewed. Part 2 implemented.
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

---

## Part 2 — Setup

### Changes made

1. **`build/installer.nsh`** — wrapped the `customUnInstall` app-data removal in the electron-builder NSIS guard:
   ```nsis
   !macro customUnInstall
     ${ifNot} ${isUpdated}
       RMDir /r "$APPDATA\rubis-pos-desktop"
       RMDir "$APPDATA"
     ${endIf}
   !macroend
   ```
   Added a comment above it citing the electron-builder NSIS docs (`https://www.electron.build/nsis#custom-nsis-script`) and explaining why the guard exists (the OTA update path silently runs this same uninstaller). Nothing else in the file changed — `customInstall` is still the phase-20 no-op.

2. **`electron-builder.yml`** — repointed the publish block's `repo`:
   ```yaml
   publish:
     provider: github
     owner: Volcha-Enterprises
     repo: rubis-pos-releases
   ```
   No `releaseType` key added — the electron-builder default (`draft`) applies, per the request. `win.target`, `nsis.oneClick`, `nsis.include`, and every other key are unchanged.

3. **`package.json`** — added `"dist:publish": "npm run dist -- --publish always"` right after `dist`/`postdist`. Because `dist:publish` invokes `npm run dist`, npm's own `pre`/`post` lifecycle hooks (`predist` → `check-node-version` + `check-env`; `postdist` → `verify-dist.cjs`) still run around it automatically — no separate guard duplication was needed. `version`, `repository`, and `homepage` are unchanged; `repository`/`homepage` keep pointing at the source repo (`rubis-pos-desktop`) since they are npm/GitHub metadata only and do not feed electron-builder's `publish` config.

4. **`src/renderer/src/components/AdminScreen.tsx`** — added `installedVersion` state, a dedicated `useEffect(() => { void window.api.getAppVersion().then(setInstalledVersion) }, [])` (single read on mount, no new IPC — `getAppVersion`/`app:get-version` already existed), and a `"Installed version: x.y.z"` line inside the existing "App & Updates" section, rendered only once `installedVersion` is populated.

5. **`docs/RELEASING.md`** (new) — the release runbook: `GH_TOKEN` handling, version bump, `dist:publish`, reviewing/publishing the draft, updating a till, rollback, the one-time manual-install note for tills still on 2.0.x, and the SmartScreen note for a manual install.

6. **Tests:**
   - `tests/updateReleaseConfig.test.ts` (new) — string/regex checks (no YAML parser added) that `electron-builder.yml`'s `publish` block has `provider: github`, `owner: Volcha-Enterprises`, `repo: rubis-pos-releases`, that the file contains no `ghp_`/`token:` pattern anywhere, and that `build/installer.nsh`'s `customUnInstall` macro wraps the `RMDir /r` deletion between `${ifNot} ${isUpdated}` and `${endIf}` (not just that both strings appear somewhere in the macro).
   - `tests/adminScreen.test.ts` — added `getAppVersion` to the shared `stubApi()` (unwrapped string, unlike every `ServiceResult` call already there) and a new test asserting the Overview tab shows `"Installed version: 2.0.4"` after mount.
   - `tests/adminIntegrationsSections.test.ts` — same `getAppVersion` addition to its own separate `stubApi()`; this file also mounts `AdminScreen` and started throwing `TypeError: window.api.getAppVersion is not a function` once the new mount effect was added, until fixed.
   - `tests/updater.test.ts` — unchanged, confirmed no assertion needed to change (Part 1 item 4/8 held: `autoDownload`, launch-check behaviour, and event wiring are untouched by this phase).

### Mutation checks (each applied, verified, then reverted)

| # | Mutation | Result |
| --- | --- | --- |
| i | Removed the `${ifNot} ${isUpdated}` guard from `installer.nsh` | `build/installer.nsh update-safety guard` test failed as expected |
| ii | Changed `electron-builder.yml`'s `repo` back to `rubis-pos-desktop` | `electron-builder.yml publish config` "publishes to the public releases-only repo" test failed as expected |
| iii | Added `token: ghp_x` under `electron-builder.yml`'s `publish` block | `electron-builder.yml publish config` "contains no token-like string" test failed as expected (both the `ghp_` and `token:` assertions) |

`git diff --stat build/installer.nsh electron-builder.yml` after all three reverts showed only the two permanent Part 2 edits — no mutation leaked through.

### Tripwires

`git diff --stat` was empty for all nine files: `checkout.ts`, `fiscal-engine.ts`, `fiscal-routing.ts`, `real-etims-provider.ts`, `database.ts`, `PosCheckoutPanel.tsx`, `PaymentModal.tsx`, `reports.ts`, `receiptLayout.ts`.

### Verification

- `npm run typecheck` (node + web) — clean.
- `npx vitest run` — **148 files, 2247 tests, all passing** (includes the 3 new config-guard tests and the 1 new Admin renderer test).
- `npm run dist:dir` — succeeded: built, packaged `release/win-unpacked`, no publish, no network call (electron-builder logged `no signing info identified, signing is skipped` and stopped there — it never reached a publish step). `postdist:dir`'s `verify-dist.cjs` confirmed `.env` was bundled.
- `git status --short` after `dist:dir`: `release/` stayed untracked/ignored (`git status --short --ignored` shows `!! release/`); the only untracked entries anywhere are the two new files this phase adds (`docs/RELEASING.md`, `tests/updateReleaseConfig.test.ts`) — no stray file landed in the repo root.
- `dist:publish` was **not** run, per the request.

### Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| `build/installer.nsh` | Modified | Uninstall/update safety — the OTA update path no longer deletes the till's database and vault |
| `electron-builder.yml` | Modified | Where the packaged app's update feed points |
| `package.json` | Modified | Adds the one publish entry point (`dist:publish`); nothing else in the build pipeline changes |
| `src/renderer/src/components/AdminScreen.tsx` | Modified | Admin > App & Updates now shows the installed version |
| `docs/RELEASING.md` | Added | Human release runbook — no runtime effect |
| `tests/updateReleaseConfig.test.ts` | Added | Guards the publish repo/token and the NSIS guard against regression |
| `tests/adminScreen.test.ts` | Modified | Stub + coverage for the new version line |
| `tests/adminIntegrationsSections.test.ts` | Modified | Stub fix only — this file's own assertions are unrelated to this phase |

### Possible impact

- **Direct:** once a build made from this commit is installed (by hand, per the first-time note), a genuine over-the-air update on that till will no longer wipe `$APPDATA\rubis-pos-desktop`. Admin now shows the installed version.
- **Indirect:** none identified — the `publish` block change only affects where `electron-builder --publish` uploads to; it has no effect on `dist`/`dist:dir` (which never publish) and none on any till until a new build is installed on it.
- **Data / schema / contract:** none. No database, IPC, or wire-format change.
- **Security posture:** unchanged. No token is committed anywhere (`updateReleaseConfig.test.ts` guards this); `GH_TOKEN` lives only in the release operator's shell per `RELEASING.md`.
- **Idempotency / re-run safety:** `dist:publish` is safe to re-run — a re-published draft with the same version tag is still a draft until a human publishes it; nothing in this phase's code writes state that a second run would corrupt.
- **Residual risk:** entirely the item 6/9 findings from Part 1 — tills on 2.0.x will not see any update, including the first one built from this phase, until it is installed on them by hand once. This is expected and is documented in `RELEASING.md` §g.

### Rollback

`git revert` of the Part 2 commit(s). The `rubis-pos-releases` GitHub repo, if already created by then, can be left in place — nothing points at it (no till's baked `app-update.yml` references it) until a build made after this commit is installed somewhere.

### What only a human can do

- [ ] Create the public repo `Volcha-Enterprises/rubis-pos-releases` with a README stating it holds installers only, no source.
- [ ] Create a fine-grained GitHub token with write access to Releases on that repo only, short expiry.
- [ ] Bump the version (`chore: bump to x.y.z`) and run `npm run dist:publish` on the build machine.
- [ ] Install the resulting Setup exe by hand on a spare till (not the pilot till first), confirm "Installed version" in Admin, then publish a second, higher version and prove **Check for Updates > Restart & Install** lands it with the database, the vault, and the fiscal queue intact. Only after that does the pilot till get pointed at the feed.

### Observed but not changed

- `win.target` still lists both `nsis` and `portable` ([electron-builder.yml:26-27](../electron-builder.yml#L26-L27)). `dist:dir` (used for this phase's verification) passes `--dir`, which only produces the unpacked directory regardless of `win.target`. `dist`/`dist:publish` do not pass `--dir`, so a plain `npm run dist:publish` will build and publish both the NSIS installer and a portable `.exe` — this was already true before this phase and the request said not to change `win.target`, so it is left as-is; worth the release operator noting in `RELEASING.md` if only the NSIS asset set turns out to be wanted on GitHub.
- `artifactName` remains unset (electron-builder default naming) — left as-is per the request ("Do not change win.target, nsis.oneClick or the include" plus no instruction to set it).
