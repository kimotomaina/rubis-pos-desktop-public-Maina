/**
 * Local file permission hardening.
 *
 * `rubis-pos.db` holds every local sale, staff PIN hash, and shift
 * record — it already lives in `app.getPath('userData')`, which
 * Electron scopes to the current Windows user profile, but the file
 * itself is created with the process's default umask, which can still
 * be group/world-readable on some systems. This restricts it to
 * owner-only access as a second, explicit layer on top of that
 * OS-level user-profile scoping.
 */

/** Narrow surface of `node:fs`'s `chmodSync` this module depends on. */
export type ChmodFn = (path: string, mode: number) => void

/** Owner read/write only — no group or world access. */
export const OWNER_ONLY_MODE = 0o600

/**
 * Restricts `filePath` to owner-only read/write. Never throws — a
 * failure (e.g. the filesystem doesn't support POSIX permission bits,
 * as on most Windows volumes, where this only toggles the read-only
 * attribute) is logged and treated as non-fatal, since it must never
 * block the app from starting.
 *
 * @param {ChmodFn} chmod
 * @param {string} filePath
 * @returns {boolean} `true` if the permission change succeeded
 */
export function restrictToOwnerOnly(chmod: ChmodFn, filePath: string): boolean {
  try {
    chmod(filePath, OWNER_ONLY_MODE)
    return true
  } catch (err) {
    console.error(`[rubis-pos] Failed to restrict permissions on ${filePath}:`, err)
    return false
  }
}
