/**
 * What the update screens say when an update fails, and what the log keeps (docs/phase-230).
 *
 * `electron-updater` and the backup step produce messages that carry file paths, folders and feed addresses. None
 * of that reaches a screen: the screens get a plain sentence, and the full technical message, with any token
 * removed, goes to `till.log` as `update-failed` for support. The screen cannot write that event.
 */

import type { ServiceResult } from './shopify-types.js'
import type { UpdateStatus } from './updater.js'
import { STILL_SENDING_MESSAGE } from './updateInstall.js'

/** Where in the update a failure happened, as the log names it. */
export type UpdateStage = 'check' | 'download' | 'install'

export const UPDATE_CHECK_FAILED_MESSAGE = 'The update check failed. Check the internet connection and try again.'
export const UPDATE_DOWNLOAD_FAILED_MESSAGE =
  'The update could not be downloaded. Check the internet connection and try again.'
export const NO_UPDATE_READY_MESSAGE = 'No update ready to install.'

/**
 * @param {string} fromVersion — the version the till is on
 * @returns {string}
 */
export function updateInstallFailedMessage(fromVersion: string): string {
  return `The update could not be installed. The till is still on version ${fromVersion}.`
}

const REMOVED = '[removed]'

/**
 * Takes secrets out of a technical message before it is logged: bearer, basic and token values, GitHub token
 * shapes, credentials inside a URL, and secret-looking query values. Paths and addresses are kept, since the log is
 * for support. Applied before the length cap, so a token cannot survive by being cut in half.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REMOVED}`)
    .replace(/\b(authorization|x-api-key|api[-_]?key)["']?\s*[:=]\s*["']?[^\s"',;]+/gi, `$1: ${REMOVED}`)
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, REMOVED)
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}/g, REMOVED)
    .replace(/(:\/\/)[^/\s:@]+:[^/\s@]*@/g, `$1${REMOVED}@`)
    .replace(
      /([?&](?:access_token|token|key|secret|password|signature|sig|x-amz-[a-z-]+)=)[^&\s"']+/gi,
      `$1${REMOVED}`
    )
}

/**
 * The line `till.log` keeps for a failure: the stage and the technical message, secrets removed.
 *
 * @param {UpdateStage} stage
 * @param {unknown} error
 * @returns {string}
 */
export function updateFailureDetail(stage: UpdateStage, error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : 'no reason given'
  return `${stage}: ${redactSecrets(raw)}`
}

/** What {@link createUpdateErrors} gives the main process. */
export interface UpdateErrors {
  /** Passes a status on, turning an error status into the plain message and logging the technical one. */
  onStatus(status: UpdateStatus): UpdateStatus
  /** Marks that a download is starting, so an error that follows is logged as a download failure. */
  beginDownload(): void
  /** Turns a failed download into the plain message, logging the technical one. */
  download(result: ServiceResult<void>): ServiceResult<void>
  /** Turns a failed install into the plain message, logging the technical one. */
  install(result: ServiceResult<void>, fromVersion: string): ServiceResult<void>
}

/**
 * @param {(detail: string) => void} record — writes one `update-failed` line
 * @param {() => number} [now] — the clock, injectable for tests
 * @returns {UpdateErrors}
 */
export function createUpdateErrors(record: (detail: string) => void, now: () => number = Date.now): UpdateErrors {
  let stage: UpdateStage = 'check'
  let lastDetail = ''
  let lastAt = 0

  // electron-updater emits an error event and also rejects: the same failure arrives twice within moments.
  const report = (at: UpdateStage, error: unknown): void => {
    const detail = updateFailureDetail(at, error)
    const time = now()
    if (detail === lastDetail && time - lastAt < 2000) return
    lastDetail = detail
    lastAt = time
    record(detail)
  }

  return {
    onStatus(status) {
      if (status.kind === 'checking') stage = 'check'
      if (status.kind === 'downloading') stage = 'download'
      if (status.kind !== 'error') return status
      report(stage, status.message)
      return { kind: 'error', message: stage === 'download' ? UPDATE_DOWNLOAD_FAILED_MESSAGE : UPDATE_CHECK_FAILED_MESSAGE }
    },
    beginDownload() {
      stage = 'download'
    },
    download(result) {
      if (result.success) return result
      report('download', result.error)
      return { success: false, error: UPDATE_DOWNLOAD_FAILED_MESSAGE }
    },
    install(result, fromVersion) {
      if (result.success) return result
      // Two messages are already plain and say something useful (a sale is still being sent; nothing downloaded).
      if (result.error === STILL_SENDING_MESSAGE || result.error === NO_UPDATE_READY_MESSAGE) return result
      report('install', result.error)
      return { success: false, error: updateInstallFailedMessage(fromVersion) }
    }
  }
}
