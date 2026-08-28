/**
 * Database service tests.
 *
 * `better-sqlite3` is mocked with a recording fake so we assert the
 * exact SQL and parameter traffic produced by `RubisDatabase` without
 * loading the native module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import {
  RubisDatabase,
  SCHEMA,
  SYNC_BACKOFF_BASE_MS,
  SYNC_BACKOFF_CAP_MS,
  SYNC_MAX_ATTEMPTS,
  computeBackoffMs
} from '../src/main/services/database.js'
import type { ProductSummary } from '../src/renderer/src/types/shopify.js'

vi.mock('better-sqlite3', () => ({ default: vi.fn() }))

const MockedDatabaseCtor = vi.mocked(BetterSqlite3)

interface RecordedCall {
  sql: string
  kind: 'run' | 'get' | 'all'
  params: unknown[]
}

/**
 * Builds a recording fake implementing the narrow better-sqlite3
 * surface used by RubisDatabase (pragma, exec, prepare, transaction).
 */
function createFakeConnection() {
  const calls: RecordedCall[] = []
  const allResults = new Map<string, unknown[]>()
  const getResults = new Map<string, unknown>()
  const runResults = new Map<string, Array<{ lastInsertRowid: number }>>()

  /** Registers rows returned by `.all()` for SQL containing a tag. */
  const setAllResult = (sqlMatch: string, rows: unknown[]): void => {
    allResults.set(sqlMatch, rows)
  }

  /** Registers the row returned by `.get()` for SQL containing a tag. */
  const setGetResult = (sqlMatch: string, row: unknown): void => {
    getResults.set(sqlMatch, row)
  }

  /** Queues `run()` outcomes (insert ids) for SQL containing a tag. */
  const queueRunResult = (sqlMatch: string, id: number): void => {
    const list = runResults.get(sqlMatch) ?? []
    list.push({ lastInsertRowid: id })
    runResults.set(sqlMatch, list)
  }

  const findResult = <T>(
    store: Map<string, T>,
    sql: string
  ): T | undefined => {
    for (const [match, value] of store) {
      if (sql.includes(match)) return value
    }
    return undefined
  }

  const connection = {
    pragma: vi.fn(),
    exec: vi.fn(),
    close: vi.fn(),
    transaction: vi.fn(
      (fn: (...args: unknown[]) => unknown) =>
        (...args: unknown[]) =>
          fn(...args)
    ),
    prepare: vi.fn((sql: string) => ({
      run: (...params: unknown[]) => {
        calls.push({ sql, kind: 'run', params })
        const queued = findResult(runResults, sql)
        if (queued && queued.length > 0) return queued.shift()
        return { changes: 1, lastInsertRowid: 0 }
      },
      get: (...params: unknown[]) => {
        calls.push({ sql, kind: 'get', params })
        return findResult(getResults, sql)
      },
      all: (...params: unknown[]) => {
        calls.push({ sql, kind: 'all', params })
        return findResult(allResults, sql) ?? []
      }
    }))
  }

  return {
    connection,
    calls,
    setAllResult,
    setGetResult,
    queueRunResult,
    callsFor: (kind: RecordedCall['kind'], sqlMatch: string) =>
      calls.filter((c) => c.kind === kind && c.sql.includes(sqlMatch))
  }
}

const sampleProducts: ProductSummary[] = [
  {
    id: 'gid://shopify/Product/101',
    title: 'RUBIS Mug',
    handle: 'rubis-mug',
    featuredImage: 'https://cdn.example/mug.jpg',
    variants: [
      {
        id: 'gid://shopify/ProductVariant/201',
        productId: '101',
        title: 'Small',
        price: 12.5,
        availableForSale: true,
        inventoryQuantity: 8,
        image: 'https://cdn.example/mug-small.jpg',
        barcode: '012345678905'
      },
      {
        id: 'gid://shopify/ProductVariant/202',
        productId: '101',
        title: 'Large',
        price: 14.5,
        availableForSale: true,
        inventoryQuantity: 3,
        image: null,
        barcode: null
      }
    ]
  }
]

