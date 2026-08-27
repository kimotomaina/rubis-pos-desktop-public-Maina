# Phase 20 — Clean Install & Uninstall Data Wiping

**Date:** 2026-08-26 · **Branch:** `main` · **Previous:** [Phase 18](./phase-18.md)

## 1. Objective

Residual data in `%APPDATA%\rubis-pos-desktop` (the SQLite orders
database, the encrypted Shopify token vault, saved settings, and
Chromium's own cache/session storage — all of which live under one
Electron `userData` directory) persisted across installs and
uninstalls, which is unhelpful during PoC deployment: a full uninstall
should actually remove everything, and a genuinely fresh install
should start from a clean slate.

## 2. Deviation from the brief: no data wipe on install

The brief specified a `customInstall` macro that deletes
`$APPDATA\rubis-pos-desktop` before/during every install. That macro
runs identically for **both** a genuine fresh install and an in-place
update run over an existing installation — NSIS has no built-in signal
that distinguishes the two. Implementing it as specified would silently
erase the orders database, shift history, and Shopify configuration
every time an app update ships, not just on a deliberate reinstall —
a serious, easy-to-miss data-loss risk during a live retail deployment
where updates may need to go out mid-week.

`customInstall` is implemented as a no-op instead. This isn't a
functional loss: a directory that doesn't exist yet is already clean,
so there's nothing meaningful for a *true* fresh install to wipe. The
actual clean-slate path is `customUnInstall`: uninstalling deletes the
entire `userData` directory, so installing again afterward starts
genuinely clean without needing any install-time deletion at all. An
operator who wants a hard reset now has one unambiguous action —
uninstall, then reinstall — instead of every routine update carrying
a silent risk of data loss.

## 3. `build/installer.nsh`

```nsis
!macro customInstall
!macroend

!macro customUnInstall
  RMDir /r "$APPDATA\rubis-pos-desktop"
  RMDir "$APPDATA"
!macroend
```

`RMDir /r` recursively deletes the entire userData directory — this
one call covers the SQLite database, the `safeStorage`-encrypted
vault file, the settings/config data, and Chromium's cache and session
storage subfolders, since Electron stores all of them under the same
root by default. The trailing `RMDir "$APPDATA"` (no `/r`) only
succeeds if `%APPDATA%` is now completely empty of everything else —
NSIS's non-recursive `RMDir` silently no-ops on a non-empty directory,
so this can never delete another application's data.

`electron-builder.yml`'s `nsis` config now points at it:

```yaml
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  include: build/installer.nsh
```

## 4. Verifying the target path

The brief's `$APPDATA\rubis-pos-desktop` path was checked against this
machine's actual `userData` folder (`app.getPath('userData')`) rather
than assumed — Electron derives that folder name from `package.json`'s
`name` field ("rubis-pos-desktop") unless overridden, and
electron-builder's `productName` ("RUBIS POS") is a separate,
display-only value that does not by itself change it. Confirmed
against a real `%APPDATA%` listing: the folder is literally
`rubis-pos-desktop`, so the path in the script is correct as given.

## 5. Testing

NSIS scripts run outside Node/Electron and aren't exercised by Vitest
— there's no `.nsh` equivalent of a unit test in this toolchain, and
this phase adds no application code (no new function, no changed
control flow anywhere in `src/`). `npm run typecheck` and `npm test`
were run to confirm this build-tooling-only change didn't regress
anything already covered.

## 6. Verification

- `npm run typecheck` — clean (both `node` and `web` projects).
- `npm test` — 423/423 passing (unchanged from the prior phase — no
  application source was touched).
- Manual verification of the installer/uninstaller's actual behavior
  requires a packaged build run through `npm run dist` on Windows,
  which wasn't performed as part of this pass — recommended before
  relying on this for the live deployment.
