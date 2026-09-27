/**
 * `posSearch.ts` tests — `hasMoreMatches` (docs/phase-166 Commit E4).
 *
 * Pure, framework-free logic, tested directly without mounting
 * `PosSearchBar` — same convention as `productSearch.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import { AUTOCOMPLETE_MAX_RESULTS, hasMoreMatches } from '../src/renderer/src/lib/posSearch.js'
import type { ProductSummary } from '../src/renderer/src/types/shopify.js'

function makeProduct(id: string, title: string): ProductSummary {
  return {
    id,
    title,
    handle: title.toLowerCase().replace(/\s+/g, '-'),
    featuredImage: null,
    variants: [
      {
        id: `${id}-variant`,
        productId: id,
        title: 'Default',
        price: 10,
        availableForSale: true,
        inventoryQuantity: 5,
        image: null,
        barcode: null
      }
    ]
  }
}

describe('hasMoreMatches', () => {
  it('is false for a blank query', () => {
    expect(hasMoreMatches([], '  ')).toBe(false)
  })

  it('is false when the match count is within the cap', () => {
    const products = [makeProduct('1', 'RUBIS Mug'), makeProduct('2', 'RUBIS Cup')]
    expect(hasMoreMatches(products, 'RUBIS')).toBe(false)
  })

  it('is false when the match count exactly equals the cap', () => {
    const products = Array.from({ length: AUTOCOMPLETE_MAX_RESULTS }, (_, i) =>
      makeProduct(String(i), `RUBIS Item ${i}`)
    )
    expect(hasMoreMatches(products, 'RUBIS')).toBe(false)
  })

  it('is true when the match count exceeds the cap', () => {
    const products = Array.from({ length: AUTOCOMPLETE_MAX_RESULTS + 1 }, (_, i) =>
      makeProduct(String(i), `RUBIS Item ${i}`)
    )
    expect(hasMoreMatches(products, 'RUBIS')).toBe(true)
  })

  it('respects a custom limit', () => {
    const products = [makeProduct('1', 'RUBIS Mug'), makeProduct('2', 'RUBIS Cup')]
    expect(hasMoreMatches(products, 'RUBIS', 1)).toBe(true)
  })
})