describe('RubisDatabase.init', () => {
  let fake: ReturnType<typeof createFakeConnection>
  let db: RubisDatabase

  beforeEach(() => {
    fake = createFakeConnection()
    MockedDatabaseCtor.mockReset()
    MockedDatabaseCtor.mockImplementation(
      () => fake.connection as unknown as InstanceType<typeof BetterSqlite3>
    )
    db = new RubisDatabase({ dbPath: '/tmp/rubis-test.db' })
  })

  it('enables WAL and creates all core tables + index', () => {
    db.init()

    expect(MockedDatabaseCtor).toHaveBeenCalledWith('/tmp/rubis-test.db')
    expect(fake.connection.pragma).toHaveBeenCalledWith('journal_mode = WAL')
    expect(fake.connection.exec).toHaveBeenCalledWith(SCHEMA.products)
    expect(fake.connection.exec).toHaveBeenCalledWith(SCHEMA.orders)
    expect(fake.connection.exec).toHaveBeenCalledWith(SCHEMA.syncQueue)
    expect(fake.connection.exec).toHaveBeenCalledWith(SCHEMA.queueIndex)
    expect(fake.connection.exec).toHaveBeenCalledWith(SCHEMA.integrations)
    expect(fake.connection.exec).toHaveBeenCalledWith(SCHEMA.printers)
  })

  it('sets synchronous = NORMAL for faster writes without sacrificing WAL crash safety', () => {
    db.init()

    expect(fake.connection.pragma).toHaveBeenCalledWith('synchronous = NORMAL')
    const pragmaCalls = fake.connection.pragma.mock.calls.map((call) => call[0])
    expect(pragmaCalls.indexOf('journal_mode = WAL')).toBeLessThan(
      pragmaCalls.indexOf('synchronous = NORMAL')
    )
  })

  it('creates the barcode index on products for O(1) scanner lookups', () => {
    db.init()

    expect(SCHEMA.barcodeIndex).toMatch(/CREATE INDEX IF NOT EXISTS idx_products_barcode ON products \(barcode\)/)
    expect(fake.connection.exec).toHaveBeenCalledWith(SCHEMA.barcodeIndex)
  })

  it('is idempotent — a second init() reuses the connection', () => {
    db.init()
    db.init()
    expect(MockedDatabaseCtor).toHaveBeenCalledTimes(1)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})

const freshDb = () => {
  const fake = createFakeConnection()
  MockedDatabaseCtor.mockImplementation(
    () => fake.connection as unknown as InstanceType<typeof BetterSqlite3>
  )
  const db = new RubisDatabase({ dbPath: '/tmp/rubis-test.db' })
  db.init()
  return { fake, db }
}

describe('RubisDatabase.cacheProducts', () => {
  it('replaces the snapshot with one row per variant', () => {
    const { fake, db } = freshDb()

    db.cacheProducts(sampleProducts)

    expect(fake.callsFor('run', 'DELETE FROM products')).toHaveLength(1)
    const inserts = fake.callsFor('run', 'INSERT OR REPLACE INTO products')
    expect(inserts).toHaveLength(2)
    expect(inserts[0].params).toEqual([
      'gid://shopify/Product/101',
      'RUBIS Mug',
      'gid://shopify/ProductVariant/201',
      'Small',
      12.5,
      8,
      'https://cdn.example/mug-small.jpg',
      '012345678905'
    ])
    // Variant without its own image falls back to the featured image;
    // a variant without a barcode stores null.
    expect(inserts[1].params[6]).toBe('https://cdn.example/mug.jpg')
    expect(inserts[1].params[7]).toBeNull()
  })

  it('caches an empty snapshot by clearing the table only', () => {
    const { fake, db } = freshDb()

    db.cacheProducts([])

    expect(fake.callsFor('run', 'DELETE FROM products')).toHaveLength(1)
    expect(fake.callsFor('run', 'INSERT OR REPLACE INTO products')).toHaveLength(0)
  })
})

describe('RubisDatabase.queueOrder', () => {
  const cartItem = {
    id: 'gid://shopify/ProductVariant/201',
    productId: '101',
    title: 'RUBIS Mug',
    variantTitle: 'Small',
    price: 12.5,
    quantity: 2,
    image: 'https://cdn.example/mug-small.jpg'
  }

  it('inserts a pending order and an orderCreate queue entry atomically', () => {
    const { fake, db } = freshDb()
    fake.queueRunResult('INSERT INTO orders', 7)
    fake.queueRunResult('INSERT INTO sync_queue', 3)

    const result = db.queueOrder({
      items: [cartItem],
      total: 25,
      clientOrderUuid: 'uuid-1234',
      staffId: 1,
      staffName: 'Admin',
      paymentMethod: 'cash',
      tenderedAmount: 30,
      changeDue: 5
    })

    expect(result).toEqual({ localId: 7, queueId: 3 })
    expect(fake.connection.transaction).toHaveBeenCalled()

    const orderInserts = fake.callsFor('run', 'INSERT INTO orders')
    expect(orderInserts).toHaveLength(1)
    expect(orderInserts[0].params[0]).toBe(25)
    expect(orderInserts[0].params[1]).toBe('pending_sync')
    expect(orderInserts[0].params[4]).toBe(1)
    expect(orderInserts[0].params[5]).toBe('cash')
    expect(orderInserts[0].params[6]).toBe(30)
    expect(orderInserts[0].params[7]).toBe(5)
    expect(orderInserts[0].params[8]).toBeNull()

    const queueInserts = fake.callsFor('run', 'INSERT INTO sync_queue')
    expect(queueInserts).toHaveLength(1)
    const [entityType, entityId, action, payloadJson, attempts, , nextAttemptAt] =
      queueInserts[0].params as [string, number, string, string, number, string, number]
    expect(entityType).toBe('order')
    expect(entityId).toBe(7)
    expect(action).toBe('orderCreate')
    expect(attempts).toBe(0)
    expect(nextAttemptAt).toBe(0)

    const payload = JSON.parse(payloadJson)
    expect(payload.clientOrderUuid).toBe('uuid-1234')
    expect(payload.total).toBe(25)
    expect(payload.staffId).toBe(1)
    expect(payload.staffName).toBe('Admin')
    expect(payload.paymentMethod).toBe('cash')
    expect(payload.tenderedAmount).toBe(30)
    expect(payload.changeDue).toBe(5)
    expect(payload.lineItems).toEqual([
      {
        variantId: cartItem.id,
        title: cartItem.title,
        variantTitle: cartItem.variantTitle,
        quantity: 2,
        unitPrice: 12.5
      }
    ])
  })
})

describe('RubisDatabase.getPendingSyncQueue', () => {
  it('queries items due before `now` and parses their payload', () => {
    const { fake, db } = freshDb()
    fake.setAllResult('FROM sync_queue', [
      {
        id: 1,
        entity_type: 'order',
        entity_id: 7,
        action: 'orderCreate',
        payload_json: JSON.stringify({
          clientOrderUuid: 'uuid-1',
          total: 10,
          lineItems: [],
          createdAt: '2026-08-24T10:00:00.000Z'
        }),
        attempts: 0,
        last_error: null,
        created_at: '2026-08-24T10:00:00.000Z',
        next_attempt_at: 1000
      }
    ])

    const items = db.getPendingSyncQueue(5000)

    expect(fake.callsFor('all', 'FROM sync_queue')[0].params).toEqual([5000])
    expect(items).toHaveLength(1)
    expect(items[0].payload.clientOrderUuid).toBe('uuid-1')
    expect(items[0].entity_id).toBe(7)
  })
})

describe('RubisDatabase.getOrder', () => {
  it('returns the stored order row', () => {
    const { fake, db } = freshDb()
    const row = {
      local_id: 7,
      shopify_order_id: 'gid://shopify/Order/999',
      total: 25,
      status: 'synced',
      created_at: '2026-08-24T10:00:00.000Z'
    }
    fake.setGetResult('FROM orders WHERE local_id', row)

    expect(db.getOrder(7)).toEqual(row)
    expect(fake.callsFor('get', 'FROM orders')[0].params).toEqual([7])
  })
})

describe('RubisDatabase.markQueueItemSynced', () => {
  it('marks the order synced with the Shopify id and deletes the queue row', () => {
    const { fake, db } = freshDb()
    fake.setGetResult('FROM sync_queue WHERE id', { entity_id: 7 })

    db.markQueueItemSynced(3, 'gid://shopify/Order/999')

    const updates = fake.callsFor('run', 'UPDATE orders SET status')
    expect(updates).toHaveLength(1)
    expect(updates[0].params).toEqual(['synced', 'gid://shopify/Order/999', 7])
    expect(fake.callsFor('run', 'DELETE FROM sync_queue')[0].params).toEqual([3])
  })

  it('is a no-op when the queue row no longer exists', () => {
    const { fake, db } = freshDb()

    db.markQueueItemSynced(99, 'gid://shopify/Order/999')

    expect(fake.callsFor('run', 'UPDATE orders')).toHaveLength(0)
  })
})

describe('RubisDatabase.recordQueueFailure', () => {
  it('increments attempts, stores the error, and schedules backoff', () => {
    const { fake, db } = freshDb()
    fake.setGetResult('FROM sync_queue WHERE id', {
      id: 3,
      entity_id: 7,
      attempts: 2
    })
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)

    const result = db.recordQueueFailure(3, 'HTTP 429')

    expect(result).toEqual({ exhausted: false, attempts: 3 })
    const updates = fake.callsFor('run', 'UPDATE sync_queue SET attempts')
    expect(updates).toHaveLength(1)
    expect(updates[0].params[0]).toBe(3)
    expect(updates[0].params[1]).toBe('HTTP 429')
    // attempts=3 → base * 2^2 = 120 s
    expect(updates[0].params[2]).toBe(1_000_000 + SYNC_BACKOFF_BASE_MS * 4)
    expect(updates[0].params[3]).toBe(3)
    nowSpy.mockRestore()
  })

  it('marks the order failed and drops the queue row when exhausted', () => {
    const { fake, db } = freshDb()
    fake.setGetResult('FROM sync_queue WHERE id', {
      id: 3,
      entity_id: 7,
      attempts: SYNC_MAX_ATTEMPTS - 1
    })

    const result = db.recordQueueFailure(3, 'final failure')

    expect(result.exhausted).toBe(true)
    const updates = fake.callsFor('run', 'UPDATE orders')
    expect(updates).toHaveLength(1)
    expect(updates[0].params).toEqual(['failed', 7])
    expect(fake.callsFor('run', 'DELETE FROM sync_queue')).toHaveLength(1)
    expect(fake.callsFor('run', 'UPDATE sync_queue')).toHaveLength(0)
  })
})

describe('RubisDatabase.queueFiscalInvoice', () => {
  it('inserts an etims_invoice sync-queue row with the request as its payload', () => {
    const { fake, db } = freshDb()
    fake.queueRunResult('INSERT INTO sync_queue', 9)

    const request = {
      clientOrderUuid: 'uuid-1234',
      items: [{ description: 'Bread', quantity: 1, unitPrice: 60, taxRate: 0.16 }],
      total: 69.6,
      taxAmount: 9.6
    }

    const result = db.queueFiscalInvoice(7, request)

    expect(result).toEqual({ queueId: 9 })
    const inserts = fake.callsFor('run', 'INSERT INTO sync_queue')
    expect(inserts).toHaveLength(1)
    const [entityType, entityId, action, payloadJson, attempts, , nextAttemptAt] =
      inserts[0].params as [string, number, string, string, number, string, number]
    expect(entityType).toBe('etims_invoice')
    expect(entityId).toBe(7)
    expect(action).toBe('fiscalizeInvoice')
    expect(attempts).toBe(0)
    expect(nextAttemptAt).toBe(0)
    expect(JSON.parse(payloadJson)).toEqual(request)
  })
})

describe('RubisDatabase.getPendingFiscalQueue', () => {
  it('queries only etims_invoice rows due before `now` and parses their payload', () => {
    const { fake, db } = freshDb()
    fake.setAllResult('FROM sync_queue', [
      {
        id: 4,
        entity_type: 'etims_invoice',
        entity_id: 7,
        action: 'fiscalizeInvoice',
        payload_json: JSON.stringify({
          clientOrderUuid: 'uuid-1',
          items: [],
          total: 10,
          taxAmount: 1
        }),
        attempts: 0,
        last_error: null,
        created_at: '2026-08-24T10:00:00.000Z',
        next_attempt_at: 1000
      }
    ])

    const items = db.getPendingFiscalQueue(5000)

    const [call] = fake.callsFor('all', 'FROM sync_queue')
    expect(call.sql).toContain("entity_type = 'etims_invoice'")
    expect(call.params).toEqual([5000])
    expect(items).toHaveLength(1)
    expect(items[0].payload.clientOrderUuid).toBe('uuid-1')
    expect(items[0].entity_id).toBe(7)
  })
})

describe('RubisDatabase.markFiscalQueueItemSynced', () => {
  it('saves the invoice number/QR code on the order and deletes the queue row', () => {
    const { fake, db } = freshDb()
    fake.setGetResult('FROM sync_queue WHERE id', { entity_id: 7 })

    db.markFiscalQueueItemSynced(4, 'KRA-0001', 'base64qr')

    const updates = fake.callsFor('run', 'UPDATE orders SET fiscal_invoice_number')
    expect(updates).toHaveLength(1)
    expect(updates[0].params[0]).toBe('KRA-0001')
    expect(updates[0].params[1]).toBe('base64qr')
    expect(updates[0].params[3]).toBe(7)
    expect(fake.callsFor('run', 'DELETE FROM sync_queue')[0].params).toEqual([4])
  })

  it('is a no-op when the queue row no longer exists', () => {
    const { fake, db } = freshDb()

    db.markFiscalQueueItemSynced(99, 'KRA-0001', 'base64qr')

    expect(fake.callsFor('run', 'UPDATE orders')).toHaveLength(0)
    expect(fake.callsFor('run', 'DELETE FROM sync_queue')).toHaveLength(0)
  })
})

describe('RubisDatabase.recordFiscalQueueFailure', () => {
  it('increments attempts, stores the error, and schedules backoff without deleting the row', () => {
    const { fake, db } = freshDb()
    fake.setGetResult('FROM sync_queue WHERE id', { id: 4, attempts: 2 })
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)

    const result = db.recordFiscalQueueFailure(4, 'device unreachable')

    expect(result).toEqual({ exhausted: false })
    const updates = fake.callsFor('run', 'UPDATE sync_queue SET attempts')
    expect(updates).toHaveLength(1)
    expect(updates[0].params[0]).toBe(3)
    expect(updates[0].params[1]).toBe('device unreachable')
    expect(updates[0].params[2]).toBe(1_000_000 + SYNC_BACKOFF_BASE_MS * 4)
    expect(updates[0].params[3]).toBe(4)
    expect(fake.callsFor('run', 'DELETE FROM sync_queue')).toHaveLength(0)
    nowSpy.mockRestore()
  })

  it('abandons after the max attempts but keeps the row for inspection', () => {
    const { fake, db } = freshDb()
    fake.setGetResult('FROM sync_queue WHERE id', {
      id: 4,
      attempts: SYNC_MAX_ATTEMPTS - 1
    })

    const result = db.recordFiscalQueueFailure(4, 'final failure')

    expect(result.exhausted).toBe(true)
    expect(fake.callsFor('run', 'DELETE FROM sync_queue')).toHaveLength(0)
    const updates = fake.callsFor('run', 'UPDATE sync_queue SET attempts')
    expect(updates).toHaveLength(1)
    expect(updates[0].params[0]).toBe(SYNC_MAX_ATTEMPTS)
    expect(updates[0].params[1]).toMatch(/^ABANDONED/)
    expect(updates[0].params[2]).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('treats a missing queue row as already exhausted', () => {
    const { db } = freshDb()

    const result = db.recordFiscalQueueFailure(999, 'irrelevant')

    expect(result).toEqual({ exhausted: true })
  })
})

describe('RubisDatabase.getCachedProducts', () => {
  it('rehydrates rows into ProductSummary objects grouped by product', () => {
    const { fake, db } = freshDb()
    fake.setAllResult('FROM products', [
      {
        id: 'gid://shopify/Product/101',
        title: 'RUBIS Mug',
        variant_id: 'gid://shopify/ProductVariant/201',
        price: 12.5,
        inventory_quantity: 8,
        image_url: 'https://cdn.example/mug-small.jpg',
        barcode: '012345678905'
      },
      {
        id: 'gid://shopify/Product/101',
        title: 'RUBIS Mug',
        variant_id: 'gid://shopify/ProductVariant/202',
        price: 14.5,
        inventory_quantity: 0,
        image_url: null,
        barcode: null
      }
    ])

    const products = db.getCachedProducts()

    expect(products).toHaveLength(1)
    const product = products[0]
    expect(product.id).toBe('gid://shopify/Product/101')
    expect(product.featuredImage).toBe('https://cdn.example/mug-small.jpg')
    expect(product.variants).toHaveLength(2)
    expect(product.variants[0].productId).toBe('101')
    expect(product.variants[0].availableForSale).toBe(true)
    expect(product.variants[0].barcode).toBe('012345678905')
    expect(product.variants[1].availableForSale).toBe(false)
    expect(product.variants[1].barcode).toBeNull()
  })
})

describe('RubisDatabase integration config', () => {
  it('writes config as JSON via an upsert', () => {
    const { fake, db } = freshDb()

    db.setIntegrationConfig('mpesa', { paybill: '123456', consumerKey: 'abc' })

    const upsertCalls = fake.callsFor('run', 'INSERT INTO integrations')
    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].params).toEqual([
      'mpesa',
      JSON.stringify({ paybill: '123456', consumerKey: 'abc' })
    ])
  })

  it('reads back a stored config, parsed from JSON', () => {
    const { fake, db } = freshDb()
    fake.setGetResult('FROM integrations', {
      config_json: JSON.stringify({ middlewareUrl: 'http://localhost:9000' })
    })

    const config = db.getIntegrationConfig('etims')

    expect(config).toEqual({ middlewareUrl: 'http://localhost:9000' })
  })

  it('returns an empty object when a provider has no stored config', () => {
    const { db } = freshDb()

    expect(db.getIntegrationConfig('mpesa')).toEqual({})
  })
})

