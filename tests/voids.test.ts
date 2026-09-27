/**
 * Order void tests.
 *
 * `RubisDatabase.voidOrder` is tested against a recording fake
 * `better-sqlite3` connection (same pattern as `shifts.test.ts` /
 * `database.test.ts`); `voidLocalOrder` (the `voids.ts` service) is
 * tested against a minimal fake satisfying only the two methods it
 * calls, mirroring how `auth.test.ts` exercises `authenticateStaff`
 * against a fake `RubisDatabase`.
 */

import { describe, it, expect, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import type { OrderRow } from '../src/main/services/database.js'
import { voidLocalOrder } from '../src/main/services/voids.js'

vi.mock('better-sqlite3', () => ({ default: vi.fn() }))

const MockedDatabaseCtor = vi.mocked(BetterSqlite3)

interface RecordedCall {
  sql: string
  kind: 'run' | 'get' | 'all'
  params: unknown[]
}

function createFakeConnection() {
  const calls: RecordedCall[] = []
  const getResults = new Map<string, unknown[]>()

  const queueGetResult = (sqlMatch: string, row: unknown): void => {
    const list = getResults.get(sqlMatch) ?? []
    list.push(row)
    getResults.set(sqlMatch, list)
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
        return []
      }
    }))
  }

  return {
    connection,
    calls,
    queueGetResult,
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

const pendingOrderRow = (overrides: Partial<OrderRow> = {}): OrderRow => ({
  local_id: 7,
  shopify_order_id: null,
  total: 250,
  status: 'pending_sync',
  created_at: '2026-08-25T10:00:00.000Z',
  payload_json: JSON.stringify({
    clientOrderUuid: 'uuid-7',
    total: 250,
    createdAt: '2026-08-25T10:00:00.000Z',
    lineItems: [
      { variantId: 'variant-1', title: 'RUBIS Mug', variantTitle: 'Small', quantity: 2, unitPrice: 100 },
      { variantId: 'variant-2', title: 'RUBIS Cap', variantTitle: 'Default', quantity: 1, unitPrice: 50 }
    ],
    staffId: 1,
    staffName: 'Alex',
    paymentMethod: 'cash',
    tenderedAmount: 250,
    changeDue: 0
  }),
  staff_id: 1,
  payment_method: 'cash',
  tendered_amount: 250,
  change_due: 0,
  reference_number: null,
  shift_id: 1,
  fiscal_invoice_number: null,
  fiscal_qr_code: null,
  fiscal_fiscalized_at: null,
  fiscal_status: null,
  fiscal_error_reason: null,
  fiscal_error_kind: null,
  fiscal_request_json: null,
  fiscal_data_issue: null,
  fiscal_vat_groups_json: null,
  fiscal_fiscalized_at_source: null,
  fiscal_cu_serial: null,
  ...overrides
})

describe('RubisDatabase.voidOrder', () => {
  it('marks the order voided and clears its sync-queue entries', () => {
    const { fake, db } = freshDb()
    fake.queueGetResult('FROM orders WHERE local_id', pendingOrderRow())

    const result = db.voidOrder(7)

    expect(result.voidedAt).toEqual(expect.any(String))

    const statusUpdate = fake.callsFor('run', 'UPDATE orders SET status')
    expect(statusUpdate).toHaveLength(1)
    expect(statusUpdate[0].params).toEqual(['voided', 7])

    const queueClear = fake.callsFor('run', 'DELETE FROM sync_queue')
    expect(queueClear).toHaveLength(2)
    expect(queueClear[0].sql).toContain("entity_type = 'order'")
    expect(queueClear[0].params).toEqual([7])
    expect(queueClear[1].sql).toContain("entity_type = 'etims_invoice'")
    expect(queueClear[1].params).toEqual([7])
  })

  /**
   * Shopify is the only source of truth for stock. A `pending_sync`
   * order never reached Shopify, so Shopify's quantity was never
   * decremented and a void has nothing to reverse. The increment this
   * used to run had no matching decrement anywhere, so it only
   * inflated the cached figure the stock take reports variance
   * against — see phase-118.
   */
  it('never writes to the cached products inventory', () => {
    const { fake, db } = freshDb()
    fake.queueGetResult('FROM orders WHERE local_id', pendingOrderRow())

    db.voidOrder(7)

    expect(fake.callsFor('run', 'UPDATE products')).toHaveLength(0)
    expect(fake.callsFor('run', 'inventory_quantity')).toHaveLength(0)
  })

  it('throws when the order does not exist', () => {
    const { fake, db } = freshDb()
    fake.queueGetResult('FROM orders WHERE local_id', undefined)

    expect(() => db.voidOrder(999)).toThrow(/not found/i)
  })

  it('throws when the order is already synced', () => {
    const { fake, db } = freshDb()
    fake.queueGetResult('FROM orders WHERE local_id', pendingOrderRow({ status: 'synced' }))

    expect(() => db.voidOrder(7)).toThrow(/cannot be voided/i)
  })

  it('throws when the order is already voided', () => {
    const { fake, db } = freshDb()
    fake.queueGetResult('FROM orders WHERE local_id', pendingOrderRow({ status: 'voided' }))

    expect(() => db.voidOrder(7)).toThrow(/cannot be voided/i)
  })
})

describe('voidLocalOrder', () => {
  const fakeDb = (overrides: Partial<{ getOrder: unknown; voidOrder: unknown }> = {}) =>
    ({
      getOrder: vi.fn(() => pendingOrderRow()),
      voidOrder: vi.fn(() => ({ voidedAt: '2026-08-25T10:05:00.000Z' })),
      ...overrides
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any

  it('voids a pending_sync order and returns the result', () => {
    const db = fakeDb()

    const result = voidLocalOrder(db, 7)

    expect(result).toEqual({
      success: true,
      data: { localId: 7, voidedAt: '2026-08-25T10:05:00.000Z' }
    })
    expect(db.voidOrder).toHaveBeenCalledWith(7)
  })

  it('rejects an unknown order without calling voidOrder', () => {
    const db = fakeDb({ getOrder: vi.fn(() => undefined) })

    const result = voidLocalOrder(db, 999)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
    expect(db.voidOrder).not.toHaveBeenCalled()
  })

  it('rejects a synced order with an already-synced explanation, without calling voidOrder', () => {
    const db = fakeDb({ getOrder: vi.fn(() => pendingOrderRow({ status: 'synced' })) })

    const result = voidLocalOrder(db, 7)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already synced/i)
    expect(db.voidOrder).not.toHaveBeenCalled()
  })

  it('rejects a failed order without calling voidOrder', () => {
    const db = fakeDb({ getOrder: vi.fn(() => pendingOrderRow({ status: 'failed' })) })

    const result = voidLocalOrder(db, 7)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/cannot be voided/i)
    expect(db.voidOrder).not.toHaveBeenCalled()
  })

  it('surfaces an error thrown by db.voidOrder as a ServiceResult failure', () => {
    const db = fakeDb({
      voidOrder: vi.fn(() => {
        throw new Error('disk full')
      })
    })

    const result = voidLocalOrder(db, 7)

    expect(result).toEqual({ success: false, error: 'disk full' })
  })
})
