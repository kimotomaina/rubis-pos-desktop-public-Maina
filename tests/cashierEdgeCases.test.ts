/**
 * Phase 254, the edge cases: the session through a failed login, an inactive account, and a manager's PIN check at a
 * cashier's till; opening and closing at the margins (a manager's PIN, an inactive cashier, a held sale, a shift
 * already closed); the Z lock with nobody signed in; paging, merged shifts, split payments and older sales with no
 * cashier in "My shifts and sales" and the Order History; the gate passing arguments through untouched. Real in-memory
 * SQLite throughout.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase, type StaffSummary } from '../src/main/services/database.js'
import { hashPin, loginWithSession } from '../src/main/services/auth.js'
import { openShiftChecked } from '../src/main/services/shift-open.js'
import { closeShiftUnlessHeld } from '../src/main/services/held-sales.js'
import { generateZReport } from '../src/main/services/reports.js'
import { mySales, myShifts, orderHistoryFor } from '../src/main/services/my-shifts.js'
import {
  CASHIER_CHANNELS,
  MANAGER_NEEDED_MESSAGE,
  Z_REPORT_LOCKED_MESSAGE,
  createStaffSession,
  gateIpcMain,
  zReportRefusal
} from '../src/main/lib/roleGate.js'

const LATER = Date.now() + 3 * 24 * 60 * 60 * 1000

function freshDb() {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const make = (name: string, role: 'admin' | 'cashier', pin: string): StaffSummary => ({
    id: db.createStaff({ name, pinHash: hashPin(pin), role }).staffId,
    name,
    role
  })
  return { db, admin: make('Admin', 'admin', '9999'), amina: make('Amina', 'cashier', '1111'), brian: make('Brian', 'cashier', '2222') }
}
const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn
const deactivate = (db: RubisDatabase, id: number): void => {
  conn(db).prepare('UPDATE staff SET is_active = 0 WHERE id = ?').run(id)
}
const count = (db: RubisDatabase, table: string): number =>
  (conn(db).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

function sale(db: RubisDatabase, v: { staffId: number | null; total: number; at: string; method?: string; shiftId?: number }): number {
  const info = conn(db)
    .prepare('INSERT INTO orders (total, status, created_at, payload_json, staff_id, payment_method, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(v.total, 'synced', v.at, '{}', v.staffId, v.method ?? 'cash', v.shiftId ?? null)
  return Number(info.lastInsertRowid)
}
function insertShift(db: RubisDatabase, v: { staffId: number; clockIn: string; closedBy?: number | null; open?: boolean }): number {
  const info = conn(db)
    .prepare(
      `INSERT INTO shifts (staff_id, clock_in, clock_out, starting_cash, expected_cash, ending_cash, discrepancy, status, closed_by_staff_id)
       VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?)`
    )
    .run(v.staffId, v.clockIn, v.open ? null : v.clockIn, v.open ? 'open' : 'closed', v.closedBy ?? null)
  return Number(info.lastInsertRowid)
}
const day = (n: number, hour = 4): string => new Date(Date.UTC(2026, 8, n, hour)).toISOString()

describe('the session at login', () => {
  it('the login screen signs the staff member in', () => {
    const { db, amina } = freshDb()
    const session = createStaffSession()
    expect(loginWithSession(db, session, { staffId: amina.id, pin: '1111', session: true }).success).toBe(true)
    expect(session.current()).toEqual(amina)
  })

  it('a wrong PIN at the login screen leaves nobody signed in, not the one before', () => {
    const { db, admin, amina } = freshDb()
    const session = createStaffSession()
    session.signIn(admin)
    expect(loginWithSession(db, session, { staffId: amina.id, pin: '0000', session: true })).toEqual({ success: false, error: 'Incorrect PIN' })
    expect(session.current()).toBeNull()
  })

  it('an inactive account cannot sign in', () => {
    const { db, amina } = freshDb()
    deactivate(db, amina.id)
    const session = createStaffSession()
    expect(loginWithSession(db, session, { staffId: amina.id, pin: '1111', session: true }).success).toBe(false)
    expect(session.current()).toBeNull()
  })

  it('a manager PIN checked at a cashier\'s till, right or wrong, leaves the cashier signed in', () => {
    const { db, admin, amina } = freshDb()
    const session = createStaffSession()
    session.signIn(amina)
    expect(loginWithSession(db, session, { staffId: admin.id, pin: '9999' })).toEqual({ success: true, data: admin })
    expect(loginWithSession(db, session, { staffId: admin.id, pin: '0000' }).success).toBe(false)
    expect(session.current()).toEqual(amina)
  })
})

describe('the gate itself', () => {
  it('hands an allowed call its event and arguments untouched, and returns what the handler returns', async () => {
    const session = createStaffSession()
    session.signIn({ id: 2, name: 'Amina', role: 'cashier' })
    const registered = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const ipc = gateIpcMain({ handle: (c: string, l: (event: unknown, ...args: unknown[]) => unknown) => registered.set(c, l), on: vi.fn() } as unknown as Pick<IpcMain, 'handle' | 'on'>, session)
    const listener = vi.fn(async () => ({ success: true, data: 7 }))
    ipc.handle('orders:retrySync', listener)
    const event = { sender: 'x' }

    await expect(registered.get('orders:retrySync')!(event, 41, { extra: true })).resolves.toEqual({ success: true, data: 7 })
    expect(listener).toHaveBeenCalledWith(event, 41, { extra: true })
  })

  it('decides on who is signed in at the moment of the call, not at registration', () => {
    const session = createStaffSession()
    const registered = new Map<string, () => unknown>()
    const ipc = gateIpcMain({ handle: (c: string, l: () => unknown) => registered.set(c, l), on: vi.fn() } as unknown as Pick<IpcMain, 'handle' | 'on'>, session)
    ipc.handle('staff:create', () => ({ success: true }))
    session.signIn({ id: 1, name: 'Admin', role: 'admin' })
    expect(registered.get('staff:create')!()).toEqual({ success: true })
    session.signIn({ id: 2, name: 'Amina', role: 'cashier' })
    expect(registered.get('staff:create')!()).toEqual({ success: false, error: MANAGER_NEEDED_MESSAGE })
    session.signOut()
    expect(registered.get('staff:create')!()).toEqual({ success: false, error: MANAGER_NEEDED_MESSAGE })
  })

  it('A3: a cashier reprints a receipt as today; the reprint path itself checks no role', () => {
    expect(CASHIER_CHANNELS.has('receipt:print')).toBe(true)
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
    const print = source.slice(source.indexOf("'receipt:print',"), source.indexOf("'staff:list',"))
    const orderBranch = print.slice(print.indexOf('if (!localId)'))
    expect(orderBranch).not.toMatch(/zReportRefusal|mayReadShift|staffSession/)
  })
})

describe('opening at the margins', () => {
  it('a manager\'s PIN at a cashier\'s till opens the shift under the manager, as before', () => {
    const { db, admin, amina } = freshDb()
    const opened = openShiftChecked(db, { staffId: amina.id, startingCash: 100, managerId: admin.id, managerPin: '9999' }, amina)
    expect(opened.success).toBe(true)
    expect(db.getOpenShift()?.staff_id).toBe(admin.id)
  })

  it('a wrong manager PIN opens nothing, even with a cashier signed in', () => {
    const { db, admin, amina } = freshDb()
    expect(openShiftChecked(db, { staffId: amina.id, startingCash: 100, managerId: admin.id, managerPin: '0000' }, amina).success).toBe(false)
    expect(count(db, 'shifts')).toBe(0)
  })

  it('a cashier made inactive since signing in cannot open a shift', () => {
    const { db, amina } = freshDb()
    deactivate(db, amina.id)
    expect(openShiftChecked(db, { staffId: amina.id, startingCash: 100 }, amina)).toEqual({ success: false, error: MANAGER_NEEDED_MESSAGE })
    expect(count(db, 'shifts')).toBe(0)
  })

  it('an admin signed in may still start at 0', () => {
    const { db, admin } = freshDb()
    expect(openShiftChecked(db, { staffId: admin.id, startingCash: 0, startAtZero: true }, admin).success).toBe(true)
  })

  it('with nobody signed in, the rule from before the phase: a cashier id is refused, an admin id opens', () => {
    const { db, admin, amina } = freshDb()
    expect(openShiftChecked(db, { staffId: amina.id, startingCash: 100 }).success).toBe(false)
    expect(openShiftChecked(db, { staffId: admin.id, startingCash: 100 }).success).toBe(true)
  })
})

describe('closing at the margins', () => {
  function opened() {
    const fresh = freshDb()
    const shiftId = (openShiftChecked(fresh.db, { staffId: fresh.amina.id, startingCash: 100 }, fresh.amina) as { data: { shiftId: number } }).data.shiftId
    return { ...fresh, shiftId }
  }

  it('a held sale stops a cashier\'s close as it stops an admin\'s, and records no closer', () => {
    const { db, shiftId, amina } = opened()
    db.holdSale({ cartToken: 't1', payloadJson: '{"items":[]}', total: 50, lineCount: 1, unitCount: 1, staffId: amina.id })
    const result = closeShiftUnlessHeld(db, shiftId, 100, null, LATER, null, amina.id)
    expect(result.success).toBe(false)
    expect(result.error).toContain('on hold')
    expect(db.getShiftById(shiftId)).toMatchObject({ status: 'open', closed_by_staff_id: null })
  })

  it('a shift already closed is not closed again, and its closer stays the first one', () => {
    const { db, shiftId, amina, brian } = opened()
    expect(closeShiftUnlessHeld(db, shiftId, 100, null, LATER, null, amina.id).success).toBe(true)
    const again = closeShiftUnlessHeld(db, shiftId, 500, null, LATER, null, brian.id)
    expect(again).toEqual({ success: false, error: `Shift ${shiftId} is already closed` })
    expect(db.getShiftById(shiftId)).toMatchObject({ closed_by_staff_id: amina.id, ending_cash: 100 })
  })

  it('docs/phase-255: before the window end an admin may close (someone leaving early); a cashier may not', () => {
    const now = Date.now()
    const cashier = opened()
    const early = closeShiftUnlessHeld(cashier.db, cashier.shiftId, 100, null, now, null, cashier.amina.id, false)
    expect(early.success).toBe(false)
    expect(cashier.db.getShiftById(cashier.shiftId)?.status).toBe('open')

    const admin = opened()
    sale(admin.db, { staffId: admin.amina.id, total: 300, at: new Date(now).toISOString(), shiftId: admin.shiftId })
    const closed = closeShiftUnlessHeld(admin.db, admin.shiftId, 390, null, now, null, admin.admin.id, true)
    expect(closed).toEqual({ success: true, data: { expectedCash: 400, discrepancy: -10, mpesaExpected: null, mpesaDifference: null } })
    expect(admin.db.getShiftById(admin.shiftId)).toMatchObject({ status: 'closed', closed_by_staff_id: admin.admin.id })
  })

  it('docs/phase-255: an admin\'s early close is still stopped by a held sale', () => {
    const { db, shiftId, admin, amina } = opened()
    db.holdSale({ cartToken: 't1', payloadJson: '{"items":[]}', total: 50, lineCount: 1, unitCount: 1, staffId: amina.id })
    const result = closeShiftUnlessHeld(db, shiftId, 100, null, Date.now(), null, admin.id, true)
    expect(result.success).toBe(false)
    expect(result.error).toContain('on hold')
  })

  it('docs/phase-255: the close handler lets an early close through only for an admin signed in', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
    const body = source.slice(source.indexOf("'shifts:close',"), source.indexOf("'shifts:window-status'"))
    expect(body).toMatch(/staffSession\.current\(\)\?\.id \?\? null,\s*staffSession\.current\(\)\?\.role === 'admin'\s*\)/)
  })

  it('the Z names an unknown closer "Unknown" rather than failing', () => {
    const { db, shiftId } = opened()
    closeShiftUnlessHeld(db, shiftId, 100, null, LATER, null, 999)
    expect(generateZReport(db, shiftId, 0.16).closedByName).toBe('Unknown')
  })
})

describe('the Z lock', () => {
  it('nobody signed in: the open Z is locked, a closed one needs someone signed in', () => {
    const open = { status: 'open' as const, staff_id: 1, closed_by_staff_id: null }
    const closed = { status: 'closed' as const, staff_id: 1, closed_by_staff_id: 1 }
    expect(zReportRefusal(open, null, 'print')).toBe(Z_REPORT_LOCKED_MESSAGE)
    expect(zReportRefusal(open, null, 'view')).toBe(Z_REPORT_LOCKED_MESSAGE)
    expect(zReportRefusal(closed, null, 'print')).toBe(MANAGER_NEEDED_MESSAGE)
  })

  it('unlocks the moment the shift closes: the cashier who closed it prints it, twice if they like', () => {
    const { db, amina, brian } = freshDb()
    const shiftId = (openShiftChecked(db, { staffId: brian.id, startingCash: 100 }, brian) as { data: { shiftId: number } }).data.shiftId
    expect(zReportRefusal(db.getShiftById(shiftId)!, amina, 'print')).toBe(Z_REPORT_LOCKED_MESSAGE)
    closeShiftUnlessHeld(db, shiftId, 100, null, LATER, null, amina.id)
    expect(zReportRefusal(db.getShiftById(shiftId)!, amina, 'print')).toBeNull()
    expect(zReportRefusal(db.getShiftById(shiftId)!, amina, 'print')).toBeNull()
    expect(zReportRefusal(db.getShiftById(shiftId)!, brian, 'print')).toBeNull()
  })
})

describe('"My shifts and sales" at the margins', () => {
  it('pages My shifts ten at a time, the open shift on page 1, and counts them all', () => {
    const { db, amina, brian } = freshDb()
    for (let n = 1; n <= 12; n++) insertShift(db, { staffId: amina.id, clockIn: day(n), closedBy: amina.id })
    const open = insertShift(db, { staffId: brian.id, clockIn: day(20), open: true })

    const first = myShifts(db, amina, { page: 1 })
    const second = myShifts(db, amina, { page: 2 })

    expect(first.data?.shifts).toHaveLength(10)
    expect(first.data?.shifts[0].id).toBe(open)
    expect(second.data?.shifts).toHaveLength(3)
    expect(first.data?.total).toBe(13)
    expect(new Set([...first.data!.shifts, ...second.data!.shifts].map((s) => s.id)).size).toBe(13)
  })

  it('leaves out a shift merged into another, as Shift History does', () => {
    const { db, amina } = freshDb()
    const kept = insertShift(db, { staffId: amina.id, clockIn: day(1), closedBy: amina.id })
    const absorbed = insertShift(db, { staffId: amina.id, clockIn: day(1, 6), closedBy: amina.id })
    conn(db)
      .prepare('INSERT INTO shift_merges (absorbed_shift_id, into_shift_id, by_staff_id, at, reason, sales_count) VALUES (?, ?, ?, ?, ?, ?)')
      .run(absorbed, kept, 1, day(2), 'test', 0)
    const result = myShifts(db, amina, { page: 1 })
    expect(result.data?.shifts.map((s) => s.id)).toEqual([kept])
    expect(result.data?.total).toBe(1)
  })

  it('a cashier with no shifts sees only the open one, and with none open, nothing', () => {
    const { db, amina, brian } = freshDb()
    expect(myShifts(db, amina, { page: 1 }).data).toEqual({ shifts: [], total: 0, page: 1 })
    insertShift(db, { staffId: brian.id, clockIn: day(3), closedBy: brian.id })
    const open = insertShift(db, { staffId: brian.id, clockIn: day(4), open: true })
    expect(myShifts(db, amina, { page: 1 }).data?.shifts.map((s) => s.id)).toEqual([open])
  })

  it('pages My sales ten at a time, newest first', () => {
    const { db, amina } = freshDb()
    for (let n = 1; n <= 12; n++) sale(db, { staffId: amina.id, total: n, at: day(n) })
    expect(mySales(db, amina, { page: 1 }).data?.invoices.map((row) => row.order.total)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3])
    expect(mySales(db, amina, { page: 2 }).data?.invoices.map((row) => row.order.total)).toEqual([2, 1])
    expect(mySales(db, amina, { page: 2 }).data?.total).toBe(12)
  })

  it('shows a split sale as the invoice list does', () => {
    const { db, amina } = freshDb()
    const id = sale(db, { staffId: amina.id, total: 164, at: day(5), method: 'split' })
    const leg = conn(db).prepare(
      'INSERT INTO order_payments (order_local_id, leg_no, method, mpesa_mode, amount, reference, tendered, change_due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    leg.run(id, 1, 'mpesa', 'daraja', 100, 'QAB1', null, null, day(5))
    leg.run(id, 2, 'cash', null, 64, null, 64, 0, day(5))
    expect(mySales(db, amina, { page: 1 }).data?.invoices[0].paymentText).toBe('split: mpesa 100.00 + cash 64.00')
  })

  it('refuses a malformed page and reads nothing', () => {
    const { db, amina } = freshDb()
    expect(mySales(db, amina, { page: 0 }).success).toBe(false)
    expect(myShifts(db, amina, { page: 'two' }).success).toBe(false)
  })
})

describe('the Order History at the margins', () => {
  it('older sales recorded with no cashier are an admin\'s to see, not a cashier\'s', () => {
    const { db, admin, amina } = freshDb()
    sale(db, { staffId: null, total: 10, at: day(1) })
    sale(db, { staffId: amina.id, total: 20, at: day(2) })
    expect(orderHistoryFor(db, amina, undefined).data?.map((order) => order.total)).toEqual([20])
    expect(orderHistoryFor(db, admin, undefined).data?.map((order) => order.total)).toEqual([20, 10])
  })

  it('keeps the screen\'s limit and offset for a cashier', () => {
    const { db, amina, brian } = freshDb()
    for (let n = 1; n <= 5; n++) sale(db, { staffId: amina.id, total: n, at: day(n) })
    sale(db, { staffId: brian.id, total: 99, at: day(9) })
    expect(orderHistoryFor(db, amina, { limit: 2, offset: 1 }).data?.map((order) => order.total)).toEqual([4, 3])
  })
})
