# Release 2.2.5

- **Date:** 2026-10-06
- **Outcome:** version bumped and the installer built from commit `de297e6`. **Not published** (no `GH_TOKEN` on this PC, and the dry run is outstanding). **Not installed on any till.**
- **Contains:** phase 232 (one shift per window, automatic assignment, close from the window's last minute) on top of 2.2.4's phases 227 to 230. 2.2.4 was built (`e88078e`, record `b4232f5`) and never published or installed, so its number was not reused and its contents ship here. 2.2.3 was never published either.
- **Commits:** `126512b` (phase 232 build, committed under the label "phase 231"), `8a46c74` (restores `docs/phase-231.md`), `adf8ca1` (renumber to 232, comments only), `de297e6` (the version bump).

## 1. Checks on `de297e6`

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| Full suite (run on the renumbered tree before the bump) | 213 files, 3574 passed, 1 skipped (the build-freshness check, which runs only when `out/` is fresh), 0 failed |
| `npm run dist` | passed: `check-env` ("no credentials"), typecheck, build, "Confirmed: neither mock provider is in out/main.", `verify-dist` ("win-unpacked/resources/.env is bundled") |
| `docs/phase-231.md` against `a8efab9` | `git diff` prints nothing |

## 2. The build

- **Setup:** `release/RUBIS POS Setup 2.2.5.exe`, 121,576,145 bytes, SHA-256 `e98502ef2d70b7a2832d187b7c650744289c1735d3dc68425cce38eb27895fd6`. `latest.yml` says 2.2.5.
- **Portable:** `release/RUBIS POS 2.2.5.exe`, SHA-256 `aa5787e84d79c58cd50ffff1fbce1f29c8e7a5d016efd2f087bee9bb4b452535`.
- **Packed `app.asar`:** reports version 2.2.5.
- **Bundled `.env`:** `VITE_PRINTER_INTERFACE=tcp://192.168.1.50:9100`, `VITE_MOCK_PRINTER=false`. Two non-secret M-Pesa settings carry values (`MPESA_SHORTCODE`, `MPESA_ENVIRONMENT`); no token, key, secret or passkey does, and `check-env` passes. The printer address is the development one, as in 2.2.2 (see KNOWN_GAPS).
- Unsigned, as every build.
- **Way back:** `release/RUBIS POS Setup 2.2.4.exe` and 2.2.2 are in `release/`. The new tables are additive: 2.2.4 and earlier still start on a database 2.2.5 has touched, but they would not show the adjustments, and shifts made automatically would read as ordinary closed shifts with cash not counted.

## 3. Before it goes on a till

1. **The dry run on a copy of the live data is not done.** The first start creates shifts for every earlier window with sales; Paul asked to see exactly what it does first. The script is ready (tested on synthetic data only).
2. **Publishing needs `GH_TOKEN`** as a Windows user variable, a fine-grained token on `Volcha-Enterprises/rubis-pos-releases` with Releases write access. `npm run dist:publish` **rebuilds**, so the published bytes and `latest.yml` hashes will differ from section 2; publish from one run only. It creates a draft; Paul presses Publish.
3. **The build at Enjoy Haile Selassie** is for the owner to confirm.

## 4. Not done

Not installed; the app was not started; nothing uploaded to GitHub; nothing sent to the device, Shopify or Safaricom; `check:fit` not run (owner's rule).
