/**
 * Pre-update backup, retention, and carried-over-data check
 * (docs/phase-178). Every DB/fs dependency is a recording fake — same DI
 * pattern `updater.test.ts` uses for `AutoUpdaterLike`.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  backupFileName,
  backupsToPrune,
  installUpdate,
  readCarryOverCounts,
  runPostUpdateCheck,
  runPreInstallSteps,
  PENDING_UPDATE_CHECK_KEY,
  LAST_UPDATE_RESULT_KEY,
  type CarryOverCounts,
  type PendingUpdateCheck,
  type UpdateBackupDatabase
} from '../src/main/services/updateBackup.js'

const COUNTS: CarryOverCounts = { orders: 10, unpushed: 1, unfiled: 2, mpesaPayments: 3 }

/** A recording fake `UpdateBackupDatabase` — an in-memory settings map plus a call log. */
function createFakeDb(overrides?: {
  backupError?: unknown
  counts?: CarryOverCounts
}): { db: UpdateBackupDatabase; calls: string[]; settings: Map<string, string> } {
  const calls: string[] = []
  const settings = new Map<string, string>()
  const counts = overrides?.counts ?? COUNTS

  const db: UpdateBackupDatabase = {
    getTotalOrderCount: () => counts.orders,
    getUnpushedOrderCount: () => counts.unpushed,
    getUnfiledOrderCount: () => counts.unfiled,
    getMpesaPaymentCount: () => counts.mpesaPayments,
    backup: vi.fn(async () => {
      calls.push('backup:start')
      if (overrides?.backupError) throw overrides.backupError
      calls.push('backup:resolved')
    }),
    getSetting: (key) => settings.get(key),
    setSetting: (key, value) => {
      calls.push(`setSetting:${key}`)
      settings.set(key, value)
    },
    deleteSetting: (key) => {
      calls.push(`deleteSetting:${key}`)
      settings.delete(key)
    }
  }
  return { db, calls, settings }
}

describe('readCarryOverCounts', () => {
  it('reads all four counts from the database', () => {
    const { db } = createFakeDb()
    expect(readCarryOverCounts(db)).toEqual(COUNTS)
  })
})

describe('backupFileName', () => {
  it('contains no colon or unescaped dot from the timestamp (Windows-safe)', () => {
    const name = backupFileName('2.0.5', '2.0.6', new Date('2026-09-29T12:34:56.789Z'))
    expect(name).toBe('pre-update-2.0.5-to-2.0.6-2026-09-29T12-34-56-789Z.sqlite')
    expect(name).not.toMatch(/:/)
  })
})

describe('backupsToPrune', () => {
  it('keeps the newest 5 (by sorted name) and returns the rest', () => {
    const names = [
      'pre-update-1-to-2-2026-01-01T00-00-00-000Z.sqlite',
      'pre-update-2-to-3-2026-02-01T00-00-00-000Z.sqlite',
      'pre-update-3-to-4-2026-03-01T00-00-00-000Z.sqlite',
      'pre-update-4-to-5-2026-04-01T00-00-00-000Z.sqlite',
      'pre-update-5-to-6-2026-05-01T00-00-00-000Z.sqlite',
      'pre-update-6-to-7-2026-06-01T00-00-00-000Z.sqlite'
    ]
    expect(backupsToPrune(names)).toEqual(['pre-update-1-to-2-2026-01-01T00-00-00-000Z.sqlite'])
  })

  it('returns nothing when at or under the retention count', () => {
    const names = ['a.sqlite', 'b.sqlite', 'c.sqlite']
    expect(backupsToPrune(names, 5)).toEqual([])
  })
})

