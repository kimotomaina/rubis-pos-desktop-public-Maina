import { describe, it, expect } from 'vitest'
import { filterProducts } from '../src/renderer/src/lib/productSearch.js'
import type { ProductSummary } from '../src/renderer/src/types/shopify.js'

function makeProduct(overrides: Partial<ProductSummary> = {}): ProductSummary {
  return {
    id: 'gid://shopify/Product/1',
    title: 'RUBIS Mug',
    handle: 'rubis-mug',
    featuredImage: null,
    variants: [
      {
        id: 'gid://shopify/ProductVariant/1',
        productId: '1',
        title: 'Small',
        price: 12.5,
        availableForSale: true,
        inventoryQuantity: 10,
        image: null,
        barcode: '012345678905'
      }
    ],
    ...overrides
  }
}

describe('filterProducts', () => {
  const products = [
    makeProduct(),
    makeProduct({
      id: 'gid://shopify/Product/2',
      title: 'RUBIS T-Shirt',
      variants: [
        {
          id: 'gid://shopify/ProductVariant/2',
          productId: '2',
          title: 'Large',
          price: 19.99,
          availableForSale: true,
          inventoryQuantity: 5,
          image: null,
          barcode: '999888777666'
        }
      ]
    }),
    makeProduct({
      id: 'gid://shopify/Product/3',
      title: 'Engine Oil 5W-30',
      variants: [
        {
          id: 'gid://shopify/ProductVariant/3',
          productId: '3',
          title: '1L',
          price: 8,
          availableForSale: true,
          inventoryQuantity: 20,
          image: null,
          barcode: null
        }
      ]
    })
  ]

  it('returns every product for an empty query', () => {
    expect(filterProducts(products, '')).toEqual(products)
  })

  it('returns every product for a whitespace-only query', () => {
    expect(filterProducts(products, '   ')).toEqual(products)
  })

  it('matches product title case-insensitively', () => {
    const result = filterProducts(products, 'rubis mug')
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('RUBIS Mug')
  })

  it('matches a substring of the product title', () => {
    const result = filterProducts(products, 'shirt')
    expect(result.map((p) => p.title)).toEqual(['RUBIS T-Shirt'])
  })

  it('matches variant title', () => {
    const result = filterProducts(products, 'large')
    expect(result.map((p) => p.title)).toEqual(['RUBIS T-Shirt'])
  })

  it('matches a partial barcode', () => {
    const result = filterProducts(products, '012345')
    expect(result.map((p) => p.title)).toEqual(['RUBIS Mug'])
  })

  it('matches a full barcode', () => {
    const result = filterProducts(products, '999888777666')
    expect(result.map((p) => p.title)).toEqual(['RUBIS T-Shirt'])
  })

  it('returns an empty array when nothing matches', () => {
    expect(filterProducts(products, 'nonexistent-xyz')).toEqual([])
  })

  it('does not throw for a product whose variant has a null barcode', () => {
    expect(() => filterProducts(products, '123')).not.toThrow()
    expect(filterProducts(products, 'engine')).toHaveLength(1)
  })
})
