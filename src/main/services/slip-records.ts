/**
 * What the till writes down about a sale's slips around one print
 * (docs/phase-198-1): which stamps the slips carry, and what is recorded once
 * they have printed. Kept apart from the `receipt:print` handler so the rules
 * are tested directly.
 */

import type { OrderRow, ReceiptReprintSlip } from './database.js'
import type { OrderSlipsResult } from './printer.js'
import { physicallyPrintedSlips, shouldMarkReceiptPrinted } from './printer.js'

/** The slice of the database these rules use. */
export interface SlipRecordsDb {
  hasReceiptPrinted(localId: number): boolean
  markReceiptPrinted(localId: number): void
  markCustomerSlipPrinted(localId: number): void
  recordReceiptReprint(row: { order_id: number; slip: ReceiptReprintSlip; staff_id: number | null }): void
}

/**
 * Which slips are stamped "DUPLICATE" at the moment of printing.
 *
 * The fiscal-side slip follows `receipt_printed_at` (set once the fiscal receipt
 * reached paper); the Enjoy slip follows `customer_slip_printed_at` (set once
 * that slip reached paper). Each is decided from its own record, never from
 * which button was pressed.
 *
 * @param {SlipRecordsDb} db
 * @param {OrderRow} order the order as read before this print
 * @returns {{ isDuplicate: boolean; customerSlipIsDuplicate: boolean }}
 */
export function slipStamps(
  db: Pick<SlipRecordsDb, 'hasReceiptPrinted'>,
  order: OrderRow
): { isDuplicate: boolean; customerSlipIsDuplicate: boolean } {
  return {
    isDuplicate: db.hasReceiptPrinted(order.local_id),
    customerSlipIsDuplicate: Boolean(order.customer_slip_printed_at)
  }
}

/**
 * Records what one print achieved: the fiscal slip's first physical print
 * (docs/phase-164-1), the customer slip's first physical print, and, for an
 * Order History reprint, one `receipt_reprints` row per slip that reached
 * paper. A PDF fallback or a failure records nothing, and the Needs Attention
 * print of a late-filed sale (`fiscalOnly`) is a first print, not a reprint.
 *
 * @param {SlipRecordsDb} db
 * @param {OrderRow} order
 * @param {OrderSlipsResult} printed
 * @param {object} options
 * @param {boolean} [options.auto] the automatic end-of-sale print
 * @param {boolean} [options.fiscalOnly] only the fiscal slip was asked for
 * @param {number} [options.staffId] the cashier signed in
 */
export function recordSlipOutcome(
  db: SlipRecordsDb,
  order: OrderRow,
  printed: OrderSlipsResult,
  options: { auto?: boolean; fiscalOnly?: boolean; staffId?: number }
): void {
  if (printed.fiscal && shouldMarkReceiptPrinted(printed.fiscal, order.fiscal_invoice_number)) {
    db.markReceiptPrinted(order.local_id)
  }
  if (printed.customer?.success && printed.customer.data?.mode !== 'pdf') {
    db.markCustomerSlipPrinted(order.local_id)
  }
  if (!options.auto && !options.fiscalOnly) {
    for (const slip of physicallyPrintedSlips(printed)) {
      db.recordReceiptReprint({ order_id: order.local_id, slip, staff_id: options.staffId ?? null })
    }
  }
}
