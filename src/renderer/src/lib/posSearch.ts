/**
 * Pure matching logic behind `PosSearchBar` — kept framework-free so
 * it's directly unit-testable without mounting the component, mirroring
 * `productSearch.ts`/`checkoutMath.ts`'s existing pattern in this
 * codebase.
 */

import type { ProductSummary, VariantSummary } from '../types/shopify.js'
import { filterProducts } from './productSearch.js'

/** A product/variant pair resolved from an exact barcode match. */
export interface BarcodeMatch {
  product: ProductSummary
  variant: VariantSummary
}

/**
 * Finds the first variant across `products` whose barcode exactly
 * equals `code` — used to add-to-cart immediately on a scanner's
 * Enter keystroke, before falling back to the fuzzy autocomplete list.
 *
 * @param {ProductSummary[]} products
 * @param {string} code
 * @returns {BarcodeMatch | undefined}
 */
export function findVariantByBarcode(products: ProductSummary[], code: string): BarcodeMatch | undefined {
  const needle = code.trim()
  if (!needle) return undefined
  for (const product of products) {
    const variant = product.variants.find((v) => v.barcode === needle)
    if (variant) return { product, variant }
  }
  return undefined
}

/** Maximum rows shown in the autocomplete dropdown. */
export const AUTOCOMPLETE_MAX_RESULTS = 5

/**
 * Text-matched autocomplete results for `query`, capped at `limit`
 * (default {@link AUTOCOMPLETE_MAX_RESULTS}). Returns an empty list
 * for a blank query — the dropdown has nothing useful to show for it.
 *
 * @param {ProductSummary[]} products
 * @param {string} query
 * @param {number} [limit]
 * @returns {ProductSummary[]}
 */
export function getAutocompleteMatches(
  products: ProductSummary[],
  query: string,
  limit: number = AUTOCOMPLETE_MAX_RESULTS
): ProductSummary[] {
  if (!query.trim()) return []
  return filterProducts(products, query).slice(0, limit)
}

/**
 * Picks the variant to add for a single-variant product, or `undefined`
 * for a multi-variant product that needs the variant picker instead —
 * the same "only one choice, skip the modal" rule
 * `VariantModal`'s caller already applies manually in `App.tsx`.
 *
 * @param {ProductSummary} product
 * @returns {VariantSummary | undefined}
 */
export function resolveSingleVariant(product: ProductSummary): VariantSummary | undefined {
  return product.variants.length === 1 ? product.variants[0] : undefined
}
