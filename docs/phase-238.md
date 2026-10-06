# Phase 238 — The shift dry run: no app, no fiscalization, no sales, and a proof of it

- **Date:** 2026-10-06
- **Asked by the owner:** "Can you ensure the dry run does not include fiscalization and no sales." The dry run is release-2.2.5 §3 gate 1: see what the first start of a phase-232 build does to the sales that have no shift, before any till gets it.
- **Status:** built and tested; run once for real on a copy of this PC's own till database (§4). Not released (a developer tool, `npm run shift:dry-run`; it ships no code into the app's bundles).
- **Not changed:** `autoAssignUnattachedSales`, the schema, any rule of phase 232, the fiscal engine, the sync engine, the app's start-up.

## 1. Audit: where fiscalization could have crept in

- **The assignment itself** ([database.ts](../src/main/services/database.ts) `autoAssignUnattachedSales`) writes only `shifts` (automatic shifts, `staff_id = 0`), `orders.shift_id`, `shift_adjustments` and `shift_adjustment_sales`, in one `.immediate` transaction. No `sync_queue` row, no fiscal column, no device command, no Shopify call.
- **The risk was the vehicle, not the assignment.** Running the dry run by starting RUBIS POS on a copy of live data also starts the fiscal engine ([index.ts:1132](../src/main/index.ts#L1132)), which retries every unfiled sale against ZFPLabServer and the real control unit; the Shopify sync engine, which pushes queued orders; and the M-Pesa poller. A packaged build cannot be pointed at a mock device (the mock provider is not shipped). So a dry run through the app could file or push for real.
- **The other session's script** (release-2.2.5 §3, "tested on synthetic data only") is not in the repo.

## 2. Change

| File | What |
| --- | --- |
| [src/main/lib/shiftDryRun.ts](../src/main/lib/shiftDryRun.ts) (new) | `prepareWorkingCopy`: refuses any path inside the till's data folder, then copies the given file (and `-wal`, `-shm` when present) into a fresh temp folder, so neither the live database nor the owner's copy is ever written. `fingerprint`: a SHA-256 per table of every row, for every table except the three the assignment may write, and `orders` without `shift_id`. `runShiftDryRun`: fingerprint, `init()`, fingerprint, `autoAssignUnattachedSales(now)`, fingerprint; reports what `init()` migrated and what the assignment changed, `ok` only when the assignment changed nothing protected. Imports only `RubisDatabase` and `better-sqlite3`: no engine, no IPC, no network can start. |
| [scripts/shift-dry-run.ts](../scripts/shift-dry-run.ts) (new), `package.json` `shift:dry-run` | `npm run shift:dry-run -- <path to a copy of rubis-pos.db>`, run by `vite-node` like `mock:zfplab`. Prints the working copy, the clock, one line per shift it would create or join, the waiting count, the schema note, and the proof line; exit 1 on a STOP, 2 on usage, and a plain message (no stack) for a missing or refused path. |
| [tests/shiftDryRun.test.ts](../tests/shiftDryRun.test.ts) (new, 5 tests) | a file database with four no-shift sales (two filed with KRA, one `waiting`, one in the current window) and one sync-queue row: the run creates the Day and Night shifts of 4 Oct in the copy, leaves the current window's sale waiting, changes nothing protected, leaves the owner's copy byte-identical and works under the temp folder; the fiscal columns and the queue read exactly as before; a path inside the live folder is refused with nothing copied; a missing path is refused; the fingerprint sees a fiscal change, a queue row and a product, and ignores `shift_id`; a second run on the same working copy has nothing to do. |

## 3. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `tests/shiftDryRun.test.ts` | 5 passed |
| `npm run shift:dry-run` with no argument | usage, exit 2 |
| with a missing path | `Not found: …`, exit 1 |

## 4. The dry run, for real, on this PC's till copy

RUBIS POS was closed (checked). `rubis-pos.db` (462,848 bytes; no `-wal`/`-shm` beside it) was **copied** from this PC's data folder to `C:\rubis-scratch\dry-run-2026-10-06\`; the live file was only read. Then `npm run shift:dry-run -- C:\rubis-scratch\dry-run-2026-10-06\rubis-pos.db`:

```
Opening the database first brings its schema up to date: held_sales, shift_corrections. That is the same step every start performs; no sale or shift is written by it.
Would create a shift for Night shift, 2026-10-02: 2 sales (shift #1 in the copy).
Checked: nothing outside shifts, orders.shift_id and the shift adjustments changed. No fiscal column, no sync queue row, no payment, no product.
exit 0
```

- The two sales are orders 1 (`2026-10-02T21:37Z`, 00:37 Nairobi on the 3rd, `needs_fixing`, the phase-209 test sale) and 2 (`2026-10-03T00:48Z`, 03:48 Nairobi, `fiscalized`, the phase-210-3 sale). Both fall in the **Night of 2 Oct** under the phase-237 windows. Their fiscal columns are unchanged; `sync_queue` is unchanged.
- The schema note is because this PC's app is an older build whose database has no `held_sales` or `shift_corrections` table yet; the first run of the tool (before the migration/assignment split) flagged them as "changed", which is why the split exists. The owner's copy's SHA-256 was the same before and after.
- **This is this PC's (Rubis Kisumu) data.** The Haile Selassie till's copy has not been run: the owner copies its `rubis-pos.db` (with `-wal` and `-shm` if present, phase 232 §192) with the app closed and runs the same command on this PC, or on that till with the repo present.

## 5. Possible impact

None on any till: a developer tool that only ever writes to a temp folder. It adds one npm script and one file under `src/main/lib/` that the app never imports (`verify-no-mock-provider` and the bundles are unaffected: nothing imports it from `index.ts`).

## 6. Rollback

`git revert` the commit. The temp working copies under `%TEMP%\rubis-shift-dry-run-*` can be deleted at any time.

## 7. Observed but not changed

- This PC's database predates `held_sales` and `shift_corrections`: the installed build here is older than 2.2.x (release-2.1.9 was the last installed). Not a problem for the dry run; noted so nobody reads the schema note as a fault.
- SQLite's own `sqlite_%` tables (`sqlite_sequence`, which AUTOINCREMENT bumps when a shift is created) are left out of the fingerprint on purpose: they hold counters, not rows of the till's data, and every table whose rows matter is covered by name.
