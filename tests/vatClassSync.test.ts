/**
 * Product tax classification from Shopify to the cart (docs/phase-194,
 * commit 3): the query, the mapper, the offline cache, the cart line, and
 * the guarantee that a store with no `rubis.vat_class` metafield sends
 * exactly the commands it sent before.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { PRODUCT_LIST_QUERY, mapShopifyToSummary } from '../src/main/services/shopify.js'
import type { ShopifyProduct } from '../src/main/services/shopify-types.js'
import { RubisDatabase } from '../src/main/services/database.js'
import { buildCartItem } from '../src/renderer/src/lib/cartItem.js'
import type { ProductSummary } from '../src/renderer/src/types/shopify.js'
import { GOLDEN_SALES, commandName, makeCheckoutHarness, sellCash } from './helpers/vatClassWire.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const GOLDEN = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/vat-class-a-golden.json'), 'utf8')) as Record<
  string,
  { commands: string[]; bodies: string[]; request: unknown }
>

function node(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    id: 'gid://shopify/Product/10',
    title: 'Maize flour',
    handle: 'maize-flour',
    status: 'ACTIVE',
    featuredImage: null,
    variants: {
      nodes: [
        { id: 'gid://shopify/ProductVariant/11', title: '1kg', availableForSale: true, price: '1.00', image: null, barcode: null },
        { id: 'gid://shopify/ProductVariant/12', title: '2kg', availableForSale: true, price: '2.00', image: null, barcode: null }
      ]
    },
    ...overrides
  }
}

describe('the product query', () => {
  it('asks for the product-level rubis metafields, and not per variant', () => {
    for (const key of ['vat_class', 'hs_code', 'hs_name']) {
      expect(PRODUCT_LIST_QUERY).toContain(`metafield(namespace: "rubis", key: "${key}")`)
    }
    const variantsBlock = PRODUCT_LIST_QUERY.slice(PRODUCT_LIST_QUERY.indexOf('variants(first: 250)'))
    expect(variantsBlock).not.toContain('metafield')
  })
})

describe('mapShopifyToSummary and the tax fields', () => {
  it('copies the product-level metafields onto every variant', () => {
    const [product] = mapShopifyToSummary([
      node({ vatClass: { value: 'E' }, hsCode: { value: '0013.12.02' }, hsName: { value: 'Maize' } })
    ])
    for (const variant of product.variants) {
      expect(variant).toMatchObject({ vatClass: 'E', hsCode: '0013.12.02', hsName: 'Maize' })
    }
  })

  it.each([
    ['no metafields', {}],
    ['null metafields', { vatClass: null, hsCode: null, hsName: null }],
    ['blank metafield values', { vatClass: { value: '  ' }, hsCode: { value: '' }, hsName: { value: ' ' } }]
  ] as Array<[string, Partial<ShopifyProduct>]>)('leaves the variant exactly as it always was: %s', (_label, fields) => {
    const [product] = mapShopifyToSummary([node(fields)])
    expect(Object.keys(product.variants[0]).sort()).toEqual(
      ['availableForSale', 'barcode', 'id', 'image', 'inventoryQuantity', 'price', 'productId', 'title'].sort()
    )
  })
})

describe('the offline catalogue keeps the class', () => {
  const dirs: string[] = []
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  })

  it('round-trips the three fields through cacheProducts and getCachedProducts', () => {
    const db = new RubisDatabase({ dbPath: ':memory:' })
    db.init()
    db.cacheProducts(
      mapShopifyToSummary([
        node({ vatClass: { value: 'C' }, hsCode: { value: '0015.12.00' }, hsName: { value: 'Rice' } }),
        node({ id: 'gid://shopify/Product/20', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/21', title: 'x', availableForSale: true, price: '5.00', image: null, barcode: null }] } })
      ])
    )
    const cached = db.getCachedProducts()
    const classed = cached.find((p) => p.id === 'gid://shopify/Product/10')!
    expect(classed.variants.map((v) => v.vatClass)).toEqual(['C', 'C'])
    expect(classed.variants[0]).toMatchObject({ hsCode: '0015.12.00', hsName: 'Rice' })
    const plain = cached.find((p) => p.id === 'gid://shopify/Product/20')!
    expect(plain.variants[0]).not.toHaveProperty('vatClass')
    expect(plain.variants[0]).not.toHaveProperty('hsCode')
  })

  it('adds the columns to a catalogue cached before this change, and its rows stay class A', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rubis-vat-'))
    dirs.push(dir)
    const dbPath = join(dir, 'old.db')
    const old = new BetterSqlite3(dbPath)
    old.exec(`CREATE TABLE products (
      id TEXT NOT NULL, title TEXT NOT NULL, variant_id TEXT PRIMARY KEY, variant_title TEXT NOT NULL DEFAULT '',
      price REAL NOT NULL, inventory_quantity INTEGER NOT NULL, image_url TEXT, barcode TEXT)`)
    old.prepare('INSERT INTO products VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('gid://shopify/Product/1', 'Old', 'gid://shopify/ProductVariant/2', '', 9, 3, null, null)
    old.close()

    const db = new RubisDatabase({ dbPath })
    db.init()
    expect(db.getCachedProducts()[0].variants[0]).not.toHaveProperty('vatClass')
    db.cacheProducts([
      { id: 'gid://shopify/Product/1', title: 'Old', handle: '', featuredImage: null, variants: [{ id: 'gid://shopify/ProductVariant/2', productId: '1', title: '', price: 9, availableForSale: true, inventoryQuantity: 3, image: null, barcode: null, vatClass: 'E' }] }
    ])
    expect(db.getCachedProducts()[0].variants[0].vatClass).toBe('E')
    db.close()
    // Opening it a second time must not fail on the now-existing columns.
    const again = new RubisDatabase({ dbPath })
    again.init()
    expect(again.getCachedProducts()[0].variants[0].vatClass).toBe('E')
    again.close()
  })
})

describe('buildCartItem', () => {
  const product: ProductSummary = mapShopifyToSummary([node()])[0]

  it('is exactly the old cart line for a variant with no tax fields', () => {
    expect(buildCartItem(product, product.variants[0])).toStrictEqual({
      id: 'gid://shopify/ProductVariant/11',
      productId: '10',
      title: 'Maize flour',
      variantTitle: '1kg',
      price: 1,
      image: null
    })
  })

  it('carries the tax fields when the variant has them', () => {
    const [classed] = mapShopifyToSummary([node({ vatClass: { value: 'E' }, hsCode: { value: '0013.12.02' }, hsName: { value: 'Maize' } })])
    expect(buildCartItem(classed, classed.variants[0])).toMatchObject({ vatClass: 'E', hsCode: '0013.12.02', hsName: 'Maize' })
  })
})

/** The catalogue as a store with no rubis metafields returns it, for one golden sale's lines. */
function catalogueFor(items: typeof GOLDEN_SALES[number]['items'], extra: Partial<ShopifyProduct> = {}): ProductSummary[] {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  db.cacheProducts(
    mapShopifyToSummary(
      items.map((item, index) =>
        node({
          id: `gid://shopify/Product/${100 + index}`,
          title: item.title,
          variants: {
            nodes: [{ id: item.id, title: item.variantTitle, availableForSale: true, price: String(item.price), image: null, barcode: null }]
          },
          ...extra
        })
      )
    )
  )
  return db.getCachedProducts()
}

