/**
 * Demo Mode dummy catalog tests.
 *
 * Validates the shape of `DEMO_PRODUCTS` itself, then confirms it
 * round-trips correctly through the real `RubisDatabase` seeding path
 * (`cacheProducts`/`getCachedProducts`) that `main/index.ts` uses on
 * startup when `VITE_DEMO_MODE=true` — run against a real in-memory
 * `better-sqlite3` connection, same rationale as `reconciliation.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import { DEMO_PRODUCTS } from '../src/main/services/demoData.js'
import { RubisDatabase } from '../src/main/services/database.js'

describe('DEMO_PRODUCTS', () => {
  it('contains exactly 10 products (Q2 default)', () => {
    expect(DEMO_PRODUCTS).toHaveLength(10)
  })

  it('gives every product a unique id', () => {
    const ids = new Set(DEMO_PRODUCTS.map((p) => p.id))
    expect(ids.size).toBe(DEMO_PRODUCTS.length)
  })

  it('gives every product exactly one variant with a unique, scannable barcode', () => {
    const barcodes = DEMO_PRODUCTS.map((p) => {
      expect(p.variants).toHaveLength(1)
      return p.variants[0].barcode
    })
    expect(new Set(barcodes).size).toBe(DEMO_PRODUCTS.length)
    for (const barcode of barcodes) {
      expect(barcode).toMatch(/^\d{6}$/)
    }
  })

  it('gives every product a positive price and available stock', () => {
    for (const product of DEMO_PRODUCTS) {
      const variant = product.variants[0]
      expect(variant.price).toBeGreaterThan(0)
      expect(variant.inventoryQuantity).toBeGreaterThan(0)
      expect(variant.availableForSale).toBe(true)
    }
  })
})

describe('Demo Mode seeding round-trip', () => {
  it('seeds and reads back all 10 products via the real cacheProducts/getCachedProducts path', () => {
    const db = new RubisDatabase({ dbPath: ':memory:' })
    db.init()

    db.cacheProducts(DEMO_PRODUCTS)
    const cached = db.getCachedProducts()

    expect(cached).toHaveLength(10)
    const titles = cached.map((p) => p.title).sort()
    expect(titles).toContain('Kabras Milk 500ml')
    expect(titles).toContain('Bread Loaf')

    const mug = cached.find((p) => p.title === 'Kabras Milk 500ml')
    expect(mug?.variants[0].barcode).toBe('111111')
    expect(mug?.variants[0].price).toBe(65)
  })
})