describe('runPreInstallSteps', () => {
  it('awaits the backup before writing pendingUpdateCheck', async () => {
    const { db, calls } = createFakeDb()
    await runPreInstallSteps({
      db,
      backupsDir: 'C:\\backups',
      fromVersion: '2.0.5',
      toVersion: '2.0.6',
      ensureDir: vi.fn(),
      listBackups: () => [],
      deleteBackup: vi.fn()
    })

    expect(calls).toEqual([
      'backup:start',
      'backup:resolved',
      `setSetting:${PENDING_UPDATE_CHECK_KEY}`
    ])
  })

  it('a failing backup returns failure and never writes pendingUpdateCheck', async () => {
    const { db, calls } = createFakeDb({ backupError: new Error('disk full') })
    const result = await runPreInstallSteps({
      db,
      backupsDir: 'C:\\backups',
      fromVersion: '2.0.5',
      toVersion: '2.0.6',
      ensureDir: vi.fn(),
      listBackups: () => [],
      deleteBackup: vi.fn()
    })

    expect(result).toEqual({ success: false, error: 'disk full' })
    expect(calls).toEqual(['backup:start'])
  })

  it('records pendingUpdateCheck with the counts, versions, and backup path', async () => {
    const { db, settings } = createFakeDb()
    const now = () => new Date('2026-09-29T12:00:00.000Z')
    const result = await runPreInstallSteps({
      db,
      backupsDir: 'C:\\backups',
      fromVersion: '2.0.5',
      toVersion: '2.0.6',
      ensureDir: vi.fn(),
      listBackups: () => [],
      deleteBackup: vi.fn(),
      now
    })

    expect(result.success).toBe(true)
    const pending = JSON.parse(settings.get(PENDING_UPDATE_CHECK_KEY)!) as PendingUpdateCheck
    expect(pending).toEqual({
      fromVersion: '2.0.5',
      toVersion: '2.0.6',
      ...COUNTS,
      backupPath: (result as { backupPath: string }).backupPath,
      takenAt: '2026-09-29T12:00:00.000Z'
    })
  })

  it('retention: keeps the newest 5 backups, deletes the oldest when a 6th is taken', async () => {
    const { db } = createFakeDb()
    const deleteBackup = vi.fn()
    // 5 pre-existing backups; runPreInstallSteps takes a 6th, and a real
    // `readdirSync` call (mimicked by `listBackups` here) would see all 6.
    const existing = [
      'pre-update-1-to-2-2026-01-01T00-00-00-000Z.sqlite',
      'pre-update-2-to-3-2026-02-01T00-00-00-000Z.sqlite',
      'pre-update-3-to-4-2026-03-01T00-00-00-000Z.sqlite',
      'pre-update-4-to-5-2026-04-01T00-00-00-000Z.sqlite',
      'pre-update-5-to-6-2026-05-01T00-00-00-000Z.sqlite'
    ]
    const justTaken = 'pre-update-6-to-7-2026-06-01T00-00-00-000Z.sqlite'

    await runPreInstallSteps({
      db,
      backupsDir: 'C:\\backups',
      fromVersion: '2.0.6',
      toVersion: '2.0.7',
      ensureDir: vi.fn(),
      listBackups: () => [...existing, justTaken],
      deleteBackup
    })

    expect(deleteBackup).toHaveBeenCalledOnce()
    expect(deleteBackup).toHaveBeenCalledWith(
      'C:\\backups\\pre-update-1-to-2-2026-01-01T00-00-00-000Z.sqlite'
    )
  })
})

describe('installUpdate', () => {
  it('calls quitAndInstall only after the backup and settings write both resolve', async () => {
    const { db, calls } = createFakeDb()
    const quitAndInstall = vi.fn(() => calls.push('quitAndInstall'))

    await installUpdate({
      db,
      backupsDir: 'C:\\backups',
      fromVersion: '2.0.5',
      toVersion: '2.0.6',
      ensureDir: vi.fn(),
      listBackups: () => [],
      deleteBackup: vi.fn(),
      quitAndInstall
    })

    expect(calls).toEqual([
      'backup:start',
      'backup:resolved',
      `setSetting:${PENDING_UPDATE_CHECK_KEY}`,
      'quitAndInstall'
    ])
  })

  it('never calls quitAndInstall when the backup fails, and returns the error', async () => {
    const { db } = createFakeDb({ backupError: new Error('disk full') })
    const quitAndInstall = vi.fn()

    const result = await installUpdate({
      db,
      backupsDir: 'C:\\backups',
      fromVersion: '2.0.5',
      toVersion: '2.0.6',
      ensureDir: vi.fn(),
      listBackups: () => [],
      deleteBackup: vi.fn(),
      quitAndInstall
    })

    expect(result).toEqual({ success: false, error: 'disk full' })
    expect(quitAndInstall).not.toHaveBeenCalled()
  })
})

