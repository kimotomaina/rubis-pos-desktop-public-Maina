/**
 * Holding a sale and serving the next customer (docs/phase-217).
 *
 * A held sale is not a sale: nothing here files anything with the tax device,
 * queues anything for Shopify, moves stock or takes a trader invoice number.
 * It is the cart, parked in the till's own database until it is completed or
 * discarded.
 */

import { requireAdminPin } from '../lib/requireAdminPin.js'
import { closeTiming } from '../lib/shiftRules.js'
import { shiftWindowOf } from '../lib/shiftWindows.js'
import type { HeldSaleSummary, HoldSaleInput, RubisDatabase, ShiftCloseResult } from './database.js'
import type { ServiceResult } from './shopify-types.js'

/**
 * Why a shift may not be closed yet (docs/phase-232, S2), or `null` when it may: no shift closes before its window's
 * last minute begins, for anyone. A missing shift is left to `closeShift`, which says so.
 *
 * @param {CloseShiftDb} db
 * @param {number} shiftId
 * @param {number} nowMs
 * @returns {string | null}
 */
function closeTimingFor(db: CloseShiftDb, shiftId: number, nowMs: number): string | null {
  const shift = db.getShiftById(shiftId)
  if (!shift || shift.status !== 'open') return null
  return closeTiming(shift.clock_in, shiftWindowOf(shift.clock_in), nowMs).message
}

/** What {@link closeShiftUnlessHeld} needs from the database. */
export type CloseShiftDb = Pick<RubisDatabase, 'closeShift' | 'listOpenHeldSales' | 'getShiftById'>

/**
 * Closes the shift, unless a sale is held or resumed (docs/phase-217): a held sale left at
 * shift end is the forgotten sale. The Admin screen says so first; this is the check that
 * cannot be skipped, because it runs in the main process.
 *
 * @param {CloseShiftDb} db
 * @param {number} shiftId
 * @param {number} endingCash
 * @param {number | null} [mpesaClosingBalance] — the M-Pesa till balance if it was read (docs/phase-222)
 * @param {number} [nowMs] — the clock; the main process's own
 * @returns {ServiceResult<ShiftCloseResult>}
 */
export function closeShiftUnlessHeld(
  db: CloseShiftDb,
  shiftId: number,
  endingCash: number,
  mpesaClosingBalance: number | null = null,
  nowMs: number = Date.now()
): ServiceResult<ShiftCloseResult> {
  const timing = closeTimingFor(db, shiftId, nowMs)
  if (timing !== null) {
    return { success: false, error: timing }
  }
  const open = db.listOpenHeldSales()
  if (open.length > 0) {
    const list = open.map((sale) => sale.label).join(', ')
    return {
      success: false,
      error: `${open.length === 1 ? '1 sale is' : `${open.length} sales are`} on hold (${list}). Complete or discard ${open.length === 1 ? 'it' : 'them'} before closing the shift.`
    }
  }
  try {
    return { success: true, data: db.closeShift(shiftId, endingCash, mpesaClosingBalance) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to close shift' }
  }
}

/** What this module needs from the database. */
export type HeldSalesDb = Pick<
  RubisDatabase,
  'getStaffById' | 'holdSale' | 'resumeHeldSale' | 'renameHeldSale' | 'discardHeldSale' | 'listOpenHeldSales'
>

/** The validated `held:hold` request: the cart as the renderer holds it. */
export interface HoldRequest {
  cartToken: string
  staffId: number
  total: number
  label?: string
  items: Array<{ quantity: number }>
  cartDiscount?: unknown
  customerPin?: string
  companyName?: string
}

/**
 * @param {HeldSalesDb} db
 * @param {HoldRequest} request
 * @returns {ServiceResult<HeldSaleSummary>} failure, with nothing written, when the till already holds the most
 */
export function holdCart(db: HeldSalesDb, request: HoldRequest): ServiceResult<HeldSaleSummary> {
  const input: HoldSaleInput = {
    cartToken: request.cartToken,
    payloadJson: JSON.stringify({
      items: request.items,
      cartDiscount: request.cartDiscount,
      customerPin: request.customerPin,
      companyName: request.companyName
    }),
    total: request.total,
    lineCount: request.items.length,
    unitCount: request.items.reduce((sum, item) => sum + item.quantity, 0),
    staffId: request.staffId,
    label: request.label
  }
  try {
    return { success: true, data: db.holdSale(input) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Could not hold the sale' }
  }
}

/** The validated `held:discard` request. */
export interface DiscardRequest {
  id: number
  staffId: number
  managerId: number
  managerPin: string
  reason: string
}

/**
 * Discards a held sale. The manager's PIN is re-verified here, in the main
 * process, before anything is written, so a renderer cannot forge the approval.
 *
 * @param {HeldSalesDb} db
 * @param {DiscardRequest} request
 * @returns {ServiceResult<HeldSaleSummary>}
 */
export function discardHeldSaleApproved(db: HeldSalesDb, request: DiscardRequest): ServiceResult<HeldSaleSummary> {
  const authz = requireAdminPin(db as RubisDatabase, request.managerId, request.managerPin)
  if (!authz.success) {
    return { success: false, error: authz.error }
  }
  try {
    return {
      success: true,
      data: db.discardHeldSale({
        id: request.id,
        staffId: request.staffId,
        managerId: request.managerId,
        reason: request.reason
      })
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Could not discard the sale' }
  }
}
