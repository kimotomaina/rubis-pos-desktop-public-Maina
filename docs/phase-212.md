# Phase 212 — the one-time repair of rows falsely recorded as filed: audit (stopped before the build)

- **Date:** 2026-10-03
- **Requested:** audit first (items 1 and 2), report and stop.
- **Outcome:** audit done, nothing built. The repair slots in cleanly beside an existing startup step. **One recommendation** (run once, not on every start) and one limit are in section 3.
- **Branch / base:** staging on `de5c838`.

## 1. Where migrations run, and whether a sale can precede the repair

- The database is opened and its schema and column migrations run in `db.init()` ([database.ts:1511-1557](../src/main/services/database.ts#L1511-L1557)), called from the main process start-up at [index.ts:502](../src/main/index.ts#L502), inside `app.whenReady`.
- Straight after it, before anything else, the start-up runs two synchronous steps: `runPostUpdateCheck` ([:510](../src/main/index.ts#L510)) and **`db.sweepUnqueuedFiscalOrders()` ([:518](../src/main/index.ts#L518)), a precedent for exactly this kind of repair**: it flags old rows `needs_fixing` for a person, is idempotent by its `WHERE`, writes nothing to the device, and its own comment says it "must run before the fiscal engine starts" ([database.ts:2061-2062](../src/main/services/database.ts#L2061-L2062)).
- The fiscal engine, the sync engine and the IPC handlers (`orders:checkout` among them) are all created **later** in the same callback (the first `ipcMain.handle` calls are at [index.ts:1265](../src/main/index.ts#L1265) and after). All the earlier steps are synchronous, so **no sale can be created, and no engine can tick, before a repair placed next to the sweep has finished.** The proposal: a `db.repairFalselyFiledOrders()` called immediately after the sweep.

## 2. This till's database, against the rule

A fresh copy of this PC's database (`rubis-pos.db`, `-wal`, `-shm` copied to the scratchpad at the time of this audit; the live file was not opened), read with Python's `sqlite3`:

| Check | Result |
| --- | --- |
| Orders in total | **1** |
| Rows matching the full `WHERE` | **1: `local_id` 1**, `fiscalized`, `0110605040000000000`, QR empty, `local-fallback` |
| Rows with **any** one of the conditions (empty QR, `local-fallback`, zero tail) that do not match all | **none** |
| `fiscal_status` values | `fiscalized` × 1 |
| `settings` keys starting `repair` or `last_trader` | none |

So the rule matches exactly the one row phase 209-1 will correct by hand, and nothing near it. **If the 209-1 correction runs first, this repair matches zero rows on this PC**, which is the expected result; if it has not, this repair does the same correction (the rule's reason text differs from the hand-written one).

## 3. Recommendation and limits

- **Run once, guarded by `settings.repair_212_ran_at`, not on every start.** The repair is a standing write path into fiscal columns that the app otherwise treats as write-once. After phase 208 no code path can create such a row, so there is nothing for a second run to find; running every start would only add a permanent way to alter fiscal fields. The instruction's text allows either ("runs once at startup", "idempotent"); I recommend the guard. Log the count and the `local_id`s at info level when it runs.
- **It edits no fiscal reference.** The string it clears is a zero counter the device returned when it held no invoice; the sale was refused (phase 206 section 1f). It keeps `fiscal_cu_serial`, `fiscal_trader_inv_num`, `fiscal_request_json` and the stored request, so the sale stays resendable from Needs Attention under its legacy trader number.
- **The Haile Selassie till's rows cannot be seen from here.** Only that machine's database can show them, and the repair does nothing where no row matches. **Not verified:** that rows exist there.
- **The rule's signature is the recovery branch's own** (`local-fallback`, empty QR, zero-tail number), and phase 208's `isAcceptableCuInvoiceNumber` now refuses such a number at the source, so the rule does not match any row the new build can make. **Not verified:** that no legitimate filing leaves an empty QR with a `local-fallback` time and a number ending in nine zeros; a real `CloseReceipt` reply has never been captured (phase 208-1 section 5).
- **Whether the 16:00 test sales may ever be resent** stays the owner's call, open.

## 4. The build, once approved

`db.repairFalselyFiledOrders()` in `database.ts` (one transaction: the `UPDATE`, its row count and ids, the setting written in the same transaction); one call after the sweep at `index.ts:518`; tests on a real in-memory database: one matching row repaired, one legitimately filed row (device time source and a QR) untouched, one row matching only two of the three conditions untouched, a second run changes nothing and does not run the update at all.

## 5. Rollback

Nothing to roll back: audit only.
