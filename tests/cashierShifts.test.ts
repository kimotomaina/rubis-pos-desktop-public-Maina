/**
 * Phase 254: a cashier opens and closes the till's shift with no PIN, the shift records who opened and who closed it,
 * the figures are worked out exactly as before, and the Z names both. A cashier sees and prints the Z of a closed shift
 * they opened or closed, and no other; an open shift's Z is locked until it is closed. "My shifts and sales" and the Order History hold the cashier's
 * own, by the session's id, whatever id the screen sends.
 *
 * Real in-memory SQLite throughout.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase, type ShiftRow, type StaffSummary } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { openShiftChecked } from '../src/main/services/shift-open.js'
import { closeShiftUnlessHeld } from '../src/main/services/held-sales.js'
import { generateZReport } from '../src/main/services/reports.js'
import { printZReport, type ThermalPrinterLike } from '../src/main/services/printer.js'
import { mySales, myShifts, orderHistoryFor } from '../src/main/services/my-shifts.js'
import { MANAGER_NEEDED_MESSAGE, Z_REPORT_LOCKED_MESSAGE, mayReadShift, zReportRefusal } from '../src/main/lib/roleGate.js'

const LATER = Date.now() + 3 * 24 * 60 * 60 * 1000

function freshDb(): { db: RubisDatabase; admin: StaffSummary; amina: StaffSummary; brian: StaffSummary } {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const make = (name: string, role: 'admin' | 'cashier'): StaffSummary => ({
    id: db.createStaff({ name, pinHash: hashPin('1111'), role }).staffId,
    name,
    role
  })
  return { db, admin: make('Admin', 'admin'), amina: make('Amina', 'cashier'), brian: make('Brian', 'cashier') }
}
const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn
const shift = (db: RubisDatabase, id: number): ShiftRow => db.getShiftById(id) as ShiftRow

/** One sale on a shift, recorded under a staff member. */
function sale(db: RubisDatabase, v: { shiftId?: number | null; staffId: number; total: number; method?: string; at?: string }): number {
  const info = conn(db)
    .prepare('INSERT INTO orders (total, status, created_at, payload_json, staff_id, payment_method, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(v.total, 'synced', v.at ?? new Date().toISOString(), '{}', v.staffId, v.method ?? 'cash', v.shiftId ?? null)
  return Number(info.lastInsertRowid)
}

/** A shift as it stands, inserted directly. */
function insertShift(db: RubisDatabase, v: { staffId: number; clockIn: string; closedBy?: number | null; open?: boolean }): number {
  const info = conn(db)
    .prepare(
      `INSERT INTO shifts (staff_id, clock_in, clock_out, starting_cash, expected_cash, ending_cash, discrepancy, status, closed_by_staff_id)
       VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?)`
    )
    .run(v.staffId, v.clockIn, v.open ? null : v.clockIn, v.open ? 'open' : 'closed', v.closedBy ?? null)
  return Number(info.lastInsertRowid)
}

describe('C1: a cashier opens the shift', () => {
  it('with starting cash and M-Pesa, no PIN, recorded under the cashier signed in, whatever id the screen sent', () => {
    const { db, admin, amina } = freshDb()

    const opened = openShiftChecked(db, { staffId: admin.id, startingCash: 500, mpesaOpeningBalance: 200 }, amina)

    expect(opened.success).toBe(true)
    const row = shift(db, (opened as { data: { shiftId: number } }).data.shiftId)
    expect(row.staff_id).toBe(amina.id)
    expect(row.starting_cash).toBe(500)
    expect(row.mpesa_opening_balance).toBe(200)
  })

  it('but may not start at 0: that stays an admin choice, and nothing is opened', () => {
    const { db, amina } = freshDb()

    expect(openShiftChecked(db, { staffId: amina.id, startingCash: 0, startAtZero: true }, amina)).toEqual({
      success: false,
      error: MANAGER_NEEDED_MESSAGE
    })
    expect(db.getOpenShift()).toBeUndefined()
  })

  it('under the window rules as before: a second shift in the window is refused', () => {
    const { db, amina, brian } = freshDb()
    expect(openShiftChecked(db, { staffId: amina.id, startingCash: 100 }, amina).success).toBe(true)
    const again = openShiftChecked(db, { staffId: brian.id, startingCash: 100 }, brian)
    expect(again).toEqual({ success: false, error: 'A shift is already open' })
  })
})

describe('C2: a cashier closes the till\'s open shift', () => {
  /** Opens a shift for Amina with sales of every kind, in a database of its own. */
  function withSales() {
    const fresh = freshDb()
    const shiftId = (openShiftChecked(fresh.db, { staffId: fresh.amina.id, startingCash: 500, mpesaOpeningBalance: 200 }, fresh.amina) as {
      data: { shiftId: number }
    }).data.shiftId
    sale(fresh.db, { shiftId, staffId: fresh.amina.id, total: 300, method: 'cash' })
    sale(fresh.db, { shiftId, staffId: fresh.amina.id, total: 150, method: 'mpesa' })
    sale(fresh.db, { shiftId, staffId: fresh.amina.id, total: 80, method: 'card' })
    return { ...fresh, shiftId }
  }

  it('with counted figures; the shift records the opener and the closer; the figures are exactly those of a close before the phase', () => {
    const now = withSales()
    const before = withSales()

    const closed = closeShiftUnlessHeld(now.db, now.shiftId, 790, 340, LATER, 80, now.brian.id)
    const asBefore = closeShiftUnlessHeld(before.db, before.shiftId, 790, 340, LATER, 80)

    expect(closed).toEqual(asBefore)
    expect(closed).toEqual({
      success: true,
      data: { expectedCash: 800, discrepancy: -10, mpesaExpected: 350, mpesaDifference: -10, cardExpected: 80, cardDifference: 0 }
    })
    const figures = ({ expected_cash, ending_cash, discrepancy, mpesa_expected, mpesa_difference, card_expected, card_difference }: ShiftRow) =>
      ({ expected_cash, ending_cash, discrepancy, mpesa_expected, mpesa_difference, card_expected, card_difference })
    expect(figures(shift(now.db, now.shiftId))).toEqual(figures(shift(before.db, before.shiftId)))
    expect(shift(now.db, now.shiftId).staff_id).toBe(now.amina.id)
    expect(shift(now.db, now.shiftId).closed_by_staff_id).toBe(now.brian.id)
    expect(shift(before.db, before.shiftId).closed_by_staff_id).toBeNull()
  })

  it('before the window end is refused as today, and nothing changes', () => {
    const { db, shiftId, amina } = withSales()

    const early = closeShiftUnlessHeld(db, shiftId, 790, null, Date.now(), null, amina.id)

    expect(early.success).toBe(false)
    expect(early.error).toMatch(/clos/i)
    expect(shift(db, shiftId).status).toBe('open')
    expect(shift(db, shiftId).closed_by_staff_id).toBeNull()
  })

  it('a close with nobody known makes exactly the database call it made before the phase', () => {
    const closeShift = vi.fn().mockReturnValue({ expectedCash: 0, discrepancy: 0, mpesaExpected: null, mpesaDifference: null })
    const db = { closeShift, listOpenHeldSales: () => [], getShiftById: () => undefined }
    closeShiftUnlessHeld(db, 3, 100, 640, LATER, 2500)
    closeShiftUnlessHeld(db, 3, 100, 640, LATER, 2500, 7)
    expect(closeShift.mock.calls).toEqual([
      [3, 100, 640, 2500],
      [3, 100, 640, 2500, 7]
    ])
  })
})

describe('A1: the Z names the opener and the closer', () => {
  function closedBy(closer: 'brian' | null) {
    const fresh = freshDb()
    const shiftId = (openShiftChecked(fresh.db, { staffId: fresh.amina.id, startingCash: 100 }, fresh.amina) as { data: { shiftId: number } })
      .data.shiftId
    closeShiftUnlessHeld(fresh.db, shiftId, 100, null, LATER, null, closer ? fresh.brian.id : null)
    return generateZReport(fresh.db, shiftId, 0.16)
  }

  /** What the receipt printer is sent for a Z report. */
  async function printed(report: ReturnType<typeof generateZReport>): Promise<string[]> {
    const lines: string[] = []
    const client = {
      isPrinterConnected: vi.fn(async () => true),
      alignCenter: vi.fn(),
      alignLeft: vi.fn(),
      alignRight: vi.fn(),
      bold: vi.fn(),
      setTextNormal: vi.fn(),
      setTextQuadArea: vi.fn(),
      println: vi.fn((line: string) => lines.push(line)),
      drawLine: vi.fn(),
      cut: vi.fn(),
      execute: vi.fn(async () => undefined)
    } as unknown as ThermalPrinterLike
    const result = await printZReport(report, { interfaceName: 'tcp://192.168.0.100:9100', storeName: 'RUBIS', taxRate: 0.16 }, () => client)
    expect(result.success).toBe(true)
    return lines
  }

  it('on screen and on paper, when a closer was recorded', async () => {
    const report = closedBy('brian')
    expect(report.staffName).toBe('Amina')
    expect(report.closedByName).toBe('Brian')
    const lines = await printed(report)
    expect(lines.indexOf('Closed by: Brian')).toBe(lines.indexOf('Opened by: Amina') + 1)
  })

  it('and a shift closed with nobody recorded reads and prints exactly as before', async () => {
    const report = closedBy(null)
    expect('closedByName' in report).toBe(false)
    expect((await printed(report)).some((line) => line.startsWith('Closed by'))).toBe(false)
  })
})

describe('C3: which Z a cashier may see and print', () => {
  function shifts() {
    const fresh = freshDb()
    const { db, amina, brian } = fresh
    return {
      ...fresh,
      openedByBrian: shift(db, insertShift(db, { staffId: brian.id, clockIn: '2026-10-07T04:00:00.000Z', open: true })),
      aminasOwn: shift(db, insertShift(db, { staffId: amina.id, clockIn: '2026-10-05T04:00:00.000Z', closedBy: amina.id })),
      closedByAmina: shift(db, insertShift(db, { staffId: brian.id, clockIn: '2026-10-06T04:00:00.000Z', closedBy: amina.id })),
      brians: shift(db, insertShift(db, { staffId: brian.id, clockIn: '2026-10-04T04:00:00.000Z', closedBy: brian.id }))
    }
  }

  it('a closed shift they opened, or one they closed, to view and to print; not another cashier\'s', () => {
    const { amina, aminasOwn, closedByAmina, brians } = shifts()
    for (const action of ['view', 'print'] as const) {
      expect(zReportRefusal(aminasOwn, amina, action)).toBeNull()
      expect(zReportRefusal(closedByAmina, amina, action)).toBeNull()
      expect(zReportRefusal(brians, amina, action)).toBe(MANAGER_NEEDED_MESSAGE)
    }
    expect(mayReadShift(brians, amina)).toBe(false)
  })

  it('an admin any closed shift; nobody signed in, none', () => {
    const { admin, brians } = shifts()
    expect(zReportRefusal(brians, admin, 'print')).toBeNull()
    expect(zReportRefusal(brians, null, 'view')).toBe(MANAGER_NEEDED_MESSAGE)
  })

  it('locks the Z of an open shift: nobody prints it, a cashier does not see it, an admin sees its running figures', () => {
    const { admin, amina, brian, openedByBrian } = shifts()
    expect(Z_REPORT_LOCKED_MESSAGE).toBe('This shift is still open. Close the shift first: its Z report is locked until then.')
    for (const staff of [admin, amina, brian]) expect(zReportRefusal(openedByBrian, staff, 'print')).toBe(Z_REPORT_LOCKED_MESSAGE)
    expect(zReportRefusal(openedByBrian, brian, 'view')).toBe(Z_REPORT_LOCKED_MESSAGE)
    expect(zReportRefusal(openedByBrian, amina, 'view')).toBe(Z_REPORT_LOCKED_MESSAGE)
    expect(zReportRefusal(openedByBrian, admin, 'view')).toBeNull()
  })

  it('is checked before the Z is built, for the view and for the print', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
    const view = source.slice(source.indexOf("'reports:z-report',"), source.indexOf("'reports:window-report',"))
    expect(view).toMatch(/const viewRefused = requested \? zReportRefusal\(requested, staffSession\.current\(\), 'view'\) : null\s*if \(viewRefused\) \{\s*return \{ success: false, error: viewRefused \}/)
    expect(view.indexOf('zReportRefusal(')).toBeLessThan(view.indexOf('generateZReport('))
    const print = source.slice(source.indexOf("'receipt:print',"), source.indexOf("'staff:list',"))
    const zBranch = print.slice(print.indexOf('if (isZReport)'), print.indexOf('if (!localId)'))
    expect(zBranch).toMatch(/const printRefused = requested \? zReportRefusal\(requested, staffSession\.current\(\), 'print'\) : null\s*if \(printRefused\) \{\s*return \{ success: false, error: printRefused \}/)
    expect(zBranch.indexOf('zReportRefusal(')).toBeLessThan(zBranch.indexOf('generateZReport('))
  })
})

describe('C5: My shifts and My sales, by the session\'s id', () => {
  it('My shifts: the open shift and the ones they opened or closed, open first, never another cashier\'s', () => {
    const { db, amina, brian } = freshDb()
    const own = insertShift(db, { staffId: amina.id, clockIn: '2026-10-05T04:00:00.000Z', closedBy: amina.id })
    const closedByAmina = insertShift(db, { staffId: brian.id, clockIn: '2026-10-06T04:00:00.000Z', closedBy: amina.id })
    insertShift(db, { staffId: brian.id, clockIn: '2026-10-04T04:00:00.000Z', closedBy: brian.id })
    const open = insertShift(db, { staffId: brian.id, clockIn: '2026-10-07T04:00:00.000Z', open: true })

    const result = myShifts(db, amina, { page: 1, staffId: brian.id })

    expect(result.data?.shifts.map((s) => s.id)).toEqual([open, closedByAmina, own])
    expect(result.data?.total).toBe(3)
  })

  it('My sales: only the sales recorded under the cashier signed in, though the request names another', () => {
    const { db, amina, brian } = freshDb()
    sale(db, { staffId: amina.id, total: 65, at: '2026-10-07T05:00:00.000Z' })
    sale(db, { staffId: brian.id, total: 99, at: '2026-10-07T06:00:00.000Z' })
    sale(db, { staffId: amina.id, total: 164, at: '2026-10-07T07:00:00.000Z' })

    const result = mySales(db, amina, { page: 1, staffId: brian.id })

    expect(result.success).toBe(true)
    if (!result.success || !result.data) return
    expect(result.data.invoices.map((row) => row.order.total)).toEqual([164, 65])
    expect(result.data.invoices.every((row) => row.order.staff_id === amina.id)).toBe(true)
    expect(result.data.total).toBe(2)
    expect(result.data.invoices[0]).toMatchObject({ paymentText: 'cash' })
    expect(result.data.invoices[0].traderInvoiceNumber).not.toBe('')
  })

  it('nothing with nobody signed in', () => {
    const { db } = freshDb()
    expect(myShifts(db, null, { page: 1 })).toEqual({ success: false, error: MANAGER_NEEDED_MESSAGE })
    expect(mySales(db, null, { page: 1 })).toEqual({ success: false, error: MANAGER_NEEDED_MESSAGE })
  })
})

describe('C6: the Order History', () => {
  it('holds a cashier\'s own sales only; an admin\'s holds every sale, as before', () => {
    const { db, admin, amina, brian } = freshDb()
    sale(db, { staffId: amina.id, total: 65 })
    sale(db, { staffId: brian.id, total: 99 })

    const aminas = orderHistoryFor(db, amina, undefined)
    const admins = orderHistoryFor(db, admin, undefined)

    expect(aminas.success && aminas.data?.map((order) => order.total)).toEqual([65])
    expect(admins).toEqual({ success: true, data: db.getOrders() })
    expect(admins.success && admins.data).toHaveLength(2)
    expect(orderHistoryFor(db, null, undefined)).toEqual({ success: false, error: MANAGER_NEEDED_MESSAGE })
  })
})

describe('the new column', () => {
  it('is added to a database made before the phase, with every shift reading NULL, and adding it again changes nothing', () => {
    const old = new BetterSqlite3(':memory:')
    old.exec(`CREATE TABLE shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER NOT NULL, clock_in TEXT NOT NULL, clock_out TEXT,
      starting_cash REAL NOT NULL DEFAULT 0, expected_cash REAL, ending_cash REAL, discrepancy REAL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')))`)
    old.exec("INSERT INTO shifts (staff_id, clock_in, status) VALUES (1, '2026-10-01T04:00:00.000Z', 'closed')")
    const db = new RubisDatabase({ dbPath: ':memory:', DatabaseFactory: function () { return old } as unknown as typeof BetterSqlite3 })
    const columns = (): string[] => (old.prepare('PRAGMA table_info(shifts)').all() as Array<{ name: string }>).map((c) => c.name)

    db.init()
    expect(columns()).toContain('closed_by_staff_id')
    expect(shift(db, 1).closed_by_staff_id).toBeNull()
    db.init()
    expect(columns().filter((name) => name === 'closed_by_staff_id')).toHaveLength(1)
  })
})
