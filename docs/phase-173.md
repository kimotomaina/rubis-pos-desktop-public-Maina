# Phase 173 — Every app icon and logo now uses the updated logo

- **Date:** 2026-09-28
- **Requested:** Make every app icon and logo use the updated logo file (same file name, new image). No behaviour changes.
- **Outcome:** Implemented. Report committed alongside the code.
- **Branch / base commit:** staging @ 0b4662b (docs/phase-172)

**Context found during the audit:** this is the exact follow-up [phase-133](phase-133.md) itself flagged and left undone — that phase updated the renderer logo (`src/renderer/src/assets/logo-rubis.png`) to the new "enjoy" wordmark, and its own §7 said: *"The window, taskbar, and installer icon (`resources/icons/icon.ico` and `icon.png`, dated 2026-08-25) is unchanged. If it should also become 'enjoy', it needs a new `.ico`."* Nothing since then had touched it.

---

## STEP 0 — Audit

### 1. Every icon/logo reference, file:line, and what it points to

| Reference | File:line | Points to |
| --- | --- | --- |
| `win.icon` | `electron-builder.yml:26` | `resources/icons/icon.ico` |
| `extraResources` (packaged copy, read at runtime via `process.resourcesPath`) | `electron-builder.yml:19-20` | `resources/icons/icon.ico` → `icons/icon.ico` inside the packaged app |
| NSIS `installerIcon`/`uninstallerIcon`/`installerHeaderIcon` | `electron-builder.yml:30-34` (`nsis:` block) | **Not set explicitly** — electron-builder defaults all three to `win.icon` when absent. No separate installer-specific icon exists. |
| `directories.buildResources` | not set in `electron-builder.yml` | Defaults to `build/` (electron-builder's own convention) — but this project never relies on that convention; `build/` holds only `installer.nsh` (an NSIS script include, `electron-builder.yml:34`), no icon. The icon path is given explicitly via `win.icon`/`extraResources` instead. |
| `BrowserWindow({ icon })` | `src/main/index.ts:276-278`, used at `:322` | Same file, two branches: packaged → `process.resourcesPath/icons/icon.ico`; dev → `../../resources/icons/icon.ico`. Both resolve to the one source file. |
| `index.html` favicon | `src/renderer/index.html:10` | `/src/assets/logo-rubis.png` (resolves to `src/renderer/src/assets/logo-rubis.png`) |
| Renderer logo imports | `App.tsx:44`, `OnboardingScreen.tsx:2`, `LocationPendingScreen.tsx:1`, `LoginScreen.tsx:3`, `LocationConfirmScreen.tsx:2` | All `import rubisLogo from '.../assets/logo-rubis.png'` — genuine ES module imports, not a fixed `public/` path |
| eTIMS logo (unrelated brand, not this task) | `OrderHistory.tsx:8` | `import etimsLogoSrc from '../assets/logo-etims.png'` — a different logo entirely, out of scope |

No other icon/logo reference exists anywhere in the repo (checked with a repo-wide search for `icon.ico`, `icon.png`, `installerIcon`, `uninstallerIcon`, `installerHeaderIcon` outside `node_modules`) — no macOS `.icns`, no Linux icon set, no README/CI reference, nothing in `build/`.

### 2. SHA-256, pixel size, and which files were still the old image

| File | SHA-256 (before) | Size (before) | Content (before) |
| --- | --- | --- | --- |
| `resources/icons/icon.ico` | `7812F15F02E5B97B4941BBA70776C448E291795A73DCBF13FF8B7728FBB7F91C` | 75,907 bytes, 7 embedded sizes | **Old** — the green/red "RUBiS ENERGIE" mark |
| `resources/icons/icon.png` | `0A05B5CBC285A068B9B0EADFB0173C2212EFE9C34BAB3AB6C002B05391AB2693` | 51,170 bytes, 256×256 | **Old** — same mark |
| `src/renderer/src/assets/logo-rubis.png` | unchanged this phase | 13,087 bytes, 422×160 | **Already new** — the "enjoy" wordmark, fixed by phase-133 on 2026-09-25 |
| `resources/logos/logo-rubis.jpg` | n/a (untracked, not read by the app) | 228,693 bytes, 3369×1697 | The user-supplied master source, added 2026-09-24; confirmed again this phase that nothing in the app reads `resources/logos/` |

So exactly one thing was stale: the icon (`resources/icons/icon.ico`/`icon.png`), dated 2026-08-25 — a month before the new logo even arrived. The renderer logo and favicon were already correct, both pointing at the same already-updated `logo-rubis.png`.

### 3. electron-builder's icon rule

Per [electron.build/icons.html](https://www.electron.build/icons.html) (checked 28 Sep 2026): Windows needs `icon.ico` (preferred) or a `256×256`+ `icon.png`, normally auto-discovered from `buildResources`. This project doesn't use that auto-discovery — `win.icon` is set explicitly (§0.1) — but the file it points at already met the size rule structurally: the old `icon.ico` had all 7 conventional sizes (16/24/32/48/64/128/256), each PNG-compressed 32bpp, largest frame 256×256. **The old icon was never a technical-compliance problem — only a stale-content one.**

---

## FIX

### 1. Regenerated `resources/icons/icon.ico`

No new dependency needed. `app-builder-bin` — already an installed transitive dependency of `electron-builder` (it's the native tool electron-builder itself calls for icon packaging) — was tested first (`node_modules/app-builder-bin/win/x64/app-builder.exe icon`), but it only repackages a single pre-sized image; it doesn't resample one image into multiple sizes with padding. Used .NET's `System.Drawing` instead (part of the Windows PowerShell runtime already on this machine — not a project dependency) to do the actual per-size compositing, then hand-assembled the `.ico` container myself (a plain `ICONDIR` + 7 `ICONDIRENTRY` + concatenated PNG blobs — a well-documented, simple binary format) so every size is exactly what was asked for, not whatever a tool's own defaults happen to produce.

Source: `src/renderer/src/assets/logo-rubis.png` (422×160, the already-cropped, already-verified "enjoy" wordmark phase-133 put in place) — not the raw 3369×1697 JPEG, since 422px wide is already more resolution than a 256px-max icon needs, and reusing the exact same cropped render keeps the icon visually consistent with the header/login logo rather than a second, independent crop.

For each of 16, 24, 32, 48, 64, 128, 256: a new square canvas (`Format32bppArgb`, filled fully transparent), the logo scaled to contain-fit (preserving its 2.64:1 aspect ratio — the source isn't square, so this pads top and bottom with transparency, never crops), centred, high-quality bicubic/antialiased draw, saved as a PNG-compressed frame. All 7 frames confirmed present, 32bpp, PNG-compressed, sizes exactly 16/24/32/48/64/128/256 (checked by parsing the rebuilt `.ico`'s own directory).

**A legibility trade-off, flagged and confirmed before proceeding:** because the wordmark is wide and letterboxed, the actual visible logo content shrinks to about 6px tall at the 16×16 size and 12px tall at 32×32 — barely legible at taskbar size, readable from 128px up. I stopped and asked before finishing rather than silently picking a different design; you confirmed proceeding with the literal instruction (full wordmark, letterboxed) rather than cropping to a symbol-only mark. Screenshots of the 16/32/48/256px renders were reviewed by eye before and after.

| File | SHA-256 (after) | Size (after) |
| --- | --- | --- |
| `resources/icons/icon.ico` | `A99D3A704EE424073ECE3D142D34C3C1B93623E06DF25DC2C3450E4C315B6265` | 18,697 bytes, 7 embedded sizes (16/24/32/48/64/128/256, all PNG 32bpp) |
| `resources/icons/icon.png` | `61A1383B1BFFFFE5E6DCA27663C73688D8AEB7012E6567976FAAEBA6B46E9D59` | 8,759 bytes, 256×256 (the same 256px frame, saved standalone) |

### 2. One source, no stale copies

`win.icon`, `extraResources`, and `BrowserWindow({ icon })` already all pointed at the same single file (`resources/icons/icon.ico`) before this phase (§0.1) — regenerating that one file in place updates every consumer with no config change needed. No stale duplicate icon files were found anywhere else in the repo to delete (§0.1's repo-wide search came back clean); the only other `icon.ico` on disk was `release/win-unpacked/resources/icons/icon.ico`, a build artifact removed by the clean-before-build step below, not a source file.

### 3. Renderer logo

Audited and found **already correct** — every renderer reference (`App.tsx`, `OnboardingScreen.tsx`, `LocationPendingScreen.tsx`, `LoginScreen.tsx`, `LocationConfirmScreen.tsx`, and the `index.html` favicon `<link>`) already uses a Vite-processed reference (an ES `import`, or an HTML asset href Vite rewrites the same way), not a fixed `public/` path. Confirmed in the built output: `out/renderer/index.html` reads `<link rel="icon" ... href="./assets/logo-rubis-CANYAstX.png">` — a content-hashed URL. No code change was needed or made here.

### 4. Clean build, version bump, build

```
Remove-Item -Recurse -Force out, release, node_modules\.vite
```
`package.json` version bumped **2.0.1 → 2.0.2** (patch), so the installer is treated as a new version.

### 5. Verified from the built output, not the source

```
Get-FileHash resources\icons\icon.ico  == Get-FileHash release\win-unpacked\resources\icons\icon.ico
→ True (both A99D3A70...)
```
Extracted the icon actually embedded in the packaged executables (`System.Drawing.Icon.ExtractAssociatedIcon`, reading the real Win32 resource, not the source file):
- `release\win-unpacked\RUBIS POS.exe` → 32×32 icon extracted, shows the new "enjoy" wordmark (viewed by eye).
- `release\RUBIS POS Setup 2.0.2.exe` (the NSIS installer itself) → same, 32×32, "enjoy".

Both confirm the new icon actually made it into the packaged binaries, not just the source `resources/` folder.

---

## VERIFY

```
$ npm run typecheck
(clean: typecheck:node and typecheck:web, no errors — no source code changed this phase)

$ npm run build
built; out/renderer/index.html references the content-hashed favicon; "Confirmed: neither mock provider is in out/main."

$ npm run dist
electron-builder 25.1.8 — packaged win32/x64, electron 43.4.1
  building nsis:     release\RUBIS POS Setup 2.0.2.exe
  building portable: release\RUBIS POS 2.0.2.exe
✓ .env bundling verified — a fresh install of this build needs no manual .env setup.
(code signing skipped — no signing certificate is configured on this machine; pre-existing, unrelated to this phase)
```

Grepped `tests/` for every changed file (`icon.ico`, `icon.png`, `resources/icons`, the version string) — **no test references any of them**, so no test file was run beyond typecheck/build/dist above, per this phase's own VERIFY instruction.

## Rollback

`git revert` the commit. The regenerated `icon.ico`/`icon.png` and the version bump all revert together; `out/`, `release/`, and `node_modules/.vite` are build artifacts and regenerate on the next build regardless.

## Observed but not changed

- **Small-size legibility** (FIX §1) — flagged and confirmed with you rather than decided unilaterally. A symbol-only mark (just the red smile, no wordmark) would stay legible at 16-32px if you'd like a follow-up.
- **Code signing** is not configured (`signtoolOptions.publisherName` is set, but no certificate) — every build, before and after this phase, produces an unsigned `.exe`. Unrelated to the icon change; not touched.
- **`resources/logos/logo-rubis.jpg` and `logo-rubis1.png`** remain untracked in the working tree, exactly as every phase since 133 has found them (the user's own original drop and the renamed old logo) — still not read by the app, still left for you to commit or discard.
- **The five `<img>` tags' `alt` text** still reads "RUBIS Energie" (phase-133's own §7 finding) — a text-only fix, out of scope for this icon/logo phase.

**STOP for review.**
