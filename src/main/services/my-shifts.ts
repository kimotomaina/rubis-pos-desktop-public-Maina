/**
 * The reads a cashier makes of their own work (docs/phase-254, C5 and C6), for the IPC handlers in `index.ts`.
 *
 * Whose work it is comes only from the session the main process holds (`lib/roleGate.ts`). The request carries a page
 * and nothing else is read from it: a staff id the screen sends is dropped by the schema and never consulted.
 */

import { shiftsListSchema, validate } from '../lib/ipcValidator.js'
import { MANAGER_NEEDED_MESSAGE } from '../lib/roleGate.js'
import { withWindow } from '../lib/shiftLabel.js'
import { resolveTraderSystemInvNum } from '../lib/traderSystemInvoiceNumber.js'
import { describePayment } from '../lib/paymentLegs.js'
import type { OrderRow, RubisDatabase, ShiftRow, StaffSummary } from './database.js'
import type { ServiceResult } from './shopify-types.js'

/** Rows per page, as the Admin Reports shift history and invoice list page them. */
export const MY_PAGE_SIZE = 10

/** Every sale: stored times are ISO strings, which sort as text between these two. */
const ALL_TIME = { startIso: '0000-01-01T00:00:00.000Z', endIso: '9999-12-31T23:59:59.999Z' }

/** One invoice-list row (docs/phase-158): an order plus its pre-computed trader invoice number. */
export interface InvoiceListRow {
  order: OrderRow
  traderInvoiceNumber: string
  /** How the sale was paid, in words: its method, or `split: …` with the payments (docs/phase-252). */
  paymentText: string
}

/** What this module reads. */
export type MyShiftsDb = Pick<
  RubisDatabase,
  'listVisibleShifts' | 'countVisibleShifts' | 'getOrderRowsForRange' | 'getOrders' | 'paymentLegsFor'
>

/**
 * The invoice list's rows: each order with its trader invoice number and how it was paid.
 *
 * @param {Pick<RubisDatabase, 'paymentLegsFor'>} db
 * @param {OrderRow[]} rows
 * @returns {InvoiceListRow[]}
 */
export function toInvoiceRows(db: Pick<RubisDatabase, 'paymentLegsFor'>, rows: OrderRow[]): InvoiceListRow[] {
  const legs = db.paymentLegsFor(rows.map((order) => order.local_id))
  return rows.map((order) => {
    let clientOrderUuid = ''
    try {
      clientOrderUuid = (JSON.parse(order.payload_json) as { clientOrderUuid?: string }).clientOrderUuid ?? ''
    } catch {
      // Defensive only — every order this app has written has a valid payload_json.
    }
    return {
      order,
      traderInvoiceNumber: resolveTraderSystemInvNum(order.fiscal_trader_inv_num, order.local_id, clientOrderUuid),
      paymentText: describePayment(legs.get(order.local_id) ?? [])
    }
  })
}

/**
 * "My shifts": the till's open shift and the shifts the person signed in opened or closed, the open one first.
 *
 * @param {MyShiftsDb} db
 * @param {StaffSummary | null} staff — the session's
 * @param {unknown} request — `{ page }`
 * @returns {ServiceResult<{ shifts: ShiftRow[]; total: number; page: number }>}
 */
export function myShifts(
  db: MyShiftsDb,
  staff: StaffSummary | null,
  request: unknown
): ServiceResult<{ shifts: ShiftRow[]; total: number; page: number }> {
  if (!staff) return { success: false, error: MANAGER_NEEDED_MESSAGE }
  const validation = validate(shiftsListSchema, request ?? {})
  if (!validation.success) return { success: false, error: validation.error }
  try {
    const { page } = validation.data
    const shifts = db.listVisibleShifts(MY_PAGE_SIZE, (page - 1) * MY_PAGE_SIZE, staff.id).map((shift) => withWindow(shift))
    return { success: true, data: { shifts, total: db.countVisibleShifts(staff.id), page } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to list your shifts' }
  }
}

/**
 * "My sales": the sales recorded under the person signed in, newest first, with what the invoice list shows.
 *
 * @param {MyShiftsDb} db
 * @param {StaffSummary | null} staff — the session's
 * @param {unknown} request — `{ page }`
 * @returns {ServiceResult<{ invoices: InvoiceListRow[]; total: number; page: number }>}
 */
export function mySales(
  db: MyShiftsDb,
  staff: StaffSummary | null,
  request: unknown
): ServiceResult<{ invoices: InvoiceListRow[]; total: number; page: number }> {
  if (!staff) return { success: false, error: MANAGER_NEEDED_MESSAGE }
  const validation = validate(shiftsListSchema, request ?? {})
  if (!validation.success) return { success: false, error: validation.error }
  try {
    const { page } = validation.data
    const { rows, total } = db.getOrderRowsForRange(
      ALL_TIME.startIso,
      ALL_TIME.endIso,
      MY_PAGE_SIZE,
      (page - 1) * MY_PAGE_SIZE,
      staff.id
    )
    return { success: true, data: { invoices: toInvoiceRows(db, rows), total, page } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to list your sales' }
  }
}

/**
 * Order History (C6): every sale for an admin, a cashier's own for a cashier, nothing with nobody signed in.
 *
 * @param {MyShiftsDb} db
 * @param {StaffSummary | null} staff — the session's
 * @param {{ limit?: number; offset?: number } | undefined} request
 * @returns {ServiceResult<OrderRow[]>}
 */
export function orderHistoryFor(
  db: MyShiftsDb,
  staff: StaffSummary | null,
  request: { limit?: number; offset?: number } | undefined
): ServiceResult<OrderRow[]> {
  if (!staff) return { success: false, error: MANAGER_NEEDED_MESSAGE }
  try {
    return { success: true, data: db.getOrders(request?.limit, request?.offset, staff.role === 'admin' ? undefined : staff.id) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to fetch orders' }
  }
}
