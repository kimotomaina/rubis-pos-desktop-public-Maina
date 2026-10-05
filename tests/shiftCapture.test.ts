/**
 * Phase 227, the main-process half: every sale lands in a shift. One confirmation attaches every sale in a period
 * (D1); one offer per day, cut at existing shifts (D2); "Cash not counted" (D4); who may open a shift, and the
 * schemas that guard it.
 *
 * `better-sqlite3` is mocked with a recording fake, as in `tests/pastShift.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import type { ShiftRow, StaffRow, UnattachedSaleRow } from '../src/main/services/database.js'
import { findOverlappingShift } from '../src/main/lib/pastShift.js'
import { listUnattachedOffers } from '../src/main/services/past-shifts.js'
import { createPastShiftSchema, shiftCloseSchema, shiftOpenSchema } from '../src/main/lib/ipcValidator.js'
import { generateZReport } from '../src/main/services/reports.js'
import type { ZReport } from '../src/main/services/reports.js'
import { renderZReport } from '../src/main/services/printer.js'
import type { PrinterSettings, ThermalPrinterLike } from '../src/main/services/printer.js'
import { hashPin } from '../src/main/services/auth.js'
import { openShiftChecked, OPEN_SHIFT_ADMIN_ONLY_MESSAGE } from '../src/main/services/shift-open.js'
import type { OpenShiftDb } from '../src/main/services/shift-open.js'

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

/** A database whose period holds sales 11 (cash 500), 12 (M-Pesa 300) and 13 (card 150). */
function dbWith() {
  const { fake, db } = freshDb()
  fake.setAllResult('SELECT id, clock_in, clock_out FROM shifts', [])
  fake.setAllResult('shift_id IS NULL', [
    sale(11, '2026-10-03T08:00:00.000Z', 500, 'cash'),
    sale(12, '2026-10-03T09:00:00.000Z', 300, 'mpesa'),
    sale(13, '2026-10-03T10:00:00.000Z', 150, 'card')
  ])
  fake.queueRunResult('INSERT INTO shifts', { lastInsertRowid: 9 })
  return { fake, db }
}

describe('D1: one confirmation attaches every sale with no shift in the period', () => {
  it('is one call, one shift row, and one guarded UPDATE for each of the period\'s sales', () => {
    const { fake, db } = dbWith()

    const result = db.createRetrospectiveShift(input(), NOW)

    expect(result.attachedCount).toBe(3)
    expect(fake.callsFor('run', 'INSERT INTO shifts')).toHaveLength(1)
    expect(fake.callsFor('run', 'UPDATE orders').map((u) => u.params[1])).toEqual([11, 12, 13])
  })

  it('refuses, writing nothing, when the confirmation leaves out a sale that is in the period', () => {
    const { fake, db } = dbWith()

    expect(() => db.createRetrospectiveShift(input({ orderIds: [11, 12] }), NOW)).toThrow(/appeared in this period/)
    expect(fake.callsFor('run', 'INSERT INTO shifts')).toHaveLength(0)
    expect(fake.callsFor('run', 'UPDATE orders')).toHaveLength(0)
  })
})