function cartFrom(items: typeof GOLDEN_SALES[number]['items'], catalogue: ProductSummary[]) {
  return items.map((item) => {
    const product = catalogue.find((p) => p.variants.some((v) => v.id === item.id))!
    return { ...buildCartItem(product, product.variants[0]), quantity: item.quantity }
  })
}

describe('a store with no rubis.vat_class metafield sends exactly today\'s commands', () => {
  it.each(GOLDEN_SALES.map((sale) => [sale.name, sale] as const))(
    'Shopify node -> cache -> cart -> checkout -> device: %s',
    async (name, sale) => {
      const h = makeCheckoutHarness({ A: sale.total.toFixed(2), B: '0.00' })
      const result = await sellCash(h, cartFrom(sale.items, catalogueFor(sale.items)), sale.total, sale.extra)
      const order = h.db.getOrder(result.data!.localId)!
      expect(order.fiscal_status).toBe('fiscalized')
      expect(h.rec.commands()).toEqual(GOLDEN[name].commands)
      expect(h.rec.sent).toEqual(GOLDEN[name].bodies)
      expect(JSON.parse(order.fiscal_request_json!)).toEqual(GOLDEN[name].request)
    }
  )
})

describe('a product that does carry the metafields', () => {
  const sale = GOLDEN_SALES[0]

  it('files as class E through _HS, with its HS code, and passes the group gate', async () => {
    const h = makeCheckoutHarness({ E: '1.00' })
    const extra = { vatClass: { value: 'E' }, hsCode: { value: '0013.12.02' }, hsName: { value: 'Maize' } }
    const result = await sellCash(h, cartFrom(sale.items, catalogueFor(sale.items, extra)), 1)
    expect(h.db.getOrder(result.data!.localId)?.fiscal_status).toBe('fiscalized')
    const hs = h.rec.sent.find((body) => commandName(body) === 'SellPLUfromExtDB_HS')!
    expect(hs).toContain('Name="HSCode" Value="0013.12.02"')
    expect(h.rec.commands()).not.toContain('SellPLUfromExtDB')
  })

  it('is refused at the gate, by name, when its class is one the till does not know', async () => {
    const h = makeCheckoutHarness({ A: '1.00' })
    const result = await sellCash(h, cartFrom(sale.items, catalogueFor(sale.items, { vatClass: { value: 'Z' } })), 1)
    expect(result.success).toBe(false)
    expect(result.error).toContain('"Maize (D)"')
    expect(h.db.getOrder(1)).toBeUndefined()
    expect(h.rec.sent).toEqual([])
  })

  it('files as class A when its class metafield is blank', async () => {
    const h = makeCheckoutHarness({ A: '1.00' })
    const result = await sellCash(h, cartFrom(sale.items, catalogueFor(sale.items, { vatClass: { value: ' ' } })), 1)
    expect(h.db.getOrder(result.data!.localId)?.fiscal_status).toBe('fiscalized')
    expect(h.rec.commands()).toContain('SellPLUfromExtDB')
  })
})
