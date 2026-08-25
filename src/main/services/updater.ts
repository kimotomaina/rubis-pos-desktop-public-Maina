/**
 * Auto-update wiring for RUBIS POS (Phase 8).
 *
 * `electron-updater`'s `autoUpdater` singleton is never imported directly
 * by the functions below — the real singleton is injected by the caller
 * (`main/index.ts`), and tests inject a recording fake instead, matching
 * the DI convention used everywhere else in `main/services` (see
 * `printer.ts`'s `ThermalPrinterLike`).
 */

/**
 * The subset of `electron-updater`'s `AppUpdater` this module depends on.
 */
export interface AutoUpdaterLike {
  autoDownload: boolean
  checkForUpdates(): Promise<unknown>
  quitAndInstall(): void
  on(event: string, listener: (...args: unknown[]) => void): void
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
 * Registers listeners that translate `electron-updater`'s events into
 * {@link UpdateStatus} values delivered to `onStatus`.
 *
 * @param {AutoUpdaterLike} autoUpdater - the updater instance to observe
 * @param {(status: UpdateStatus) => void} onStatus - receives each status change
 * @returns {void}
 */
export function initAutoUpdater(
  autoUpdater: AutoUpdaterLike,
  onStatus: (status: UpdateStatus) => void
): void {
  autoUpdater.autoDownload = true

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
