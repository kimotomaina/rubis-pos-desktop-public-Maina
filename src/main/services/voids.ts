/**
 * Order void service.
 *
 * Restricted to locally `pending_sync` orders — voiding an order
 * already synced to Shopify would need a Shopify refund/cancel
 * mutation, which is not currently supported. The actual reversal
 * (inventory + order status + sync-queue cleanup) lives on
 * `RubisDatabase.voidOrder`, matching how `auth.ts` wraps
 * `db.getStaffById`/`verifyPin` with business-rule validation and a
 * {@link ServiceResult}, rather than duplicating the transaction here.
 */

import type { RubisDatabase } from './database.js'
import type { ServiceResult } from './shopify-types.js'

/**
 * The `orders:void` channel's only answer since phase-131. Void was
 * removed from the till: a sale may already be filed with KRA, and the
 * till cannot issue the credit note that would reverse it.
 */
export const VOID_DISABLED_MESSAGE =
  'Sales cannot be voided on this till. A filed sale needs a credit note.'

/** Outcome of a successful void. */
export interface VoidResult {
  localId: number
  voidedAt: string
}

/**
 * Voids a local order, reversing its inventory impact and marking it
 * `voided` so it is excluded from future Shopify sync attempts.
 *
 * Only `pending_sync` orders may be voided:
 *   - `synced` — already pushed to Shopify; reversing it here would
 *     silently desync the POS ledger from the merchant's actual
 *     Shopify order/inventory state (refunds for synced orders are
 *     not currently supported).
 *   - `failed` / `voided` — already in a terminal state.
 *
 * @param {RubisDatabase} db
 * @param {number} localId
 * @returns {ServiceResult<VoidResult>}
 */
export function voidLocalOrder(db: RubisDatabase, localId: number): ServiceResult<VoidResult> {
  const order = db.getOrder(localId)
  if (!order) {
    return { success: false, error: `Order ${localId} not found` }
  }

  if (order.status === 'synced') {
    return {
      success: false,
      error:
        'This order has already synced to Shopify and cannot be voided here — refunds for synced orders are not currently supported'
    }
  }
  if (order.status !== 'pending_sync') {
    return {
      success: false,
      error: `Order ${localId} cannot be voided (status: ${order.status})`
    }
  }

  try {
    const { voidedAt } = db.voidOrder(localId)
    return { success: true, data: { localId, voidedAt } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to void order'
    }
  }
}
