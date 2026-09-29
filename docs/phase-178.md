# Phase 178 — Admin update flow with a pre-update backup and a carried-over-data check: read-only audit

- **Date:** 2026-09-29
- **Requested:** Part 1 (read-only) audit of the pieces needed for a one-panel Admin update flow with a pre-install SQLite backup and a post-update carried-over-data check. Part 2: build it, adjusted per review (step 2a dropped, Admin gets its own `onUpdateStatus` subscription, `updater:install` becomes async, three new count methods, post-update check on app ready).
- **Outcome:** Part 1 audit complete, reviewed with adjustments. Part 2 implemented.
- **Branch / base commit:** staging @ f272c7e (feat: OTA updates via a public releases-only GitHub repo (phase 177))

---

## 1. Admin > App & Updates today, and how `updater:status` reaches the renderer

`src/renderer/src/components/AdminScreen.tsx:2343-2348` (the section named in docs/phase-177.md Part 1 item 5, now extended by phase 177's own Part 2):

```tsx
{/* App & Updates */}
<section className="rounded-xl border border-slate-200 bg-white p-4">
  <h3 className="mb-3 text-base font-semibold text-slate-800">App &amp; Updates</h3>
  {installedVersion && (
    <p className="mb-3 text-base text-slate-500">Installed version: {installedVersion}</p>
  )}
  <button
    type="button"
    disabled={checkingForUpdates}
    onClick={() => void handleCheckForUpdates()}
    ...
  >
    {checkingForUpdates ? 'Checking…' : 'Check for Updates'}
  </button>
  {updateCheckMessage && (
    <p className="mt-2 text-base text-slate-500">{updateCheckMessage}</p>
  )}
</section>
```

Today it renders exactly three things: the installed version (phase 177, read once on mount via `window.api.getAppVersion()`), the "Check for Updates" button (`handleCheckForUpdates`, [AdminScreen.tsx:1068-1078](../src/renderer/src/components/AdminScreen.tsx#L1068-L1078), which calls `window.api.checkForUpdates()` and sets a one-shot message — `"Checking — you'll see a toast if an update is found."` or the error text), and that message. Nothing here reads `download-progress`/`update-downloaded` — this section has no subscription to `updater:status` at all.

**`updater:status` reaches the renderer only through `UpdateToast.tsx`** ([UpdateToast.tsx:31-37](../src/renderer/src/components/UpdateToast.tsx#L31-L37)):

```tsx
useEffect(() => {
  return window.api.onUpdateStatus((next) => {
    if (next.kind === 'downloading' || next.kind === 'downloaded') {
      setStatus(next)
    }
  })
}, [])
```

It is deliberately silent for `checking`/`not-available`/`error` (its own doc comment: "never distracts a cashier mid-sale") and only ever holds a `downloading` or `downloaded` status. On `downloaded` it shows a toast with a "Restart & Install" button that calls `window.api.installUpdate()` ([UpdateToast.tsx:39-42](../src/renderer/src/components/UpdateToast.tsx#L39-L42)). `AdminScreen` itself never subscribes to `onUpdateStatus` — it has no live download-progress or "ready" state today; Part 2 item 1 asks for exactly that subscription to be added to the Admin panel.

**`UpdateStatus` union** ([src/main/services/updater.ts:22-28](../src/main/services/updater.ts#L22-L28)), six members:

```ts
export type UpdateStatus =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'not-available' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }
```

The wiring path: `initAutoUpdater` registers `electron-updater`'s six events and translates each into one of these ([updater.ts:38-67](../src/main/services/updater.ts#L38-L67)) → `main/index.ts:3384` broadcasts every status to every window as `updater:status` → preload's `onUpdateStatus` ([preload/index.ts:583-588](../src/preload/index.ts#L583-L588)) relays it to any renderer subscriber.

## 2. `src/main/index.ts` `updater:install` handler

[src/main/index.ts:3398-3401](../src/main/index.ts#L3398-L3401), in full:

```ts
ipcMain.handle('updater:install', (): ServiceResult<void> => {
  autoUpdater.quitAndInstall()
  return { success: true }
})
```

Confirmed: nothing runs before `quitAndInstall()`. The handler is synchronous, takes no arguments, performs no check, and returns `{ success: true }` unconditionally (the return value is not even meaningful — `quitAndInstall()` starts tearing the app down immediately). This is the exact insertion point for Part 2 item 2's pre-install steps (a), (b), (c), (d), all of which must complete, in order, before this call.

## 3. Database file: path, journal mode, connection count

- **Path and filename** — [src/main/index.ts:480](../src/main/index.ts#L480): `const dbPath = join(app.getPath('userData'), 'rubis-pos.db')`. On Windows this resolves to `%APPDATA%\rubis-pos-desktop\rubis-pos.db` (electron's default `userData` for `appId: com.volcha.rubispos` / `productName: RUBIS POS`, unpacked to the folder named after `productName`'s slug, matching phase-177's `installer.nsh` reference to `$APPDATA\rubis-pos-desktop`).
- **Journal mode** — WAL. [database.ts:1267](../src/main/services/database.ts#L1267): `connection.pragma('journal_mode = WAL')`, immediately followed by `connection.pragma('synchronous = NORMAL')` ([database.ts:1268](../src/main/services/database.ts#L1268)). WAL means a straight file copy of `rubis-pos.db` alone can miss committed-but-not-checkpointed data still sitting in the `-wal` file — `better-sqlite3`'s own `db.backup()` (Part 2 item 2b) is exactly the mechanism built to handle this correctly (it uses SQLite's online backup API, which reads through WAL), unlike a plain `fs.copyFile`.
- **Connection count** — exactly one. `DatabaseService`'s constructor stores `dbPath` ([database.ts:1255](../src/main/services/database.ts#L1255)) and `init()` opens the only connection in the whole class: `const connection = new this.factory(this.dbPath)` ([database.ts:1266](../src/main/services/database.ts#L1266)), guarded by `if (this.connection) return` so a second `init()` call is a no-op. Grepped the whole `src/main` tree for another `new` call against the `better-sqlite3` factory or a second `DatabaseService` construction — [src/main/index.ts:481](../src/main/index.ts#L481) (`const db = createDatabase({ dbPath })`) is the only instantiation anywhere. One connection, one process, matches `db.backup()`'s requirement of being called against the live connection that owns the file.

## 4. Cheapest queries for the four carry-over counts

| Count | Existing helper? | Cheapest query |
| --- | --- | --- |
| Total orders | None | `SELECT COUNT(*) as count FROM orders` |
| Orders not yet pushed to Shopify | None | `SELECT COUNT(*) as count FROM orders WHERE status IN ('pending_sync', 'failed')` — matches the status set `getReconciliationCandidates` already treats as "not yet confirmed in Shopify" ([database.ts:2157-2161](../src/main/services/database.ts#L2157-L2161)); `voided` is correctly excluded since a voided sale is never meant to reach Shopify |
| Unfiled fiscal sales | **`getUnfiledOrderCount()`** ([database.ts:2145-2152](../src/main/services/database.ts#L2145-L2152)) | Already exists: `SELECT COUNT(*) as count FROM orders WHERE fiscal_status IN ('waiting', 'needs_fixing') AND status != 'voided'` — this is the same "Rule-3 safety-net number" the codebase already treats as canonical |
| `mpesa_payments` rows | None | `SELECT COUNT(*) as count FROM mpesa_payments` |

`OrderStatus` is `'pending_sync' | 'synced' | 'failed' | 'voided'` ([database.ts:23](../src/main/services/database.ts#L23)), confirming the "not yet pushed" set above is exhaustive against every non-`synced`, non-`voided` value.

Three of the four counts need a new one-line method on `DatabaseService` (total orders, not-pushed, mpesa rows); `getUnfiledOrderCount()` can be reused as-is.

## 5. Settings store, for a `pendingUpdateCheck` record

[database.ts:2069-2086](../src/main/services/database.ts#L2069-L2086):

```ts
getSetting(key: string): string | undefined {
  const row = this.conn.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

setSetting(key: string, value: string): void {
  this.conn.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}
```

Backed by `CREATE TABLE IF NOT EXISTS settings` ([database.ts:593](../src/main/services/database.ts#L593), a plain `key TEXT PRIMARY KEY, value TEXT` shape — read the schema for the exact columns before Part 2 writes to it). Both methods store/return a raw string; every existing caller that keeps a structured value under one key does its own `JSON.stringify`/`JSON.parse` around `setSetting`/`getSetting` (the pattern Part 2 items 2c and 3 will need for `pendingUpdateCheck`/`lastUpdateResult`, since the store itself has no notion of JSON).

## 6. A main-process "sale/fiscal call mid-flight" flag

**None exists.** Grepped `src/main` for lock/mutex/busy/processing/in-flight state around checkout and the fiscal queue: `checkout.ts` has no module-level or instance flag of this kind anywhere in the file — every `runCheckout` invocation runs independently with no guard against a second concurrent call. The only "in-flight" flags in the codebase are unrelated single-purpose promise caches — `connectivityMonitor.ts`'s `inFlight` (dedupes concurrent connectivity pings, [connectivityMonitor.ts:92-116](../src/main/services/connectivityMonitor.ts#L92-L116)) and `mpesa-sms-inbox.ts`'s `inFlight` (dedupes concurrent SMS poll runs, [mpesa-sms-inbox.ts:199-317](../src/main/services/mpesa-sms-inbox.ts#L199-L317)) — neither tracks checkout or fiscal submission state. There is no dedicated fiscal-queue-worker module (searched for `*queue*worker*`/`processQueue`/`isSyncing` project-wide; none found) — the fiscal queue is drained by whatever mechanism `checkFit.ts`'s background senders and the queue-processing calls in `checkout.ts`/`index.ts` already run, none of which expose a readable "busy" state to `updater:install`.

**Consequence for Part 2 item 2a:** per the request, since no such flag exists, that step is skipped — no flag will be invented. The backup (2b) and settings record (2c) still happen unconditionally before `quitAndInstall()`; the request's stated goals ("never lose an unfiled sale," "never block the till") are met by the backup step itself (a WAL-safe snapshot taken immediately before the install) rather than by refusing to install during a checkout, since there is nothing in the current codebase that can detect that condition.

---

## Summary of findings shaping Part 2

1. `AdminScreen`'s "App & Updates" section has no `onUpdateStatus` subscription today — download progress and "ready to install" only ever reach `UpdateToast`. Part 2 item 1 needs a second subscription (or a shared source of truth) added to the Admin panel.
2. `updater:install` is a two-line, unconditional handler — the whole ordering the request asks for (refuse-if-busy → backup → settings record → retention → `quitAndInstall()`) is new code, not a reordering of existing steps.
3. The database is single-connection, WAL-mode, at a well-known `userData` path — `db.backup()` is the correct mechanism (not a file copy) and there's no second connection to coordinate with.
4. Three of the four carry-over counts need a new `DatabaseService` method each; `getUnfiledOrderCount()` already exists and should be reused.
5. `settings` is a plain string key/value store — `pendingUpdateCheck`/`lastUpdateResult` must be JSON-stringified by the caller, same as every other structured value already kept there.
6. No mid-flight/busy flag exists anywhere in the main process. Part 2 item 2a is skipped per the request's own instruction, not invented.

Nothing else audited above blocks Part 2 as scoped in the request.

**STOP — awaiting review before Part 2.**

---

## Part 2 — Build

Reviewed and adjusted before this part started:

- **Step 2a dropped**, not invented. Reasoning recorded in the code comment (`updateBackup.ts`): the Install button exists only on the Admin screen, and a till has one screen, so nobody can be completing a sale on this till while an admin is pressing Install; the backup covers the rest.
- **Admin gets its own `onUpdateStatus` subscription** — the same shape as `UpdateToast.tsx:31-37`, but keeping every status kind (the toast deliberately drops `checking`/`not-available`/`error`; the Admin panel needs exactly those to show "Up to date" and error text). No shared store — two independent subscribers to the one `updater:status` broadcast.
- **`updater:install` is now async**, ordered: `db.backup()` awaited → `setSetting('pendingUpdateCheck', ...)` → retention → `quitAndInstall()`. A failing backup returns the failure and never calls `quitAndInstall()`.
- **Three new one-line `RubisDatabase` methods** (`getTotalOrderCount`, `getUnpushedOrderCount`, `getMpesaPaymentCount`) plus reuse of `getUnfiledOrderCount()`. No other schema/query change.
- **Post-update check runs once on app ready**, right after `db.init()` and before `createWindow()`, so Admin can show the result on the very first open.
- **Backups folder is `userData/backups`** — noted in `docs/RELEASING.md` in one line: it survives an update (the phase-177 NSIS guard) and is deleted on a real uninstall like everything else under `userData`.

### Changes made

1. **`src/main/services/database.ts`** — added `getTotalOrderCount()`, `getUnpushedOrderCount()` (`status IN ('pending_sync', 'failed')`), `getMpesaPaymentCount()`, `deleteSetting(key)` (a plain `DELETE FROM settings WHERE key = ?`, the missing counterpart to `getSetting`/`setSetting`), and `backup(destPath): Promise<void>` (a one-line `await this.conn.backup(destPath)` over better-sqlite3's own online-backup API, confirmed by direct call in a real in-memory-to-real-file test, not assumed).

2. **`src/main/services/updateBackup.ts`** (new) — all of phase 178's decision logic, DI'd against narrow interfaces (`CarryOverCountable`, `UpdateBackupDatabase`) the same way `updater.ts` DI's `AutoUpdaterLike`, so every rule here runs in a unit test with no `fs`/Electron touched:
   - `readCarryOverCounts`, `backupFileName` (Windows-safe — colons/dots replaced, still sorts chronologically), `backupsToPrune` (pure; keeps the newest `BACKUP_RETENTION_COUNT = 5`).
   - `runPreInstallSteps` — backup, write `pendingUpdateCheck`, prune. Returns `{ success: false, error }` without writing anything if the backup throws.
   - `installUpdate` — wraps `runPreInstallSteps` and calls the injected `quitAndInstall` only on success. Pulled out as its own function (rather than inlined in the IPC handler) specifically so the ordering guarantee is unit-tested directly, not just implied by an `await` in `index.ts`.
   - `runPostUpdateCheck` — resolves a `pendingUpdateCheck` left by a prior install: version now matches `toVersion` → compares counts, stores `lastUpdateResult`, clears `pendingUpdateCheck`; version still matches `fromVersion` (install never happened) → clears `pendingUpdateCheck`, stores nothing; matches neither → left as-is (not guessed at — this case isn't in the brief).
   - `ok` is `after.X >= before.X` for all four counts — a sale made between restart and the admin opening the screen can only add, never subtract.

3. **`src/main/index.ts`**:
   - Added `mkdirSync`/`readdirSync`/`unlinkSync` to the existing `node:fs` import.
   - `runPostUpdateCheck({ db, installedVersion: app.getVersion() })` called immediately after `db.init()`, before anything else in the startup sequence (`createWindow()` is still ~3200 lines further down the same `app.whenReady().then(...)` block).
   - A module-scoped `downloadedVersion` variable, set inside the existing `initAutoUpdater` status callback when `status.kind === 'downloaded'` — `electron-updater` has no "give me the last downloaded version" getter, so this is the only way `updater:install` can learn the backup's `toVersion`.
   - `updater:install` rewritten as thin glue: refuses with `'No update ready to install.'` if `downloadedVersion` is unset, otherwise calls `installUpdate({ db, backupsDir, fromVersion: app.getVersion(), toVersion: downloadedVersion, ...fs deps, quitAndInstall })` and returns its result.
   - New `updater:last-result` handler reads `lastUpdateResult` from settings for the renderer.

4. **`src/preload/index.ts` / `src/preload/window.d.ts`** — added `getLastUpdateResult(): Promise<ServiceResult<LastUpdateResult | null>>`. No other IPC surface changed; `checkForUpdates`/`installUpdate`/`onUpdateStatus` keep their existing signatures.

5. **`src/renderer/src/components/AdminScreen.tsx`** — App & Updates is now the four-line panel plus the carried-over result line:
   - Line 1: installed version (unchanged from phase 177).
   - Line 2: "Check for Updates" button + result text, now derived from the live `updateStatus` (`updateResultText`: `'Up to date'` for `not-available`, `` `Version ${version} is ready to install` `` for `downloaded`, the error message for `error`, `null` — nothing shown — for `checking`/`available`/`downloading`, since the button's own label and line 3 already cover those). The old one-shot `updateCheckMessage` now only ever holds a failure from the `checkForUpdates()` call itself (the trigger, not the outcome).
   - Line 3: `"Downloading update… {percent}%"`, shown only while `updateStatus.kind === 'downloading'`.
   - Line 4: "Install update and restart" button, `disabled` unless `updateStatus?.kind === 'downloaded'`; `handleInstallUpdate` calls `window.api.installUpdate()` and shows the returned error text (e.g. a failed backup) if it refuses.
   - `lastUpdateResult` line, fetched once on mount via `getLastUpdateResult()`: `` `Updated ${from} to ${to} on ${date}. Sales carried over: ${after.orders} of ${before.orders}. Backup: ${path}.` ``, in `text-rose-600 font-medium` when `!ok`.

6. **`docs/RELEASING.md`** — one line added noting the backups folder lives at `userData/backups`, survives an update (phase-177's guard), and is wiped on a real uninstall along with everything else under `userData`.

7. **Tests** — see the table below.

### Tests

| File | Assertions |
| --- | --- |
| `tests/updateBackup.test.ts` (new) | `readCarryOverCounts` reads all four counts · `backupFileName` is Windows-safe (no colon) · `backupsToPrune` keeps the newest 5 / returns `[]` under the limit · `runPreInstallSteps`: awaits backup before `setSetting` (ordering asserted via a call-log fake); a failing backup returns `{success:false,error}` and never writes `pendingUpdateCheck`; records the exact counts/versions/path/`takenAt`; retention deletes the oldest of 6 · `installUpdate`: calls `quitAndInstall` only after backup+settings resolve (ordering asserted); never calls it when the backup fails · `runPostUpdateCheck`: no `pendingUpdateCheck` → `null`, no-op; equal counts → `ok:true`, result stored, pending cleared; a lower count → `ok:false` with the differing before/after numbers; version still `fromVersion` → pending cleared, nothing stored; version matches neither → left as-is |
| `tests/databaseUpdateBackup.test.ts` (new) | Against a **real** in-memory `RubisDatabase` (`reportsDatabase.test.ts`'s own pattern): `getTotalOrderCount`, `getUnpushedOrderCount` (pending_sync/failed only, not synced/voided), `getMpesaPaymentCount`, `getUnfiledOrderCount` (unchanged behaviour) · `deleteSetting` removes a key, no-ops on a missing one · `backup()` writes a real file a fresh `better-sqlite3` connection can open, with the same row count |
| `tests/adminScreen.test.ts` | Install button: disabled with no status, disabled while downloading, enabled once `downloaded` (and shows "Version x.y.z is ready to install") · shows "Up to date" on `not-available` · clicking Install calls `installUpdate()` and shows the returned error text on refusal · `lastUpdateResult` line: renders for `ok:true` and `ok:false` (red, differing numbers), renders nothing when absent · `stubApi()` extended with `installUpdate`/`onUpdateStatus`/`getLastUpdateResult` (every existing test in the file needed these once the new mount effects were unconditional) |
| `tests/adminIntegrationsSections.test.ts` | Stub-only fix — same three additions to its own separate `stubApi()`, no behavioural change to this file's own assertions |

### Mutation checks (each applied, verified, then reverted)

| # | Mutation | Result |
| --- | --- | --- |
| i | `installUpdate` calls `quitAndInstall()` before `await runPreInstallSteps(...)` | Both `installUpdate` tests in `updateBackup.test.ts` failed as expected (ordering assertion, and "never calls quitAndInstall when backup fails") |
| ii | Removed the `installedVersion !== pending.toVersion` guard from `runPostUpdateCheck` | The "version matches neither" test in `updateBackup.test.ts` failed as expected — it started returning a stored result instead of `null` |
| iii | `AdminScreen.tsx`'s Install button changed to `disabled={false}` | Both "disabled with no status" and "stays disabled while downloading" tests in `adminScreen.test.ts` failed as expected |

`git diff --stat src/main/services/updateBackup.ts src/renderer/src/components/AdminScreen.tsx` (`updateBackup.ts` re-run through the full suite, since it's a new untracked file `git diff` can't show) confirmed all three reverts left only the intended permanent code.

### Tripwires

`git diff --stat` was empty for all ten files: `checkout.ts`, `fiscal-engine.ts`, `fiscal-routing.ts`, `real-etims-provider.ts`, `reports.ts`, `receiptLayout.ts`, `PosCheckoutPanel.tsx`, `CardEntryPanel.tsx`, `build/installer.nsh`, `electron-builder.yml`.

### Verification

- `npm run typecheck` (node + web) — clean.
- `npx vitest run` — **150 files, 2277 tests, all passing** (22 new: 15 in `updateBackup.test.ts`, 7 in `databaseUpdateBackup.test.ts`, plus the extended assertions in `adminScreen.test.ts`).
- `npx electron-vite build` — succeeded (main/preload/renderer all built).
- `npm run check:fit` — **283 fit, 0 skipped, 9 failed.** Identical to the phase-176 baseline (`docs/phase-176.md` §4: 283 fit, 9 failed) — same count, same failure (`Admin > Needs Attention: card not found`, a pre-existing, unrelated condition on that card's seeded/copied app state that `check-fit.mjs` doesn't control). The Admin card grid census (top-level `SectionCardGrid`) is unaffected by this phase — "App & Updates" is a section inside the existing `Overview` tab, not a top-level card, and `Admin > Overview` itself still fits (✔ at every size in the run). No new failure, no fixed failure.
- `release/` and `out/` both stayed ignored/untracked after the `electron-vite build` and `dist:dir` runs earlier — confirmed with `git status --short --ignored`.

### Affected files and functionality

| File | Change | Functionality affected |
| --- | --- | --- |
| `src/main/services/database.ts` | Modified | Four new/reused count methods, `deleteSetting`, `backup()` |
| `src/main/services/updateBackup.ts` | Added | All pre-install/post-update decision logic |
| `src/main/index.ts` | Modified | Post-update check on app ready; `updater:install` rewritten async; new `updater:last-result` handler |
| `src/preload/index.ts`, `src/preload/window.d.ts` | Modified | New `getLastUpdateResult` on `window.api` |
| `src/renderer/src/components/AdminScreen.tsx` | Modified | App & Updates is now the four-line live panel plus the carried-over result line |
| `docs/RELEASING.md` | Modified | One-line note on the backups folder |
| `tests/updateBackup.test.ts`, `tests/databaseUpdateBackup.test.ts` | Added | Unit + real-SQLite coverage for everything above |
| `tests/adminScreen.test.ts`, `tests/adminIntegrationsSections.test.ts` | Modified | New Admin panel coverage; stub fixes for the new mount effects |

### Possible impact

- **Direct:** the first update built from this phase backs up `rubis-pos.db` to `userData/backups` before installing, records a before/after comparison, and shows it in Admin. Admin's update panel now shows live progress and an explicit install step instead of relying solely on the toast.
- **Indirect:** none identified outside the update path — no other IPC channel, store, or schema changed.
- **Data / schema / contract:** two new `settings` keys (`pendingUpdateCheck`, `lastUpdateResult`), both JSON strings, both optional/absent on any till that hasn't gone through this flow yet. No table/column change.
- **Security posture:** unchanged. Backup files are plain SQLite copies of data already on the till's disk (no new secret surface); nothing is logged.
- **Idempotency / re-run safety:** `runPreInstallSteps` is safe to re-run — a second install attempt takes a new timestamped backup and overwrites `pendingUpdateCheck` with fresh counts; retention still holds at 5. `runPostUpdateCheck` is a no-op on every launch that isn't resolving a specific pending record, and resolves each one exactly once (it's cleared either way).
- **Residual risk:** identical to phase 177's — a till on 2.0.x needs the first phase-177+178 build installed by hand once before any of this applies. The spare-till proof below is the only way to confirm the backup/restore/carry-over loop works against a real Windows install, real WAL file, and real restart — nothing in this suite substitutes for that.

### Rollback

`git revert` of the Part 2 commit. `userData/backups` on any till that already ran an install stays on disk (nothing in this phase deletes it on revert) — harmless, and useful if a rollback is itself needed.

### What only a human can check

- [ ] Set up a till on 2.0.5 with N real sales and one queued-unpushed order, the fiscal device password saved. Publish 2.0.6 containing this phase.
- [ ] Admin > Check for Updates > wait for "Version 2.0.6 is ready to install" > Install update and restart.
- [ ] After restart: Admin shows "Installed version: 2.0.6", the green carried-over line, `userData\backups` contains the new `.sqlite` file, the queued order pushes once online, and the fiscal device password is still present (Test Connection passes).

### Observed but not changed

- `runPostUpdateCheck`'s "version matches neither `fromVersion` nor `toVersion`" case (e.g. someone manually reinstalls a third version between the backup and the next launch) leaves `pendingUpdateCheck` in place indefinitely rather than clearing it — not in the brief's two named cases, so nothing was guessed here. If this ever needs handling, it's a follow-up decision, not an oversight.
- The install button's disabled state depends only on `updateStatus.kind === 'downloaded'` from the live subscription; it does not separately track "was this same download session already installed." Restarting mid-download and reopening Admin before a fresh `downloaded` event arrives would show the button disabled again, which is the safe default (matches "never invent a flag" from step 2a's reasoning) — not a regression, just noted as the natural consequence of no persisted "ready" state.

