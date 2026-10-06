/**
 * The catalogue sync (docs/phase-253-1) on a real `:memory:` database with Shopify faked: each part is replaced only
 * when its read completed, an empty product read keeps the copy, a missing scope says so, a cart draft refuses the
 * reads, and two syncs at once are one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'
import { createCatalogSync, SYNC_CART_OPEN_MESSAGE, SYNC_NO_PRODUCTS_MESSAGE, type CatalogSyncDeps } from '../src/main/services/catalog-sync.js'
import { NO_DISCOUNT_SCOPE_MESSAGE } from '../src/main/services/shopify-discounts.js'
import type { ProductSummary } from '../src/renderer/src/types/shopify.js'
import type { AutoDiscount } from '../src/main/lib/autoDiscounts.js'

let db: RubisDatabase

function product(n: number, price: number): ProductSummary {
  return {
    id: `gid://shopify/Product/${n}`,
    title: `Product ${n}`,
    handle: `product-${n}`,
    featuredImage: null,
    variants: [
      {
        id: `gid://shopify/ProductVariant/${n}0`,
        productId: String(n),
        title: 'Default Title',
        price,
        availableForSale: true,
        inventoryQuantity: 5,
        image: null,
        barcode: null
      }
    ]
  }
}

function pairs(id: string, title: string): AutoDiscount {
  return {
    id: `gid://shopify/DiscountAutomaticNode/${id}`,
    title,
    startsAt: '2026-10-06T10:12:00Z',
    endsAt: null,
    buysQuantity: 1,
    getsQuantity: 1,
    variantIds: [],
    productIds: ['10235718041703'],
    effect: { type: 'amount', amount: 31 },
    usesPerOrderLimit: null
  }
}

const NOW = new Date('2026-10-07T06:00:00Z')

function deps(over: Partial<CatalogSyncDeps> = {}): CatalogSyncDeps {
  return {
    db,
    readProducts: vi.fn().mockResolvedValue({ success: true, data: [product(1, 65), product(2, 90)] }),
    readDiscounts: vi.fn().mockResolvedValue({
      success: true,
      data: { discounts: [pairs('1', 'Probakery Bread 2 @99/=')], skipped: [{ title: 'Old basic', reason: 'amount off products' }] }
    }),
    now: () => NOW,
    ...over
  }
}

/** Seeds a last good copy: one product at 50 and one discount. */
function seed(): void {
  db.replaceCatalogue({ products: [product(9, 50)], discounts: [pairs('9', 'Old pairs')], syncedAt: '2026-10-01T05:00:00.000Z' })
}

beforeEach(() => {
  db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
})

afterEach(() => db.close())

describe('a good sync', () => {
  it('replaces both copies and stamps the time', async () => {
    seed()
    const result = await createCatalogSync(deps()).sync()

    expect(result.success).toBe(true)
    expect(result.data?.productsRefreshed).toBe(true)
    expect(result.data?.discountsRefreshed).toBe(true)
    expect(db.getCachedProducts().map((p) => p.id)).toEqual(['gid://shopify/Product/1', 'gid://shopify/Product/2'])
    expect(db.getAutoDiscounts().map((d) => d.title)).toEqual(['Probakery Bread 2 @99/='])
    expect(db.getCatalogSyncedAt()).toBe(NOW.toISOString())
    expect(result.data?.skipped).toEqual([{ title: 'Old basic', reason: 'amount off products' }])
    expect(result.data?.messages).toEqual([])
  })

  it('run twice gives the same copy', async () => {
    const sync = createCatalogSync(deps())
    await sync.sync()
    const first = { products: db.getCachedProducts(), discounts: db.getAutoDiscounts(), at: db.getCatalogSyncedAt() }
    await sync.sync()
    expect({ products: db.getCachedProducts(), discounts: db.getAutoDiscounts(), at: db.getCatalogSyncedAt() }).toEqual(first)
  })
})