describe('D2: one offer per Nairobi day, cut at existing shifts', () => {
  const offersFor = (sales: UnattachedSaleRow[], shifts: Array<{ id: number; clock_in: string; clock_out: string | null }>) =>
    listUnattachedOffers({ listUnattachedSales: () => sales, listShiftWindows: () => shifts })

  it('gives one offer for each day that has sales with no shift', () => {
    const offers = offersFor(
      [
        sale(1, '2026-10-03T08:00:00.000Z', 100, 'cash'),
        sale(2, '2026-10-03T09:00:00.000Z', 50, 'mpesa'),
        sale(3, '2026-10-04T08:00:00.000Z', 70, 'card')
      ],
      []
    )

    expect(offers.map((o) => [o.localDay, o.count, o.total])).toEqual([
      ['2026-10-03', 2, 150],
      ['2026-10-04', 1, 70]
    ])
    expect(offers[0].firstAt).toBe('2026-10-03T08:00:00.000Z')
    expect(offers[0].lastAt).toBe('2026-10-03T09:00:00.000Z')
  })

  it("stops at an existing shift: today's sales split around shift #1, and each offer's period misses it", () => {
    // Shift #1 ran 17:43:21 to 17:43:36 Nairobi time, which is 14:43:21 to 14:43:36 UTC.
    const shifts = [{ id: 1, clock_in: '2026-10-05T14:43:21.000Z', clock_out: '2026-10-05T14:43:36.000Z' }]
    const offers = offersFor(
      [
        sale(1, '2026-10-05T05:00:00.000Z', 100, 'cash'),
        sale(2, '2026-10-05T11:00:00.000Z', 200, 'mpesa'),
        sale(3, '2026-10-05T15:00:00.000Z', 300, 'cash'),
        sale(4, '2026-10-05T16:00:00.000Z', 400, 'card')
      ],
      shifts
    )

    // docs/phase-229: old, two offers cut only at the shift (08:00 and 14:00 together, 18:00 and 19:00 together).
    // New, three: 08:00 is the night that began on the 4th, 14:00 is Day, 18:00 and 19:00 are Night. The shift
    // still separates the two sides, and no offer touches it.
    expect(offers.map((o) => [o.firstAt, o.lastAt, o.count, o.total])).toEqual([
      ['2026-10-05T05:00:00.000Z', '2026-10-05T05:00:00.000Z', 1, 100],
      ['2026-10-05T11:00:00.000Z', '2026-10-05T11:00:00.000Z', 1, 200],
      ['2026-10-05T15:00:00.000Z', '2026-10-05T16:00:00.000Z', 2, 700]
    ])
    for (const offer of offers) {
      expect(findOverlappingShift(shifts, Date.parse(offer.firstAt), Date.parse(offer.lastAt))).toBeUndefined()
    }
  })

  it('never puts a sale in an offer twice, or leaves one out', () => {
    const sales = [
      sale(1, '2026-10-05T05:00:00.000Z', 1, 'cash'),
      sale(2, '2026-10-05T11:00:00.000Z', 2, 'cash'),
      sale(3, '2026-10-05T15:00:00.000Z', 4, 'cash'),
      sale(4, '2026-10-06T01:00:00.000Z', 8, 'cash')
    ]
    const offers = offersFor(sales, [{ id: 1, clock_in: '2026-10-05T14:43:21.000Z', clock_out: '2026-10-05T14:43:36.000Z' }])

    expect(offers.reduce((sum, o) => sum + o.count, 0)).toBe(4)
    expect(offers.reduce((sum, o) => sum + o.total, 0)).toBe(15)
  })

  it('is empty when every sale has a shift', () => {
    expect(offersFor([], [])).toEqual([])
  })
})

