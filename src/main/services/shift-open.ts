/**
 * Opening a shift (docs/phase-227, docs/phase-254): who may do it, checked in the main process.
 *
 * Since docs/phase-254 the main process knows who signed in at the till (`lib/roleGate.ts`), and that person opens the
 * shift as themselves, cashier or admin, with no PIN: their own login is the authority. The shift is recorded under
 * them, never under a staff id the screen names. Starting at 0 below the earlier cash sales stays an admin's choice.
 *
 * A manager's PIN still opens a shift under that manager, re-verified here. With nobody signed in, the staff id named
 * must belong to an active admin account, as before the phase (see docs/KNOWN_GAPS.md).
 */

import { requireAdminPin } from '../lib/requireAdminPin.js'
import { MANAGER_NEEDED_MESSAGE } from '../lib/roleGate.js'
import type { EarlierSalesShown, RubisDatabase, StaffSummary } from './database.js'
import type { ServiceResult } from './shopify-types.js'

/** What {@link openShiftChecked} needs from the database. */
export type OpenShiftDb = Pick<RubisDatabase, 'getStaffById' | 'openShift'> & Parameters<typeof requireAdminPin>[0]

/** The validated `shifts:open` request. */
export interface OpenShiftRequest {
  staffId: number
  startingCash: number
  /** Ignored (docs/phase-232): the type comes from the clock. Still accepted so an older caller validates. */
  shiftType?: string | null
  mpesaOpeningBalance?: number | null
  /** What the form showed (docs/phase-232); the shift is not opened if the sales now differ. */
  earlierShown?: EarlierSalesShown
  /** An admin's choice when the drawer holds less than the earlier cash sales: start at 0. */
  startAtZero?: boolean
  /** Both or neither (the schema checks): a manager's PIN, re-verified here. */
  managerId?: number
  managerPin?: string
}

export const OPEN_SHIFT_ADMIN_ONLY_MESSAGE = 'Only an admin can open a shift. Ask a manager to enter their PIN.'

/**
 * Who the shift is recorded under, or why it may not be opened.
 *
 * @param {OpenShiftDb} db
 * @param {OpenShiftRequest} request
 * @param {StaffSummary | null} signedIn
 * @returns {{ openedBy: number } | { error: string }}
 */
function opener(db: OpenShiftDb, request: OpenShiftRequest, signedIn: StaffSummary | null): { openedBy: number } | { error: string } {
  if (request.managerId !== undefined && request.managerPin !== undefined) {
    const authz = requireAdminPin(db, request.managerId, request.managerPin)
    return authz.success ? { openedBy: request.managerId } : { error: authz.error ?? OPEN_SHIFT_ADMIN_ONLY_MESSAGE }
  }
  if (signedIn) {
    const staff = db.getStaffById(signedIn.id)
    if (!staff || staff.is_active !== 1) return { error: MANAGER_NEEDED_MESSAGE }
    if (request.startAtZero === true && staff.role !== 'admin') return { error: MANAGER_NEEDED_MESSAGE }
    return { openedBy: staff.id }
  }
  const staff = db.getStaffById(request.staffId)
  if (!staff || staff.is_active !== 1 || staff.role !== 'admin') return { error: OPEN_SHIFT_ADMIN_ONLY_MESSAGE }
  return { openedBy: request.staffId }
}

/**
 * Opens the shift for the person signed in, or under a manager's PIN, or, with nobody signed in, for the admin named.
 *
 * @param {OpenShiftDb} db
 * @param {OpenShiftRequest} request
 * @param {StaffSummary | null} [signedIn] — who the main process knows is signed in (docs/phase-254)
 * @returns {ServiceResult<{ shiftId: number }>}
 */
export function openShiftChecked(
  db: OpenShiftDb,
  request: OpenShiftRequest,
  signedIn: StaffSummary | null = null
): ServiceResult<{ shiftId: number }> {
  const who = opener(db, request, signedIn)
  if ('error' in who) return { success: false, error: who.error }
  try {
    return {
      success: true,
      data: db.openShift(who.openedBy, request.startingCash, request.mpesaOpeningBalance ?? null, {
        earlierShown: request.earlierShown,
        startAtZero: request.startAtZero
      })
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to open shift' }
  }
}
