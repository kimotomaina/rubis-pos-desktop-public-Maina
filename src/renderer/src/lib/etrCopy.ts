/**
 * Which Order History rows may offer "Print ETR copy" (docs/phase-196-2).
 *
 * The device can only reprint the last receipt it issued, so only the
 * newest filed order on this till is offered. This is a hint to save a
 * pointless PIN prompt: the main process re-checks against the device's
 * own last receipt number before anything is sent.
 */

import type { OrderRow } from '../../../main/services/database.js'
import { parseFiscalTimestamp } from './fiscalDate.js'

/** Shown on a row that has no filed receipt. Same wording the main-process guard uses. */
export const ETR_COPY_NOT_FILED_REASON =
  'This sale has not been filed with KRA, so there is no receipt to copy.'

/** Shown on a filed row that is not the newest filed order. */
export const ETR_COPY_NOT_LATEST_REASON =
  'Only the most recent receipt can be reprinted. A later sale has been filed since.'

/** Whether a row may offer the action, and why not when it may not. */
export interface EtrCopyEligibility {
  enabled: boolean
  reason: string | null
}

/**
 * @param {OrderRow} order
 * @returns {boolean} whether the order has a filed receipt on record
 */
const isFiled = (order: OrderRow): boolean =>
  order.fiscal_status === 'fiscalized' && !!order.fiscal_invoice_number

/**
 * Orders compare by filing time, then by local id when the times tie or are unreadable.
 *
 * @param {OrderRow} a
 * @param {OrderRow} b
 * @returns {number} positive when `a` was filed after `b`
 */
function byFiledOrder(a: OrderRow, b: OrderRow): number {
  const aTime = parseFiscalTimestamp(a.fiscal_fiscalized_at)?.getTime() ?? 0
  const bTime = parseFiscalTimestamp(b.fiscal_fiscalized_at)?.getTime() ?? 0
  return aTime - bTime || a.local_id - b.local_id
}

/**
 * @param {OrderRow[]} orders every order the screen has loaded
 * @param {OrderRow} order the row being rendered
 * @returns {EtrCopyEligibility}
 */
export function getEtrCopyEligibility(orders: OrderRow[], order: OrderRow): EtrCopyEligibility {
  if (!isFiled(order)) return { enabled: false, reason: ETR_COPY_NOT_FILED_REASON }

  const newest = orders.filter(isFiled).reduce((best, next) => (byFiledOrder(next, best) > 0 ? next : best))
  if (newest.local_id !== order.local_id) {
    return { enabled: false, reason: ETR_COPY_NOT_LATEST_REASON }
  }
  return { enabled: true, reason: null }
}
