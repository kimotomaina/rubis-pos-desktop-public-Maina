# Verification: Phase 224 shift corrections
Date/time (Nairobi): 2026-10-05, about 15:20 to 15:55
HEAD before / after: d88adb2 / d88adb2 (unchanged)
User's files: everything uncommitted (20 paths: 8 modified source files, 5 modified tests, 7 new files incl. docs/phase-224.md). Full diff: ~/rubis-verify/phase224-full.diff
Editor activity during run: none (user confirmed; git status, HEAD and `git diff` hash identical before and after the integration runs). Run marked unstable: no

## Verdict
RIGHT (logic and tests only; layout NOT verified)
No OWN failures. tests/shiftCorrections.test.ts (24 tests) exercises the new behaviour and passes in both the isolation and integration runs. The renderer layout was not checked: check:fit could not run here.

## Isolation run (baseline d88adb2 + user's diff)
Diff applied cleanly (`git apply --check` ok).
Typecheck: clean.
`npx vitest run` (full suite): 3386 passed / 3388, 204 files. Only failure: updateBackup (BASELINE).
`npx vitest related <13 src files> --run` ran 0 tests (cause not found; result discarded, full run used instead).
tests/shiftCorrections.test.ts: 24/24.

## Integration run (main tree), run twice
Run 1: 3366 passed / 3371 run, 4 failed + lateFiledSlip suite failed to load (17 tests not run). All five labelled ENVIRONMENT (transient), see below.
Run 2: 3386 passed / 3388. Only failure: updateBackup (BASELINE).

## Baseline (clean d88adb2)
Typecheck clean. Full suite: 3336 passed / 3338, 203 files. Failures: updateBackup (BASELINE); orderSlips failed to load with "Electron failed to install correctly" but passes 26/26 alone, twice (ENVIRONMENT, transient).
Count check: 3338 + 26 (orderSlips) + 24 (new) = 3388.

## UI run
`npm run build` (baseline): ok, mock-provider guard passed.
`CHECK_FIT_DEBUG=1 npm run check:fit` (clean baseline): crashed before measuring. `Error: setTypeOfService EINVAL` from node:net/undici under Node v24.20.0 on darwin. ENVIRONMENT.
Not retried, not run with the diff applied (it would hit the same crash). No baseline numbers to compare with the Windows record (274 fit / 9 known failures).
Also: no ~/Library/Application Support/rubis-pos-desktop on this Mac, so check:fit would launch unconfigured, so its counts would differ from the Windows record even when it runs.

## Failures
| Test | Label | Evidence | Note |
| --- | --- | --- | --- |
| tests/updateBackup.test.ts "runPreInstallSteps retention: keeps the newest 5 backups..." | BASELINE | Fails on clean d88adb2 and in every run | Known Windows path-separator failure |
| tests/orderSlips.test.ts (suite load) | ENVIRONMENT | Clean baseline, no diff; passes 26/26 alone twice | "Electron failed to install correctly" |
| tests/adminStoreDetails.test.ts "lays the six fields out two to a row, three rows" | ENVIRONMENT | Integration run 1 only; passes alone twice; passes in run 2 and isolation run | Imports no changed file |
| tests/mpesaLogsPagination.test.ts "shows exactly 10 transactions per page" | ENVIRONMENT | Same pattern | Type-only import of database.ts |
| tests/pasteAndReveal.test.ts "hold to show a secret hides when the window loses focus mid-hold" | ENVIRONMENT | Same pattern | Imports no changed file |
| tests/lateFiledSlip.test.ts (suite load) | ENVIRONMENT (judgement) | Same "Electron failed to install correctly" error as orderSlips on the clean baseline; passes 17/17 alone twice and in run 2 | It imports database.ts, a changed file, so the OWN rule applies on its face. Inference: transient, because the identical error occurred with no diff applied and it never reproduced. Not verified beyond that. |

## Not verified
- Z report modal layout on a till at the smallest size (check:fit crashed; phase-224.md already says layout is for the owner to check).
- The "Correct figures" flow in the running app (no live launch allowed).
- `related` returning 0 tests: cause not found.
- .env: file does not exist on this Mac (only .env.example), so VITE_USE_MOCK_ETIMS, VITE_MOCK_PRINTER and the Shopify target are unconfirmed.
- Printed Z report output on a real printer.
- The doc's real-SQLite check (section 5): I did not repeat it; I only ran the test suite.

## Side findings (not Phase 224)
- `npm ci` fails at HEAD d88adb2: package-lock.json is out of sync with package.json (missing electron-builder-squirrel-windows and its dependencies). package.json and package-lock.json are not in the Phase 224 diff. Worked around by cloning the main tree's node_modules into the baseline (cp -Rc); no npm install run.
- Under full-suite load, 1 to 5 tests fail transiently (Electron load error, jsdom layout/timing). Seen on the clean baseline too.

## Commands actually run (in order)
node --version; git rev-parse/status/diff snapshots; sed/grep of scripts/check-fit.mjs; git worktree add --detach ../rubis-pos-baseline HEAD; git apply --check; npm ci (failed, lockfile); cp -Rc node_modules; npm run typecheck (baseline); npx vitest run (baseline, json); git apply diff; npm run typecheck; npx vitest related ... (0 tests); npx vitest run (baseline+diff, json); git checkout -- . && git clean -fd (baseline only); orderSlips x2; npx vitest run (main, json, x2); 4-file rerun x2; npm run build (baseline); npm run check:fit (baseline; first attempt failed on missing `timeout` command, second crashed on EINVAL); kill of my own orphaned app PIDs 55785 and 55794 (SIGKILL on 55785); rm of my two check-fit scratch folders in $TMPDIR.
