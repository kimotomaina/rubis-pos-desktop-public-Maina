/**
 * Global crash safety net for RUBIS POS (Phase 8).
 *
 * Catches process-level and renderer-level failures that would otherwise
 * show a white screen or silently kill the app, logs them to a local file,
 * and shows the cashier a friendly restart prompt instead.
 */

/** Minimal file-append sink, kept swappable so tests never touch real disk. */
export interface ErrorLogger {
  append(entry: string): void
}

/**
 * Builds an {@link ErrorLogger} that appends to `filePath` via the given
 * `appendFileSync` implementation (real `node:fs` in production).
 *
 * @param {string} filePath - absolute path to the log file
 * @param {{ appendFileSync: (path: string, data: string) => void }} fs - injected append implementation
 * @returns {ErrorLogger}
 */
export function createFileErrorLogger(
  filePath: string,
  fs: { appendFileSync: (path: string, data: string) => void }
): ErrorLogger {
  return {
    append(entry: string) {
      fs.appendFileSync(filePath, entry + '\n')
    }
  }
}

/**
 * Formats an error into a single log-file line.
 *
 * @param {string} source - where the error was caught, e.g. "uncaughtException"
 * @param {unknown} error - the caught error or rejection reason
 * @returns {string} a timestamped, single-line log entry
 */
export function formatErrorEntry(source: string, error: unknown): string {
  const timestamp = new Date().toISOString()
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  return `[${timestamp}] [${source}] ${detail}`
}

/** Dependencies injected into {@link installGlobalErrorHandlers}. */
export interface ErrorHandlerDeps {
  process: { on: (event: string, listener: (...args: unknown[]) => void) => unknown }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: { on: (event: any, listener: (...args: unknown[]) => void) => unknown }
  logger: ErrorLogger
  showFatalDialog: (message: string) => void
}

const RESTART_MESSAGE = 'An unexpected error occurred. Please restart RUBIS POS.'

/**
 * Installs process-wide and renderer-crash handlers. None of the handlers
 * force-quit the app — they log the failure and prompt the cashier to
 * restart, which is the friendlier option for a store-floor PoC.
 *
 * @param {ErrorHandlerDeps} deps - injected process/app/logger/dialog implementations
 * @returns {void}
 */
export function installGlobalErrorHandlers(deps: ErrorHandlerDeps): void {
  deps.process.on('uncaughtException', (error) => {
    deps.logger.append(formatErrorEntry('uncaughtException', error))
    deps.showFatalDialog(RESTART_MESSAGE)
  })

  deps.process.on('unhandledRejection', (reason) => {
    deps.logger.append(formatErrorEntry('unhandledRejection', reason))
    deps.showFatalDialog(RESTART_MESSAGE)
  })

  deps.app.on('render-process-gone', (_event, details) => {
    deps.logger.append(formatErrorEntry('render-process-gone', details))
    deps.showFatalDialog(RESTART_MESSAGE)
  })
}
