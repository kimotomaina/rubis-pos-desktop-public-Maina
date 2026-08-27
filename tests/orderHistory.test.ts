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
    fake.setAllResult('SELECT local_id, shopify_order_id, total, status, created_at FROM orders', rows)

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
