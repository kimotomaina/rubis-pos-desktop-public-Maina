/**
 * The check at startup and the rule that nothing installs without a yes (docs/phase-219).
 *
 * `electron-updater` is never touched: a recording fake starting from the library's own
 * defaults (`autoDownload` and `autoInstallOnAppQuit` both true) stands in for it.
 */

import { describe, it, expect, vi } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import {
  checkForUpdateAtStartup,
  createStartupUpdateCheck,
  downloadUpdateNow,
  initAutoUpdater,
  refuseUnrequestedUpdates
} from '../src/main/services/updater.js'
import type { DownloadingUpdaterLike } from '../src/main/services/updater.js'

/** A fake holding electron-updater's real defaults, so a setting that is never made shows as true. */
function createLibraryDefaultUpdater(check?: () => Promise<unknown>) {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const updater: DownloadingUpdaterLike = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(check ?? (async () => ({ isUpdateAvailable: true, updateInfo: { version: '2.2.0' } }))),
    downloadUpdate: vi.fn(async () => ['installer.exe']),
    quitAndInstall: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener)
    })
  }
  return { updater, listeners }
}

describe('nothing downloads or installs by itself', () => {
  it('sets autoDownload and autoInstallOnAppQuit to false at startup', () => {
    const { updater } = createLibraryDefaultUpdater()
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)

    initAutoUpdater(updater, () => {})

    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
  })

  it('refuseUnrequestedUpdates alone sets both', () => {
    const { updater } = createLibraryDefaultUpdater()
    refuseUnrequestedUpdates(updater)
    expect([updater.autoDownload, updater.autoInstallOnAppQuit]).toEqual([false, false])
  })

  it('sets both in one place only: nothing else in src turns either on', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
      })
    const root = resolve(__dirname, '..', 'src')
    const assignments = files(root).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((line, index) => ({ at: `${relative(root, file)}:${index + 1}`, line }))
        .filter(({ line }) => /^\s*\w+\.(autoDownload|autoInstallOnAppQuit)\s*=[^=]/.test(line))
    )

    expect(assignments.map(({ line }) => line.trim())).toEqual([
      'autoUpdater.autoDownload = false',
      'autoUpdater.autoInstallOnAppQuit = false'
    ])
    expect(assignments.map(({ at }) => at.split(sep).join('/').replace(/:\d+$/, ''))).toEqual([
      'main/services/updater.ts',
      'main/services/updater.ts'
    ])
  })
})

describe('checkForUpdateAtStartup', () => {
  it('reports the version on offer', async () => {
    const { updater } = createLibraryDefaultUpdater()

    expect(await checkForUpdateAtStartup(updater, { isPackaged: true })).toEqual({ checked: true, version: '2.2.0' })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('reports an up-to-date till as checked, with nothing on offer', async () => {
    const { updater } = createLibraryDefaultUpdater(async () => ({ isUpdateAvailable: false, updateInfo: { version: '2.1.9' } }))

    expect(await checkForUpdateAtStartup(updater, { isPackaged: true })).toEqual({ checked: true, version: null })
  })

  it('makes no check at all in a dev run (app not packaged)', async () => {
    const { updater } = createLibraryDefaultUpdater()

    expect(await checkForUpdateAtStartup(updater, { isPackaged: false })).toEqual({ checked: false, version: null })
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('swallows a failed check, logs it, and says nothing to the user', async () => {
    const { updater } = createLibraryDefaultUpdater(async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com')
    })
    const logger = { warn: vi.fn() }

    expect(await checkForUpdateAtStartup(updater, { isPackaged: true, logger })).toEqual({ checked: false, version: null })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ENOTFOUND'))
  })

  it('treats a disabled updater (null result) as not checked', async () => {
    const { updater } = createLibraryDefaultUpdater(async () => null)

    expect(await checkForUpdateAtStartup(updater, { isPackaged: true })).toEqual({ checked: false, version: null })
  })
})

describe('createStartupUpdateCheck: once per app start, nothing stored', () => {
  it('offers the update on the first call and checks nothing on later calls', async () => {
    const { updater } = createLibraryDefaultUpdater()
    const startupCheck = createStartupUpdateCheck(updater, { isPackaged: true })

    expect(await startupCheck()).toBe('2.2.0')
    expect(await startupCheck()).toBeNull()
    expect(await startupCheck()).toBeNull()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('asks again at the next start: a new instance has no memory of the last', async () => {
    const { updater } = createLibraryDefaultUpdater()

    expect(await createStartupUpdateCheck(updater, { isPackaged: true })()).toBe('2.2.0')
    expect(await createStartupUpdateCheck(updater, { isPackaged: true })()).toBe('2.2.0')
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('does not use up its one check on a failure', async () => {
    let calls = 0
    const { updater } = createLibraryDefaultUpdater(async () => {
      calls += 1
      if (calls === 1) throw new Error('offline')
      return { isUpdateAvailable: true, updateInfo: { version: '2.2.0' } }
    })
    const startupCheck = createStartupUpdateCheck(updater, { isPackaged: true, logger: { warn: () => {} } })

    expect(await startupCheck()).toBeNull()
    expect(await startupCheck()).toBe('2.2.0')
  })

  it('makes no check in a dev run, however often it is called', async () => {
    const { updater } = createLibraryDefaultUpdater()
    const startupCheck = createStartupUpdateCheck(updater, { isPackaged: false })

    expect(await startupCheck()).toBeNull()
    expect(await startupCheck()).toBeNull()
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('stores nothing: the module writes no setting and has no database', () => {
    const source = readFileSync(resolve(__dirname, '..', 'src', 'main', 'services', 'updater.ts'), 'utf8')
    expect(source).not.toMatch(/setSetting|localStorage|writeFile|\.run\(/)
  })
})

describe('downloadUpdateNow', () => {
  it('downloads on request and reports success', async () => {
    const { updater } = createLibraryDefaultUpdater()

    expect(await downloadUpdateNow(updater)).toEqual({ success: true })
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
  })

  it('reports why a download failed, and never installs', async () => {
    const { updater } = createLibraryDefaultUpdater()
    updater.downloadUpdate = vi.fn(async () => {
      throw new Error('net::ERR_CONNECTION_RESET')
    })

    expect(await downloadUpdateNow(updater)).toEqual({ success: false, error: 'net::ERR_CONNECTION_RESET' })
    expect(updater.quitAndInstall).not.toHaveBeenCalled()
  })
})
