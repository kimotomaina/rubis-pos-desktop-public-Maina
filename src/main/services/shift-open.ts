/**
 * Opening a shift (docs/phase-227): who may do it, checked in the main process.
 *
 * The main process keeps no session, so it cannot know who is at the till (`auth:logout` does nothing, and the
 * renderer holds the signed-in staff member). What it can check is the staff id the request names and, when one is
 * given, a manager PIN. So a shift is only ever recorded under an admin:
 *
 * - with a manager PIN, the PIN is re-verified and the shift is recorded under that manager;
 * - without one, the staff id named must belong to an active admin account.
 *
 * Neither proves who is physically at the till (see docs/KNOWN_GAPS.md): a caller that names an admin's id passes
 * the second. The cart's dialog for a cashier always sends a PIN.
 */

import { requireAdminPin } from '../lib/requireAdminPin.js'
import type { ShiftType } from '../lib/shiftWindows.js'
import type { RubisDatabase } from './database.js'
import type { ServiceResult } from './shopify-types.js'

/** What {@link openShiftChecked} needs from the database. */
export type OpenShiftDb = Pick<RubisDatabase, 'getStaffById' | 'openShift'> & Parameters<typeof requireAdminPin>[0]

/** The validated `shifts:open` request. */
export interface OpenShiftRequest {
  staffId: number
  startingCash: number
  shiftType?: ShiftType | null
  mpesaOpeningBalance?: number | null
  /** Both or neither (the schema checks): a manager's PIN, re-verified here. */
  managerId?: number
  managerPin?: string
}

export const OPEN_SHIFT_ADMIN_ONLY_MESSAGE = 'Only an admin can open a shift. Ask a manager to enter their PIN.'

/**
 * Opens the shift if the request comes from an admin, or carries an admin's PIN.
 *
 * @param {OpenShiftDb} db
 * @param {OpenShiftRequest} request
 * @returns {ServiceResult<{ shiftId: number }>}
 */
export function openShiftChecked(db: OpenShiftDb, request: OpenShiftRequest): ServiceResult<{ shiftId: number }> {
  let openedBy = request.staffId
  if (request.managerId !== undefined && request.managerPin !== undefined) {
    const authz = requireAdminPin(db, request.managerId, request.managerPin)
    if (!authz.success) return { success: false, error: authz.error }
    openedBy = request.managerId
  } else {
    const staff = db.getStaffById(request.staffId)
    if (!staff || staff.is_active !== 1 || staff.role !== 'admin') {
      return { success: false, error: OPEN_SHIFT_ADMIN_ONLY_MESSAGE }
    }
  }
  try {
    return {
      success: true,
      data: db.openShift(openedBy, request.startingCash, request.shiftType ?? null, request.mpesaOpeningBalance ?? null)
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to open shift' }
  }
}