describe('runPostUpdateCheck', () => {
  function seedPending(
    settings: Map<string, string>,
    overrides: Partial<PendingUpdateCheck> = {}
  ): void {
    const pending: PendingUpdateCheck = {
      fromVersion: '2.0.5',
      toVersion: '2.0.6',
      ...COUNTS,
      backupPath: 'C:\\backups\\pre-update-2.0.5-to-2.0.6-2026-09-29T12-00-00-000Z.sqlite',
      takenAt: '2026-09-29T12:00:00.000Z',
      ...overrides
    }
    settings.set(PENDING_UPDATE_CHECK_KEY, JSON.stringify(pending))
  }

  it('returns null and does nothing when there is no pendingUpdateCheck', () => {
    const { db, calls } = createFakeDb()
    const result = runPostUpdateCheck({ db, installedVersion: '2.0.6' })
    expect(result).toBeNull()
    expect(calls).toEqual([])
  })

  it('equal counts after the update -> ok true, lastUpdateResult stored, pendingUpdateCheck cleared', () => {
    const { db, settings } = createFakeDb({ counts: COUNTS })
    seedPending(settings)

    const result = runPostUpdateCheck({
      db,
      installedVersion: '2.0.6',
      now: () => new Date('2026-09-29T12:05:00.000Z')
    })

    expect(result).toEqual({
      ok: true,
      fromVersion: '2.0.5',
      toVersion: '2.0.6',
      before: COUNTS,
      after: COUNTS,
      backupPath: 'C:\\backups\\pre-update-2.0.5-to-2.0.6-2026-09-29T12-00-00-000Z.sqlite',
      checkedAt: '2026-09-29T12:05:00.000Z'
    })
    expect(settings.has(PENDING_UPDATE_CHECK_KEY)).toBe(false)
    expect(JSON.parse(settings.get(LAST_UPDATE_RESULT_KEY)!)).toEqual(result)
  })

  it('a lower count after the update -> ok false, with the differing before/after numbers recorded', () => {
    const after: CarryOverCounts = { ...COUNTS, unfiled: COUNTS.unfiled - 1 }
    const { db, settings } = createFakeDb({ counts: after })
    seedPending(settings)

    const result = runPostUpdateCheck({ db, installedVersion: '2.0.6' })

    expect(result?.ok).toBe(false)
    expect(result?.before.unfiled).toBe(COUNTS.unfiled)
    expect(result?.after.unfiled).toBe(after.unfiled)
    expect(settings.has(PENDING_UPDATE_CHECK_KEY)).toBe(false)
  })

  it('version unchanged (still fromVersion, install did not happen) -> record cleared, no result stored', () => {
    const { db, settings, calls } = createFakeDb()
    seedPending(settings)

    const result = runPostUpdateCheck({ db, installedVersion: '2.0.5' })

    expect(result).toBeNull()
    expect(settings.has(PENDING_UPDATE_CHECK_KEY)).toBe(false)
    expect(settings.has(LAST_UPDATE_RESULT_KEY)).toBe(false)
    expect(calls).toEqual([`deleteSetting:${PENDING_UPDATE_CHECK_KEY}`])
  })

  it('version matches neither fromVersion nor toVersion -> left as-is, nothing stored or cleared', () => {
    const { db, settings, calls } = createFakeDb()
    seedPending(settings)

    const result = runPostUpdateCheck({ db, installedVersion: '9.9.9' })

    expect(result).toBeNull()
    expect(settings.has(PENDING_UPDATE_CHECK_KEY)).toBe(true)
    expect(calls).toEqual([])
  })
})
