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
import type { FiscalVatGroupAmounts } from './integrations/etims.js'
import { buildCsv, csvMoney } from '../lib/csv.js'
import { describePayment } from '../lib/paymentLegs.js'
import { resolveTraderSystemInvNum } from '../lib/traderSystemInvoiceNumber.js'
import { computeVatIncluded, formatNairobiDateTime, buildReconciliationRow, orderVatBase, type ReportRange } from './reports.js'

/** `'A'`..`'E'`, in column order, for the raw per-VAT-group `orders.csv` columns. */
const VAT_GROUP_COLUMN_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const

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
 * The reconciliation columns (docs/phase-163, Commit 2) reuse
 * {@link buildReconciliationRow} — the same figures the fiscal
 * reconciliation report shows — and are blank for an order that was
 * never fiscalized. The five VAT-group columns are the raw device
 * strings verbatim (blank when the device never reported that group),
 * independent of whether the order fiscalized cleanly.
 *
 * @param {RubisDatabase} db
 * @param {ReportRange} range
 * @param {number} taxRate
 * @returns {string} CSV text, UTF-8 with BOM
 */
export function buildOrdersCsv(db: RubisDatabase, range: ReportRange, taxRate: number): string {
  const orders = db.getOrdersForDateRange(range.startIso, range.endIso)
  const payments = db.getMpesaPaymentsForDateRange(range.startIso, range.endIso)
  // docs/phase-250: the payment method column comes from the sale's legs; a split sale shows them all (docs/phase-252).
  const legs = db.paymentLegsFor(orders.map((order) => order.local_id))

  // docs/phase-252: a split sale can have more than one M-Pesa payment; each column lists them all, joined. A sale with
  // one shows it alone, as before.
  const paymentsByOrder = new Map<number, MpesaPaymentRow[]>()
  for (const payment of payments) {
    const list = paymentsByOrder.get(payment.order_local_id)
    if (list) list.push(payment)
    else paymentsByOrder.set(payment.order_local_id, [payment])
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
    'Customer KRA PIN present',
    'Client order UUID',
    // docs/phase-163, Commit 2 — the fiscal reconciliation figures, blank
    // for an order that was never fiscalized (nothing to reconcile yet).
    'Device total',
    'Difference',
    'Reconciliation status',
    'VAT group A',
    'VAT group B',
    'VAT group C',
    'VAT group D',
    'VAT group E'
  ]

  const rows = orders.map((order) => {
    const payload = parsePayload(order)
    const orderPayments = paymentsByOrder.get(order.local_id) ?? []
    const reconciliation = order.fiscal_status === 'fiscalized' ? buildReconciliationRow(order, console) : null
    const rawGroups: FiscalVatGroupAmounts = order.fiscal_vat_groups_json
      ? (JSON.parse(order.fiscal_vat_groups_json) as FiscalVatGroupAmounts)
      : {}
    return [
      formatNairobiDateTime(order.created_at),
      resolveTraderSystemInvNum(order.fiscal_trader_inv_num, order.local_id, payload?.clientOrderUuid ?? ''),
      order.fiscal_invoice_number ?? '',
      order.fiscal_status ?? '',
      staffName(order.staff_id),
      describePayment(legs.get(order.local_id) ?? []),
      orderPayments.map((payment) => payment.reference).join(' + '),
      orderPayments.map((payment) => payment.mode).join(' + '),
      csvMoney(order.total),
      csvMoney(computeVatIncluded(orderVatBase(order), taxRate)),
      order.shift_id ?? '',
      order.status === 'voided' ? 'voided' : 'completed',
      order.shopify_order_id ?? '',
      order.status,
      payload?.customerPin?.trim() ? 'yes' : 'no',
      // Same value orders.ts sends Shopify as the `client_order_uuid`
      // customAttribute/metafield (docs/phase-158-1) — the offline
      // dedup key, useful here for cross-referencing this row against
      // the matching Shopify order.
      payload?.clientOrderUuid ?? '',
      reconciliation?.deviceTotal !== null && reconciliation?.deviceTotal !== undefined
        ? csvMoney(reconciliation.deviceTotal)
        : '',
      reconciliation?.difference !== null && reconciliation?.difference !== undefined
        ? csvMoney(reconciliation.difference)
        : '',
      reconciliation?.status ?? '',
      ...VAT_GROUP_COLUMN_LETTERS.map((letter) => rawGroups[letter] ?? '')
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
    const traderInvNum = resolveTraderSystemInvNum(order.fiscal_trader_inv_num, order.local_id, payload.clientOrderUuid)
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
