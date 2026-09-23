# Phase 132 — Version 2.0.1: a clean, identifiable rebuild

- **Date:** 2026-09-23
- **Requested:** Bump 2.0.0 to 2.0.1 and do a clean rebuild, so the installer the partner runs is unambiguously the Item-1 + Item-2 build (the VAT rate fix and void removal). No code changes beyond the version string.
- **Outcome:** Implemented
- **Branch / base commit:** staging @ e75f0b8. Version commit **`01eb80f`**.
- **Previous:** [phase-131](./phase-131.md)

## 1. Audit — every place the version lives

| Location | Held | Action |
| --- | --- | --- |
| `package.json` `"version"` | `2.0.0` | **Bumped to `2.0.1`.** This is the single source. electron-builder, `app.getVersion()` and electron-updater all read it. |
| `package-lock.json`, root `version` (twice) | **`1.1.0`**, already stale | **Realigned to `2.0.1`.** It is metadata only and no dependency changed. |
| `package.json` `"@electron-toolkit/tsconfig": "^2.0.0"` | a dependency range | Not a version declaration; left alone. |
| `electron-builder.yml` | no version and no `artifactName` | Nothing to change. Artifact names use the default `${productName} Setup ${version}.exe`. |
| `updater.ts` | reports `info.version` from the update feed | Nothing hardcoded. The comparison uses `app.getVersion()`. |
| `app:get-version` IPC ([index.ts:2553](../src/main/index.ts#L2553)), preload `getAppVersion` | returns `app.getVersion()` | Nothing to change. |
| **An in-app version display** | **none exists** | **Not added** (see below). |

**There is no in-app version display.** `window.api.getAppVersion` is exposed
by the preload, but **no renderer code calls it**. The only version text in
the renderer is `UpdateToast`'s *"Update ready - v…"*, which names an
*incoming* update. Adding a display would be a code change, and the brief
allowed none. So the installed version can be read off the machine in three
ways, all confirmed below as 2.0.1:

1. the installer filename;
2. Windows **Settings → Apps → Installed apps** (NSIS registers the version);
3. the exe's **Properties → Details → Product version**.

## 2. Changes made

**Deleted.** All of these were untracked and git-ignored; none was in git.
- `release/`, in full: the stale 12-Sep files, the 2.0.0 exes from phase-131,
  and the stale `builder-effective-config.yaml`.
- Root clutter from phase-129 §7: `release.zip`, `release_run.log` through
  `release_run6.log`, `dev_run.log`, `electron_run.log`, `electron_run2.log`,
  and `portable_run.log`.

**Modified.** `package.json` and `package-lock.json`, version strings only.
The `git diff --stat` came to 3 insertions and 3 deletions.

**Not touched:** any source file, the database, the vault, and all test data.
Test data is Item 6.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| package.json | Modified | The app version: artifact names, `app.getVersion()`, the Windows version metadata, and the update feed |
| package-lock.json | Modified | Lock metadata only |
| release/ and the root log/zip files | Deleted (untracked) | none; build output and clutter |

## 4. Possible impact

- **Direct:** the installer and the installed app identify as **2.0.1**.
- **Indirect:** electron-updater compares against 2.0.1. The update feed
  (`latest.yml`) now says 2.0.1. No update check runs on launch, only from the
  Admin button ([POC_AS_BUILT_ASSESSMENT](./POC_AS_BUILT_ASSESSMENT.md) §8).
- **Data / schema / contract:** none.
- **Security posture:** unchanged. **The installer is still unsigned, so a
  SmartScreen prompt on the partner's machine is expected and is not a fault.**
- **Idempotency / re-run safety:** re-running `npm run dist` reproduces the
  same artifacts.
- **Residual risk:** none new.

## 5. Verification

```
npm run typecheck   → clean
npm test            → 90 files, 1391 tests, all passing (unchanged; no code changed)
git commit          → 01eb80f "chore: bump to 2.0.1", made BEFORE the dist so the build is exactly that commit
npm run dist        → exit 0 (run once)
  ✓ .env found — will be bundled into the packaged app.
  ✓ Confirmed: neither mock provider is in out/main.
  ✓ Confirmed: win-unpacked/resources/.env is bundled.
git status          → clean after the build
```

**The build output** (`release/`, all dated 2026-09-23 21:16, x64):

| File | Bytes |
| --- | --- |
| `RUBIS POS Setup 2.0.1.exe` (the installer) | 121,581,514 |
| `RUBIS POS 2.0.1.exe` (portable) | 121,301,444 |
| `RUBIS POS Setup 2.0.1.exe.blockmap` | 128,376 |
| `latest.yml` (`version: 2.0.1`) | 347 |
| `builder-debug.yml` | 6,115 |

**How the build identifies itself:**

| Check | Result |
| --- | --- |
| Installer filename | `RUBIS POS Setup 2.0.1.exe` |
| Installer Properties → Product/File version | 2.0.1 / 2.0.1 |
| Portable exe Properties → Product/File version | 2.0.1 / 2.0.1 |
| Installed app exe (`win-unpacked\RUBIS POS.exe`) | Product version 2.0.1.0, File version 2.0.1 |
| `package.json` inside `app.asar`, which is what `app.getVersion()` returns | 2.0.1 |

**The fixes are in the bundle:**
- the bundled `resources/.env` has 1 line of `VITE_TAX_RATE=0.16`;
- `out/main/index.js` contains `VOID_DISABLED_MESSAGE` (*"Sales cannot be
  voided on this till…"*) and `VOIDED_ORDER_NOT_FILED_REASON` (*"This sale was
  voided and will not be filed…"*), once each.

## 6. Rollback

`git revert 01eb80f`, then `npm run dist`. That restores 2.0.0 naming over the
same code. The deleted files were untracked build output and logs, and they
cannot be recovered from git. None of them was needed.

## 7. Observed but not changed

- **No in-app version display exists** (section 1). If it's wanted, it is a
  small renderer change, such as a footer or an Admin → About line calling the
  existing `getAppVersion`. It belongs in its own phase.
- **The installer is unsigned**, so a SmartScreen prompt is expected.

**Next:** Item 2b. The partner installs `RUBIS POS Setup 2.0.1.exe` and runs
the first live 1-KSh cash sale.
