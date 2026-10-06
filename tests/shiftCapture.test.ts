/**
 * Phase 227, the main-process half: every sale lands in a shift. "Cash not counted" (D4); who may open a shift, and
 * the schemas that guard it.
 *
 * CHANGED (docs/phase-232). OLD: this file also tested D1 (one confirmation attaches every sale in a period, through
 * `createRetrospectiveShift`), D2 (one offer per day, cut at existing shifts, `listUnattachedOffers`), the
 * `shifts:create-past` request schema, and the handlers `shifts:create-past` and `shifts:unattached-days`. NEW: the
 * manual past-shift flow is retired, so those are removed; the automatic assignment that replaces it is tested in
 * tests/oneShiftPerWindow.test.ts, including a shift made with its cash not counted (no figures, nothing sent to
 * Shopify or the tax device). The column, the Z report, the correction and the open-shift tests are unchanged except
 * as noted where they are.
 *
 * `better-sqlite3` is mocked with a recording fake, as in `tests/pastShift.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import type { ShiftRow, StaffRow } from '../src/main/services/database.js'
import { shiftCloseSchema, shiftOpenSchema } from '../src/main/lib/ipcValidator.js'
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
        // ADDED (docs/phase-232): a record's time is after the shift's newest record; an aggregate always answers one row.
        if (sql.includes('MAX(at)')) return { latest: null }
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

describe('D4: "Cash not counted"', () => {
  it('adds the column to a table from before, with a default that keeps every existing shift as it was', () => {
    const { fake } = freshDb()

    const alters = fake.connection.exec.mock.calls.map((call) => String(call[0]))
    expect(alters.some((sql) => sql.includes('ALTER TABLE shifts ADD COLUMN cash_not_counted INTEGER NOT NULL DEFAULT 0'))).toBe(true)
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
          listShiftCorrections: () => [],
          getShiftMerge: () => undefined, // ADDED (docs/phase-239): the Z report reads whether the shift was merged
          listShiftAdjustments: () => [], // ADDED (docs/phase-232)
          listAdjustmentSales: () => []
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
    // CHANGED (docs/phase-232). OLD: openShift(1, 250, 'night', null), the type from the request. NEW: openShift(1, 250, null, options):
    // a type in the request is ignored, so none reaches the database; the options carry what the form showed.
    expect(openShift).toHaveBeenCalledWith(1, 250, null, { earlierShown: undefined, startAtZero: undefined })
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
    expect(openShift).toHaveBeenCalledWith(2, 100, 1500, { earlierShown: undefined, startAtZero: undefined })
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

})
