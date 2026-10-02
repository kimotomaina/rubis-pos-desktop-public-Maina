/**
 * The fiscal slip of a sale the fiscal queue files after the customer has
 * left (docs/phase-198).
 *
 * At checkout such a sale printed a "sale record" slip and the Enjoy customer
 * slip saying the tax invoice would follow. When the queue later files it, the
 * fiscal slip is printed once, as the ORIGINAL, with no customer slip. The
 * single guard is `receipt_printed_at`: a slip already on paper is never
 * printed again here. When it cannot be printed the sale is flagged for the
 * Needs Attention list and nothing retries it.
 */

import type { OrderRow } from './database.js'
import type { ServiceResult } from './shopify-types.js'
import type { ReceiptPrintResult } from './printer.js'
import { shouldMarkReceiptPrinted } from './printer.js'
import type { Logger } from './logger.js'

/** The slice of the database this needs. */
export interface LateFiledSlipDb {
  getOrder(localId: number): OrderRow | undefined
  hasReceiptPrinted(localId: number): boolean
  markReceiptPrinted(localId: number): void
  markFiscalSlipUnprinted(localId: number): void
}

/** Dependencies of {@link printLateFiledSlip}. */
export interface LateFiledSlipDeps {
  db: LateFiledSlipDb
  /** Prints the fiscal-side slip of `order` as the original, and nothing else. */
  printFiscalSlip: (order: OrderRow) => Promise<ServiceResult<ReceiptPrintResult>>
  logger?: Logger
}

/**
 * Prints the fiscal slip of a just-filed sale. Never throws.
 *
 * @param {LateFiledSlipDeps} deps
 * @param {number} localId
 * @returns {Promise<void>}
 */
export async function printLateFiledSlip(deps: LateFiledSlipDeps, localId: number): Promise<void> {
  const { db } = deps
  const logger = deps.logger ?? console
  try {
    const order = db.getOrder(localId)
    if (!order || order.fiscal_status !== 'fiscalized' || db.hasReceiptPrinted(localId)) return
    const result = await deps.printFiscalSlip(order)
    if (shouldMarkReceiptPrinted(result, order.fiscal_invoice_number)) {
      db.markReceiptPrinted(localId)
      return
    }
    db.markFiscalSlipUnprinted(localId)
    logger.warn(`[rubis-pos] Sale ${localId}: filed later, but its fiscal slip did not print; flagged in Needs Attention`)
  } catch (err) {
    logger.warn(
      `[rubis-pos] Sale ${localId}: filed later; printing its fiscal slip failed — ${err instanceof Error ? err.message : String(err)}`
    )
    try {
      db.markFiscalSlipUnprinted(localId)
    } catch {
      // The flag could not be written either; the sale is filed, and Order History still prints it.
    }
  }
}
