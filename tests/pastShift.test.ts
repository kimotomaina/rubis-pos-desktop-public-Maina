/**
 * Recording a shift for sales that had none (docs/phase-223): the period and overlap rules, the one transaction
 * that writes, the day list and the preview, the request schemas, and the Z report that says so.
 *
 * `better-sqlite3` is mocked with a recording fake, as in `tests/shifts.test.ts`. The fake does not roll back, so
 * what is asserted here is the SQL, its parameters, and that nothing was written before a refusal; rollback itself
 * is SQLite's, and was checked against a real database (see docs/phase-223.md).
 */

import { describe, it, expect, vi } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import type { ShiftRow, StaffRow, UnattachedSaleRow } from '../src/main/services/database.js'
import { findOverlappingShift, parsePastShiftPeriod } from '../src/main/lib/pastShift.js'
import { listUnattachedDays, previewPastShift } from '../src/main/services/past-shifts.js'
import { createPastShiftSchema, pastShiftPreviewSchema } from '../src/main/lib/ipcValidator.js'
import { generateZReport } from '../src/main/services/reports.js'
import type { ZReport } from '../src/main/services/reports.js'
import { renderZReport } from '../src/main/services/printer.js'
import type { PrinterSettings, ThermalPrinterLike } from '../src/main/services/printer.js'
import { zReportRetroLines } from '../src/main/lib/zReportRetro.js'
import { zReportRetroLines as rendererRetroLines } from '../src/renderer/src/lib/zReportRetro.js'

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

const NOW = Date.parse('2026-10-05T12:00:00.000Z')
const START = '2026-10-03T07:00:00.000Z'
const END = '2026-10-03T14:59:59.999Z'

const sale = (id: number, createdAt: string, total: number, method: 'cash' | 'mpesa' | 'card'): UnattachedSaleRow => ({
  local_id: id,
  created_at: createdAt,
  total,
  payment_method: method
})

const input = (overrides: Record<string, unknown> = {}) => ({
  managerId: 2,
  startIso: START,
  endIso: END,
  orderIds: [11, 12, 13],
  startingCash: 1000,
  endingCash: 1480,
  mpesaOpeningBalance: null,
  mpesaClosingBalance: null,
  shiftType: 'day' as const,
  reason: 'Till used without opening a shift',
  ...overrides
})

/** A database whose period holds sales 11 (cash 500), 12 (M-Pesa 300) and 13 (card 150), and these shifts. */
function dbWith(shifts: Array<{ id: number; clock_in: string; clock_out: string | null }> = []) {
  const { fake, db } = freshDb()
  fake.setAllResult('SELECT id, clock_in, clock_out FROM shifts', shifts)
  fake.setAllResult('shift_id IS NULL', [
    sale(11, '2026-10-03T08:00:00.000Z', 500, 'cash'),
    sale(12, '2026-10-03T09:00:00.000Z', 300, 'mpesa'),
    sale(13, '2026-10-03T10:00:00.000Z', 150, 'card')
  ])
  fake.queueRunResult('INSERT INTO shifts', { lastInsertRowid: 9 })
  return { fake, db }
}

describe('parsePastShiftPeriod', () => {
  it('normalises both instants to the .000Z form and keeps their milliseconds', () => {
    const period = parsePastShiftPeriod('2026-10-03T10:00:00+03:00', '2026-10-03T17:59:59.999+03:00', NOW)

    expect(period.startIso).toBe('2026-10-03T07:00:00.000Z')
    expect(period.endIso).toBe('2026-10-03T14:59:59.999Z')
  })

  it('refuses an unreadable time, an end before the start, and an end in the future', () => {
    expect(() => parsePastShiftPeriod('nonsense', END, NOW)).toThrow(/not a valid time/)
    expect(() => parsePastShiftPeriod(END, START, NOW)).toThrow(/before its start/)
    expect(() => parsePastShiftPeriod(START, '2026-10-05T12:00:00.001Z', NOW)).toThrow(/future/)
  })

  it('allows an end of exactly now, and an end equal to the start', () => {
    expect(() => parsePastShiftPeriod(START, '2026-10-05T12:00:00.000Z', NOW)).not.toThrow()
    expect(() => parsePastShiftPeriod(START, START, NOW)).not.toThrow()
  })
})

