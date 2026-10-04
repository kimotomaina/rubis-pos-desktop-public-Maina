/**
 * Pre-update backup and carried-over-data check (docs/phase-178).
 *
 * Pure decision logic lives here, DI'd against narrow interfaces (the
 * `AutoUpdaterLike` pattern `updater.ts` already uses) so it runs against
 * a real in-memory `RubisDatabase` in tests without touching `fs` or
 * Electron. `main/index.ts` supplies the real database and `node:fs`
 * functions.
 */

import { join } from 'node:path'

/** The four counts phase 178 proves didn't shrink across an update. */
export interface CarryOverCounts {
  orders: number
  unpushed: number
  unfiled: number
  mpesaPayments: number
}

/** Written to `settings` immediately before `quitAndInstall()`; read back on the next launch. */
export interface PendingUpdateCheck extends CarryOverCounts {
  fromVersion: string
  toVersion: string
  backupPath: string
  takenAt: string
}

/** Written to `settings` once the post-update check resolves a `PendingUpdateCheck`. */
export interface LastUpdateResult {
  ok: boolean
  fromVersion: string
  toVersion: string
  before: CarryOverCounts
  after: CarryOverCounts
  backupPath: string
  checkedAt: string
}

export const PENDING_UPDATE_CHECK_KEY = 'pendingUpdateCheck'
export const LAST_UPDATE_RESULT_KEY = 'lastUpdateResult'

/** How many pre-update backups to keep under `userData/backups` (docs/phase-178 item 2d). */
export const BACKUP_RETENTION_COUNT = 5

/** The subset of `RubisDatabase` the four carry-over counts need. */
export interface CarryOverCountable {
  getTotalOrderCount(): number
  getUnpushedOrderCount(): number
  getUnfiledOrderCount(): number
  getMpesaPaymentCount(): number
}

/** The subset of `RubisDatabase` this module depends on. */
export interface UpdateBackupDatabase extends CarryOverCountable {
  backup(destPath: string): Promise<void>
  getSetting(key: string): string | undefined
  setSetting(key: string, value: string): void
  deleteSetting(key: string): void
}

/**
 * @param {CarryOverCountable} db
 * @returns {CarryOverCounts}
 */
export function readCarryOverCounts(db: CarryOverCountable): CarryOverCounts {
  return {
    orders: db.getTotalOrderCount(),
    unpushed: db.getUnpushedOrderCount(),
    unfiled: db.getUnfiledOrderCount(),
    mpesaPayments: db.getMpesaPaymentCount()
  }
}

/**
 * Sortable, Windows-safe filename for a pre-update backup — colons and
 * dots in an ISO timestamp are illegal in a Windows path, so both are
 * replaced with `-`; the result still sorts chronologically as a plain
 * string, which {@link backupsToPrune} relies on.
 *
 * @param {string} fromVersion
 * @param {string} toVersion
 * @param {Date} takenAt
 * @returns {string}
 */
export function backupFileName(fromVersion: string, toVersion: string, takenAt: Date): string {
  const stamp = takenAt.toISOString().replace(/[:.]/g, '-')
  return `pre-update-${fromVersion}-to-${toVersion}-${stamp}.sqlite`
}

/**
 * Which of the given backup filenames are beyond the newest `keep` and
 * should be deleted. Pure — sorts by name (which sorts chronologically,
 * per {@link backupFileName}'s timestamp suffix) and returns everything
 * before the last `keep` entries.
 *
 * @param {string[]} filenames
 * @param {number} [keep]
 * @returns {string[]}
 */
export function backupsToPrune(
  filenames: string[],
  keep: number = BACKUP_RETENTION_COUNT
): string[] {
  return [...filenames].sort().slice(0, Math.max(0, filenames.length - keep))
}

/** `node:fs` functions {@link runPreInstallSteps} needs, injected so tests never touch a real disk. */
export interface PreInstallFsDeps {
  ensureDir: (dir: string) => void
  listBackups: (dir: string) => string[]
  deleteBackup: (path: string) => void
}

export interface PreInstallParams extends PreInstallFsDeps {
  db: UpdateBackupDatabase
  backupsDir: string
  fromVersion: string
  toVersion: string
  /** Defaults to `() => new Date()` — overridable so tests get a fixed timestamp. */
  now?: () => Date
}

export type PreInstallResult =
  | { success: true; backupPath: string }
  | { success: false; error: string }

/**
 * Phase 178's pre-install sequence, run from the `updater:install` IPC
 * handler before `quitAndInstall()`: back up the live database, record
 * the before-counts under `pendingUpdateCheck`, then prune old backups.
 *
 * The original brief's step 2a (refuse if a sale/fiscal call is
 * mid-flight) was dropped in phase 178 on the ground that the Install
 * button lived only on the Admin screen. That no longer holds: since
 * docs/phase-219 the update prompt is on the sale screen. The prompt
 * refuses while the cart has items, a payment is in progress or a sale
 * is being completed, and `installWhenQuiet` (`updateInstall.ts`) holds
 * the background engines still before this runs.
 *
 * If the backup throws, the function returns before writing
 * `pendingUpdateCheck` or pruning anything, and the caller must not call
 * `quitAndInstall()`.
 *
 * @param {PreInstallParams} params
 * @returns {Promise<PreInstallResult>}
 */
