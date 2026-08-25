# Phase 8 — Production Packaging, Deployment, and Kiosk Polish

**Date:** 2026-08-24 · **Branch:** `main` · **Previous:** [Phase 7](./phase-7.md)

## 1. Objective

Turn seven phases of working POS software into something IT can actually
hand to a cashier: a real Windows installer, auto-update wiring against
GitHub Releases, and a runtime that fails safely — logging and a friendly
restart prompt instead of a white screen — for a 1-week Proof of Concept at
the RUBIS store.

## 2. Decisions

| # | Decision | Value |
| --- | --- | --- |
| Q1 | Code signing | Skipped for the PoC (no paid certificate). `publisher`/`appId` metadata is already set so signing can be added later without a config rewrite. IT clicks "More info → Run anyway" past SmartScreen on first launch — see §7. |
| Q2 | Kiosk mode | Not true `--kiosk`. `resizable: false` + `maximize()` on show, existing `autoHideMenuBar: true` — looks locked down but a cashier can still minimize for Wi-Fi/Windows needs. |
| Q3 | Update feed | GitHub Releases (`publish: { provider: 'github', owner: 'Volcha-Enterprises', repo: 'rubis-pos-desktop' }`) — the repo the app already ships from (`package.json`'s existing `repository`/`homepage` fields). |
| Icon | No custom `.ico` exists in the repo and one can't be meaningfully fabricated here. Shipped with electron-builder's default Electron icon; flagged as a pre-launch TODO in §11. |

## 3. Packaging (`electron-builder.yml`)

```yaml
appId: com.volcha.rubispos
productName: RUBIS POS
directories:
  output: release
files:
  - out/**/*
  - package.json
asarUnpack:
  - '**/*.node'
win:
  target: [nsis, portable]
publish:
  provider: github
  owner: Volcha-Enterprises
  repo: rubis-pos-desktop
```

`asarUnpack: ['**/*.node']` is the one load-bearing line for native modules:
asar archives can't execute compiled addons directly, so `better-sqlite3`'s
platform binary has to live outside the archive. Verified by running
`npm run dist:dir` and confirming
`release/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node`
exists next to the packaged app. `node-thermal-printer`'s TCP/IP interface
is pure JS and needs no special handling.

New scripts:
- `npm run dist` — full build + NSIS installer + portable `.exe` (output in `release/`)
- `npm run dist:dir` — unpacked build only, for fast local smoke-testing without generating an installer

## 4. Auto-Update

`src/main/services/updater.ts` wraps `electron-updater`'s `autoUpdater`
behind a narrow `AutoUpdaterLike` interface — the same dependency-injection
convention as `printer.ts`'s `ThermalPrinterLike` — so `electron-updater`
is never mocked in tests, only a recording fake is injected.

- `initAutoUpdater(autoUpdater, onStatus)` — wires `checking-for-update`,
  `update-available`, `update-not-available`, `download-progress`,
  `update-downloaded`, and `error` into a single `UpdateStatus` union
  delivered to `onStatus`.
- `checkForUpdates(autoUpdater)` — triggers a check; failures surface via
  the `error` listener rather than a thrown/unhandled rejection.

Wiring (`src/main/index.ts`): `initAutoUpdater(autoUpdater, (status) =>
broadcast('updater:status', status))`, plus two IPC handlers —
`updater:check` (renderer-triggered check) and `updater:install`
(`autoUpdater.quitAndInstall()`).

**Renderer**: `UpdateToast.tsx` subscribes via `window.api.onUpdateStatus`
and stays silent for `checking`/`not-available`/`error` — it only appears
once a download is actually in progress or ready, with a "Restart &
Install" button on `downloaded`. The Admin screen's new "App & Updates"
section has a "Check for Updates" button (the brief's "hidden admin
trigger" — no entry point for a regular cashier).

## 5. Production Hardening & Kiosk Polish

- **Window behavior** (`src/main/window-factory.ts`, `src/main/index.ts`):
  `createBrowserWindowConfig` now returns `resizable: false`; `createWindow`
  calls `mainWindow.maximize()` right after `.show()` on `ready-to-show`.
  `autoHideMenuBar: true` was already set (Phase 1).
- **Devtools lockdown**: `optimizer.watchWindowShortcuts(window)` (which
  binds the F12 devtools toggle) is now gated behind `!app.isPackaged` —
  a packaged build never wires the shortcut. A `devtools-opened` listener
  additionally force-closes devtools whenever `app.isPackaged` is true, in
  case some other route (a stray menu item, a future regression) opens
  them anyway.
- **Global error handling** (`src/main/services/errorHandler.ts`) — kept
  pure/testable like every other main-process service, no direct
  `node:fs`/`electron` imports inside the tested functions:
  - `installGlobalErrorHandlers({ process, app, logger, showFatalDialog })`
    registers `process.on('uncaughtException')`,
    `process.on('unhandledRejection')`, and `app.on('render-process-gone')`.
    None of them force-quit — each logs via `logger.append` and shows a
    "Please restart RUBIS POS" dialog, matching "friendly prompt instead of
    a white screen" rather than a hard crash.
  - `createFileErrorLogger(filePath, { appendFileSync })` appends
    timestamped, single-line entries to `app.getPath('userData')/error.log`.
  - Wired in `main/index.ts` near the top of `app.whenReady().then(...)`
    with real `fs.appendFileSync` and `dialog.showErrorBox('RUBIS POS', message)`.

## 6. IPC Contract (Phase 8 additions)

| Channel | Direction | Payload |
| --- | --- | --- |
| `updater:check` | invoke | → `ServiceResult<void>` (triggers a check; result arrives via `updater:status`) |
| `updater:install` | invoke | → `ServiceResult<void>` (quits and installs) |
| `updater:status` | broadcast | `UpdateStatus` (`checking` / `available` / `not-available` / `downloading` / `downloaded` / `error`) |

## 7. Build, Deploy, and SmartScreen

```bash
npm run dist:dir   # fast unpacked build → release/win-unpacked/ (smoke test)
npm run dist       # full installer → release/RUBIS POS Setup <version>.exe
                    #                  and release/RUBIS POS <version>.exe (portable)
```

To deploy: copy `release/RUBIS POS Setup <version>.exe` to the target
machine and run it (or the portable `.exe` for a quick USB install with no
install step). Because the build isn't code-signed for this PoC (§2, Q1),
Windows SmartScreen will show an "Unrecognized app" warning on first
launch — click **More info → Run anyway**. This is expected and safe for
software from a known source; `publisher`/`appId` are already set in
`electron-builder.yml` so a real code-signing certificate can be added
later (`win.certificateFile`/`win.certificatePassword` or a signing
service) without touching anything else in this config.

## 8. Files Created / Modified

| File | Action | Purpose |
| --- | --- | --- |
| `electron-builder.yml` | Create | packaging targets, `asarUnpack`, publish config |
| `src/main/services/updater.ts` | Create | `initAutoUpdater`, `checkForUpdates`, `AutoUpdaterLike`, `UpdateStatus` |
| `src/main/services/errorHandler.ts` | Create | `installGlobalErrorHandlers`, `createFileErrorLogger`, `formatErrorEntry` |
| `src/main/window-factory.ts` | Modify | `resizable: false` |
| `src/main/index.ts` | Modify | maximize on show, devtools gating, error-handler wiring, updater wiring + 2 new IPC handlers |
| `src/preload/index.ts`, `window.d.ts` | Modify | `checkForUpdates`, `installUpdate`, `onUpdateStatus` |
| `src/renderer/src/components/UpdateToast.tsx` | Create | download/ready-to-install toast |
| `src/renderer/src/components/AdminScreen.tsx` | Modify | "App & Updates" section with "Check for Updates" button |
| `src/renderer/src/App.tsx` | Modify | mounts `UpdateToast` |
| `package.json` | Modify | `electron-builder`/`electron-updater` deps, `dist`/`dist:dir` scripts |
| `.gitignore` | Modify | ignore `release/` (electron-builder output) |
| `tests/updater.test.ts` | Create | 11 tests |
| `tests/errorHandler.test.ts` | Create | 7 tests |
| `docs/phase-8.md` | Create | this document |

## 9. Testing Strategy

Same rule as every prior phase: mock the boundary, never touch the real
thing. `updater.test.ts` builds a recording fake `AutoUpdaterLike` that
captures registered listeners in a `Map` so tests can invoke them directly
and assert the resulting `UpdateStatus`. `errorHandler.test.ts` builds fake
`process`/`app` objects with the same "capture-then-invoke" `.on()` pattern,
a fake `ErrorLogger`, and a `vi.fn()` for `showFatalDialog` — verifying each
handler logs and prompts without throwing.

```bash
npm test           # vitest run — 19 files / 182 tests
npm run typecheck  # tsc --noEmit (node + web) — clean
npm run dist:dir   # electron-builder --dir smoke build — confirms the
                    # native better-sqlite3 binary is correctly unpacked
```

| Suite | Coverage highlights |
| --- | --- |
| `updater.test.ts` (11) | all six listeners registered, `autoDownload` enabled, correct `UpdateStatus` shape per event (including version/percent fallbacks), `checkForUpdates` calls through and never throws |
| `errorHandler.test.ts` (7) | `formatErrorEntry` timestamp/source/message shape, `createFileErrorLogger` appends via injected `appendFileSync`, all three handlers registered and each logs + shows a fatal dialog without crashing the fake process |

## 10. Manual Verification (not feasible headless)

`npm run dist` (the real NSIS installer) and installing/running it on an
actual Windows machine — including the SmartScreen click-through and a
live GitHub Releases update check — can't be exercised in this
environment. `npm run dist:dir` was run here as the closest automatable
proxy: it confirmed the packaged app builds cleanly, native modules
resolve correctly, and no build-time config errors exist. IT/the user
should run `npm run dist` on a Windows box and do one real install +
launch before the PoC starts.

## 11. Known Limitations (candidate backlog)

- **No custom product icon** — the packaged `.exe` uses Electron's default
  icon; a real `RUBIS POS` icon asset needs to be designed and wired into
  `electron-builder.yml`'s `win.icon` before wider rollout.
- **Unsigned build** — SmartScreen warns on first launch (§7); acceptable
  for a 1-week PoC, not for general distribution.
- **No auto-update rollback** — if a bad release is published, there's no
  built-in mechanism to force-downgrade; a GitHub Release would need to be
  pulled/replaced manually.
- **Not true kiosk mode** — a cashier can still minimize the window or
  access the Windows taskbar (deliberate per Q2, but worth re-evaluating
  for a permanent store deployment).
- **Error log has no rotation** — `error.log` grows unbounded; fine for a
  1-week PoC, would need rotation/size-capping for long-term use.

---

*Phase 8 status: implementation complete — `npm test` (182/182),
`npm run typecheck`, and `npm run dist:dir` all pass.*
