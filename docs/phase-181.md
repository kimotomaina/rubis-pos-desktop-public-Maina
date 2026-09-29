# Phase 181 — Version 2.1.0, and unsigned updates no longer rejected

- **Date:** 2026-09-29
- **Requested:** Build a new version at 2.1.0 (the public `rubis-pos-releases` repo now exists).
- **Outcome:** 2.1.0 built locally and ready to publish. A blocker found during the build check is fixed: every over-the-air update would have been rejected. Not published; publishing needs the release operator's `GH_TOKEN`.
- **Branch / base commit:** staging @ 626d62a (fix: never bundle credentials in the installer's .env (phase 180))

---

## Version bump

`npm version 2.1.0 --no-git-tag-version`, committed as `2da4239 chore: bump to 2.1.0`. It updated `package.json` and `package-lock.json` together. The earlier 2.0.5 bump had edited `package.json` by hand, which left the lockfile at 2.0.4; this bump brings it back in line. 2.0.5 was never published, so no till has it.

## Blocker found: updates rejected as unsigned

Checking the first 2.1.0 build, the update settings baked into the app (`resources/app-update.yml`) contained:

```yaml
publisherName:
  - Volcha Enterprises
```

It comes from `win.signtoolOptions.publisherName` in `electron-builder.yml`. In the installed `electron-updater` 6.8.9 source:

- `NsisUpdater.verifySignature` (`out/NsisUpdater.js:84-90`) skips the check only when `publisherName` is absent.
- If it is present, `windowsExecutableCodeSignatureVerifier.js:56-93` accepts the download only when Windows reports a valid signature (`Status === 0`) whose subject matches. Our installers are unsigned, so it returns a failure string.
- `NsisUpdater.js:52-56` then throws `ERR_UPDATER_INVALID_SIGNATURE`: "New version … is not signed by the application owner".

So every till would have downloaded each update and then refused to install it. The check runs in the app already on the till, using its own `app-update.yml`, so the fix had to be in 2.1.0 itself: that is the build installed by hand, and it has to accept 2.1.1 over the air.

## Change

- **`electron-builder.yml`**: added `win.verifyUpdateCodeSignature: false`, a documented electron-builder option (default `true`, read in `app-builder-lib/out/winPackager.js:27`) with a comment explaining why. When it is `false`, electron-builder leaves `publisherName` out of `app-update.yml`. `signtoolOptions.publisherName` itself is kept, so a future signed build only needs this one line removed.
- **`tests/updateReleaseConfig.test.ts`**: new test asserting the `win:` block contains `verifyUpdateCodeSignature: false`. Its doc comment says to remove the test and the setting together once signing exists.
- **`docs/RELEASING.md`**: section h explains the setting and when to remove it.

Security trade-off: tills no longer check who signed an update. `electron-updater` still verifies the downloaded file against the sha512 in the release's `latest.yml`, so a corrupted or swapped download is rejected. But anyone able to publish to `rubis-pos-releases` controls what tills install. That makes the publishing token the thing to protect: fine-grained, scoped to that repo only, short expiry, and set only in the operator's shell (RELEASING.md step a). Code signing would restore the publisher check and remove the SmartScreen prompt.

## Verification

| Check | Result |
| --- | --- |
| New test | Passes; removing the setting makes it fail (mutation checked, then reverted, `git diff` shows only the intended 4 lines) |
| `npm run dist` (2.1.0, no publish) | Succeeded: `RUBIS POS Setup 2.1.0.exe`, `.blockmap`, `latest.yml` (`version: 2.1.0`), portable `RUBIS POS 2.1.0.exe` |
| Baked `resources/app-update.yml` | `owner: Volcha-Enterprises`, `repo: rubis-pos-releases`, `provider: github`, no `publisherName` |
| Bundled `resources/.env` (redacted) | All six credential keys blank (phase 180 guard passed) |
| `npm run typecheck` | Clean |
| `npx vitest run` | 151 files, 2291 tests, all passing |
| `git diff --stat -- src/ build/` | Empty (no app code or installer script changed) |

## Before publishing (human)

- [ ] **Give `rubis-pos-releases` one commit.** The repo is public but empty (GitHub API: "Git Repository is empty."), and GitHub cannot create a release in an empty repo. Add a README on the repo page saying it holds installers only, no source.
- [ ] In your own shell: `$env:GH_TOKEN = "<paste>"`, then `npm run dist:publish`. Check the draft release, then publish it (RELEASING.md steps c and d).
- [ ] Install 2.1.0 by hand on a spare till first, using the phase-180 checklist for tills coming from 2.0.x.
- [ ] Don't share the older files in `release/`: `RUBIS POS Setup 2.0.4.exe`, `RUBIS POS Setup 2.0.5.exe` and their portable copies were built before phase 180 and contain the old credentials.
- [ ] The real proof is an over-the-air update. Once a till is on 2.1.0, publish 2.1.1 and check that Admin > Check for Updates > Install update and restart lands it, with the carried-over line green (phase 178).

## Rollback

`git revert` the fix commit restores publisher checking, and with it the rejection of every unsigned update. The version bump can stay.