describe('findOverlappingShift', () => {
  const shift = { id: 4, clock_in: '2026-10-03T06:00:00.000Z', clock_out: '2026-10-03T14:00:00.000Z' }
  const at = (iso: string): number => Date.parse(iso)

  it('counts touching as overlap, at either end, to the millisecond', () => {
    expect(findOverlappingShift([shift], at('2026-10-03T14:00:00.000Z'), at('2026-10-03T16:00:00.000Z'))).toBe(shift)
    expect(findOverlappingShift([shift], at('2026-10-03T04:00:00.000Z'), at('2026-10-03T06:00:00.000Z'))).toBe(shift)
    expect(findOverlappingShift([shift], at('2026-10-03T14:00:00.001Z'), at('2026-10-03T16:00:00.000Z'))).toBeUndefined()
    expect(findOverlappingShift([shift], at('2026-10-03T04:00:00.000Z'), at('2026-10-03T05:59:59.999Z'))).toBeUndefined()
  })

  it('refuses a period inside, around or straddling a shift', () => {
    expect(findOverlappingShift([shift], at('2026-10-03T08:00:00.000Z'), at('2026-10-03T09:00:00.000Z'))).toBe(shift)
    expect(findOverlappingShift([shift], at('2026-10-03T01:00:00.000Z'), at('2026-10-03T20:00:00.000Z'))).toBe(shift)
    expect(findOverlappingShift([shift], at('2026-10-03T13:00:00.000Z'), at('2026-10-03T20:00:00.000Z'))).toBe(shift)
  })

  it('treats an open shift as running on for ever: a period wholly before it is allowed, one after is not', () => {
    const open = { id: 5, clock_in: '2026-10-05T06:00:00.000Z', clock_out: null }
    expect(findOverlappingShift([open], at('2026-10-03T07:00:00.000Z'), at('2026-10-03T15:00:00.000Z'))).toBeUndefined()
    expect(findOverlappingShift([open], at('2026-10-05T06:00:00.000Z'), at('2026-10-05T07:00:00.000Z'))).toBe(open)
    expect(findOverlappingShift([open], at('2026-10-04T00:00:00.000Z'), at('2026-10-05T11:00:00.000Z'))).toBe(open)
  })

  it('refuses rather than guesses when a shift time cannot be read', () => {
    const broken = { id: 6, clock_in: '2026-10-03T06:00:00.000Z', clock_out: 'garbage' }
    expect(findOverlappingShift([broken], at('2030-01-01T00:00:00.000Z'), at('2030-01-02T00:00:00.000Z'))).toBe(broken)
  })
})

