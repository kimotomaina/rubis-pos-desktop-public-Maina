/**
 * M-Pesa opening and closing balances on a shift (docs/phase-222).
 *
 * The balances are optional: a shift without them behaves, stores and prints exactly as before, and a missing
 * figure reads "Not recorded", never 0. `better-sqlite3` is mocked with the same recording fake the other
 * shift tests use, so the exact SQL and parameters are asserted.
 */

import { describe, it, expect, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import type { OrderRow, ShiftRow, StaffRow } from '../src/main/services/database.js'
import { generateZReport } from '../src/main/services/reports.js'
import type { ZReport } from '../src/main/services/reports.js'
import { renderZReport } from '../src/main/services/printer.js'
import type { PrinterSettings, ThermalPrinterLike } from '../src/main/services/printer.js'
import { closeShiftUnlessHeld } from '../src/main/services/held-sales.js'
import { shiftOpenSchema, shiftCloseSchema } from '../src/main/lib/ipcValidator.js'
import { zReportMpesaLines } from '../src/main/lib/zReportMpesa.js'
import { zReportMpesaLines as rendererLines } from '../src/renderer/src/lib/zReportMpesa.js'

vi.mock('better-sqlite3', () => ({ default: vi.fn() }))

const MockedDatabaseCtor = vi.mocked(BetterSqlite3)

interface RecordedCall {
  sql: string
  kind: 'run' | 'get' | 'all'
  params: unknown[]
}

function createFakeConnection() {
  const calls: RecordedCall[] = []
  const allResults = new Map<string, unknown[]>()
  const getResults = new Map<string, unknown[]>()
  const runResults = new Map<string, Array<{ lastInsertRowid: number; changes: number }>>()
  const find = <T>(store: Map<string, T>, sql: string): T | undefined => {
    for (const [match, value] of store) if (sql.includes(match)) return value
    return undefined
  }
  const connection = {
    pragma: vi.fn(),
    exec: vi.fn(),
    close: vi.fn(),
    transaction: vi.fn((fn: (...args: unknown[]) => unknown) => {
      const run = (...args: unknown[]): unknown => fn(...args)
      return Object.assign(run, { immediate: run })
    }),
    prepare: vi.fn((sql: string) => ({
      run: (...params: unknown[]) => {
        calls.push({ sql, kind: 'run', params })
        const queued = find(runResults, sql)
        if (queued && queued.length > 0) return queued.shift()
        return { changes: 1, lastInsertRowid: 0 }
      },
      get: (...params: unknown[]) => {
        calls.push({ sql, kind: 'get', params })
        const queued = find(getResults, sql)
        if (queued && queued.length > 0) return queued.shift()
        return undefined
      },
      all: (...params: unknown[]) => {
        calls.push({ sql, kind: 'all', params })
        return find(allResults, sql) ?? []
      }
    }))
  }
  return {
    connection,
    setAllResult: (match: string, rows: unknown[]) => allResults.set(match, rows),
    queueGetResult: (match: string, row: unknown) => {
      const list = getResults.get(match) ?? []
      list.push(row)
      getResults.set(match, list)
    },
    queueRunResult: (match: string, outcome: Partial<{ lastInsertRowid: number; changes: number }>) => {
      const list = runResults.get(match) ?? []
      list.push({ lastInsertRowid: 0, changes: 1, ...outcome })
      runResults.set(match, list)
    },
    callsFor: (kind: RecordedCall['kind'], match: string) =>
      calls.filter((c) => c.kind === kind && c.sql.includes(match))
  }
}

const freshDb = () => {
  const fake = createFakeConnection()
  MockedDatabaseCtor.mockImplementation(() => fake.connection as unknown as InstanceType<typeof BetterSqlite3>)
  const db = new RubisDatabase({ dbPath: '/tmp/rubis-test.db' })
  db.init()
  return { fake, db }
}

const openShiftRow: ShiftRow = {
  id: 1,
  staff_id: 1,
  clock_in: '2026-10-05T06:00:00.000Z',
  clock_out: null,
  starting_cash: 100,
  expected_cash: null,
  ending_cash: null,
  discrepancy: null,
  status: 'open'
}

const order = (total: number, method: 'cash' | 'mpesa' | 'card', status = 'completed'): OrderRow =>
  ({
    local_id: 1,
    shopify_order_id: null,
    total,
    status,
    created_at: '2026-10-05T07:00:00.000Z',
    payload_json: '{}',
    staff_id: 1,
    payment_method: method,
    shift_id: 1,
    fiscal_request_json: null
  }) as unknown as OrderRow

// CHANGED (docs/phase-232). OLD: openShift(1, 100, 'day', 2500) took a type from the screen and left shift_type and the
// M-Pesa column out of the INSERT when they were not given. NEW: openShift(1, 100, 2500, {}, nowMs): the type is the
// window of the clock and both columns are always written (null is "not recorded").
describe('openShift with an M-Pesa opening balance', () => {
  const nowMs = Date.parse('2026-10-02T07:00:00.000Z')

  it('stores it in its own column, after the existing ones', () => {
    const { fake, db } = freshDb()
    fake.queueRunResult('INSERT INTO shifts', { lastInsertRowid: 7 })

    expect(db.openShift(1, 100, 2500, {}, nowMs)).toEqual({ shiftId: 7 })

    const [insert] = fake.callsFor('run', 'INSERT INTO shifts')
    expect(insert.sql).toBe(
      "INSERT INTO shifts (staff_id, clock_in, starting_cash, status, shift_type, mpesa_opening_balance) VALUES (?, ?, ?, 'open', ?, ?)"
    )
    expect(insert.params).toEqual([1, new Date(nowMs).toISOString(), 100, 'day', 2500])
  })

  it('stores a recorded balance of 0 as 0, not as "not recorded"', () => {
    const { fake, db } = freshDb()
    db.openShift(1, 100, 0, {}, nowMs)

    const [insert] = fake.callsFor('run', 'INSERT INTO shifts')
    expect(insert.params).toEqual([1, new Date(nowMs).toISOString(), 100, 'day', 0])
  })

  it('stores null for a balance that was not given, in the same statement', () => {
    const { fake, db } = freshDb()
    db.openShift(1, 100, null, {}, nowMs)

    const [insert] = fake.callsFor('run', 'INSERT INTO shifts')
    expect(insert.params).toEqual([1, new Date(nowMs).toISOString(), 100, 'day', null])
  })
})

describe('closeShift with M-Pesa balances', () => {
  const closeWith = (shift: ShiftRow, closing: number | null) => {
    const { fake, db } = freshDb()
    fake.queueGetResult('FROM shifts WHERE id', shift)
    fake.setAllResult('FROM orders WHERE shift_id', [
      order(50, 'cash'),
      order(300, 'mpesa'),
      order(200, 'mpesa'),
      order(999, 'mpesa', 'voided'),
      order(75, 'card')
    ])
    const result = db.closeShift(1, 150, closing)
    return { fake, result }
  }

  it('expects the opening balance plus the non-voided M-Pesa sales, and stores the difference', () => {
    const { fake, result } = closeWith({ ...openShiftRow, mpesa_opening_balance: 1000 }, 1480)

    // 1000 + 300 + 200; the voided 999 and the cash and card sales do not count.
    expect(result.mpesaExpected).toBe(1500)
    expect(result.mpesaDifference).toBe(-20)
    const [update] = fake.callsFor('run', 'SET mpesa_closing_balance')
    expect(update.params).toEqual([1480, 1500, -20, 1])
  })

  it('leaves the cash figures and the cash statement exactly as they were', () => {
    const { fake, result } = closeWith({ ...openShiftRow, mpesa_opening_balance: 1000 }, 1480)

    expect(result.expectedCash).toBe(150)
    expect(result.discrepancy).toBe(0)
    const [update] = fake.callsFor('run', 'UPDATE shifts SET clock_out')
    expect(update.params).toEqual([expect.any(String), 150, 150, 0, 1])
  })

  it('stores the counted balance but no difference when there was no opening balance', () => {
    const { fake, result } = closeWith(openShiftRow, 1480)

    expect(result.mpesaExpected).toBeNull()
    expect(result.mpesaDifference).toBeNull()
    const [update] = fake.callsFor('run', 'SET mpesa_closing_balance')
    expect(update.params).toEqual([1480, null, null, 1])
  })

  it('stores no expected figure when there was no counted balance', () => {
    const { fake, result } = closeWith({ ...openShiftRow, mpesa_opening_balance: 1000 }, null)

    expect(result.mpesaExpected).toBeNull()
    expect(result.mpesaDifference).toBeNull()
    expect(fake.callsFor('run', 'SET mpesa_closing_balance')).toHaveLength(0)
  })

  it('writes nothing beyond the old statement when no balance was recorded at all', () => {
    const { fake, result } = closeWith(openShiftRow, null)

    expect(result).toEqual({ expectedCash: 150, discrepancy: 0, mpesaExpected: null, mpesaDifference: null })
    expect(fake.callsFor('run', 'UPDATE shifts')).toHaveLength(1)
  })

  it('passes the counted balance through the held-sales guard', () => {
    const closeShift = vi.fn(() => ({ expectedCash: 1, discrepancy: 0, mpesaExpected: null, mpesaDifference: null }))
    // CHANGED (docs/phase-232). OLD: the guard's database had two methods. NEW: it also reads the shift, to check the window
    // has reached its last minute; a shift it cannot find is left to closeShift, which says so.
    closeShiftUnlessHeld({ closeShift, listOpenHeldSales: () => [], getShiftById: () => undefined }, 3, 100, 640)

    expect(closeShift).toHaveBeenCalledWith(3, 100, 640)
  })
})

describe('IPC schemas', () => {
  it('accept a request with no balance, a null one, and a recorded one including 0', () => {
    expect(shiftOpenSchema.safeParse({ staffId: 1, startingCash: 100 }).success).toBe(true)
    expect(shiftOpenSchema.safeParse({ staffId: 1, startingCash: 100, mpesaOpeningBalance: null }).success).toBe(true)
    expect(shiftOpenSchema.safeParse({ staffId: 1, startingCash: 100, mpesaOpeningBalance: 0 }).success).toBe(true)
    expect(shiftCloseSchema.safeParse({ shiftId: 1, endingCash: 100, mpesaClosingBalance: 1200.5 }).success).toBe(true)
  })

  it('refuse a negative, non-finite or text balance', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '100']) {
      expect(shiftOpenSchema.safeParse({ staffId: 1, startingCash: 100, mpesaOpeningBalance: bad }).success).toBe(false)
      expect(shiftCloseSchema.safeParse({ shiftId: 1, endingCash: 100, mpesaClosingBalance: bad }).success).toBe(false)
    }
  })
})