describe('a part whose read did not complete keeps its last good copy', () => {
  it('a failed discount read keeps the old discounts and still refreshes products', async () => {
    seed()
    const result = await createCatalogSync(deps({ readDiscounts: vi.fn().mockResolvedValue({ success: false, error: 'Throttled' }) })).sync()

    expect(db.getAutoDiscounts().map((d) => d.title)).toEqual(['Old pairs'])
    expect(db.getCachedProducts()).toHaveLength(2)
    expect(result.data?.discountsRefreshed).toBe(false)
    expect(result.data?.messages).toEqual(['Discounts not read: Throttled. The last good copy is kept.'])
  })

  it('a missing read_discounts scope says so, keeps the discounts and refreshes products', async () => {
    seed()
    const result = await createCatalogSync(
      deps({ readDiscounts: vi.fn().mockResolvedValue({ success: false, error: NO_DISCOUNT_SCOPE_MESSAGE }) })
    ).sync()

    expect(result.data?.messages).toEqual(['Discounts not read: the Shopify token has no read_discounts access'])
    expect(db.getAutoDiscounts().map((d) => d.title)).toEqual(['Old pairs'])
    expect(db.getCachedProducts()).toHaveLength(2)
  })

  it('a failed product read keeps the old products and the old sync time, and still refreshes discounts', async () => {
    seed()
    const result = await createCatalogSync(
      deps({ readProducts: vi.fn().mockResolvedValue({ success: false, error: 'The stock read stopped part-way' }) })
    ).sync()

    expect(db.getCachedProducts().map((p) => p.id)).toEqual(['gid://shopify/Product/9'])
    expect(db.getCatalogSyncedAt()).toBe('2026-10-01T05:00:00.000Z')
    expect(db.getAutoDiscounts().map((d) => d.title)).toEqual(['Probakery Bread 2 @99/='])
    expect(result.data?.messages[0]).toBe('Products not refreshed: The stock read stopped part-way. The last good copy is kept.')
  })

  it('an empty product read keeps the copy and reports it', async () => {
    seed()
    const result = await createCatalogSync(deps({ readProducts: vi.fn().mockResolvedValue({ success: true, data: [] }) })).sync()

    expect(db.getCachedProducts().map((p) => p.id)).toEqual(['gid://shopify/Product/9'])
    expect(result.data?.productsRefreshed).toBe(false)
    expect(result.data?.messages).toContain(SYNC_NO_PRODUCTS_MESSAGE)
  })

  it('a read that throws (a bad store URL) is a failed read, not a crash', async () => {
    seed()
    const result = await createCatalogSync(deps({ readProducts: vi.fn().mockRejectedValue(new Error('Invalid Shopify store URL')) })).sync()

    expect(result.success).toBe(true)
    expect(db.getCachedProducts().map((p) => p.id)).toEqual(['gid://shopify/Product/9'])
  })
})

describe('never while a cart is open, never twice at once', () => {
  it('a cart draft refuses the reads and answers with the copy as it is', async () => {
    seed()
    db.saveCartDraft(JSON.stringify({ cartToken: 't', items: [] }))
    const d = deps()
    const result = await createCatalogSync(d).sync()

    expect(d.readProducts).not.toHaveBeenCalled()
    expect(d.readDiscounts).not.toHaveBeenCalled()
    expect(result.data?.refused).toBe(true)
    expect(result.data?.messages).toEqual([SYNC_CART_OPEN_MESSAGE])
    expect(result.data?.products.map((p) => p.id)).toEqual(['gid://shopify/Product/9'])
    expect(result.data?.discounts.map((d) => d.title)).toEqual(['Old pairs'])
  })

  it('a second sync while one runs joins it: one read each', async () => {
    let release: (value: unknown) => void = () => {}
    const readProducts = vi
      .fn()
      .mockResolvedValue({ success: true, data: [product(1, 65)] })
      .mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ success: true, data: [product(1, 65)] }))))
    const sync = createCatalogSync(deps({ readProducts }))
    const first = sync.sync()
    const second = sync.sync()
    release(undefined)

    expect(await second).toBe(await first)
    expect(readProducts).toHaveBeenCalledTimes(1)
    await sync.sync()
    expect(readProducts).toHaveBeenCalledTimes(2)
  })
})