describe('createRetrospectiveShift', () => {
  it('inserts the closed shift with its cash figures, who, when and why, then attaches each sale', () => {
    const { fake, db } = dbWith()

    const result = db.createRetrospectiveShift(input(), NOW)

    // expected cash = 1000 float + the one cash sale (500); M-Pesa and card are not cash.
    expect(result).toEqual({
      shiftId: 9,
      attachedCount: 3,
      expectedCash: 1500,
      discrepancy: -20,
      mpesaExpected: null,
      mpesaDifference: null
    })
    const [insert] = fake.callsFor('run', 'INSERT INTO shifts')
    expect(insert.sql).toContain("'closed'")
    expect(insert.sql).toContain("'retrospective'")
    expect(insert.params).toEqual([
      2, START, END, 1000, 1500, 1480, -20, 'day', null, null, null, null, 2, new Date(NOW).toISOString(),
      'Till used without opening a shift'
    ])
  })

  it('attaches with one guarded UPDATE per sale, and writes nothing else to orders', () => {
    const { fake, db } = dbWith()

    db.createRetrospectiveShift(input(), NOW)

    const updates = fake.callsFor('run', 'UPDATE orders')
    expect(updates).toHaveLength(3)
    for (const update of updates) {
      expect(update.sql).toBe(
        "UPDATE orders SET shift_id = ? WHERE local_id = ? AND shift_id IS NULL AND status <> 'voided' AND created_at >= ? AND created_at <= ?"
      )
    }
    expect(updates.map((u) => u.params)).toEqual([
      [9, 11, START, END],
      [9, 12, START, END],
      [9, 13, START, END]
    ])
    expect(fake.callsFor('run', 'sync_queue')).toHaveLength(0)
  })

  it('works out the M-Pesa figures only when both balances are given', () => {
    const { db } = dbWith()
    const both = db.createRetrospectiveShift(input({ mpesaOpeningBalance: 1000, mpesaClosingBalance: 1280 }), NOW)

    // 1000 + 300 (the one M-Pesa sale); counted 1280, so 20 below expected.
    expect(both.mpesaExpected).toBe(1300)
    expect(both.mpesaDifference).toBe(-20)

    const { db: other } = dbWith()
    const one = other.createRetrospectiveShift(input({ mpesaClosingBalance: 1280 }), NOW)
    expect(one.mpesaExpected).toBeNull()
    expect(one.mpesaDifference).toBeNull()
  })

  it('refuses an overlap, touching included, before writing anything', () => {
    const { fake, db } = dbWith([{ id: 3, clock_in: '2026-10-03T14:59:59.999Z', clock_out: '2026-10-03T20:00:00.000Z' }])

    expect(() => db.createRetrospectiveShift(input(), NOW)).toThrow('This period overlaps shift #3')
    expect(fake.callsFor('run', 'INSERT INTO shifts')).toHaveLength(0)
    expect(fake.callsFor('run', 'UPDATE orders')).toHaveLength(0)
  })

  it('allows a period wholly before the open shift', () => {
    const { db } = dbWith([{ id: 5, clock_in: '2026-10-05T06:00:00.000Z', clock_out: null }])

    expect(db.createRetrospectiveShift(input(), NOW).shiftId).toBe(9)
  })

  it('refuses a period that ends in the future, with no reason, or with an empty or repeated sale list', () => {
    const { fake, db } = dbWith()

    expect(() => db.createRetrospectiveShift(input({ endIso: '2026-10-06T00:00:00.000Z' }), NOW)).toThrow(/future/)
    expect(() => db.createRetrospectiveShift(input({ reason: '   ' }), NOW)).toThrow(/reason is required/)
    expect(() => db.createRetrospectiveShift(input({ orderIds: [] }), NOW)).toThrow(/Choose the sales/)
    expect(() => db.createRetrospectiveShift(input({ orderIds: [11, 11, 12] }), NOW)).toThrow(/Choose the sales/)
    expect(() => db.createRetrospectiveShift(input({ shiftType: 'dusk' }), NOW)).toThrow(/Unknown shift type/)
    expect(fake.callsFor('run', 'INSERT INTO shifts')).toHaveLength(0)
  })

  it('refuses a stale list: a sale with no shift has appeared in the period since it was shown', () => {
    const { fake, db } = dbWith()

    expect(() => db.createRetrospectiveShift(input({ orderIds: [11, 12] }), NOW)).toThrow(
      /A sale has appeared in this period since the list was shown \(order #13\)/
    )
    expect(fake.callsFor('run', 'INSERT INTO shifts')).toHaveLength(0)
  })

  it('names why a sale could not join, and stops', () => {
    const cases: Array<[Record<string, unknown> | undefined, RegExp]> = [
      [{ status: 'synced', created_at: START, shift_id: 4 }, /Order #12 now belongs to shift #4/],
      [{ status: 'voided', created_at: START, shift_id: null }, /Order #12 was voided/],
      [{ status: 'synced', created_at: '2026-10-01T00:00:00.000Z', shift_id: null }, /Order #12 is outside the period/],
      [undefined, /Order #12 does not exist/]
    ]
    for (const [row, message] of cases) {
      const { fake, db } = dbWith()
      fake.queueRunResult('UPDATE orders', { changes: 1 })
      fake.queueRunResult('UPDATE orders', { changes: 0 })
      fake.queueGetResult('SELECT status, created_at, shift_id FROM orders', row)

      expect(() => db.createRetrospectiveShift(input(), NOW)).toThrow(message)
      // The first sale was attached and the second failed: the third is never tried, so the throw is what undoes it.
      expect(fake.callsFor('run', 'UPDATE orders')).toHaveLength(2)
    }
  })

  it('is one write transaction, taken up front', () => {
    const { fake, db } = dbWith()
    db.createRetrospectiveShift(input(), NOW)

    expect(fake.connection.transaction).toHaveBeenCalled()
  })
})

describe('listUnattachedDays', () => {
  it('groups by Nairobi day, not UTC day: 00:37 Nairobi is the previous UTC day', () => {
    const days = listUnattachedDays({
      listUnattachedSales: () => [
        sale(1, '2026-10-02T21:37:08.330Z', 1, 'cash'),
        sale(2, '2026-10-03T00:48:03.119Z', 90, 'cash'),
        sale(3, '2026-10-03T21:00:00.000Z', 40, 'mpesa')
      ]
    })

    expect(days).toEqual([
      {
        localDay: '2026-10-03',
        count: 2,
        total: 91,
        firstAt: '2026-10-02T21:37:08.330Z',
        lastAt: '2026-10-03T00:48:03.119Z'
      },
      { localDay: '2026-10-04', count: 1, total: 40, firstAt: '2026-10-03T21:00:00.000Z', lastAt: '2026-10-03T21:00:00.000Z' }
    ])
  })

  it('is empty when every sale has a shift', () => {
    expect(listUnattachedDays({ listUnattachedSales: () => [] })).toEqual([])
  })
})

describe('previewPastShift', () => {
  const rows = [sale(11, '2026-10-03T08:00:00.000Z', 500, 'cash'), sale(12, '2026-10-03T09:00:00.000Z', 300, 'mpesa')]
  const db = (shifts: Array<{ id: number; clock_in: string; clock_out: string | null }> = []) => ({
    listUnattachedSalesInPeriod: vi.fn(() => rows),
    listShiftWindows: () => shifts
  })

  it('lists exactly the sales, with count, total and the total by method', () => {
    const preview = previewPastShift(db(), START, END, NOW)

    expect(preview.problem).toBeNull()
    expect(preview.count).toBe(2)
    expect(preview.total).toBe(800)
    expect(preview.totalsByMethod).toEqual({ cash: 500, mpesa: 300, card: 0 })
    expect(preview.sales.map((s) => s.id)).toEqual([11, 12])
  })

  it('suggests day or night from the period start, as an ordinary shift would', () => {
    expect(previewPastShift(db(), '2026-10-03T07:00:00.000Z', END, NOW).suggestedShiftType).toBe('day') // 10:00 Nairobi
    expect(previewPastShift(db(), '2026-10-03T16:00:00.000Z', '2026-10-03T20:00:00.000Z', NOW).suggestedShiftType).toBe('night') // 19:00
  })

  it('reports the problem instead of throwing: an overlap, a future end, bad times, no sales', () => {
    expect(previewPastShift(db([{ id: 4, clock_in: START, clock_out: END }]), START, END, NOW).problem).toBe(
      'This period overlaps shift #4'
    )
    expect(previewPastShift(db(), START, '2030-01-01T00:00:00.000Z', NOW).problem).toMatch(/future/)
    expect(previewPastShift(db(), 'x', END, NOW).problem).toMatch(/not a valid time/)
    const none = { listUnattachedSalesInPeriod: () => [], listShiftWindows: () => [] }
    expect(previewPastShift(none, START, END, NOW).problem).toMatch(/no sales without a shift/)
  })
})

describe('request schemas', () => {
  const valid = {
    managerId: 2,
    managerPin: '1234',
    startIso: START,
    endIso: END,
    orderIds: [11, 12],
    startingCash: 1000,
    endingCash: 1480,
    shiftType: 'day',
    reason: 'Till used without opening a shift'
  }

  it('accepts a complete request, with or without the optional M-Pesa balances', () => {
    expect(createPastShiftSchema.safeParse(valid).success).toBe(true)
    expect(createPastShiftSchema.safeParse({ ...valid, mpesaOpeningBalance: 0, mpesaClosingBalance: null }).success).toBe(true)
  })

  it('requires the manager, the sales, both cash figures, the shift type and a reason', () => {
    for (const missing of ['managerId', 'managerPin', 'orderIds', 'startingCash', 'endingCash', 'shiftType', 'reason']) {
      const { [missing]: _removed, ...rest } = valid as Record<string, unknown>
      expect(createPastShiftSchema.safeParse(rest).success).toBe(false)
    }
    expect(createPastShiftSchema.safeParse({ ...valid, orderIds: [] }).success).toBe(false)
    expect(createPastShiftSchema.safeParse({ ...valid, reason: '   ' }).success).toBe(false)
    expect(createPastShiftSchema.safeParse({ ...valid, endingCash: -1 }).success).toBe(false)
    expect(createPastShiftSchema.safeParse({ ...valid, mpesaClosingBalance: Number.NaN }).success).toBe(false)
  })

  it('validates the preview request', () => {
    expect(pastShiftPreviewSchema.safeParse({ startIso: START, endIso: END }).success).toBe(true)
    expect(pastShiftPreviewSchema.safeParse({ startIso: START }).success).toBe(false)
  })
})

describe('the Z report of a shift recorded afterwards', () => {
  const staff = (name: string) => ({ id: 2, name, role: 'admin', is_active: 1 }) as unknown as StaffRow
  const row: ShiftRow = {
    id: 9,
    staff_id: 2,
    clock_in: START,
    clock_out: END,
    starting_cash: 1000,
    expected_cash: 1500,
    ending_cash: 1480,
    discrepancy: -20,
    status: 'closed',
    shift_type: 'day',
    kind: 'retrospective',
    created_by_staff_id: 2,
    created_at: '2026-10-05T12:00:00.000Z',
    reason: 'Till used without opening a shift'
  }
  const reportFor = (shift: ShiftRow): ZReport =>
    generateZReport(
      {
        getShiftById: () => shift,
        getStaffById: () => staff('Manager Mo'),
        getOrdersForShift: () => [],
        getMpesaPaymentsForShift: () => []
      } as unknown as RubisDatabase,
      9,
      0.16
    )

  it('carries who recorded it, when and why', () => {
    expect(reportFor(row)).toMatchObject({
      kind: 'retrospective',
      createdAt: '2026-10-05T12:00:00.000Z',
      createdByName: 'Manager Mo',
      reason: 'Till used without opening a shift'
    })
  })

  it('is a normal shift, with nothing recorded, for one from before', () => {
    const { kind: _k, created_by_staff_id: _c, created_at: _a, reason: _r, ...old } = row
    expect(reportFor(old as ShiftRow)).toMatchObject({ kind: 'normal', createdAt: null, createdByName: null, reason: null })
  })

  it('has the retrospective lines, none for a normal shift, the same in the renderer twin', () => {
    const format = (iso: string): string => `at ${iso}`
    const retro = reportFor(row)
    const normal = reportFor({ ...row, kind: 'normal' })

    expect(zReportRetroLines(retro, format)).toEqual([
      'RETROSPECTIVE SHIFT, created at 2026-10-05T12:00:00.000Z by Manager Mo',
      'Reason: Till used without opening a shift'
    ])
    expect(zReportRetroLines(normal, format)).toEqual([])
    for (const report of [retro, normal]) {
      expect(rendererRetroLines(report, format)).toEqual(zReportRetroLines(report, format))
    }
  })

  it('prints those lines in place of a cashier, and prints the cashier for a normal shift', () => {
    const settings: PrinterSettings = { interfaceName: 'tcp://x', storeName: 'ENJOY', taxRate: 0.16 }
    const printed = (report: ZReport): string[] => {
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
      renderZReport(client, report, settings)
      return lines
    }

    const retro = printed(reportFor(row))
    expect(retro.some((l) => l.startsWith('RETROSPECTIVE SHIFT, created'))).toBe(true)
    expect(retro).toContain('Reason: Till used without opening a shift')
    expect(retro.some((l) => l.startsWith('Cashier:'))).toBe(false)

    const normal = printed(reportFor({ ...row, kind: 'normal' }))
    expect(normal.some((l) => l.startsWith('Cashier:'))).toBe(true)
    expect(normal.some((l) => l.includes('RETROSPECTIVE'))).toBe(false)
  })
})
