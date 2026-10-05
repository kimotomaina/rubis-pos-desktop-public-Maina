# Release 2.2.3

- **Date:** 2026-10-05
- **Outcome:** version bumped, installer built from commit `da220d5`. **Not installed, not published, not even as a draft.** Nigel installs it by hand on the live till (Rubis Kisumu) after trading closes. Publishing to the update feed waits for his written go.
- **Contains:** phases 227 (every sale lands in a shift) and 228 (Z report and printer status use the receipt printer; `till.log`), on top of 2.2.2. First commit `d63a1ac`, last `da220d5`.
- **Checks on that commit:** full suite 211 files, 3503 passed, 0 failed; typecheck clean; `npm run dist` (typecheck, build, no-mock guard, `verify-dist`) passed. `GH_TOKEN` was not set in the build shell.
- **Setup:** `release/RUBIS POS Setup 2.2.3.exe`, 121,568,823 bytes, SHA-256 `a52842e6eeb72dc887f433cfd8546a4c04694e91aee70a2dfe4ab00117e12aac`. `latest.yml` says 2.2.3.
- **Portable:** `release/RUBIS POS 2.2.3.exe`, 121,346,113 bytes, SHA-256 `26e4aea2fcdf17c7ca6d4aa08a27371979f2c8616eeecfcd5965140439ac7249`.
- Unsigned, as every build. `npm run dist:publish` would rebuild, so published bytes would differ; publish from one run only.
- **Bundled `.env`:** `VITE_PRINTER_INTERFACE=tcp://192.168.1.50:9100`, `VITE_MOCK_PRINTER=false`, no token lines with a value.
- **Rollback:** reinstall 2.2.2 by hand from `release/RUBIS POS Setup 2.2.2.exe` (121,565,433 bytes, SHA-256 `c2f13c077fdb3da08909f4539d5bfc6758fb7f374b0e9e49f69f6a9de8093c12`). 2.2.2 reads a database 2.2.3 touched: the new `shifts.cash_not_counted` column is additive with a default, and 2.2.2's `SELECT * FROM shifts` and inserts ignore it. A shift saved as "not counted" would read there as starting cash 0, no counted cash and no difference.
- **Not done:** not installed, app not started, nothing sent to GitHub.