const staff = { id: 1, name: 'Ann', role: 'cashier', is_active: 1 } as unknown as StaffRow

const dbFor = (shift: ShiftRow, orders: OrderRow[] = []): RubisDatabase =>
  ({
    getShiftById: vi.fn(() => shift),
    getStaffById: vi.fn(() => staff),
    getOrdersForShift: vi.fn(() => orders),
    getMpesaPaymentsForShift: vi.fn(() => []),
    listShiftCorrections: vi.fn(() => []), // ADDED (docs/phase-224)
    listShiftAdjustments: vi.fn(() => []), // ADDED (docs/phase-232): the Z report reads the shift's adjustments
    listAdjustmentSales: vi.fn(() => []), // ADDED (docs/phase-232)
  }) as unknown as RubisDatabase

describe('generateZReport M-Pesa balances', () => {
  it('reports the stored figures for a closed shift', () => {
    const report = generateZReport(
      dbFor({
        ...openShiftRow,
        status: 'closed',
        clock_out: '2026-10-05T14:00:00.000Z',
        mpesa_opening_balance: 1000,
        mpesa_closing_balance: 1480,
        mpesa_expected: 1500,
        mpesa_difference: -20
      }),
      1,
      0.16
    )

    expect(report).toMatchObject({
      mpesaOpeningBalance: 1000,
      mpesaExpected: 1500,
      mpesaClosingBalance: 1480,
      mpesaDifference: -20
    })
  })

  it('computes the expected figure live for an open shift that has an opening balance', () => {
    const report = generateZReport(
      dbFor({ ...openShiftRow, mpesa_opening_balance: 1000 }, [order(300, 'mpesa'), order(50, 'cash')]),
      1,
      0.16
    )

    expect(report.mpesaExpected).toBe(1300)
    expect(report.mpesaClosingBalance).toBeNull()
    expect(report.mpesaDifference).toBeNull()
  })

  it('reports null, never 0, for a shift from before the balances existed', () => {
    const report = generateZReport(dbFor({ ...openShiftRow, status: 'closed' }), 1, 0.16)

    expect(report.mpesaOpeningBalance).toBeNull()
    expect(report.mpesaExpected).toBeNull()
    expect(report.mpesaClosingBalance).toBeNull()
    expect(report.mpesaDifference).toBeNull()
  })

  it('does not rewrite a closed shift whose balances were not both recorded', () => {
    const report = generateZReport(
      dbFor({ ...openShiftRow, status: 'closed', mpesa_opening_balance: 1000 }, [order(300, 'mpesa')]),
      1,
      0.16
    )

    expect(report.mpesaOpeningBalance).toBe(1000)
    expect(report.mpesaExpected).toBeNull()
  })
})

