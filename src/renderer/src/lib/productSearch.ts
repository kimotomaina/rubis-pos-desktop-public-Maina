import type { ProductSummary } from '../types/shopify.js'

/**
 * Filters a product list by a free-text query, matching case-insensitively
 * against the product title, any variant title, or any variant barcode
 * (substring match, so a partially typed/scanned barcode still narrows
 * results progressively rather than requiring the full code).
 *
 * @param {ProductSummary[]} products
 * @param {string} query
 * @returns {ProductSummary[]}
 */
export function filterProducts(products: ProductSummary[], query: string): ProductSummary[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return products

  return products.filter((product) => {
    if (product.title.toLowerCase().includes(needle)) return true
    return product.variants.some(
      (variant) =>
        variant.title.toLowerCase().includes(needle) ||
        (variant.barcode?.toLowerCase().includes(needle) ?? false)
    )
  })
}
