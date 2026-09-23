# Phase 129 — Item 0 — repair the toolchain

> Skill-structured report, moved from the retired `tracker/2026-09-23-2040-item0-toolchain-repair.md`. Companion: [phase-124](./phase-124.md).

- **Date:** 2026-09-23 20:40
- **Requested:** Restore package.json, prove the toolchain works, commit, and find out what wrote to package.json at 20:03.
- **Outcome:** Implemented
- **Branch / base commit:** staging @ 8871592

## 1. Audit

### What was examined
- `git diff package.json`, which removed all of `scripts` and `devDependencies`.
- File modification times in the repo between 19:50 and 20:10.
- The `package.json` embedded in `release/win-unpacked/resources/app.asar`.
- The session's task output files. The agent ones are empty; the one bash output is read-only.

### How it currently works
n/a. This was a repair of the working copy.

### Dependencies found
- **Inbound:** every npm script (test, typecheck, build, dist, postinstall).
- **Outbound:** none.
- **String-based / indirect:** none.

### Risks and constraints identified
- The damaged file is identical in size and shape to the package.json that electron-builder packages into the app (1,051 bytes, no scripts or devDependencies, no trailing newline).
- No build ran at that time.
- The cause is almost certainly an `asar extract-file` run in the repo root by the fresh-install investigation agent. See docs/phase-124.md.

## 2. Changes made
- `package.json` restored to HEAD with `git checkout`, so there is no diff.
- Added docs/phase-124.md.

## 3. Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| package.json | Restored (identical to HEAD) | All npm scripts and dev tooling |
| docs/phase-124.md | Added | Documentation |

## 4. Possible impact
- **Direct:** npm test, npm run typecheck and npm run dist work again.
- **Indirect:** none.
- **Data / schema / contract:** none.
- **Security posture:** unchanged.
- **Idempotency / re-run safety:** a `git checkout` of a clean file is safe to re-run.
- **Residual risk:** the exact command that caused this cannot be quoted, because the agent transcripts were not kept.

## 5. Verification
- `npm run typecheck`: clean.
- `npm test`: 89 files, 1384 tests, all passing.

## 6. Rollback
Not applicable. The restore returns the file to HEAD.

## 7. Observed but not changed
- The repo root has stray files: `release.zip`, several `release_run*.log` files, `dev_run.log`, `electron_run*.log` and `portable_run.log`. They are left alone.
- No more parallel investigation agents will be run against this repo, as instructed.
