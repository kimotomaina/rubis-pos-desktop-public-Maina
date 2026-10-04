/**
 * Auto-update service tests.
 *
 * `electron-updater` is never touched — a recording fake implementing
 * {@link AutoUpdaterLike} is injected directly, the same dependency-
 * injection pattern used for the thermal printer client and the SQLite
 * connection elsewhere in this codebase.
 */

import { describe, it, expect, vi } from 'vitest'
import { initAutoUpdater, checkForUpdates } from '../src/main/services/updater.js'
import type { AutoUpdaterLike, UpdateStatus } from '../src/main/services/updater.js'

/**
 * Builds a recording fake implementing the narrow AutoUpdaterLike
 * surface, capturing registered listeners so tests can trigger them.
 */
function createFakeAutoUpdater(options?: { checkForUpdatesError?: unknown }) {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const autoUpdater: AutoUpdaterLike = {
    autoDownload: false,
    checkForUpdates: vi.fn(async () => {
      if (options?.checkForUpdatesError) throw options.checkForUpdatesError
      return undefined
    }),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener)
    })
  }
  return { autoUpdater, listeners }
}

describe('initAutoUpdater', () => {
  it('registers all six event listeners and leaves autoDownload off', () => {
    const { autoUpdater, listeners } = createFakeAutoUpdater()
    initAutoUpdater(autoUpdater, () => {})

    expect(autoUpdater.autoDownload).toBe(false)
    expect(listeners.has('checking-for-update')).toBe(true)
    expect(listeners.has('update-available')).toBe(true)
    expect(listeners.has('update-not-available')).toBe(true)
    expect(listeners.has('download-progress')).toBe(true)
    expect(listeners.has('update-downloaded')).toBe(true)
    expect(listeners.has('error')).toBe(true)
  })

  it('emits a checking status', () => {
    const { autoUpdater, listeners } = createFakeAutoUpdater()
    const statuses: UpdateStatus[] = []
    initAutoUpdater(autoUpdater, (s) => statuses.push(s))

    listeners.get('checking-for-update')?.()

    expect(statuses).toEqual([{ kind: 'checking' }])
  })

  it('emits an available status with the version from the update info', () => {
    const { autoUpdater, listeners } = createFakeAutoUpdater()
    const statuses: UpdateStatus[] = []
    initAutoUpdater(autoUpdater, (s) => statuses.push(s))

    listeners.get('update-available')?.({ version: '1.2.0' })

    expect(statuses).toEqual([{ kind: 'available', version: '1.2.0' }])
  })

  it('falls back to "unknown" when update info has no version', () => {
    const { autoUpdater, listeners } = createFakeAutoUpdater()
    const statuses: UpdateStatus[] = []
    initAutoUpdater(autoUpdater, (s) => statuses.push(s))

    listeners.get('update-available')?.({})

    expect(statuses).toEqual([{ kind: 'available', version: 'unknown' }])
  })

  it('emits a not-available status', () => {
    const { autoUpdater, listeners } = createFakeAutoUpdater()
    const statuses: UpdateStatus[] = []
    initAutoUpdater(autoUpdater, (s) => statuses.push(s))

    listeners.get('update-not-available')?.()

    expect(statuses).toEqual([{ kind: 'not-available' }])
  })

  it('emits a downloading status with the reported percent', () => {
    const { autoUpdater, listeners } = createFakeAutoUpdater()
    const statuses: UpdateStatus[] = []
    initAutoUpdater(autoUpdater, (s) => statuses.push(s))

    listeners.get('download-progress')?.({ percent: 42.5 })

    expect(statuses).toEqual([{ kind: 'downloading', percent: 42.5 }])
  })

  it('emits a downloaded status with the version', () => {
    const { autoUpdater, listeners } = createFakeAutoUpdater()
    const statuses: UpdateStatus[] = []
    initAutoUpdater(autoUpdater, (s) => statuses.push(s))

    listeners.get('update-downloaded')?.({ version: '1.3.0' })

    expect(statuses).toEqual([{ kind: 'downloaded', version: '1.3.0' }])
  })

  it('emits an error status with the error message', () => {
    const { autoUpdater, listeners } = createFakeAutoUpdater()
    const statuses: UpdateStatus[] = []
    initAutoUpdater(autoUpdater, (s) => statuses.push(s))

    listeners.get('error')?.(new Error('feed unreachable'))

    expect(statuses).toEqual([{ kind: 'error', message: 'feed unreachable' }])
  })

  it('falls back to a generic error message for a non-Error rejection', () => {
    const { autoUpdater, listeners } = createFakeAutoUpdater()
    const statuses: UpdateStatus[] = []
    initAutoUpdater(autoUpdater, (s) => statuses.push(s))

    listeners.get('error')?.('boom')

    expect(statuses).toEqual([{ kind: 'error', message: 'Update check failed' }])
  })
})

describe('checkForUpdates', () => {
  it('calls autoUpdater.checkForUpdates', async () => {
    const { autoUpdater } = createFakeAutoUpdater()
    await checkForUpdates(autoUpdater)
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledOnce()
  })

  it('does not throw when checkForUpdates rejects', async () => {
    const { autoUpdater } = createFakeAutoUpdater({ checkForUpdatesError: new Error('offline') })
    await expect(checkForUpdates(autoUpdater)).resolves.toBeUndefined()
  })
})
