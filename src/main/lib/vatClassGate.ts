/**
 * Checkout gate for per-item VAT classes (docs/phase-194, D2 and D4).
 * Runs before anything is saved or paid, so a refused cart leaves no order
 * and no payment behind: a sale the fiscal device could only reject after
 * the customer has paid is refused up front instead.
 */

import { HS_CODE_PATTERN, resolveVatClass } from './vatClass.js'

/** The cart-line fields the gate reads. */
export interface VatClassGateLine {
  title: string
  variantTitle?: string
  vatClass?: string
  hsCode?: string
  hsName?: string
}

function itemLabel(line: VatClassGateLine): string {
  const hasRealVariant = line.variantTitle && line.variantTitle !== 'Default Title'
  return hasRealVariant ? `${line.title} (${line.variantTitle})` : line.title
}

/**
 * Finds the first line the till must refuse, and says which and why.
 *
 *   - a class the till does not know (D2): never filed as A, never sent on;
 *   - a non-A class with a blank or malformed HS code, or a blank HS name
 *     (D4): the validator in `fiscal-validate.ts` would refuse it after the
 *     sale was paid.
 *
 * @param {VatClassGateLine[]} items
 * @returns {string | null} a cashier-facing message naming the item, or `null` when every line may be sold
 */
export function findVatClassRefusal(items: VatClassGateLine[]): string | null {
  for (const item of items) {
    const label = itemLabel(item)
    const vatClass = resolveVatClass(item.vatClass)
    if (vatClass === null) {
      return `"${label}" has a tax class the till does not recognise ("${String(item.vatClass).trim()}"). Correct the product's tax class in Shopify, then try again.`
    }
    if (vatClass === 'A') continue
    if (!HS_CODE_PATTERN.test(item.hsCode?.trim() ?? '')) {
      return `"${label}" is tax class ${vatClass} but its HS code is missing or not in the form 1234.56.78. Correct the product's HS code in Shopify, then try again.`
    }
    if (!item.hsName?.trim()) {
      return `"${label}" is tax class ${vatClass} but has no HS name. Add the product's HS name in Shopify, then try again.`
    }
  }
  return null
}
