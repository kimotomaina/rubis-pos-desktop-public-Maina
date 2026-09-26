/**
 * CSV export for the Admin Reports screen (docs/phase-158).
 *
 * Two files per preset: `orders.csv` (one row per order) and
 * `lines.csv` (one row per line item, parsed from `payload_json`).
 * Read-only against the local database — no fiscal or payment code is
 * touched, and nothing is sent anywhere.
 */

import type { RubisDatabase, MpesaPaymentRow, OrderRow } from './database.js'
import type { OfflineOrderPayload } from './shopify-types.js'
import { buildCsv, csvMoney } from '../lib/csv.js'
import { buildTraderSystemInvNum } from '../lib/traderSystemInvoiceNumber.js'
import { computeVatIncluded, formatNairobiDateTime, type ReportRange } from './reports.js'

/**
 * Parses an order's stored offline payload, tolerating a malformed or
 * missing value (defensive only — every order this app has ever written
 * has a valid `payload_json`) rather than throwing partway through an
 * export.
 *
 * @param {OrderRow} order
 * @returns {OfflineOrderPayload | null}
 */
function parsePayload(order: OrderRow): OfflineOrderPayload | null {
  try {
    return JSON.parse(order.payload_json) as OfflineOrderPayload
  } catch {
    return null
  }
}

/**
 * Builds `orders.csv` for one report range: one row per order, including
 * voided ones (marked `voided` rather than dropped, so the export is a
 * complete record). No device password, PIN, token, or other secret is
 * ever a column here — only whether a customer KRA PIN was captured
 * (yes/no), never the PIN itself.
 *
 * @param {RubisDatabase} db
 * @param {ReportRange} range
 * @param {number} taxRate
 * @returns {string} CSV text, UTF-8 with BOM
 */
export function buildOrdersCsv(db: RubisDatabase, range: ReportRange, taxRate: number): string {
  const orders = db.getOrdersForDateRange(range.startIso, range.endIso)
  const payments = db.getMpesaPaymentsForDateRange(range.startIso, range.endIso)

  const paymentByOrder = new Map<number, MpesaPaymentRow>()
  for (const payment of payments) {
    if (!paymentByOrder.has(payment.order_local_id)) {
      paymentByOrder.set(payment.order_local_id, payment)
    }
  }

  const staffNameCache = new Map<number, string>()
  const staffName = (staffId: number | null): string => {
    if (staffId === null) return ''
    const cached = staffNameCache.get(staffId)
    if (cached !== undefined) return cached
    const name = db.getStaffById(staffId)?.name ?? 'Unknown'
    staffNameCache.set(staffId, name)
    return name
  }

  const header = [
    'Date and time (Nairobi)',
    'Trader invoice number',
    'CU invoice number',
    'Fiscal status',
    'Cashier',
    'Payment method',
    'M-Pesa code',
    'M-Pesa mode',
    'Total',
    'VAT included',
    'Shift id',
    'Order status',
    'Shopify order id',
    'Sync status',
    'Customer KRA PIN present'
  ]

  const rows = orders.map((order) => {
    const payload = parsePayload(order)
    const payment = paymentByOrder.get(order.local_id)
    return [
      formatNairobiDateTime(order.created_at),
      buildTraderSystemInvNum(order.local_id, payload?.clientOrderUuid ?? ''),
      order.fiscal_invoice_number ?? '',
      order.fiscal_status ?? '',
      staffName(order.staff_id),
      order.payment_method ?? '',
      payment?.reference ?? '',
      payment?.mode ?? '',
      csvMoney(order.total),
      csvMoney(computeVatIncluded(order.total, taxRate)),
      order.shift_id ?? '',
      order.status === 'voided' ? 'voided' : 'completed',
      order.shopify_order_id ?? '',
      order.status,
      payload?.customerPin?.trim() ? 'yes' : 'no'
    ]
  })

  return buildCsv(header, rows)
}

/**
 * Builds `lines.csv` for one report range: one row per line item, read
 * from each order's `payload_json` (there is no dedicated line-items
 * table — docs/phase-157 Part 2). Orders whose payload fails to parse
 * contribute no rows (defensive only, see {@link parsePayload}).
 *
 * @param {RubisDatabase} db
 * @param {ReportRange} range
 * @returns {string} CSV text, UTF-8 with BOM
 */
export function buildLinesCsv(db: RubisDatabase, range: ReportRange): string {
  const orders = db.getOrdersForDateRange(range.startIso, range.endIso)

  const header = [
    'Trader invoice number',
    'Variant id',
    'Title',
    'Variant title',
    'Quantity',
    'Unit price',
    'Line discount'
  ]

  const rows: Array<Array<string | number>> = []
  for (const order of orders) {
    const payload = parsePayload(order)
    if (!payload) continue
    const traderInvNum = buildTraderSystemInvNum(order.local_id, payload.clientOrderUuid)
    for (const line of payload.lineItems) {
      rows.push([
        traderInvNum,
        line.variantId,
        line.title,
        line.variantTitle,
        line.quantity,
        csvMoney(line.unitPrice),
        line.discount ? `${line.discount.type} ${line.discount.value}` : ''
      ])
    }
  }

  return buildCsv(header, rows)
}