export async function runPreInstallSteps(params: PreInstallParams): Promise<PreInstallResult> {
  const { db, backupsDir, fromVersion, toVersion, ensureDir, listBackups, deleteBackup } = params
  const now = params.now ?? ((): Date => new Date())

  ensureDir(backupsDir)
  const takenAt = now()
  const backupPath = join(backupsDir, backupFileName(fromVersion, toVersion, takenAt))

  try {
    await db.backup(backupPath)
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Backup failed' }
  }

  const counts = readCarryOverCounts(db)
  const pending: PendingUpdateCheck = {
    fromVersion,
    toVersion,
    ...counts,
    backupPath,
    takenAt: takenAt.toISOString()
  }
  db.setSetting(PENDING_UPDATE_CHECK_KEY, JSON.stringify(pending))

  const existing = listBackups(backupsDir).filter((name) => name.endsWith('.sqlite'))
  for (const stale of backupsToPrune(existing)) {
    deleteBackup(join(backupsDir, stale))
  }

  return { success: true, backupPath }
}

export interface InstallUpdateParams extends PreInstallParams {
  /** Called only once `runPreInstallSteps` has resolved successfully. */
  quitAndInstall: () => void
}

/**
 * The full `updater:install` sequence: run {@link runPreInstallSteps},
 * and call `quitAndInstall` only if it succeeds. Kept as its own
 * function (rather than inlined in the IPC handler) so the ordering
 * itself — backup and settings write fully resolved before
 * `quitAndInstall` ever runs — is directly unit-testable, not just
 * implied by an `await` in `main/index.ts`.
 *
 * @param {InstallUpdateParams} params
 * @returns {Promise<PreInstallResult>}
 */
export async function installUpdate(params: InstallUpdateParams): Promise<PreInstallResult> {
  const { quitAndInstall, ...preInstallParams } = params
  const result = await runPreInstallSteps(preInstallParams)
  if (result.success) quitAndInstall()
  return result
}

export interface PostUpdateCheckParams {
  db: UpdateBackupDatabase
  installedVersion: string
  /** Defaults to `() => new Date()` — overridable so tests get a fixed timestamp. */
  now?: () => Date
}

/**
 * Phase 178's post-update check, run once on app ready (after
 * `db.init()`, before the window shows): resolves whatever
 * `pendingUpdateCheck` an install left behind.
 *
 * - Version now matches `toVersion` (the install landed): reruns the
 *   four counts, compares against the recorded before-counts, stores
 *   `lastUpdateResult`, and clears `pendingUpdateCheck`.
 * - Version still matches `fromVersion` (the install never happened —
 *   the update was declined, failed before restart, or the app was
 *   simply relaunched): clears `pendingUpdateCheck` and stores nothing.
 * - Neither (some other build landed, e.g. a manual reinstall): the
 *   record matches no case this function knows how to resolve, so it is
 *   left as-is rather than guessed at.
 *
 * `ok` is true only when every count after the update is greater than
 * or equal to its before-count — a sale made between the restart and
 * the admin opening this screen can only add to these counts, never
 * shrink them, so equal-or-higher is the correct "nothing was lost" test.
 *
 * @param {PostUpdateCheckParams} params
 * @returns {LastUpdateResult | null} the stored result, or `null` if there was nothing to resolve
 */
export function runPostUpdateCheck(params: PostUpdateCheckParams): LastUpdateResult | null {
  const { db, installedVersion } = params
  const now = params.now ?? ((): Date => new Date())

  const pendingRaw = db.getSetting(PENDING_UPDATE_CHECK_KEY)
  if (!pendingRaw) return null
  const pending = JSON.parse(pendingRaw) as PendingUpdateCheck

  if (installedVersion === pending.fromVersion) {
    db.deleteSetting(PENDING_UPDATE_CHECK_KEY)
    return null
  }

  if (installedVersion !== pending.toVersion) {
    return null
  }

  const before: CarryOverCounts = {
    orders: pending.orders,
    unpushed: pending.unpushed,
    unfiled: pending.unfiled,
    mpesaPayments: pending.mpesaPayments
  }
  const after = readCarryOverCounts(db)
  const ok =
    after.orders >= before.orders &&
    after.unpushed >= before.unpushed &&
    after.unfiled >= before.unfiled &&
    after.mpesaPayments >= before.mpesaPayments

  const result: LastUpdateResult = {
    ok,
    fromVersion: pending.fromVersion,
    toVersion: pending.toVersion,
    before,
    after,
    backupPath: pending.backupPath,
    checkedAt: now().toISOString()
  }

  db.setSetting(LAST_UPDATE_RESULT_KEY, JSON.stringify(result))
  db.deleteSetting(PENDING_UPDATE_CHECK_KEY)
  return result
}
