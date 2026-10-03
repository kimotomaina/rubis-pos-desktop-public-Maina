# Release 2.1.8

- **Date:** 2026-10-03
- **Requested:** close both copies and clean up order 1; correct the device-figures VAT table and its reconciliation; build and publish.
- **Outcome:** done. **Published** on GitHub (`v2.1.8`, 2026-10-03T01:14:10Z, not a draft, marked latest) and installed over the top on this PC. 2.1.7 was superseded before it was ever published; its draft was deleted.
- **Branch / commits:** staging, not pushed by me.

```
463f832 chore: bump version to 2.1.8
f5d0196 Phase 214: read the device's VAT group amounts as gross on the slip and in its reconciliation
```

2.1.8 is 2.1.7 plus phase 214 (and everything in [release-2.1.7.md](release-2.1.7.md): phases 208, 210-1, 211-1, 212-1, 213).

## 1. Order 1 (before the build)

Both copies were already closed (0 processes, no dev server). Database backed up beside the originals (`*.2026-10-03-pre-order1-cleanup.bak`, hash-identical for the `.db`; the WAL and shm were already folded in). Order 1 had **never been filed** (no invoice number; 6 refused attempts under `INV-000000001`, status `waiting`, a retry row id 3). It was set back to `needs_fixing`, kind `system`, with the "Do not resend" reason, and its retry row deleted. Order 2 untouched.

## 2. Build and checks

- Before the build: full suite **191 files, 3071 tests, all passing**; typecheck clean; `npm run build` passed with `Confirmed: neither mock provider is in out/main.`
- `dist:publish`: `check-env` passed (no credentials, including the new `GH_TOKEN` rule from phase 213), `verify-dist` confirmed the bundled `.env`, and the packaged `resources\.env` has no `GH_TOKEN` or `GITHUB_TOKEN` text.
- **Setup SHA-256 `6B9BC482933C056F99F61BDEC90143B14F96E6BD1A14C6EC05E7DB5BF354C1C9`**, 121,547,011 bytes. `latest.yml`: version 2.1.8, path `RUBIS-POS-Setup-2.1.8.exe`, sha512 `ElJSF6fm1YIEzPIaChn3eVfASfDpQTPa583CzMrpw3hH+IsHRMJYMXCMs7K5aMWN4tAtpfYPZ+0wTWT98SONaw==`.

## 3. Publishing

- `npm run dist:publish` created the GitHub **draft** `v2.1.8` (setup, blockmap, portable exe, `latest.yml`). **Before publishing I downloaded the uploaded setup back from GitHub: size and SHA-256 identical to the local build.**
- Published by a `PATCH` of the release (`draft: false`, make latest): HTTP 200, `draft=False`, `published_at 2026-10-03T01:14:10Z`. My first call had a JSON quoting fault and changed nothing; the second took.
- **Public feed read back, unauthenticated:** the release API's latest is `v2.1.8`; `latest.yml` (the file the tills' updater reads) says version 2.1.8 and the sha512 above; the setup downloads with HTTP 200. The first read right after publishing still showed 2.1.5 and the setup 404 for a few seconds, then it settled.
- The superseded **v2.1.7 draft was deleted** (HTTP 204). It was never public.
- The tills' updater will offer 2.1.8 on their next check, including the Haile Selassie till.

## 4. Install on this PC

`RUBIS POS Setup 2.1.8.exe /S`: exit 0 in 12 s, same folder, no uninstall, file version 2.1.8, the Windows entry reads "RUBIS POS 2.1.8", the installed `.env` holds no `GH_TOKEN`. The data fingerprint before and after is **identical** (vault hash `d64bf937939bf270`, orders 2, staff 1, products 714, settings 7 including `repair_212_ran_at` and `last_trader_seq` `23762883`, order 1 unchanged). **The app was not started** after this install.

## 5. Still open

- **The GitHub token is still the exposed one.** It was used again for this release. Its hash is unchanged (`F44157EB25FC`) and GitHub still accepts it (HTTP 200 on the repository). The public v2.1.5 installer still carries it (phase 213-1). **It must be revoked and replaced**; until then anyone who downloaded 2.1.5 could alter the release repository. A new token goes in an environment variable or `.env.secrets.local`, never `.env`.
- **v2.1.5's assets still contain the token** and remain downloadable; replacing or deleting them is the owner's decision. Tills that installed 2.1.5 hold it in their own `resources\.env` until they update.
- **The printer test** (release 2.1.6 section 7) has still not been run on any till; the owner chose to let the Haile Selassie till update regardless.
- **Sales created before 2.1.7 keep a legacy `INV-` trader number** and are expected to be refused by the device again on a retry or resend (phase 210-3 finding 1). **Not changed.**
- **Not verified:** that a till updating from 2.1.5 or earlier through the updater (not a manual install) keeps its data (it has been the case for manual installs over the top only).

## 6. Rollback

Install `RUBIS POS Setup 2.1.7.exe` is not available (2.1.7 was never published); install 2.1.5 or an earlier release over the top, never uninstall. Withdrawing 2.1.8 means setting the GitHub release back to draft or deleting it; tills that already updated keep 2.1.8. `git revert` the two commits to take the code back.
