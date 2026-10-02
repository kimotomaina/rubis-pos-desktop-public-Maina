/**
 * The sales whose stored device VAT figures disagree with the till's own
 * (docs/phase-198-1), for the Needs Attention list "VAT figures to reconcile".
 *
 * Worked out when asked, from what is stored, rather than flagged once and
 * remembered: when the live test settles how the device reports its group
 * amounts and the reading changes, the list changes with it.
 */

import type { OfflineOrderPayload } from './shopify-types.js'
import { computeReceiptTotals } from '../lib/receiptTotals.js'
import { reconcileVatGroups } from '../lib/vatReconcile.js'
import type { FiscalVatGroupAmounts } from './integrations/etims.js'

/** The stored order fields the check reads (see `RubisDatabase.getFiscalisedOrdersWithVatGroups`). */
export interface VatReconcileOrderRow {
  local_id: number
  created_at: string
  total: number
  staff_name: string | null
  payload_json: string
  fiscal_request_json: string | null
  fiscal_vat_groups_json: string
}

/** One sale whose VAT figures disagree. */
export interface VatMismatchRow {
  local_id: number
  created_at: string
  total: number
  staff_name: string | null
  /** The VAT the stored device groups add up to, read as net. */
  group_vat: number
  /** The VAT the till worked out. */
  till_vat: number
  diff: number
}

const SILENT = { warn: () => undefined }

/**
 * Runs the reconcile over each order and returns those that disagree, oldest
 * first. An order whose stored JSON cannot be read is left out: it cannot be
 * compared, and one bad row must not hide the others.
 *
 * @param {VatReconcileOrderRow[]} rows
 * @param {number} taxRate the till's fractional VAT rate (0.16)
 * @returns {VatMismatchRow[]}
 */
export function findVatMismatches(rows: VatReconcileOrderRow[], taxRate: number): VatMismatchRow[] {
  const mismatches: VatMismatchRow[] = []
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload_json) as OfflineOrderPayload
      const groups = JSON.parse(row.fiscal_vat_groups_json) as FiscalVatGroupAmounts
      const request = row.fiscal_request_json
        ? (JSON.parse(row.fiscal_request_json) as { items?: Array<{ vatClass?: string }> })
        : {}
      const totals = computeReceiptTotals(
        {
          localId: row.local_id,
          lineItems: payload.lineItems.map((line, index) => ({
            unitPrice: line.unitPrice,
            quantity: line.quantity,
            discount: line.discount,
            vatClass: request.items?.[index]?.vatClass
          })),
          cartDiscount: payload.cartDiscount,
          total: row.total
        },
        taxRate,
        SILENT
      )
      const check = reconcileVatGroups(groups, totals)
      if (!check.consistent) {
        mismatches.push({
          local_id: row.local_id,
          created_at: row.created_at,
          total: row.total,
          staff_name: row.staff_name,
          group_vat: check.groupVat,
          till_vat: check.tillVat,
          diff: check.diff
        })
      }
    } catch {
      continue
    }
  }
  return mismatches
}
