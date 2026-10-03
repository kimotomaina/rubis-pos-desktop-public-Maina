# Release 2.1.9

- **Date:** 2026-10-03
- **Requested:** commit phase 216; bump the version, build with `npm run dist`, install over the top on this PC; publish as a draft with `npm run dist:publish`; list the phases carried.
- **Outcome:** built and installed here. **Not published, not even as a draft:** `GH_TOKEN` is not set (user, machine or this session) and `gh` is not installed, so I stopped at step 3 as instructed. The owner sets `GH_TOKEN`, then runs `npm run dist:publish` (section 4).
- **Branch / commits:** staging, not pushed by me.

```
e63bef2 chore: bump version to 2.1.9
6019daa Known gaps: TOTAL KSH prints on two large lines on a 58mm (32-column) printer
1679b5f Phase 216: build double-size rows for half the printer width
f0acaef Phase 215: record the receipt-alignment audit and measure the double-size TOTAL KSH row
```

## 1. Phases this release carries, since the last published release (v2.1.8)

The last published release is **v2.1.8** (published 2026-10-03T01:14:10Z; read back unauthenticated from the public releases list just now: v2.1.8 is the latest, and no 2.1.9 release is visible). It already carried phases 208, 210-1, 211-1, 212-1, 213 and 214 ([release-2.1.8.md](release-2.1.8.md)). Since then:

| Phase | What | Committed | Verified on paper |
| --- | --- | --- | --- |
| [215](phase-215.md) | Audit of the receipt-alignment report; TOTAL KSH measured (a 48-character string at double size wraps). Document only, no code | yes (`f0acaef`) | **no** (nothing to print; its audit rests on byte dumps) |
| [216](phase-216.md) | Double-size rows built for `width / 2`: the TOTAL KSH row, long shop-name headings; golden updated; guard test | yes (`1679b5f`) | **no**: no real printer on this PC; the Enjoy till has not yet updated or printed it |
| (none) | `docs/KNOWN_GAPS.md`: the 32-column TOTAL KSH limit; version bump to 2.1.9 | yes (`6019daa`, `e63bef2`) | not applicable |

The only code change in 2.1.9 is phase 216. The "verified on paper" step is the Enjoy till reprint in section 5.

## 2. Build and checks

- Before the build: full suite **192 files, 3155 tests, all passing**; typecheck clean; `npm run build` passed with `Confirmed: neither mock provider is in out/main.`
- `npm run dist`: `check-env` passed (no credentials in `.env`), typecheck, build and the no-mock check passed, `verify-dist` confirmed the bundled `.env`. The `.env` carries no `GH_TOKEN` or `GITHUB_TOKEN`, and its Shopify and M-Pesa credential values are empty (only the short code and environment name are set).
- **Setup SHA-256 `10279cabec4f5446308cf684c67f3eedbf4ab62d5f7d1d8c282f3c4eb58df1f6`**, 121,546,931 bytes. `latest.yml`: version 2.1.9, path `RUBIS-POS-Setup-2.1.9.exe`, sha512 `oikqE/5cpVDd+XgBWyPIhu3dloKyOpvaLhy3yRB39H/JV9qCIi6+dQXDvrPQ7biOTj8OwrFOS7tQUwc3MBBJuw==`.
- **Portable exe SHA-256 `b0eb8a5642eb9b073fcf6ec65fa9879289fa27954546bdc0fee7de16a99a074b`**, 121,324,186 bytes.
- `npm run dist:publish` rebuilds, so the published installer's bytes will differ from the hashes above (as with every electron-builder run); the source is the same commit.

## 3. Install on this PC, and the data fingerprint

`RUBIS POS Setup 2.1.9.exe /S`: exit 0 in 15 s, same folder, no uninstall. The app was not running (0 processes), so nothing needed closing. The exe's file version is 2.1.9 and the Windows entry reads "RUBIS POS 2.1.9". The installed `app.asar` holds `columnsFor` (phase 216) and neither the `KRA-MOCK-` text nor the test banner text. The installed `.env` has no `GH_TOKEN` or `GITHUB_TOKEN`.

**Data fingerprint, before and after the install: identical** (a read-only copy of the database and the vault, compared as in release 2.1.6 section 4, and the same values as release 2.1.8 section 4):

| | Before | After |
| --- | --- | --- |
| Vault (SHA-256, first 16 hex), size | `d64bf937939bf270`, 231 bytes | same |
| Orders | 2 (order 1 `needs_fixing`, `INV-000000001`; order 2 `fiscalized`, invoice `0110605040001000810`) | same |
| Staff, products, printers | 1, 714, 0 | same |
| Settings | 7 keys, including `repair_212_ran_at` and `last_trader_seq` `23762883` | same |

`rubis-pos.db` and `secret-vault.json` are present, and the earlier `.bak` files are untouched. **The app was not started** after this install (it would call Shopify and the fiscal device). The temporary database copies used for the fingerprint were deleted.

## 4. Publishing: how to finish

- Set `GH_TOKEN` as a Windows user environment variable (a token with write access to `Volcha-Enterprises/rubis-pos-releases`), start a new terminal, then run `npm run dist:publish` from `rubis-pos-desktop`. `electron-builder.yml` has no `releaseType` override, so the release is created as a **draft**; check that it shows "Draft" on the releases page. The tills' updater does not see it until **Publish** is pressed on GitHub.
- **The token is still the exposed one until the owner replaces it** (release 2.1.8 section 5, phase 213-1): it was in the public v2.1.5 installer. I did not look for or use any stored copy of it for this release. Put the new token in an environment variable, never in `.env`.
- Once published, read `latest.yml` back unauthenticated and confirm it says 2.1.9, as for 2.1.8.

## 5. After the Enjoy till updates (phase 216-1)

Reprint sale LZZYNW4NOE68CQ from Order History (it prints as DUPLICATE, as expected). Photograph it **flat, from directly above**, with a straight edge under TOTAL KSH and under Invoice No. Pass:
- TOTAL KSH and its amount on one large line;
- every label-and-value row on one line;
- the Enjoy slip's footer complete above the cut.

Record the result, with the photo, as phase 216-1.

## 6. Still open (unchanged from release 2.1.8 section 5)

The exposed GitHub token; the v2.1.5 assets still holding it; the real-printer test never having been run on a till; legacy `INV-` trader numbers expected to be refused on a resend; whether a till updating through the updater (not a manual install) keeps its data.

## 7. Rollback

Install 2.1.8 (or earlier) over the top, never uninstall. Withdrawing 2.1.9, once a draft exists, means deleting the draft; once published, setting it back to draft. Tills that already updated keep 2.1.9. `git revert` `1679b5f` takes the phase 216 code and golden back.
