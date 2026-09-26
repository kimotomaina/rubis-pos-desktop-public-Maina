/**
 * Receipt totals — the printed subtotal/discount/total/VAT figures for
 * one order, shared by `printer.ts`'s `renderReceipt` and
 * `pdf-receipt.ts`'s `generatePdfReceipt` (docs/phase-160 Part A,
 * docs/phase-161 Commit 2, go-live plan Item 3).
 *
 * Before this module, both renderers independently recomputed
 * `subtotal = Σ unitPrice × quantity` and `tax = subtotal × rate`,
 * ignoring every discount/override and adding tax on top of an
 * already-VAT-inclusive price (docs/phase-159). `total` here is never
 * recomputed — it is always the order's own stored total, the amount
 * actually charged, so the printed figure can never drift from it the
 * way the old per-file math could.
 */

import type { Discount } from '../services/shopify-types.js'
import { computeVatIncluded } from '../services/reports.js'

/** One line item's contribution to the receipt totals. */
export interface ReceiptTotalsLineItem {
  unitPrice: number
  quantity: number
  discount?: Discount
}

/** The stored order data {@link computeReceiptTotals} needs. */
export interface ReceiptTotalsOrder {
  /** Used only to identify the order in the reconciliation warning below. */
  localId: number
  lineItems: ReceiptTotalsLineItem[]
  cartDiscount?: Discount
  /** The amount actually charged — printed verbatim as `total`, never recomputed. */
  total: number
}

/** The printed receipt figures. */
export interface ReceiptTotals {
  /** Sum of every line's `unitPrice × quantity`, before any discount. */
  rawSubtotal: number
  /** Total reduction from every line discount plus the cart discount. */
  discountTotal: number
  /** The order's own stored total — never recomputed from the lines. */
  total: number
  /** VAT already included in `total` (docs/phase-158's extraction, not added on top). */
  vatIncluded: number
}

/** Minimal logging surface, matching `fiscal-provider-factory.ts`'s own `FiscalProviderLogger` shape. */
export interface ReceiptTotalsLogger {
  warn(message: string): void
}

/** A reconciliation mismatch beyond this is logged rather than silently printed. */
const RECONCILIATION_TOLERANCE = 0.01

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * The amount one discount removes from `base`, floored so a discount
 * can never remove more than the base itself — the same clamp
 * `applyDiscount` (`renderer/src/lib/checkoutMath.ts`) uses, reimplemented
 * here because that file is renderer-side and this module is main-side
 * (docs/phase-158-1 accepted the same small, one-formula duplication
 * across this boundary for `formatVatRateLabel`, for the same reason).
 *
 * @param {number} base
 * @param {Discount} [discount]
 * @returns {number}
 */
function discountAmount(base: number, discount?: Discount): number {
  if (!discount || !(discount.value > 0)) return 0
  const reduction = discount.type === 'percent' ? base * (discount.value / 100) : discount.value
  return Math.min(reduction, base)
}

/**
 * Computes the printed subtotal/discount/total/VAT for one order.
 *
 * `total` is always `order.total` — the amount actually charged at
 * checkout — never recomputed from `lineItems`. `rawSubtotal` and
 * `discountTotal` are derived independently, purely to show the
 * customer what was discounted; if they don't reconcile against
 * `total` to within a cent (a sign of stale or malformed stored data,
 * not something this function should silently paper over or block a
 * receipt on), a warning is logged with the order id and `total` is
 * still returned and printed as the stored figure.
 *
 * @param {ReceiptTotalsOrder} order
 * @param {number} vatRate — fractional VAT rate (0.16 = 16%)
 * @param {ReceiptTotalsLogger} [logger] — defaults to `console`
 * @returns {ReceiptTotals}
 */
export function computeReceiptTotals(
  order: ReceiptTotalsOrder,
  vatRate: number,
  logger: ReceiptTotalsLogger = console
): ReceiptTotals {
  const rawSubtotal = round2(
    order.lineItems.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0)
  )

  let discountTotal = 0
  let afterLineDiscounts = 0
  for (const line of order.lineItems) {
    const lineRaw = line.unitPrice * line.quantity
    const lineDiscount = discountAmount(lineRaw, line.discount)
    discountTotal += lineDiscount
    afterLineDiscounts += lineRaw - lineDiscount
  }
  discountTotal += discountAmount(afterLineDiscounts, order.cartDiscount)
  discountTotal = round2(discountTotal)

  const expectedTotal = round2(rawSubtotal - discountTotal)
  if (Math.abs(expectedTotal - order.total) > RECONCILIATION_TOLERANCE) {
    logger.warn(
      `[rubis-pos] Order ${order.localId}: receipt totals do not reconcile - raw subtotal ` +
        `${rawSubtotal} minus discounts ${discountTotal} = ${expectedTotal}, but the order's ` +
        `stored total is ${order.total}. Printing the stored total regardless.`
    )
  }

  return {
    rawSubtotal,
    discountTotal,
    total: order.total,
    vatIncluded: computeVatIncluded(order.total, vatRate)
  }
}
