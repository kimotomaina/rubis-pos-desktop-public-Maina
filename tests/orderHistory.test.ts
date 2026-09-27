/**
 * Order history + retry-sync tests.
 *
 * `better-sqlite3` is mocked with a recording fake so we assert the
 * exact SQL and parameter traffic produced by `RubisDatabase` without
 * loading the native module.
 */

import { describe, it, expect, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'

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

  const setAllResult = (sqlMatch: string, rows: unknown[]): void => {
    allResults.set(sqlMatch, rows)
  }

  const setGetResult = (sqlMatch: string, row: unknown): void => {
    getResults.set(sqlMatch, row)
  }

  const queueRunResult = (sqlMatch: string, id: number): void => {
    const list = runResults.get(sqlMatch) ?? []
    list.push({ lastInsertRowid: id })
    runResults.set(sqlMatch, list)
  }

  const findResult = <T>(store: Map<string, T>, sql: string): T | undefined => {
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

const freshDb = () => {
  const fake = createFakeConnection()
  MockedDatabaseCtor.mockImplementation(
    () => fake.connection as unknown as InstanceType<typeof BetterSqlite3>
  )
  const db = new RubisDatabase({ dbPath: '/tmp/rubis-test.db' })
  db.init()
  return { fake, db }
}

describe('RubisDatabase.getOrders', () => {
  it('returns orders sorted by created_at DESC via SQL ORDER BY', () => {
    const { fake, db } = freshDb()
    const rows = [
      { local_id: 2, shopify_order_id: null, total: 10, status: 'pending_sync', created_at: '2026-08-24T10:00:00Z' },
      { local_id: 1, shopify_order_id: 'gid://shopify/Order/1', total: 5, status: 'synced', created_at: '2026-08-23T10:00:00Z' }
    ]
    fake.setAllResult('SELECT local_id, shopify_order_id, total, status, created_at', rows)

    const result = db.getOrders()

    expect(result).toEqual(rows)
    const [call] = fake.callsFor('all', 'FROM orders ORDER BY created_at DESC')
    expect(call).toBeDefined()
  })

  it('applies limit/offset with defaults of 50 and 0', () => {
    const { fake, db } = freshDb()
    fake.setAllResult('FROM orders', [])

    db.getOrders()

    const [call] = fake.callsFor('all', 'FROM orders')
    expect(call.params).toEqual([50, 0])
  })

  it('passes through custom limit/offset values', () => {
    const { fake, db } = freshDb()
    fake.setAllResult('FROM orders', [])

    db.getOrders(10, 20)

    const [call] = fake.callsFor('all', 'FROM orders')
    expect(call.params).toEqual([10, 20])
  })

  it('includes payload_json in the SELECT so line items can be shown in order history', () => {
    const { fake, db } = freshDb()
    fake.setAllResult('FROM orders', [])

    db.getOrders()

    const [call] = fake.callsFor('all', 'FROM orders')
    expect(call.sql).toContain('payload_json')
  })
})

describe('RubisDatabase.retryOrderSync', () => {
  it('creates a new sync_queue entry from the stored payload_json', () => {
    const { fake, db } = freshDb()
    fake.setGetResult('SELECT local_id, status, payload_json FROM orders', {
      local_id: 5,
      status: 'failed',
      payload_json: '{"clientOrderUuid":"uuid-5"}'
    })
    fake.queueRunResult('INSERT INTO sync_queue', 99)

    const result = db.retryOrderSync(5)

    expect(result).toEqual({ queueId: 99 })
    const [insertCall] = fake.callsFor('run', 'INSERT INTO sync_queue')
    expect(insertCall.params).toEqual([
      'order',
      5,
      'orderCreate',
      '{"clientOrderUuid":"uuid-5"}',
      0,
      insertCall.params[5],
      0
    ])
  })

  it('resets the order status to pending_sync', () => {
    const { fake, db } = freshDb()
    fake.setGetResult('SELECT local_id, status, payload_json FROM orders', {
      local_id: 5,
      status: 'failed',
      payload_json: '{}'
    })
    fake.queueRunResult('INSERT INTO sync_queue', 1)

    db.retryOrderSync(5)

    const [updateCall] = fake.callsFor('run', 'UPDATE orders SET status = ?')
    expect(updateCall.params).toEqual(['pending_sync', 5])
  })

  it('rejects retrying an order that is already synced', () => {
    const { fake, db } = freshDb()
    fake.setGetResult('SELECT local_id, status, payload_json FROM orders', {
      local_id: 5,
      status: 'synced',
      payload_json: '{}'
    })

    expect(() => db.retryOrderSync(5)).toThrow(/already synced/i)
  })

  it('rejects retrying a non-existent order', () => {
    const { fake: _fake, db } = freshDb()

    expect(() => db.retryOrderSync(999)).toThrow(/not found/i)
  })
})

/**
 * docs/phase-168 finding 3: Retry Sync must never leave two queue rows
 * for one sale. Row counts need a real database, so these use the real
 * `better-sqlite3` (bypassing this file's module mock through
 * `vi.importActual`) against `:memory:`, injected via `DatabaseFactory`.
 */
describe('RubisDatabase.retryOrderSync keeps one queue row per sale (real SQLite)', () => {
  const realDb = async (maxAttempts?: number): Promise<RubisDatabase> => {
    const { default: RealSqlite } = await vi.importActual<{ default: typeof BetterSqlite3 }>('better-sqlite3')
    const db = new RubisDatabase({ dbPath: ':memory:', DatabaseFactory: RealSqlite, maxAttempts })
    db.init()
    return db
  }

  const seedSale = (db: RubisDatabase): number =>
    db.queueOrder({
      items: [],
      total: 10,
      clientOrderUuid: 'uuid-retry-1',
      staffId: 1,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 10,
      changeDue: 0
    }).localId

  /** Every 'order' queue row for this sale, due or not. */
  const rowsFor = (db: RubisDatabase, localId: number) =>
    db.getPendingSyncQueue(Number.MAX_SAFE_INTEGER).filter((row) => row.entity_id === localId)

  it('pending_sync with a row: still exactly one row, and it is due now', async () => {
    const db = await realDb()
    const localId = seedSale(db)
    const [original] = rowsFor(db, localId)
    // One failed push moves the row into the future (backoff), so "due
    // now" below is proven by the retry, not by the row's initial 0.
    db.recordQueueFailure(original.id, 'timed out')
    expect(db.getPendingSyncQueue(Date.now())).toHaveLength(0)

    const { queueId } = db.retryOrderSync(localId)

    expect(queueId).toBe(original.id)
    expect(rowsFor(db, localId)).toHaveLength(1)
    expect(db.getPendingSyncQueue(Date.now()).map((row) => row.id)).toEqual([original.id])
    expect(db.getOrder(localId)?.status).toBe('pending_sync')
  })

  it('failed (no row left): exactly one new row', async () => {
    const db = await realDb(1)
    const localId = seedSale(db)
    const [original] = rowsFor(db, localId)
    db.recordQueueFailure(original.id, 'always fails')
    expect(db.getOrder(localId)?.status).toBe('failed')
    expect(rowsFor(db, localId)).toHaveLength(0)

    db.retryOrderSync(localId)

    expect(rowsFor(db, localId)).toHaveLength(1)
    expect(db.getOrder(localId)?.status).toBe('pending_sync')
  })

  it('synced: refused, and no row is created', async () => {
    const db = await realDb()
    const localId = seedSale(db)
    const [original] = rowsFor(db, localId)
    db.markQueueItemSynced(original.id, 'gid://shopify/Order/1')

    expect(() => db.retryOrderSync(localId)).toThrow(/already synced/i)
    expect(rowsFor(db, localId)).toHaveLength(0)
  })

  it('two presses: still one row', async () => {
    const db = await realDb()
    const localId = seedSale(db)

    db.retryOrderSync(localId)
    db.retryOrderSync(localId)

    expect(rowsFor(db, localId)).toHaveLength(1)
  })

  it('two presses on a failed sale: one row, not two', async () => {
    const db = await realDb(1)
    const localId = seedSale(db)
    db.recordQueueFailure(rowsFor(db, localId)[0].id, 'always fails')

    db.retryOrderSync(localId)
    db.retryOrderSync(localId)

    expect(rowsFor(db, localId)).toHaveLength(1)
  })

  /**
   * docs/phase-169-1 commit B: `retryOrderSync` refuses a voided sale
   * (docs/phase-169 §7's own finding), and resets a reused row's
   * `attempts` back to 0 — a manual retry is a fresh decision, not
   * another automatic backoff step.
   */
  it('voided: refused, and no row is created', async () => {
    const db = await realDb()
    const localId = seedSale(db)
    db.voidOrder(localId)

    expect(() => db.retryOrderSync(localId)).toThrow(/voided/i)
    expect(rowsFor(db, localId)).toHaveLength(0)
    expect(db.getOrder(localId)?.status).toBe('voided')
  })

  it('a reused row has attempts reset to 0 and is due now', async () => {
    const db = await realDb()
    const localId = seedSale(db)
    const [original] = rowsFor(db, localId)
    db.recordQueueFailure(original.id, 'timed out')
    db.recordQueueFailure(original.id, 'timed out again')
    expect(rowsFor(db, localId)[0].attempts).toBe(2)

    db.retryOrderSync(localId)

    const [reused] = rowsFor(db, localId)
    expect(reused.attempts).toBe(0)
    expect(db.getPendingSyncQueue(Date.now()).map((row) => row.id)).toEqual([reused.id])
  })

  it('the push marker is unchanged by a retry', async () => {
    const db = await realDb()
    const localId = seedSale(db)
    db.recordPushStarted(localId)
    db.recordPushStarted(localId)
    expect(db.getShopifyPushMarker(localId)).toEqual(
      expect.objectContaining({ count: 2 })
    )

    db.retryOrderSync(localId)

    expect(db.getShopifyPushMarker(localId)).toEqual(
      expect.objectContaining({ count: 2 })
    )
  })
})

/**
 * docs/phase-170 commit 2: `linkOrderToShopify` is the reconciliation
 * check's one write - a lost-response sale is marked `synced` with the
 * matching Shopify order id, and its `'order'` queue row (never its
 * `'etims_invoice'` row) is removed. Real SQLite, same reasoning as the
 * `retryOrderSync` describe block above: proving a row count needs a
 * real transaction, not a recording fake.
 */
describe('RubisDatabase.linkOrderToShopify (real SQLite)', () => {
  const realDb = async (maxAttempts?: number): Promise<RubisDatabase> => {
    const { default: RealSqlite } = await vi.importActual<{ default: typeof BetterSqlite3 }>('better-sqlite3')
    const db = new RubisDatabase({ dbPath: ':memory:', DatabaseFactory: RealSqlite, maxAttempts })
    db.init()
    return db
  }

  const seedSale = (db: RubisDatabase): number =>
    db.queueOrder({
      items: [],
      total: 10,
      clientOrderUuid: 'uuid-link-1',
      staffId: 1,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 10,
      changeDue: 0
    }).localId

  const rowsFor = (db: RubisDatabase, localId: number) =>
    db.getPendingSyncQueue(Number.MAX_SAFE_INTEGER).filter((row) => row.entity_id === localId)

  it('links a pending_sync sale: synced, shopify_order_id set, its order queue row removed', async () => {
    const db = await realDb()
    const localId = seedSale(db)

    const { linked } = db.linkOrderToShopify(localId, 'gid://shopify/Order/900')

    expect(linked).toBe(true)
    const order = db.getOrder(localId)
    expect(order?.status).toBe('synced')
    expect(order?.shopify_order_id).toBe('gid://shopify/Order/900')
    expect(rowsFor(db, localId)).toHaveLength(0)
  })

  it('links a failed sale the same way, even with no queue row left', async () => {
    const db = await realDb(1)
    const localId = seedSale(db)
    db.recordQueueFailure(rowsFor(db, localId)[0].id, 'always fails')
    expect(db.getOrder(localId)?.status).toBe('failed')

    const { linked } = db.linkOrderToShopify(localId, 'gid://shopify/Order/901')

    expect(linked).toBe(true)
    expect(db.getOrder(localId)?.status).toBe('synced')
  })

  it('refuses a voided sale: no write, no queue row removed', async () => {
    const db = await realDb()
    const localId = seedSale(db)
    db.voidOrder(localId)

    const { linked } = db.linkOrderToShopify(localId, 'gid://shopify/Order/902')

    expect(linked).toBe(false)
    expect(db.getOrder(localId)?.status).toBe('voided')
    expect(db.getOrder(localId)?.shopify_order_id).toBeNull()
  })

  it('refuses an already-synced sale: does not overwrite its existing shopify_order_id', async () => {
    const db = await realDb()
    const localId = seedSale(db)
    db.linkOrderToShopify(localId, 'gid://shopify/Order/original')

    const { linked } = db.linkOrderToShopify(localId, 'gid://shopify/Order/different')

    expect(linked).toBe(false)
    expect(db.getOrder(localId)?.shopify_order_id).toBe('gid://shopify/Order/original')
  })

  it('removes only the order queue row, never an etims_invoice row for the same sale', async () => {
    const db = await realDb()
    const localId = seedSale(db)
    db.queueFiscalInvoice(localId, {
      clientOrderUuid: 'uuid-link-1',
      items: [],
      total: 10,
      taxAmount: 0.8
    })

    db.linkOrderToShopify(localId, 'gid://shopify/Order/903')

    const remaining = db
      .getPendingFiscalQueue(Number.MAX_SAFE_INTEGER)
      .filter((row) => row.entity_id === localId)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].entity_type).toBe('etims_invoice')
  })
})
