/**
 * "Print ETR copy at the fiscal device" (docs/phase-196-2).
 *
 * Sends `InfoLastReceiptDuplicate` for one order, only when the device's
 * last receipt is provably that order's. Issues no new fiscal document,
 * never writes the order's fiscal columns, and never touches the fiscal
 * queue or `sync_queue`: its only write is one append-only audit row,
 * whatever the outcome.
 */

import { canPrintDuplicate } from '../lib/duplicatePrintGuard.js'
import type { FiscalDuplicatePrintResult, OrderRow, RubisDatabase } from './database.js'
import type { DuplicatePrintGate, FiscalizationProvider } from './integrations/etims.js'
import type { ServiceResult } from './shopify-types.js'

/** What the caller needs from the database. */
export type FiscalDuplicatePrintDb = Pick<RubisDatabase, 'getOrder' | 'recordFiscalDuplicatePrint'>

/** Dependencies of {@link printFiscalDuplicate}. */
export interface FiscalDuplicatePrintDeps {
  db: FiscalDuplicatePrintDb
  fiscalizationProvider: FiscalizationProvider
  now?: () => Date
}

/** Returned when the command was sent. */
export interface FiscalDuplicatePrintSent {
  /** `true` when the device's last receipt number changed across the send, meaning a new document may have been issued. */
  issuedNewReceipt: boolean
}

/**
 * Order-level checks only, made before any device call: with the device
 * state set equal to the order's own number, the guard can refuse only
 * for a reason that belongs to the order.
 *
 * @param {OrderRow} order
 * @returns {string | null} the refusal sentence, or `null` when the order may proceed
 */
function orderRefusal(order: OrderRow): string | null {
  const verdict = canPrintDuplicate({
    orderCuInvoiceNumber: order.fiscal_invoice_number,
    deviceLastCuInvoiceNumber: order.fiscal_invoice_number,
    fiscalStatus: order.fiscal_status,
    queueHasInFlight: false,
    receiptOpen: false
  })
  return verdict.allowed ? null : verdict.reason
}

/**
 * @param {FiscalDuplicatePrintDeps} deps
 * @param {number} orderId
 * @param {number} staffId — the manager who authorised this print, already verified by the caller
 * @returns {Promise<ServiceResult<FiscalDuplicatePrintSent>>} success only when the command was sent
 */
export async function printFiscalDuplicate(
  deps: FiscalDuplicatePrintDeps,
  orderId: number,
  staffId: number
): Promise<ServiceResult<FiscalDuplicatePrintSent>> {
  const { db, fiscalizationProvider } = deps
  const requestedAt = (deps.now ?? (() => new Date()))().toISOString()

  /** Never throws: a failed audit write must not turn an already-sent print into a reported failure. */
  const record = (
    result: FiscalDuplicatePrintResult,
    fields: { before?: string | null; after?: string | null; error?: string | null }
  ): void => {
    try {
      db.recordFiscalDuplicatePrint({
        order_id: orderId,
        staff_id: staffId,
        requested_at: requestedAt,
        device_last_cu_inv: fields.before ?? null,
        device_last_cu_inv_after: fields.after ?? null,
        result,
        error: fields.error ?? null
      })
    } catch (err) {
      console.error(`[rubis-pos] Could not record the duplicate print of order ${orderId}:`, err)
    }
  }

  const order = db.getOrder(orderId)
  if (!order) {
    const error = `Order ${orderId} not found`
    record('refused', { error })
    return { success: false, error }
  }
  const early = orderRefusal(order)
  if (early) {
    record('refused', { error: early })
    return { success: false, error: early }
  }

  const gate: DuplicatePrintGate = (state) =>
    canPrintDuplicate({
      orderCuInvoiceNumber: order.fiscal_invoice_number,
      deviceLastCuInvoiceNumber: state.deviceLastCuInvoiceNumber,
      fiscalStatus: order.fiscal_status,
      queueHasInFlight: state.queueHasInFlight,
      receiptOpen: state.receiptOpen
    })

  let outcome
  try {
    outcome = await fiscalizationProvider.printLastReceiptDuplicate(gate)
  } catch (err) {
    const error = err instanceof Error ? err.message : 'The duplicate print failed unexpectedly'
    record('error', { error })
    return { success: false, error }
  }

  if (outcome.status === 'refused') {
    record('refused', { before: outcome.deviceLastBefore, error: outcome.reason })
    return { success: false, error: outcome.reason }
  }
  if (outcome.status === 'error') {
    record('error', { before: outcome.deviceLastBefore, error: outcome.reason })
    return { success: false, error: outcome.reason }
  }
  record('sent', { before: outcome.deviceLastBefore, after: outcome.deviceLastAfter })
  return {
    success: true,
    data: {
      issuedNewReceipt: outcome.deviceLastAfter !== null && outcome.deviceLastAfter !== outcome.deviceLastBefore
    }
  }
}
