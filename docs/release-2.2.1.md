# Release 2.2.1

- **Date:** 2026-10-05
- **Requested:** a new build, 2.2.1.
- **Outcome:** version bumped and the installer built. **Not installed on this PC, not published, not even as a draft.** The owner publishes (section 4).
- **Relation to 2.2.0:** 2.2.0 was built on 2026-10-04 and, as far as this record knows, was not published ([release-2.2.0.md](release-2.2.0.md)). 2.2.1 carries everything in it plus phase 220. If 2.2.0 was published, tills on it will be offered 2.2.1; if not, 2.2.1 is the first release after v2.1.8.
- **Branch / commits:** main, not pushed by me.

```
f64fd13 chore: bump version to 2.2.1
e305c75 Phase 220: End of Day entries scroll, action bar pinned to the bottom; Admin title removed
```

## 1. What is new since 2.2.0

| Phase | What | Verified on a till |
| --- | --- | --- |
| [220](phase-220.md) | End of Day: top card fixed, entries scroll, action bar pinned to the bottom, pagination removed from that page; the plain "Admin" title above the Admin screens removed | **no**: layout is to be checked by the owner on the till (checklist in phase-220 section 5) |

Everything else in the build is as listed in [release-2.2.0.md](release-2.2.0.md) section 1 (phases 215 to 219), also not yet seen on a till.

## 2. Build and checks

- Before the build: full suite **199 files, 3290 passed, 1 skipped**; typecheck clean.
- `npm run dist`: typecheck, build and `Confirmed: neither mock provider is in out/main.`; `verify-dist` confirmed `win-unpacked/resources/.env` is bundled. That bundled `.env` has **no** `GH_TOKEN` or `GITHUB_TOKEN`; `GH_TOKEN` was not set in the build shell.
- The packed `app.asar` reports version 2.2.1; contains the phase 219 setting (`autoInstallOnAppQuit`) and the `updater:startup-check` handler, the "Manual verification" text, and the phase 220 End of Day scroll region and scrollbar style; contains no `KRA-MOCK-` text.
- **Setup SHA-256 `4df89da80eea531a01c0227b3272548cb295b80d8854b9a5716093268e64d9ae`**, 121,556,021 bytes (`release/RUBIS POS Setup 2.2.1.exe`). `latest.yml`: version 2.2.1, path `RUBIS-POS-Setup-2.2.1.exe`, sha512 `0Jxj/7zhjZQyxGdohuJhszuJJ3YgCEdzaSb8Ayb1lwHKRkRJhQZeh0qEqmSBql4DGMd3a/mI47bz2G5hlDeQ8w==`.
- **Portable exe SHA-256 `761e413f7874e0923a12518566cf195a9c2d498fcc11f31aa23239d83857d724`**, 121,333,306 bytes (`release/RUBIS POS 2.2.1.exe`).
- The installers are **unsigned** (no signing info configured), as in every earlier build.
- `npm run dist:publish` rebuilds, so the published bytes and `latest.yml` hash will differ from the above; the source is the same commit. **Publish from one `dist:publish` run only; never mix files from different builds.**

## 3. Not done

Not installed over the top on this PC; the app was not started. Nothing was uploaded to GitHub.

## 4. Publishing: how to finish

- `GH_TOKEN` must be a Windows user environment variable, never in `.env`. Run `npm run dist:publish` from `rubis-pos-desktop`. The release is created as a **draft**; check it says Draft, that the installer, its blockmap, the portable exe and `latest.yml` are all there, and that `latest.yml` says 2.2.1.
- **Pressing Publish offers 2.2.1 to every till.** A till on 2.1.8 or earlier updates under the **old** rules (it downloads by itself and installs when closed); from 2.2.0 on, the till asks first.
- Do not publish until a till has shown the new screens (End of Day on a busy day, hold a sale, the update prompt on a build older than 2.2.0) and the Enjoy reprint of phase 216-1 has been done.
- A stray **2.1.9 draft** may still be on GitHub from the failed upload of 2026-10-04 (see release-2.2.0.md); delete it so it is not published by mistake.

## 5. Still open

The exposed GitHub token and the v2.1.5 assets still holding it; the real-printer test never having been run on a till; phase 216-1; the unmeasured width of the "Manual verification" tab; whether a till updating through the updater keeps its data; the phase 220 layout check and the sweep findings in phase-220 section 7 (Stock Take commit and Needs Attention can still push their buttons off screen).

## 6. Rollback

Install 2.1.8 (or earlier) over the top, never uninstall. Withdrawing 2.2.1, once published, means setting it back to draft; tills that already updated keep it.
