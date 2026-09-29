# Phase 178 — Admin update flow with a pre-update backup and a carried-over-data check: read-only audit

- **Date:** 2026-09-29
- **Requested:** Part 1 (read-only) audit of the pieces needed for a one-panel Admin update flow with a pre-install SQLite backup and a post-update carried-over-data check. No code changes in this part.
- **Outcome:** Audit complete. STOP for review, per the request — Part 2 not started.
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
