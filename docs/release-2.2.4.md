# Release 2.2.4

- **Date:** 2026-10-05
- **Outcome:** version bumped and the installer built from commit `e88078e`. **Not published: no `GH_TOKEN` is set on this PC** (see section 3). Not installed on any till.
- **Contains:** phases 227 (every sale lands in a shift), 228 (Z report and printer status use the receipt printer; `till.log`), 229 (buckets by Day or Night window) and 230 (update screens show no paths or addresses), on top of 2.2.2. **2.2.3 was built (commit `da220d5`, record in [release-2.2.3.md](release-2.2.3.md)) and was never published.**
- **Commits:** first `d63a1ac` (phase 227), `cee4457` (227), `1293807` (228), `75fb885` (229), `0652eb9` (230), last `e88078e` (the version bump).

## 1. Gates

| Gate | Result |
| --- | --- |
| 1 (phase 229) | typecheck clean; full suite 212 files, 3527 passed, 1 skipped; all mutation checks caught (four, one more than asked for) |
| 2 (phase 230) | typecheck clean; full suite 213 files, 3569 passed, 1 skipped; all three mutation checks caught; the audit found no secret exposure |
| 3 (build) | on `e88078e`: full suite 213 files, 3569 passed, 1 skipped, 0 failed; typecheck clean; `npm run dist` (typecheck, build, "Confirmed: neither mock provider is in out/main.", `verify-dist`) passed; `check-env` passed ("no credentials"); the bundled `.env` has mock off and no credential line with a value; the packed `app.asar` reports 2.2.4 |
| 4 (publish) | **not run** |

## 2. The build

- **Setup:** `release/RUBIS POS Setup 2.2.4.exe`, 121,570,381 bytes, SHA-256 `e28fa40974663fcbd3bb6d5882df8cba5646f7ec463a8068b0384dc6e59795fd`. `latest.yml` says 2.2.4.
- **Portable:** `release/RUBIS POS 2.2.4.exe`, SHA-256 `0613b25099dec872c45775595fd00a0fa8c46e46c95a14c877aca8f5b4267fee`.
- **Bundled `.env`:** `VITE_PRINTER_INTERFACE=tcp://192.168.1.50:9100`, `VITE_MOCK_PRINTER=false`.
- Unsigned, as every build.
- **Way back:** `release/RUBIS POS Setup 2.2.2.exe` (SHA-256 `c2f13c077fdb3da08909f4539d5bfc6758fb7f374b0e9e49f69f6a9de8093c12`) and `release/RUBIS POS Setup 2.2.3.exe` (`a52842e6eeb72dc887f433cfd8546a4c04694e91aee70a2dfe4ab00117e12aac`). The new column `shifts.cash_not_counted` is additive, so 2.2.2 still starts on a database 2.2.4 has touched (a "not counted" shift would read there as starting cash 0 with no counted cash).

## 3. Why it was not published

`npm run dist:publish` needs `GH_TOKEN`, which must be a Windows user environment variable and never in `.env`. It is not set at user, machine or process level on this PC (presence checked; no value was read or printed). The token was not looked for elsewhere and nobody was asked to paste one.

To publish: set `GH_TOKEN` as a Windows **user** environment variable, open a new terminal, and give the go. `dist:publish` **rebuilds**, so the published bytes and `latest.yml` hashes will differ from section 2 (same commit); publish from one run only, and do not mix files from different builds. The release is created as a **draft**: check it says Draft, that the installer, its blockmap, the portable exe and `latest.yml` are all there and that `latest.yml` says 2.2.4, then press Publish. Pressing Publish offers 2.2.4 to every till.

## 4. Not done

Not installed over the top on any till; the app was not started; nothing uploaded to GitHub.
