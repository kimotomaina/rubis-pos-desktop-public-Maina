/**
 * Update messages on screen (docs/phase-230). The main process already sends plain sentences; this is the second
 * lock: whatever text an update screen is about to show is checked once more, and anything that carries a file
 * path, a folder, an address or a file name is replaced by a plain sentence. No update screen shows one.
 */

export const UPDATE_CHECK_FAILED_TEXT = 'The update check failed. Check the internet connection and try again.'
export const UPDATE_DOWNLOAD_FAILED_TEXT = 'The update could not be downloaded. Check the internet connection and try again.'
export const UPDATE_INSTALL_FAILED_TEXT = 'The update could not be installed. The till is still running.'

/**
 * A drive letter, a backslash, a URL or `file:` address, a slash path, a file name with a technical extension, or a
 * network or system error code such as `net::ERR_CONNECTION_RESET` or `ENOENT`.
 */
const TECHNICAL_TEXT =
  /[A-Za-z]:[\\/]|\\|\b(?:https?|file|ftp):|\/[A-Za-z][\w.-]*\/[A-Za-z][\w.-]*|\.(?:exe|sqlite|yml|blockmap|asar|dll|log)\b|\bnet::|\bERR_[A-Z_]+|\bE(?:NOENT|PERM|ACCES|BUSY|CONN[A-Z]*|TIMEDOUT|HOSTUNREACH|NOTFOUND)\b/i

/**
 * @param {string} text
 * @returns {boolean} whether the text holds a path, folder, address or file name
 */
export function looksTechnical(text: string): boolean {
  return TECHNICAL_TEXT.test(text)
}

/**
 * The text to show for an update message: the message itself when it is plain, otherwise `fallback`.
 *
 * @param {string | null | undefined} text
 * @param {string} fallback
 * @returns {string}
 */
export function plainUpdateText(text: string | null | undefined, fallback: string): string {
  if (!text) return fallback
  return looksTechnical(text) ? fallback : text
}
