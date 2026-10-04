/**
 * Auto-update wiring for RUBIS POS.
 *
 * `electron-updater`'s `autoUpdater` singleton is never imported directly
 * by the functions below — the real singleton is injected by the caller
 * (`main/index.ts`), and tests inject a recording fake instead, matching
 * the DI convention used everywhere else in `main/services` (see
 * `printer.ts`'s `ThermalPrinterLike`).
 */

import type { Logger } from './logger.js'
import type { ServiceResult } from './shopify-types.js'

/**
 * The subset of `electron-updater`'s `AppUpdater` this module depends on.
 */
export interface AutoUpdaterLike {
  autoDownload: boolean
  /** Always present on the real singleton; optional here so a narrower fake still satisfies the type. */
  autoInstallOnAppQuit?: boolean
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
  on(event: string, listener: (...args: unknown[]) => void): void
}

/** {@link AutoUpdaterLike} plus the on-request download (docs/phase-219). */
export interface DownloadingUpdaterLike extends AutoUpdaterLike {
  downloadUpdate(): Promise<unknown>
}

/** A single point-in-time update status, pushed to the renderer as a toast. */
export type UpdateStatus =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'not-available' }
  | { kind: 'downloading'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

/**
 * Turns off both of electron-updater's automatic behaviours, so nothing is downloaded or
 * installed without a person choosing it (docs/phase-219). Its defaults are
 * `autoDownload = true` and `autoInstallOnAppQuit = true`: with them an update is downloaded
 * as soon as it is found and installed when the till is next closed, even after the user said
 * no. This is the only place either is set.
 *
 * @param {AutoUpdaterLike} autoUpdater - the updater instance to configure
 * @returns {void}
 */
export function refuseUnrequestedUpdates(autoUpdater: AutoUpdaterLike): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
}

/**
 * Registers listeners that translate `electron-updater`'s events into
 * {@link UpdateStatus} values delivered to `onStatus`, after
 * {@link refuseUnrequestedUpdates}.
 *
 * @param {AutoUpdaterLike} autoUpdater - the updater instance to observe
 * @param {(status: UpdateStatus) => void} onStatus - receives each status change
 * @returns {void}
 */
export function initAutoUpdater(
  autoUpdater: AutoUpdaterLike,
  onStatus: (status: UpdateStatus) => void
): void {
  refuseUnrequestedUpdates(autoUpdater)

  autoUpdater.on('checking-for-update', () => onStatus({ kind: 'checking' }))

  autoUpdater.on('update-available', (info) => {
    const version = (info as { version?: string } | undefined)?.version ?? 'unknown'
    onStatus({ kind: 'available', version })
  })

  autoUpdater.on('update-not-available', () => onStatus({ kind: 'not-available' }))

  autoUpdater.on('download-progress', (progress) => {
    const percent = (progress as { percent?: number } | undefined)?.percent ?? 0
    onStatus({ kind: 'downloading', percent })
  })

  autoUpdater.on('update-downloaded', (info) => {
    const version = (info as { version?: string } | undefined)?.version ?? 'unknown'
    onStatus({ kind: 'downloaded', version })
  })

  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : 'Update check failed'
    onStatus({ kind: 'error', message })
  })
}

/**
 * Triggers an update check. Errors are swallowed here because `initAutoUpdater`
 * already surfaces failures via the `error` event/{@link UpdateStatus}.
 *
 * @param {AutoUpdaterLike} autoUpdater - the updater instance to query
 * @returns {Promise<void>}
 */
export async function checkForUpdates(autoUpdater: AutoUpdaterLike): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    // Surfaced to the renderer via the 'error' listener registered in initAutoUpdater.
  }
}

/** What the check at startup found (docs/phase-219). */
export interface StartupCheckOutcome {
  /** Whether a check actually ran and got an answer; false in a dev run and when the check failed. */
  checked: boolean
  /** The version on offer, or null when up to date or when no check ran. */
  version: string | null
}

/** The part of electron-updater's check result the startup check reads. */
interface CheckResultLike {
  isUpdateAvailable?: boolean
  updateInfo?: { version?: string }
}

/**
 * The check made once per app start after login (docs/phase-219). It makes no check at all
 * when the app is not packaged, so a dev run never contacts GitHub, and a failure (no
 * internet, GitHub unreachable) is logged and reported as "not checked", never to the user.
 * It never downloads: `autoDownload` is off.
 *
 * @param {AutoUpdaterLike} autoUpdater - the updater instance to query
 * @param {{ isPackaged: boolean; logger?: Pick<Logger, 'warn'> }} options
 * @returns {Promise<StartupCheckOutcome>}
 */
export async function checkForUpdateAtStartup(
  autoUpdater: AutoUpdaterLike,
  options: { isPackaged: boolean; logger?: Pick<Logger, 'warn'> }
): Promise<StartupCheckOutcome> {
  if (!options.isPackaged) return { checked: false, version: null }
  try {
    const result = (await autoUpdater.checkForUpdates()) as CheckResultLike | null | undefined
    if (!result) return { checked: false, version: null }
    const version = result.isUpdateAvailable ? (result.updateInfo?.version ?? 'unknown') : null
    return { checked: true, version }
  } catch (error) {
    ;(options.logger ?? console).warn(
      `[rubis-pos] Update check at startup failed: ${error instanceof Error ? error.message : String(error)}`
    )
    return { checked: false, version: null }
  }
}

/**
 * The startup check as the main process holds it: one per app start (docs/phase-219). The
 * first successful check answers; every later call returns null without checking, so a
 * logout and login or a window reload does not ask again, and the next app start (a new
 * instance) does. Nothing is stored, and a check that failed does not use up the one chance.
 *
 * @param {AutoUpdaterLike} autoUpdater - the updater instance to query
 * @param {{ isPackaged: boolean; logger?: Pick<Logger, 'warn'> }} options
 * @returns {() => Promise<string | null>} resolves with the version on offer, or null
 */
export function createStartupUpdateCheck(
  autoUpdater: AutoUpdaterLike,
  options: { isPackaged: boolean; logger?: Pick<Logger, 'warn'> }
): () => Promise<string | null> {
  let done = false
  return async () => {
    if (done) return null
    const outcome = await checkForUpdateAtStartup(autoUpdater, options)
    if (outcome.checked) done = true
    return outcome.version
  }
}

/**
 * Downloads the update found by the last check, on request. The library only allows this
 * after a check in the same run. Progress and completion arrive as `updater:status`; this
 * resolves when the download has finished, or with the reason it failed.
 *
 * @param {DownloadingUpdaterLike} autoUpdater - the updater instance holding the checked update
 * @returns {Promise<ServiceResult<void>>}
 */
export async function downloadUpdateNow(autoUpdater: DownloadingUpdaterLike): Promise<ServiceResult<void>> {
  try {
    await autoUpdater.downloadUpdate()
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'The update could not be downloaded' }
  }
}
