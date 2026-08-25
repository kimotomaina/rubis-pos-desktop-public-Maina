/**
 * Order void service (Phase 10 — POC Critical Operational Features).
 *
 * Restricted to locally `pending_sync` orders for this phase — voiding
 * an order already synced to Shopify would need a Shopify refund/cancel
 * mutation, which is out of scope for the 1-week PoC (see docs/phase-10.md
 * Q1). The actual reversal (inventory + order status + sync-queue
 * cleanup) lives on `RubisDatabase.voidOrder`, matching how `auth.ts`
 * wraps `db.getStaffById`/`verifyPin` with business-rule validation and
 * a {@link ServiceResult}, rather than duplicating the transaction here.
 */

import type { RubisDatabase } from './database.js'
import type { ServiceResult } from './shopify-types.js'

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
 *     Shopify order/inventory state. Phase 11 scope (Shopify Refund API).
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
        'This order has already synced to Shopify and cannot be voided here — Shopify refund integration is Phase 11 scope'
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
