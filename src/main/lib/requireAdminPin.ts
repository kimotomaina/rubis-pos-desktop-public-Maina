/**
 * Server-side admin re-authorization (Phase 14 — Pre-Deployment
 * Security Patch).
 *
 * `staff:create`, `staff:resetPin`, and `integrations:set-config`
 * previously trusted the renderer's `ManagerPinModal` gate with no
 * check in the main process at all — a compromised or DevTools-driven
 * renderer could call `window.api.createStaff(...)` directly and skip
 * that prompt entirely, since `contextBridge` exposes it globally.
 * This closes that gap by re-running the same PIN check `auth:login`
 * performs, independent of whatever the renderer claims about the
 * current session.
 */

import { authenticateStaff } from '../services/auth.js'
import type { RubisDatabase } from '../services/database.js'
import type { ServiceResult } from '../services/shopify-types.js'

/**
 * Generic failure message covering an unknown manager id, a wrong
 * PIN, a correct PIN on a non-admin account, and an unexpected
 * `authenticateStaff` failure alike — mirroring `authenticateStaff`'s
 * own generic-error pattern so this check never reveals which part of
 * it failed.
 */
const AUTHORIZATION_ERROR = 'Manager PIN required for this action'

/**
 * Verifies that `managerPin` is the correct PIN for `managerId` and
 * that the account it belongs to has the `admin` role, re-checked in
 * the main process rather than trusted from the renderer.
 *
 * `authenticateStaff` does not throw in practice (`verifyPin` never
 * throws), but this is a privileged authorization gate reached from
 * every write IPC it guards — a defensive `try/catch` keeps an
 * unforeseen failure a clean rejection rather than an unhandled
 * exception surfacing out of `ipcMain.handle`.
 *
 * @param {RubisDatabase} db
 * @param {number} managerId — staff id the caller claims authorized this action
 * @param {string} managerPin — PIN entered in `ManagerPinModal`
 * @returns {ServiceResult<void>} `{ success: true }`, or a generic authorization failure
 */
export function requireAdminPin(
  db: RubisDatabase,
  managerId: number,
  managerPin: string
): ServiceResult<void> {
  try {
    const result = authenticateStaff(db, managerId, managerPin)
    if (!result.success || !result.data || result.data.role !== 'admin') {
      return { success: false, error: AUTHORIZATION_ERROR }
    }
    return { success: true }
  } catch {
    return { success: false, error: AUTHORIZATION_ERROR }
  }
}
