/**
 * Till/register shift tests.
 *
 * `better-sqlite3` is mocked with a recording fake so we assert the
 * exact SQL and parameter traffic produced by `RubisDatabase` without
 * loading the native module — the same pattern used throughout this
 * codebase's database tests.
 */

import { describe, it, expect, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import type { OrderRow, ShiftRow } from '../src/main/services/database.js'

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
  const getResults = new Map<string, unknown[]>()
  const runResults = new Map<string, Array<{ lastInsertRowid: number; changes: number }>>()

  const setAllResult = (sqlMatch: string, rows: unknown[]): void => {
    allResults.set(sqlMatch, rows)
  }

  /** Queues successive `.get()` return values for SQL containing a tag. */
  const queueGetResult = (sqlMatch: string, row: unknown): void => {
    const list = getResults.get(sqlMatch) ?? []
    list.push(row)
    getResults.set(sqlMatch, list)
  }

  const queueRunResult = (
    sqlMatch: string,
    outcome: Partial<{ lastInsertRowid: number; changes: number }>
  ): void => {
    const list = runResults.get(sqlMatch) ?? []
    list.push({ lastInsertRowid: 0, changes: 1, ...outcome })
    runResults.set(sqlMatch, list)
  }

  const findAll = <T>(store: Map<string, T>, sql: string): T | undefined => {
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
        const queued = findAll(runResults, sql)
        if (queued && queued.length > 0) return queued.shift()
        return { changes: 1, lastInsertRowid: 0 }
      },
      get: (...params: unknown[]) => {
        calls.push({ sql, kind: 'get', params })
        const queued = findAll(getResults, sql)
        if (queued && queued.length > 0) return queued.shift()
        return undefined
      },
      all: (...params: unknown[]) => {
        calls.push({ sql, kind: 'all', params })
        return findAll(allResults, sql) ?? []
      }
    }))
  }

  return {
    connection,
    calls,
    setAllResult,
    queueGetResult,
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

const openShiftRow: ShiftRow = {
  id: 1,
  staff_id: 1,
  clock_in: '2026-08-24T08:00:00.000Z',
  clock_out: null,
  starting_cash: 100,
  expected_cash: null,
  ending_cash: null,
  discrepancy: null,
  status: 'open'
}

describe('RubisDatabase.openShift', () => {
  it('opens a shift with the given starting cash when none is open', () => {
    const { fake, db } = freshDb()
    fake.queueRunResult('INSERT INTO shifts', { lastInsertRowid: 5 })

    const result = db.openShift(1, 100)

    expect(result).toEqual({ shiftId: 5 })
    const [insert] = fake.callsFor('run', 'INSERT INTO shifts')
    expect(insert.params).toEqual([1, expect.any(String), 100])
  })

  it('throws when a shift is already open', () => {
    const { fake, db } = freshDb()
    fake.queueGetResult("status = 'open'", openShiftRow)

    expect(() => db.openShift(2, 50)).toThrow(/already open/i)
  })
})

describe('RubisDatabase.getOpenShift', () => {
  it('returns undefined when no shift is open', () => {
    const { db } = freshDb()
    expect(db.getOpenShift()).toBeUndefined()
  })

  it('returns the open shift row when one exists', () => {
    const { fake, db } = freshDb()
    fake.queueGetResult("status = 'open'", openShiftRow)

    expect(db.getOpenShift()).toEqual(openShiftRow)
  })
})

describe('RubisDatabase.closeShift', () => {
  const cashOrder = (total: number): OrderRow => ({
    local_id: 1,
    shopify_order_id: null,
    total,
    status: 'pending_sync',
    created_at: '2026-08-24T09:00:00.000Z',
    payload_json: '{}',
    staff_id: 1,
    payment_method: 'cash',
    tendered_amount: total,
    change_due: 0,
    reference_number: null,
    shift_id: 1
  })

  const mpesaOrder = (total: number): OrderRow => ({
    ...cashOrder(total),
    payment_method: 'mpesa',
    reference_number: 'QGH7XJ2K1L'
  })

  it('computes expected cash from starting cash + cash-order revenue, and the discrepancy', () => {
    const { fake, db } = freshDb()
    fake.queueGetResult('FROM shifts WHERE id', openShiftRow)
    fake.setAllResult(
      'FROM orders WHERE shift_id',
      [cashOrder(50), cashOrder(30), mpesaOrder(20)]
    )

    const result = db.closeShift(1, 175)

    // expected = 100 (starting) + 50 + 30 (cash orders) = 180; mpesa ignored
    expect(result.expectedCash).toBe(180)
    // discrepancy = counted (175) - expected (180) = -5 (short)
    expect(result.discrepancy).toBe(-5)

    const [update] = fake.callsFor('run', 'UPDATE shifts SET clock_out')
    expect(update.params).toEqual([expect.any(String), 180, 175, -5, 1])
  })

  it('reports a positive discrepancy when counted cash exceeds expected', () => {
    const { fake, db } = freshDb()
    fake.queueGetResult('FROM shifts WHERE id', openShiftRow)
    fake.setAllResult('FROM orders WHERE shift_id', [cashOrder(50)])

    const result = db.closeShift(1, 160)

    // expected = 100 + 50 = 150; discrepancy = 160 - 150 = 10 (over)
    expect(result.expectedCash).toBe(150)
    expect(result.discrepancy).toBe(10)
  })

  it('throws for a non-existent shift', () => {
    const { db } = freshDb()
    expect(() => db.closeShift(999, 100)).toThrow(/not found/i)
  })

  it('throws when the shift is already closed', () => {
    const { fake, db } = freshDb()
    fake.queueGetResult('FROM shifts WHERE id', { ...openShiftRow, status: 'closed' })

    expect(() => db.closeShift(1, 100)).toThrow(/already closed/i)
  })
})

describe('RubisDatabase.getOrdersForShift', () => {
  it('queries orders scoped to the given shift id', () => {
    const { fake, db } = freshDb()
    fake.setAllResult('WHERE shift_id', [])

    db.getOrdersForShift(1)

    const [call] = fake.callsFor('all', 'WHERE shift_id')
    expect(call.params).toEqual([1])
  })
})

describe('recording orders against an open shift', () => {
  it('persists shift_id on the order row via queueOrder', () => {
    const { fake, db } = freshDb()
    fake.queueRunResult('INSERT INTO orders', { lastInsertRowid: 9 })
    fake.queueRunResult('INSERT INTO sync_queue', { lastInsertRowid: 4 })

    db.queueOrder({
      items: [
        {
          id: 'gid://shopify/ProductVariant/201',
          productId: '101',
          title: 'RUBIS Mug',
          variantTitle: 'Small',
          price: 12.5,
          quantity: 1,
          image: null
        }
      ],
      total: 12.5,
      clientOrderUuid: 'uuid-shift-1',
      staffId: 1,
      staffName: 'Admin',
      paymentMethod: 'cash',
      tenderedAmount: 20,
      changeDue: 7.5,
      shiftId: 7
    })

    const [insert] = fake.callsFor('run', 'INSERT INTO orders')
    expect(insert.params[insert.params.length - 1]).toBe(7)
  })
})
