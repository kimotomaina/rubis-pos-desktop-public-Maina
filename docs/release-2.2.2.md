# Release 2.2.2

- **Date:** 2026-10-05
- **Requested:** a new build, committed.
- **Outcome:** version bumped, installer built, committed. **Not installed on this PC, not published, not even as a draft.** The owner publishes (section 4 of [release-2.2.1.md](release-2.2.1.md) applies unchanged, with 2.2.2 in place of 2.2.1).
- **Relation to 2.2.1:** 2.2.1 was built earlier today and, as far as this record knows, not published. 2.2.2 carries everything in it plus phases 221 to 226.
- **Branch / commits:** main, not pushed by me.

```
67ca89d chore: bump version to 2.2.2
a5b46d7 Phase 225-226: Order History list scrolls; fix Z report request shape
```

## 1. What is new since 2.2.1

| Phase | What | Verified on a till |
| --- | --- | --- |
| [222](phase-222.md) to [224](phase-224.md) | Optional M-Pesa opening and closing balances on shifts, shown on the Z report; recording a shift for sales that had none; shift corrections | **no** |
| [225](phase-225.md) | Order History: the list scrolls on its own, title fixed, pagination removed | **no**: layout to be checked on the till (phase-225 section 4) |
| [226](phase-226.md) | Fix: opening a shift's Z report (Shift History, Close Shift) failed with "expected object, received number" | **no** |

## 2. Build and checks

- Before the build: full suite **205 files, 3389 passed, 1 skipped**; typecheck clean.
- `npm run dist`: typecheck, build, `Confirmed: neither mock provider is in out/main.`; `verify-dist` confirmed `win-unpacked/resources/.env` is bundled. `GH_TOKEN` was not set in the build shell.
- The packed `app.asar` reports version 2.2.2.
- **Setup SHA-256 `b9f9f3297ebf3f23a720acca66d452418382474b98cf4d119384808d007dbcc9`**, 121,565,433 bytes (`release/RUBIS POS Setup 2.2.2.exe`). `latest.yml`: version 2.2.2, path `RUBIS-POS-Setup-2.2.2.exe`.
- **Portable exe SHA-256 `89f0a4debfdc97535ee3df89a2ff07f66507ef4c9fd0fb85d6caac57c863abc1`**, 121,342,719 bytes (`release/RUBIS POS 2.2.2.exe`).
- The installers are **unsigned**, as in every earlier build.
- `npm run dist:publish` rebuilds, so published hashes will differ. Publish from one run only.

## 3. Not done

Not installed over the top on this PC; the app was not started; nothing uploaded to GitHub. The installers in `release/` are not committed (the folder is build output).

## 4. Rollback

Install 2.2.1 (or earlier) over the top, never uninstall.