describe('RubisDatabase.getSetting / setSetting', () => {
  it('upserts a key-value pair', () => {
    const { fake, db } = freshDb()

    db.setSetting('location_confirmed', '1')

    const upsertCalls = fake.callsFor('run', 'INSERT OR REPLACE INTO settings')
    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].params).toEqual(['location_confirmed', '1'])
  })

  it('reads back a stored value', () => {
    const { fake, db } = freshDb()
    fake.setGetResult('FROM settings WHERE key', { value: 'gid://shopify/Location/1' })

    expect(db.getSetting('location_id')).toBe('gid://shopify/Location/1')
  })

  it('returns undefined for a key that was never set', () => {
    const { db } = freshDb()

    expect(db.getSetting('location_confirmed')).toBeUndefined()
  })
})

describe('RubisDatabase printers', () => {
  it('returns an empty list when no printers are configured', () => {
    const { db } = freshDb()

    expect(db.getPrinters()).toEqual([])
  })

  it('lists configured printers, normalizing enabled to a boolean', () => {
    const { fake, db } = freshDb()
    fake.setAllResult('FROM printers', [
      { id: 'till-1', type: 'receipt', interface: 'tcp://192.168.0.51:9100', enabled: 1 },
      { id: 'label-1', type: 'label', interface: 'tcp://192.168.0.53:9100', enabled: 0 }
    ])

    expect(db.getPrinters()).toEqual([
      { id: 'till-1', type: 'receipt', interfaceName: 'tcp://192.168.0.51:9100', enabled: true },
      { id: 'label-1', type: 'label', interfaceName: 'tcp://192.168.0.53:9100', enabled: false }
    ])
  })

  it('upserts a printer configuration', () => {
    const { fake, db } = freshDb()

    db.savePrinter({
      id: 'kitchen-1',
      type: 'kitchen',
      interfaceName: 'tcp://192.168.0.52:9100',
      enabled: true
    })

    const upsertCalls = fake.callsFor('run', 'INSERT INTO printers')
    expect(upsertCalls).toHaveLength(1)
    expect(upsertCalls[0].params).toEqual(['kitchen-1', 'kitchen', 'tcp://192.168.0.52:9100', 1])
  })

  it('stores enabled: false as 0', () => {
    const { fake, db } = freshDb()

    db.savePrinter({
      id: 'label-1',
      type: 'label',
      interfaceName: 'tcp://192.168.0.53:9100',
      enabled: false
    })

    const upsertCalls = fake.callsFor('run', 'INSERT INTO printers')
    expect(upsertCalls[0].params).toEqual(['label-1', 'label', 'tcp://192.168.0.53:9100', 0])
  })

  it('deletes a printer by id and reports true when a row was removed', () => {
    const { fake, db } = freshDb()

    expect(db.deletePrinter('till-1')).toBe(true)
    const deleteCalls = fake.callsFor('run', 'DELETE FROM printers')
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0].params).toEqual(['till-1'])
  })

  it('reports false when deleting an unknown printer id', () => {
    const { fake, db } = freshDb()
    const originalPrepare = fake.connection.prepare
    fake.connection.prepare = vi.fn((sql: string) => {
      if (sql.includes('DELETE FROM printers')) {
        return { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }
      }
      return originalPrepare(sql)
    }) as typeof fake.connection.prepare

    expect(db.deletePrinter('unknown-id')).toBe(false)
  })
})

describe('computeBackoffMs', () => {
  it('doubles on every attempt starting from the base delay', () => {
    expect(computeBackoffMs(1)).toBe(30_000)
    expect(computeBackoffMs(2)).toBe(60_000)
    expect(computeBackoffMs(3)).toBe(120_000)
    expect(computeBackoffMs(4)).toBe(240_000)
  })

  it('caps at 30 minutes', () => {
    expect(computeBackoffMs(10)).toBe(SYNC_BACKOFF_CAP_MS)
    expect(computeBackoffMs(25)).toBe(SYNC_BACKOFF_CAP_MS)
  })

  it('treats non-positive attempts as the first attempt', () => {
    expect(computeBackoffMs(0)).toBe(30_000)
    expect(computeBackoffMs(-3)).toBe(30_000)
  })
})

