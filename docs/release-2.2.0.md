# Release 2.2.0

- **Date:** 2026-10-04
- **Requested:** a new build, 2.2.0.
- **Outcome:** version bumped and the installer built. **Not installed on this PC, not published, not even as a draft.** The owner publishes (section 4).
- **Why 2.2.0 and not 2.1.9:** the 2.1.9 installer built earlier today was rebuilt from a later commit and so no longer matched [release-2.1.9.md](release-2.1.9.md); the same version number would have meant two different builds, and a till already on the older 2.1.9 would never have been offered the new one. 2.1.9 was never published. 2.2.0 supersedes it, and its release note stays as the record of that earlier build.
- **Branch / commits:** main, not pushed by me.

```
55f9cd5 chore: bump version to 2.2.0
19cb5fa Phase 219: check for updates at startup, ask, ask again next time; nothing installs without a yes
b3a559e Phase 218-1: reword the Manual verification panel's sentences
c5148b6 Phase 218: show "Manual verification" where the screen said "Unverified" (wording only)
bf6925f Phase 217: hold a sale and serve the next customer (verification, End of Day list, check:fit, record)
```

## 1. Phases this release carries, since the last published release (v2.1.8)

| Phase | What | Committed | Verified on paper / on a till |
| --- | --- | --- | --- |
| [215](phase-215.md) | Receipt-alignment audit; TOTAL KSH measured. Document only | yes | no |
| [216](phase-216.md) | Double-size rows built for `width / 2` (TOTAL KSH, long shop-name headings) | yes | **no**: no real printer on this PC; the Enjoy reprint (phase 216-1) is still to do |
| [217](phase-217.md) | Hold a sale and serve the next customer (up to three held sales; Close Shift refused while any is held; discarded held sales listed at End of Day) | yes | **no**: not tried on a till |
| [218](phase-218.md), [218-1](phase-218-1.md) | "Unverified" reads "Manual verification" on screen; the panel sentences reworded. Wording only | yes | no; layout of the longer tab label **not measured** |
| [219](phase-219.md) | Check for updates at startup, ask, ask again next start; nothing installs without a yes; background work finishes before an install | yes | **no**: not seen on a packaged build, not run against GitHub |

## 2. Build and checks

- Before the build: full suite **198 files, 3274 tests, all passing**; typecheck clean.
- `npm run dist`: `check-env` passed, typecheck, build and `Confirmed: neither mock provider is in out/main.`; `verify-dist` confirmed the bundled `.env` (no `GH_TOKEN` or `GITHUB_TOKEN` in it).
- The packed `app.asar` reports version 2.2.0, contains the phase 219 setting (`autoInstallOnAppQuit` set to false) and the `updater:startup-check` handler, contains the "Update available" and "Manual verification" texts, and contains no `KRA-MOCK-` text.
- **Setup SHA-256 `999ecf66483487bbf2492690b6093c69eb7dce7bff2a4b8e24f1cd9314e4f2bd`**, 121,555,543 bytes. `latest.yml`: version 2.2.0, path `RUBIS-POS-Setup-2.2.0.exe`, sha512 `Zrt6qZU2LAgn1sjKB25Bm3vVD25Va3pO2w8EDtQcWUeKKydGB8hZwaG87mknsVEz2XR3pPUgV8xg2b0BEDGu4Q==`.
- **Portable exe SHA-256 `e594eb455d0714e9fd638d139bf880f20a9f18017f4cee20513ed279bb09fb36`**, 121,332,826 bytes.
- `npm run dist:publish` rebuilds, so the published bytes and `latest.yml` hash will differ from the above (as with every electron-builder run); the source is the same commit. **Publish from one `dist:publish` run only; never mix files from different builds** (the local 2.1.9 `latest.yml` did not match its installer for that reason).

## 3. Not done

Not installed over the top on this PC; the app was not started. Nothing was uploaded.

## 4. Publishing: how to finish

- `GH_TOKEN` is a Windows user environment variable, not in `.env`. Run `npm run dist:publish` from `rubis-pos-desktop`. The release is created as a **draft**; check it says Draft, that the installer, its blockmap, the portable exe and `latest.yml` are all there, and that `latest.yml` says 2.2.0.
- **Pressing Publish offers 2.2.0 to every till.** A till on 2.1.8 updates under the **old** rules (it downloads by itself and installs when closed), because it does not yet have phase 219; from 2.2.0 on, the till asks first.
- The first upload attempt of today (2.1.9) failed on the network (connection errors to GitHub). It may have left a **2.1.9 draft** on GitHub with some files. It is invisible to the tills, but delete it from the releases page so it is not published by mistake.
- Do not publish until a till has shown the new screens (hold a sale, the update prompt on a build older than 2.2.0) and the Enjoy reprint of phase 216-1 has been done.

## 5. Still open

The exposed GitHub token and the v2.1.5 assets still holding it; the real-printer test never having been run on a till; phase 216-1; the unmeasured width of the "Manual verification" tab; whether a till updating through the updater keeps its data.

## 6. Rollback

Install 2.1.8 (or earlier) over the top, never uninstall. Withdrawing 2.2.0, once published, means setting it back to draft; tills that already updated keep it.
