# Phase 212-1 — the one-time repair of sales falsely recorded as filed: built

- **Date:** 2026-10-03
- **Follows:** [phase-212.md](phase-212.md) (the audit), with its recommendation taken: **run once**, guarded by `settings.repair_212_ran_at`.
- **Branch / base:** staging on `eecfb75`.
- **Outcome:** built and tested. Full suite **190 files, 3051 tests, all passing**; typecheck clean; `npm run build` passes with "neither mock provider is in out/main". **Not run against any real database**: the repair has not run on this PC (the app is the old build) and cannot be seen on the Haile Selassie till from here.

## 1. What changed

- **`database.ts`:** `repairFalselyFiledOrders()`, in one transaction: if `repair_212_ran_at` is already set it returns `{ ran: false }` and touches nothing; otherwise it selects the matching `local_id`s, updates exactly those rows, records the time, and returns the ids. A row matches only when **all four** hold: `fiscal_status = 'fiscalized'`, `fiscal_invoice_number LIKE '%000000000'`, an empty or NULL QR, `fiscal_fiscalized_at_source = 'local-fallback'`. A match gets `needs_fixing`, kind `system`, the reason `Recorded as filed in error: the fiscal device refused this sale and no invoice was issued. Corrected automatically on update 2026-10-03. Check before resending.`, and NULL for the invoice number, QR, fiscal time, time source and unprinted-slip flag.
- **It edits no real fiscal reference.** The string it clears is the zero counter the device returned when it held no invoice (phase 206 section 1f); the comment on the method says so. The serial, the trader number and the stored request are kept, so the sale stays resendable from Needs Attention under its own trader number.
- **`index.ts`:** called once, right after `sweepUnqueuedFiscalOrders()` and before the fiscal engine, the sync engine and every IPC handler exist (phase 212 section 1). It logs the count and the `local_id`s at info level when it runs.
- **Nothing is sent to the device or Shopify.** After a repair the sale is in Needs Attention; a Resend would send it to the device again, and with phase 208 in place a refusal cannot be mistaken for a filing. **Whether the 16:00 test sales may ever be resent is still the owner's call, open.**

## 2. Tests (`tests/repairFalselyFiled.test.ts`, 12, real in-memory database)

- One matching row is repaired and exactly the false fiscal fields are cleared; the serial, trader number and stored request are kept.
- A sale the device really filed (device time and a QR) is untouched; so is a sale matching only two of the three conditions (each of the three pairings is a case); so is a matching-looking sale whose status is not `fiscalized`.
- A false sale beside a real one: only the false one is repaired.
- **Run once:** a second call returns `{ ran: false }`, changes nothing, and leaves a matching row created after the first run alone (so it does not even run the update); the timestamp is unchanged.
- It records that it ran even when nothing matched.
- The repaired sale appears in `getOrdersNeedingAttention`.
- **A source pin** that `index.ts` calls the repair after the sweep and before `createFiscalEngine(` and the first `ipcMain.handle(`. `index.ts` needs Electron and cannot run in a unit test; the pin fails if the call is moved.

**Mutation checks (each run, file restored, hash compared):** the `local-fallback` condition dropped, 1 test fails (the "device time" pairing); the run-once guard removed, 2 tests fail.

## 3. On this PC and on the Haile Selassie till

- **This PC:** the copy of the database taken for the audit held one order, and it matched the rule. If the hand correction of phase 209 runs first, the repair matches zero rows and still records that it ran. If not, the repair makes the same correction (the reason text differs from the hand-written one).
- **Haile Selassie:** **Not verified** that rows exist there. Only that machine's database can show them; the repair does nothing where none match.
- **Not verified:** that no legitimate filing leaves an empty QR with a `local-fallback` time and a number ending in nine zeros. A real `CloseReceipt` reply has never been captured, and phase 208's guard now refuses a zero-tail number at the source.

## 4. Rollback

`git revert` the commit. A repair that has already run is not undone: the rows stay `needs_fixing`, which is the true state. `repair_212_ran_at` stays in `settings`, harmless.