describe('D4: "Cash not counted"', () => {
  it('adds the column to a table from before, with a default that keeps every existing shift as it was', () => {
    const { fake } = freshDb()

    const alters = fake.connection.exec.mock.calls.map((call) => String(call[0]))
    expect(alters.some((sql) => sql.includes('ALTER TABLE shifts ADD COLUMN cash_not_counted INTEGER NOT NULL DEFAULT 0'))).toBe(true)
  })

  it('stores no cash figures, only the flag, and returns none', () => {
    const { fake, db } = dbWith()

    const result = db.createRetrospectiveShift(input({ cashNotCounted: true, startingCash: 999, endingCash: 888 }), NOW)

    expect(result).toMatchObject({ shiftId: 9, attachedCount: 3, expectedCash: null, discrepancy: null })
    const [insert] = fake.callsFor('run', 'INSERT INTO shifts')
    expect(insert.sql).toContain('cash_not_counted')
    // starting 0 (meaningless), expected, ending and discrepancy NULL, whatever figures were sent.
    expect(insert.params.slice(3, 7)).toEqual([0, null, null, null])
  })

  it('leaves a counted shift exactly as it was: no flag in its statement', () => {
    const { fake, db } = dbWith()

    db.createRetrospectiveShift(input(), NOW)

    expect(fake.callsFor('run', 'INSERT INTO shifts')[0].sql).not.toContain('cash_not_counted')
  })

  it('still sends nothing to Shopify or the tax device', () => {
    const { fake, db } = dbWith()

    db.createRetrospectiveShift(input({ cashNotCounted: true }), NOW)

    expect(fake.callsFor('run', 'sync_queue')).toHaveLength(0)
  })

  describe('the request', () => {
    const base = {
      managerId: 2,
      managerPin: '1234',
      startIso: START,
      endIso: END,
      orderIds: [11],
      shiftType: 'day',
      reason: 'Nobody counted'
    }

    it('accepts "not counted" with no cash figures, and counted figures with no flag', () => {
      expect(createPastShiftSchema.safeParse({ ...base, cashNotCounted: true }).success).toBe(true)
      expect(createPastShiftSchema.safeParse({ ...base, startingCash: 0, endingCash: 0 }).success).toBe(true)
    })

    it('refuses neither the figures nor the flag, and one figure alone', () => {
      expect(createPastShiftSchema.safeParse(base).success).toBe(false)
      expect(createPastShiftSchema.safeParse({ ...base, startingCash: 5 }).success).toBe(false)
      expect(createPastShiftSchema.safeParse({ ...base, cashNotCounted: false }).success).toBe(false)
    })
  })

  it('is never offered to a normal Close Shift: the close request needs a counted figure whatever else it says', () => {
    expect(shiftCloseSchema.safeParse({ shiftId: 1 }).success).toBe(false)
    expect(shiftCloseSchema.safeParse({ shiftId: 1, cashNotCounted: true }).success).toBe(false)
    expect(shiftCloseSchema.safeParse({ shiftId: 1, endingCash: null }).success).toBe(false)
    expect(shiftCloseSchema.safeParse({ shiftId: 1, endingCash: 0 }).success).toBe(true)
  })

  describe('the Z report', () => {
    const staff = { id: 2, name: 'Manager Mo', role: 'admin', is_active: 1 } as unknown as StaffRow
    const notCounted: ShiftRow = {
      id: 9,
      staff_id: 2,
      clock_in: START,
      clock_out: END,
      starting_cash: 0,
      expected_cash: null,
      ending_cash: null,
      discrepancy: null,
      status: 'closed',
      shift_type: 'day',
      kind: 'retrospective',
      created_by_staff_id: 2,
      created_at: '2026-10-05T12:00:00.000Z',
      reason: 'Nobody counted',
      cash_not_counted: 1
    }
    const orders = [
      { local_id: 11, total: 500, status: 'synced', payment_method: 'cash', fiscal_request_json: null },
      { local_id: 12, total: 300, status: 'synced', payment_method: 'mpesa', fiscal_request_json: null }
    ]
    const reportFor = (shift: ShiftRow): ZReport =>
      generateZReport(
        {
          getShiftById: () => shift,
          getStaffById: () => staff,
          getOrdersForShift: () => orders,
          getMpesaPaymentsForShift: () => [],
          listShiftCorrections: () => []
        } as unknown as RubisDatabase,
        9,
        0.16
      )
    const settings: PrinterSettings = { interfaceName: 'tcp://x', storeName: 'RUBIS', taxRate: 0.16 }
    const printed = (report: ZReport): string[] => {
      const lines: string[] = []
      const noop = (): void => {}
      renderZReport(
        {
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
        } as unknown as ThermalPrinterLike,
        report,
        settings
      )
      return lines
    }

    it('says so, with the cash sales and no difference, and never "Pending"', () => {
      const report = reportFor(notCounted)
      expect(report.cashNotCounted).toBe(true)
      expect(report.totalsByMethod.cash).toBe(500)

      const lines = printed(report)
      expect(lines).toContain('Cash not counted')
      expect(lines.some((l) => l.startsWith('Cash Sales:') && l.includes('500.00'))).toBe(true)
      expect(lines.some((l) => l.startsWith('Starting Cash:'))).toBe(false)
      expect(lines.some((l) => l.startsWith('Expected Cash:'))).toBe(false)
      expect(lines.some((l) => l.startsWith('Counted Cash:'))).toBe(false)
      expect(lines.some((l) => l.startsWith('Discrepancy:'))).toBe(false)
      expect(lines.some((l) => l.includes('Pending'))).toBe(false)
    })

    it('reads "Opened by", on paper, for the person who opened the shift', () => {
      const lines = printed(reportFor({ ...notCounted, kind: 'normal', cash_not_counted: 0, starting_cash: 100, expected_cash: 600, ending_cash: 600, discrepancy: 0 }))

      expect(lines).toContain('Opened by: Manager Mo')
      expect(lines.some((l) => l.startsWith('Cashier:'))).toBe(false)
      expect(lines.some((l) => l.startsWith('Starting Cash:'))).toBe(true)
      expect(lines).not.toContain('Cash not counted')
    })

    it('leaves a shift from before exactly as it was: no flag on its report at all', () => {
      const { cash_not_counted: _omit, ...fromBefore } = { ...notCounted, kind: 'normal' as const, cash_not_counted: 0 as const, starting_cash: 100, expected_cash: 600, ending_cash: 600, discrepancy: 0 }
      void _omit
      expect('cashNotCounted' in reportFor(fromBefore as ShiftRow)).toBe(false)
    })
  })

  describe('a correction', () => {
    const flagged: ShiftRow = {
      id: 1,
      staff_id: 2,
      clock_in: START,
      clock_out: END,
      starting_cash: 0,
      expected_cash: null,
      ending_cash: null,
      discrepancy: null,
      status: 'closed',
      shift_type: 'day',
      kind: 'retrospective',
      cash_not_counted: 1
    }
    const correction = {
      shiftId: 1,
      managerId: 2,
      reason: 'Found the count sheet',
      startingCash: 0,
      endingCash: 0,
      mpesaOpeningBalance: null,
      mpesaClosingBalance: null
    }

    it('may add figures to a shift whose cash was not counted, even figures that read 0 and 0', () => {
      const { fake, db } = freshDb()
      fake.queueGetResult('FROM shifts WHERE id', flagged)
      fake.setAllResult('FROM shift_corrections WHERE shift_id', [])
      fake.setAllResult('FROM orders WHERE shift_id', [])
      fake.queueRunResult('INSERT INTO shift_corrections', { lastInsertRowid: 3 })

      expect(() => db.addShiftCorrection(correction, NOW)).not.toThrow()
      expect(fake.callsFor('run', 'INSERT INTO shift_corrections')).toHaveLength(1)
    })

    it('still refuses "nothing changed" on a shift whose cash was counted', () => {
      const { fake, db } = freshDb()
      fake.queueGetResult('FROM shifts WHERE id', { ...flagged, cash_not_counted: 0, starting_cash: 0, ending_cash: 0, expected_cash: 0, discrepancy: 0 })
      fake.setAllResult('FROM shift_corrections WHERE shift_id', [])
      fake.setAllResult('FROM orders WHERE shift_id', [])

      expect(() => db.addShiftCorrection(correction, NOW)).toThrow('Nothing has changed from the current figures')
    })
  })
})

