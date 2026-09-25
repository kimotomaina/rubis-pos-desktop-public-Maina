# Phase 133 — New "enjoy" logo, with every stale cache cleared

- **Date:** 2026-09-25
- **Requested:** The logo was changed. Make sure no cache is used, so the app shows the new one.
- **Outcome:** Implemented
- **Branch / base commit:** staging @ cf7c7d8
- **Previous:** [phase-132](./phase-132.md)

## 1. Audit — why the old logo would still show

| Location | Held | Finding |
| --- | --- | --- |
| `resources/logos/logo-rubis.jpg` | the new "enjoy" logo, 3369×1697, 228 KB (added by the user 2026-09-24) | The new source. **Nothing in the app reads `resources/logos/`.** |
| `resources/logos/logo-rubis.png` → `logo-rubis1.png` | the old RUBIS Energie logo | Renamed by the user. |
| `src/renderer/src/assets/logo-rubis.png` | **the old RUBIS logo** (12,192 bytes, identical in size to `logo-rubis1.png`) | **The root cause.** This is the file the renderer imports: `App.tsx` header, `LoginScreen`, `OnboardingScreen`, `LocationPendingScreen`, `LocationConfirmScreen`, and the `index.html` favicon. Phase 35 set up the same copy-into-assets pattern for the eTIMS logo. |
| `out/renderer/assets/logo-rubis-D8wm_kb9.png` | old logo, built 2026-09-23 | Stale build output. |
| `node_modules/.vite` | Vite's dependency pre-bundle cache | Stale dev cache. |
| `%APPDATA%\rubis-pos-desktop\{Cache, Code Cache, GPUCache, DawnGraphiteCache, DawnWebGPUCache, Shared Dictionary}` | Chromium's HTTP, compiled-code, and GPU caches for the renderer | Could serve an old response in dev. |

The new JPEG has wide white margins. The letters fill only about 55% of its
height, so at the header's `h-9` (36 px) they would render about 15 px tall.

## 2. Changes made

**Modified.** `src/renderer/src/assets/logo-rubis.png` now holds the new logo:
- cropped to its content plus a 24 px margin;
- scaled to 422×160;
- saved as PNG (13,087 bytes).

The file keeps the **same name**, so no import, component, or `index.html`
changed. The source `resources/logos/logo-rubis.jpg` was not modified.

**Deleted (caches, all untracked):**
- `out/`
- `node_modules/.vite`
- the six Chromium cache folders listed above in `%APPDATA%\rubis-pos-desktop`

**Not touched:** in userData, `rubis-pos.db`, `secret-vault.json`, `Local
Storage`, `Session Storage`, `Preferences`, and `Local State`. That means the
database, credentials, cart, and settings are all kept.

**Why a stale logo can't come back.** In production, Vite names each asset by
its content hash. The logo changed from `logo-rubis-D8wm_kb9.png` to
`logo-rubis-CANYAstX.png`, so a packaged app cannot reuse the old file. In
dev, Vite revalidates every asset through its ETag, and the ETag changes with
the content. No cache-busting code is needed.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| src/renderer/src/assets/logo-rubis.png | Modified | The logo in the header, the login, onboarding, and location screens, and the favicon |
| out/, node_modules/.vite, the Chromium caches in userData | Deleted (untracked) | none; all of them regenerate |

## 4. Possible impact

- **Direct:** every place that showed the RUBIS Energie logo now shows "enjoy".
- **Indirect:** the new logo is wider (2.6:1 against the old logo's roughly
  2:1), so it takes about 94 px of header width at `h-9`. The header's
  logo-and-nav group is `shrink-0` (phase-43), so the nav moves right by that
  difference but does not wrap.
- **Data / schema / contract:** none.
- **Residual risk:** the `alt` text still reads "RUBIS Energie" (section 7).

## 5. Verification

```
npm run build   → typecheck clean; the renderer emitted out/renderer/assets/logo-rubis-CANYAstX.png (13.09 kB)
                  ✓ Confirmed: neither mock provider is in out/main.
SHA-256(src/renderer/src/assets/logo-rubis.png) == SHA-256(out/renderer/assets/logo-rubis-CANYAstX.png) → True
```

The cropped image was checked by eye. It shows the full "enjoy" wordmark,
including the red smile, with nothing clipped.

**Not yet done:** `npm run dist`. The installer in `release/` (2.0.1, built
2026-09-23) **still has the old logo** until it is rebuilt.

## 6. Rollback

Run `git revert` on this commit to restore the old asset. The deleted caches
regenerate on the next `npm run dev` or `npm run build`.

## 7. Observed but not changed

- **The `alt` text** on all five `<img>` tags still reads "RUBIS Energie".
  Changing it depends on the brand name, which should be confirmed first.
- **The window, taskbar, and installer icon** (`resources/icons/icon.ico` and
  `icon.png`, dated 2026-08-25) is unchanged. If it should also become
  "enjoy", it needs a new `.ico`.
- **The user's `resources/logos/` changes** (the deleted `logo-rubis.png`, the
  new `logo-rubis.jpg`, and `logo-rubis1.png`) are left uncommitted for the
  user to commit or discard.
