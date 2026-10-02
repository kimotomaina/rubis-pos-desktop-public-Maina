/**
 * Records manager-approved cart removals (docs/phase-197).
 *
 * The manager's PIN is re-verified here, in the main process, before
 * anything is written, so a renderer cannot forge an approval. The cart
 * changes in the renderer only after this returns success.
 */

import { requireAdminPin } from '../lib/requireAdminPin.js'
import type { RubisDatabase } from './database.js'
import type { ServiceResult } from './shopify-types.js'

/** What {@link recordApprovedRemovals} needs from the database. */
export type CartRemovalsDb = Pick<RubisDatabase, 'getStaffById' | 'recordCartLineRemovals'>

/** The validated `cart:record-removals` request. */
export interface ApprovedRemovalsRequest {
  managerId: number
  managerPin: string
  staffId: number
  cartToken: string
  changes: { variantId: string; qtyBefore: number; qtyAfter: number }[]
}

/**
 * @param {CartRemovalsDb} db
 * @param {ApprovedRemovalsRequest} request
 * @param {() => Date} [now]
 * @returns {ServiceResult<void>} failure, with nothing written, unless the manager's PIN checks out
 */
export function recordApprovedRemovals(
  db: CartRemovalsDb,
  request: ApprovedRemovalsRequest,
  now: () => Date = () => new Date()
): ServiceResult<void> {
  const authz = requireAdminPin(db as RubisDatabase, request.managerId, request.managerPin)
  if (!authz.success) {
    return { success: false, error: authz.error }
  }
  try {
    const at = now().toISOString()
    db.recordCartLineRemovals(
      request.changes.map((change) => ({
        cart_token: request.cartToken,
        variant_id: change.variantId,
        qty_before: change.qtyBefore,
        qty_after: change.qtyAfter,
        staff_id: request.staffId,
        manager_id: request.managerId,
        at
      }))
    )
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to record the removal' }
  }
}