describe('shifts:open: only an admin opens a shift', () => {
  const adminStaff = (id: number, pin: string, overrides: Partial<StaffRow> = {}): StaffRow =>
    ({ id, name: `Staff ${id}`, pin_hash: hashPin(pin), role: 'admin', is_active: 1, ...overrides }) as StaffRow

  const dbFor = (staff: StaffRow[]) => {
    const openShift = vi.fn().mockReturnValue({ shiftId: 5 })
    const db = {
      getStaffById: (id: number) => staff.find((row) => row.id === id),
      openShift
    } as unknown as OpenShiftDb
    return { db, openShift }
  }

  it("opens for an active admin's own id, with no PIN, exactly as the Admin screen does", () => {
    const { db, openShift } = dbFor([adminStaff(1, '1111')])

    const result = openShiftChecked(db, { staffId: 1, startingCash: 250, shiftType: 'night' })

    expect(result).toEqual({ success: true, data: { shiftId: 5 } })
    expect(openShift).toHaveBeenCalledWith(1, 250, 'night', null)
  })

  it('refuses a cashier with no PIN, through the handler logic and not only on screen', () => {
    const { db, openShift } = dbFor([adminStaff(3, '3333', { role: 'cashier' })])

    const result = openShiftChecked(db, { staffId: 3, startingCash: 250 })

    expect(result).toEqual({ success: false, error: OPEN_SHIFT_ADMIN_ONLY_MESSAGE })
    expect(openShift).not.toHaveBeenCalled()
  })

  it('refuses an unknown or inactive account', () => {
    const { db, openShift } = dbFor([adminStaff(1, '1111', { is_active: 0 })])

    expect(openShiftChecked(db, { staffId: 1, startingCash: 1 }).success).toBe(false)
    expect(openShiftChecked(db, { staffId: 99, startingCash: 1 }).success).toBe(false)
    expect(openShift).not.toHaveBeenCalled()
  })

  it("opens a cashier's shift under the manager whose PIN was given, and records the manager", () => {
    const { db, openShift } = dbFor([adminStaff(3, '3333', { role: 'cashier' }), adminStaff(2, '2222')])

    const result = openShiftChecked(db, {
      staffId: 2,
      startingCash: 100,
      shiftType: 'night',
      mpesaOpeningBalance: 1500,
      managerId: 2,
      managerPin: '2222'
    })

    expect(result.success).toBe(true)
    expect(openShift).toHaveBeenCalledWith(2, 100, 'night', 1500)
  })

  it('refuses a wrong PIN, and a PIN that belongs to a cashier', () => {
    const { db, openShift } = dbFor([adminStaff(3, '3333', { role: 'cashier' }), adminStaff(2, '2222')])

    expect(openShiftChecked(db, { staffId: 2, startingCash: 1, managerId: 2, managerPin: '0000' }).success).toBe(false)
    expect(openShiftChecked(db, { staffId: 3, startingCash: 1, managerId: 3, managerPin: '3333' }).success).toBe(false)
    expect(openShift).not.toHaveBeenCalled()
  })

  it('passes a refusal from the database on, such as a shift already open', () => {
    const { db, openShift } = dbFor([adminStaff(1, '1111')])
    openShift.mockImplementation(() => {
      throw new Error('A shift is already open')
    })

    expect(openShiftChecked(db, { staffId: 1, startingCash: 1 })).toEqual({ success: false, error: 'A shift is already open' })
  })

  describe('the request', () => {
    it('refuses a negative starting cash and a negative M-Pesa opening', () => {
      expect(shiftOpenSchema.safeParse({ staffId: 1, startingCash: -1 }).success).toBe(false)
      expect(shiftOpenSchema.safeParse({ staffId: 1, startingCash: 0, mpesaOpeningBalance: -1 }).success).toBe(false)
      expect(shiftOpenSchema.safeParse({ staffId: 1, startingCash: 0, mpesaOpeningBalance: 0 }).success).toBe(true)
    })

    it('takes a manager id and PIN together or not at all', () => {
      expect(shiftOpenSchema.safeParse({ staffId: 1, startingCash: 0, managerId: 2 }).success).toBe(false)
      expect(shiftOpenSchema.safeParse({ staffId: 1, startingCash: 0, managerPin: '2222' }).success).toBe(false)
      expect(shiftOpenSchema.safeParse({ staffId: 1, startingCash: 0, managerId: 2, managerPin: '2222' }).success).toBe(true)
    })
  })
})

describe('the handlers in main/index.ts', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
  const handlerBody = (channel: string): string => {
    const start = source.indexOf(`'${channel}',`)
    return source.slice(start, source.indexOf('ipcMain.handle(', start))
  }

  it('shifts:open goes through the admin check, not straight to the database', () => {
    const body = handlerBody('shifts:open')

    expect(body).toContain('validate(shiftOpenSchema')
    expect(body).toContain('openShiftChecked(db, validation.data)')
    expect(body).not.toContain('db.openShift(')
  })

  it('shifts:create-past re-verifies the manager PIN before it writes anything (D1: nothing attached without it)', () => {
    const body = handlerBody('shifts:create-past')

    expect(body.indexOf('requireAdminPin(db, validation.data.managerId, validation.data.managerPin)')).toBeGreaterThan(-1)
    expect(body.indexOf('requireAdminPin(')).toBeLessThan(body.indexOf('db.createRetrospectiveShift('))
  })

  it('shifts:unattached-days lists the offers, cut at shifts, not whole days', () => {
    expect(handlerBody('shifts:unattached-days')).toContain('listUnattachedOffers(db)')
  })
})