describe('the Z report M-Pesa lines', () => {
  const money = (n: number): string => `KES ${n}`
  const base: ZReport = {
    shiftId: 1,
    staffName: 'Ann',
    openedAt: '2026-10-05T06:00:00.000Z',
    closedAt: '2026-10-05T14:00:00.000Z',
    status: 'closed',
    startingCash: 100,
    totalsByMethod: { cash: 0, mpesa: 0, card: 0 },
    mpesaByMode: { manual: 0, daraja: 0 },
    orderCount: 0,
    totalRevenue: 0,
    vatIncluded: 0,
    vatRate: 0.16,
    expectedCash: 100,
    endingCash: 100,
    discrepancy: 0
  }
  const recorded: ZReport = {
    ...base,
    mpesaOpeningBalance: 1000,
    mpesaExpected: 1500,
    mpesaClosingBalance: 1480,
    mpesaDifference: -20
  }

  it('say "Not recorded" for every missing figure of a closed shift', () => {
    expect(zReportMpesaLines(base, money).map((l) => l.value)).toEqual([
      'Not recorded',
      'Not recorded',
      'Not recorded',
      'Not recorded'
    ])
  })

  it('say "Pending" for the figures an open shift has not reached, and not for an opening nobody entered', () => {
    const open = { ...base, status: 'open' as const, closedAt: null }
    expect(zReportMpesaLines({ ...open, mpesaOpeningBalance: 1000, mpesaExpected: 1300 }, money).map((l) => l.value)).toEqual([
      'KES 1000',
      'KES 1300',
      'Pending',
      'Pending'
    ])
    expect(zReportMpesaLines(open, money)[3].value).toBe('Not recorded')
  })

  it('show a recorded balance of 0 as a figure', () => {
    const lines = zReportMpesaLines({ ...recorded, mpesaOpeningBalance: 0, mpesaClosingBalance: 0 }, money)
    expect(lines[0].value).toBe('KES 0')
    expect(lines[2].value).toBe('KES 0')
  })

  it('word the last line as a check against the statement, not a shortage', () => {
    const lines = zReportMpesaLines(recorded, money)
    expect(lines.map((l) => l.label)).toEqual([
      'M-Pesa opening',
      'M-Pesa expected',
      'M-Pesa counted',
      'Check against the M-Pesa statement'
    ])
    expect(lines.map((l) => l.label).join(' ')).not.toMatch(/short|over|discrepancy/i)
  })

  it('are the same in the renderer twin, over every case above', () => {
    const open = { ...base, status: 'open' as const, closedAt: null }
    for (const report of [base, recorded, open, { ...open, mpesaOpeningBalance: 1000, mpesaExpected: 1300 }]) {
      expect(rendererLines(report, money)).toEqual(zReportMpesaLines(report, money))
    }
  })

  it('are printed under the cash figures, after a dashed line', () => {
    const lines: string[] = []
    const noop = (): void => {}
    const client = {
      isPrinterConnected: async () => true,
      alignCenter: noop,
      alignLeft: noop,
      alignRight: noop,
      bold: noop,
      setTextNormal: noop,
      setTextQuadArea: noop,
      println: (text: string) => lines.push(text),
      drawLine: () => lines.push('---'),
      printQR: noop,
      cut: noop,
      execute: async () => undefined
    } as unknown as ThermalPrinterLike
    const settings: PrinterSettings = { interfaceName: 'tcp://x', storeName: 'ENJOY', taxRate: 0.16 }

    renderZReport(client, recorded, settings)

    const at = lines.findIndex((l) => l.startsWith('Discrepancy:'))
    expect(lines.slice(at + 1)).toEqual([
      '---',
      expect.stringMatching(/^M-Pesa opening: .*1,000\.00$/),
      expect.stringMatching(/^M-Pesa expected: .*1,500\.00$/),
      expect.stringMatching(/^M-Pesa counted: .*1,480\.00$/),
      expect.stringMatching(/^Check against the M-Pesa statement: .*20\.00$/)
    ])
  })
})
