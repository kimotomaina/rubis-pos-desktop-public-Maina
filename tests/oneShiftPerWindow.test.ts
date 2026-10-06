/**
 * Phase 231: one shift per window, automatic assignment, a close from the window's last minute.
 *
 * Every database step runs against a real in-memory SQLite (not the recording fake), so a refusal that must write
 * nothing is shown to write nothing, and "run it twice changes nothing" is a count of rows. Times are written as
 * Nairobi wall-clock time; Nairobi is UTC+3 all year.
 *
 * CHANGED (docs/phase-237). OLD: Day began at 09:00 and Night ended at 08:59 (docs/phase-199 D1). NEW: Day begins at
 * 07:00 and Night ends at 06:59, the owner's correction; the rule, the labels and the boundary seconds move with it.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import type { ShiftRow } from '../src/main/services/database.js'
import { closeShiftUnlessHeld } from '../src/main/services/held-sales.js'
import { runAutoAssign } from '../src/main/services/auto-assign.js'
import { openShiftChecked } from '../src/main/services/shift-open.js'
import { getShiftWindowStatus } from '../src/main/services/shift-window-status.js'
import { generateWindowReport } from '../src/main/services/window-report.js'
import { generateZReport } from '../src/main/services/reports.js'
import { renderZReport } from '../src/main/services/printer.js'
import type { PrinterSettings, ThermalPrinterLike } from '../src/main/services/printer.js'
import { planAutoAssignment } from '../src/main/lib/autoAssign.js'
import { windowClosableFrom, shiftWindowOf } from '../src/main/lib/shiftWindows.js'
import { withWindow } from '../src/main/lib/shiftLabel.js'
import { shiftOpenSchema, moveSaleSchema } from '../src/main/lib/ipcValidator.js'
import {
  zReportAdjustmentBlocks,
  zReportChangeBlocks,
  zReportLabelledLine,
  zReportMergedLine,
  zReportSalesAtCloseLine
} from '../src/main/lib/zReportAdjustments.js'
import {
  zReportAdjustmentBlocks as rendererBlocks,
  zReportChangeBlocks as rendererChangeBlocks,
  zReportLabelledLine as rendererLabelled,
  zReportMergedLine as rendererMerged,
  zReportSalesAtCloseLine as rendererAtClose
} from '../src/renderer/src/lib/zReportAdjustments.js'
import { zReportRetroLines } from '../src/main/lib/zReportRetro.js'
import { zReportRetroLines as rendererRetroLines } from '../src/renderer/src/lib/zReportRetro.js'
import { previewOpenFloat } from '../src/renderer/src/lib/openShiftFloat.js'
import { TILL_LOG_EVENTS, RENDERER_TILL_EVENTS } from '../src/main/services/tillLog.js'

/** A Nairobi wall-clock time as epoch milliseconds. */
const ms = (t: string): number => Date.parse(`${t}+03:00`)
/** A Nairobi wall-clock time as the ISO instant it is stored as. */
const iso = (t: string): string => new Date(ms(t)).toISOString()

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}
const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn
const count = (db: RubisDatabase, table: string): number =>
  (conn(db).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const snapshot = (db: RubisDatabase): Record<string, number> => ({
  shifts: count(db, 'shifts'),
  adjustments: count(db, 'shift_adjustments'),
  adjustmentSales: count(db, 'shift_adjustment_sales'),
  corrections: count(db, 'shift_corrections'),
  attached: (conn(db).prepare('SELECT COUNT(*) AS n FROM orders WHERE shift_id IS NOT NULL').get() as { n: number }).n
})

/** Inserts one sale with the given time, total and method; returns its id. */
function sale(
  db: RubisDatabase,
  at: string,
  total = 100,
  method: 'cash' | 'mpesa' | 'card' = 'cash',
  extra: { status?: string; shiftId?: number | null; createdAt?: string } = {}
): number {
  const info = conn(db)
    .prepare(
      'INSERT INTO orders (total, status, created_at, payload_json, staff_id, payment_method, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(total, extra.status ?? 'synced', extra.createdAt ?? iso(at), '{}', 1, method, extra.shiftId ?? null)
  return Number(info.lastInsertRowid)
}

/** Inserts a shift directly, as older data or a past state would have it. */
function insertShift(
  db: RubisDatabase,
  v: {
    clockIn: string
    clockOut?: string | null
    startingCash?: number
    /** What the shift's expected cash was stored as at close; defaults to the starting cash (it had no sales then). */
    expectedCash?: number
    endingCash?: number | null
    type?: 'day' | 'night' | null
    notCounted?: boolean
    staffId?: number
  }
): number {
  const closed = v.clockOut !== undefined && v.clockOut !== null
  const info = conn(db)
    .prepare(
      `INSERT INTO shifts (staff_id, clock_in, clock_out, starting_cash, expected_cash, ending_cash, discrepancy, status, shift_type, cash_not_counted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      v.staffId ?? 1,
      iso(v.clockIn),
      closed ? iso(v.clockOut as string) : null,
      v.startingCash ?? 0,
      closed && !v.notCounted ? (v.expectedCash ?? v.startingCash ?? 0) : null,
      closed && !v.notCounted ? (v.endingCash ?? 0) : null,
      closed && !v.notCounted ? (v.endingCash ?? 0) - (v.expectedCash ?? v.startingCash ?? 0) : null,
      closed ? 'closed' : 'open',
      v.type === undefined ? null : v.type,
      v.notCounted ? 1 : 0
    )
  return Number(info.lastInsertRowid)
}

const adjustments = (db: RubisDatabase, shiftId: number) => db.listShiftAdjustments(shiftId)
const shiftOf = (db: RubisDatabase, id: number): ShiftRow => db.getShiftById(id) as ShiftRow

describe('S1: one shift per window, inside the transaction that creates it', () => {
  it('refuses a second shift in a window that already has one, closed or open, and writes nothing', () => {
    const db = freshDb()
    insertShift(db, { clockIn: '2026-10-05T17:43:21', clockOut: '2026-10-05T17:43:36', endingCash: 3790, type: 'day' })
    const before = snapshot(db)

    expect(() => db.openShift(1, 100, null, {}, ms('2026-10-05T20:00:00'))).toThrow(
      'Night shift, 5 Oct 2026 already has shift #1. A window has one shift.'
    )
    expect(snapshot(db)).toEqual(before)
  })

  it('allows a shift in each different window, and names none by the screen', () => {
    const db = freshDb()
    const day = db.openShift(1, 0, null, {}, ms('2026-10-05T10:00:00'))
    db.closeShift(day.shiftId, 0)
    const night = db.openShift(1, 0, null, {}, ms('2026-10-05T18:00:00'))

    expect(shiftOf(db, day.shiftId).shift_type).toBe('day')
    expect(shiftOf(db, night.shiftId).shift_type).toBe('night')
  })

  it('leaves an older pair in one window exactly as it is, and still refuses a third', () => {
    const db = freshDb()
    const a = insertShift(db, { clockIn: '2026-10-05T17:43:21', clockOut: '2026-10-05T17:43:36', type: 'day' })
    const b = insertShift(db, { clockIn: '2026-10-05T19:00:00', clockOut: '2026-10-05T20:00:00', type: 'night' })
    const before = snapshot(db)

    expect(() => db.openShift(1, 0, null, {}, ms('2026-10-05T21:00:00'))).toThrow('A window has one shift.')
    expect(snapshot(db)).toEqual(before)
    expect([a, b].map((id) => shiftOf(db, id).shift_type)).toEqual(['day', 'night'])
  })

  it('works the window by the clock: 06:59:59 is the previous Night, 07:00:00 is Day', () => {
    const db = freshDb()
    const early = db.openShift(1, 0, null, {}, ms('2026-10-06T06:59:59'))
    db.closeShift(early.shiftId, 0)
    const morning = db.openShift(1, 0, null, {}, ms('2026-10-06T07:00:00'))

    expect(shiftOf(db, early.shiftId).shift_type).toBe('night')
    expect(shiftWindowOf(shiftOf(db, early.shiftId).clock_in)).toEqual({ type: 'night', startDate: '2026-10-05' })
    expect(shiftOf(db, morning.shiftId).shift_type).toBe('day')
  })

  it('refuses a second open shift as before', () => {
    const db = freshDb()
    db.openShift(1, 0, null, {}, ms('2026-10-05T10:00:00'))

    expect(() => db.openShift(1, 0, null, {}, ms('2026-10-05T10:05:00'))).toThrow('A shift is already open')
  })
})

describe('W4: the type comes from the clock only', () => {
  it('stores the window of the clock whatever the request carried', () => {
    const request = shiftOpenSchema.safeParse({ staffId: 1, startingCash: 0, shiftType: 'day' })
    expect(request.success).toBe(true)

    const db = freshDb()
    // `shiftType` has no parameter on the database: 17:43 is Night, and Night is stored.
    const { shiftId } = db.openShift(1, 0, null, {}, ms('2026-10-05T17:43:00'))
    expect(shiftOf(db, shiftId).shift_type).toBe('night')
  })

  it('ignores a type the screen sends: a request that says day at 17:43 stores night (through the admin check)', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(ms('2026-10-05T17:43:00'))
      const db = freshDb()
      const admin = db.createStaff({ name: 'Admin', pinHash: 'x', role: 'admin' }).staffId

      const result = openShiftChecked(db, { staffId: admin, startingCash: 0, shiftType: 'day' })

      expect(result.success).toBe(true)
      expect(shiftOf(db, (result as { data: { shiftId: number } }).data.shiftId).shift_type).toBe('night')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows an older shift by its window, with the label it was given, and leaves the stored row alone', () => {
    const db = freshDb()
    const id = insertShift(db, { clockIn: '2026-10-05T17:43:21', clockOut: '2026-10-05T17:43:36', type: 'day' })

    const shown = withWindow(shiftOf(db, id))

    expect(shown).toMatchObject({ window_type: 'night', window_date: '2026-10-05', labelled_as: 'day' })
    expect(shiftOf(db, id).shift_type).toBe('day')
    expect(withWindow({ ...shiftOf(db, id), shift_type: null }).labelled_as).toBeUndefined()
    expect(withWindow({ ...shiftOf(db, id), shift_type: 'night' }).labelled_as).toBeUndefined()
  })
})

describe('the adjustment tables are append-only', () => {
  it('refuse UPDATE and DELETE, on both', () => {
    const db = freshDb()
    const id = insertShift(db, { clockIn: '2026-10-05T17:43:21', clockOut: '2026-10-05T17:50:00', endingCash: 100 })
    const orderId = sale(db, '2026-10-05T17:45:00')
    db.autoAssignUnattachedSales(ms('2026-10-05T21:00:00'))
    expect(adjustments(db, id)).toHaveLength(1)

    expect(() => conn(db).prepare('UPDATE shift_adjustments SET reason = ? WHERE shift_id = ?').run('x', id)).toThrow(/append-only/)
    expect(() => conn(db).prepare('DELETE FROM shift_adjustments WHERE shift_id = ?').run(id)).toThrow(/append-only/)
    expect(() => conn(db).prepare('UPDATE shift_adjustment_sales SET order_id = 99 WHERE order_id = ?').run(orderId)).toThrow(/append-only/)
    expect(() => conn(db).prepare('DELETE FROM shift_adjustment_sales WHERE order_id = ?').run(orderId)).toThrow(/append-only/)
    expect(adjustments(db, id)).toHaveLength(1)
  })

  it('are created once, with their triggers, and are safe to open twice', () => {
    const db = freshDb()
    db.init()
    const names = (conn(db).prepare("SELECT name FROM sqlite_master WHERE name LIKE 'shift_adjustment%'").all() as Array<{ name: string }>).map((r) => r.name)

    expect(names).toEqual(
      expect.arrayContaining([
        'shift_adjustments',
        'shift_adjustment_sales',
        'shift_adjustments_no_update',
        'shift_adjustments_no_delete',
        'shift_adjustment_sales_no_update',
        'shift_adjustment_sales_no_delete'
      ])
    )
  })
})

describe('S4: automatic assignment', () => {
  const NOW = ms('2026-10-06T10:00:00') // the Day window of 6 Oct: the 5 Oct windows have ended

  it("gives the Night window's sales to shift #1, closed with 0 starting and 3,790 counted, and the difference shows (S7)", () => {
    const db = freshDb()
    const id = insertShift(db, { clockIn: '2026-10-05T17:43:21', clockOut: '2026-10-05T17:43:36', startingCash: 0, endingCash: 3790, type: 'day' })
    const early = sale(db, '2026-10-05T17:35:00', 1000)
    const late = sale(db, '2026-10-05T17:50:00', 2790)

    const result = db.autoAssignUnattachedSales(NOW)

    expect(result.touched).toEqual([{ shiftId: id, created: false, windowType: 'night', windowDate: '2026-10-05', count: 2 }])
    expect(conn(db).prepare('SELECT shift_id FROM orders WHERE local_id IN (?, ?)').all(early, late)).toEqual([{ shift_id: id }, { shift_id: id }])
    const [adjustment] = adjustments(db, id)
    expect(adjustment).toMatchObject({
      kind: 'auto',
      by_staff_id: null,
      sales_count: 2,
      cash_total: 3790,
      starting_cash: 0,
      ending_cash: 3790,
      expected_cash: 3790,
      discrepancy: 0
    })
    expect(adjustment.reason).toContain('joined this shift automatically')
    expect(conn(db).prepare('SELECT order_id FROM shift_adjustment_sales WHERE adjustment_id = ? ORDER BY order_id').all(adjustment.id)).toEqual([
      { order_id: early },
      { order_id: late }
    ])
    // The shift's own row is untouched: the original close stays visible.
    expect(shiftOf(db, id)).toMatchObject({ clock_out: iso('2026-10-05T17:43:36'), expected_cash: 0, ending_cash: 3790, discrepancy: 3790 })
  })

  it('shows a difference when the counted cash does not cover the added sales, keeping the counted cash', () => {
    const db = freshDb()
    const id = insertShift(db, { clockIn: '2026-10-05T17:43:21', clockOut: '2026-10-05T17:43:36', startingCash: 0, endingCash: 3000, type: 'night' })
    sale(db, '2026-10-05T17:50:00', 3500)

    db.autoAssignUnattachedSales(NOW)

    expect(adjustments(db, id)[0]).toMatchObject({ ending_cash: 3000, expected_cash: 3500, discrepancy: -500 })
  })

  it('writes no figures for a shift whose cash was not counted, or that is still open', () => {
    const db = freshDb()
    const notCounted = insertShift(db, { clockIn: '2026-10-04T10:00:00', clockOut: '2026-10-04T12:00:00', notCounted: true, type: 'day' })
    sale(db, '2026-10-04T11:00:00') // inside it
    const open = insertShift(db, { clockIn: '2026-10-05T10:00:00', type: 'day' })
    sale(db, '2026-10-05T09:30:00') // same Day window, before it opened

    db.autoAssignUnattachedSales(ms('2026-10-05T11:00:00'))

    expect(adjustments(db, notCounted)[0]).toMatchObject({ kind: 'auto', starting_cash: null, expected_cash: null, discrepancy: null })
    expect(adjustments(db, open)[0]).toMatchObject({ kind: 'auto', starting_cash: null, expected_cash: null })
  })

  it('makes a shift for an ended window with none: closed, cash not counted, created automatically, one record', () => {
    const db = freshDb()
    const a = sale(db, '2026-10-05T10:00:10', 500, 'cash')
    const b = sale(db, '2026-10-05T11:30:00', 300, 'mpesa')

    const result = db.autoAssignUnattachedSales(NOW)

    expect(result.touched).toHaveLength(1)
    const created = result.touched[0]
    expect(created).toMatchObject({ created: true, windowType: 'day', windowDate: '2026-10-05', count: 2 })
    const shift = shiftOf(db, created.shiftId)
    expect(shift).toMatchObject({
      staff_id: 0,
      created_by_staff_id: null,
      kind: 'retrospective',
      cash_not_counted: 1,
      status: 'closed',
      shift_type: 'day',
      reason: 'Created automatically for sales with no shift',
      clock_in: iso('2026-10-05T10:00:00'),
      starting_cash: 0,
      expected_cash: null,
      ending_cash: null
    })
    expect(shift.clock_out).toBe(new Date(ms('2026-10-05T11:31:00') - 1).toISOString())
    expect(conn(db).prepare('SELECT shift_id FROM orders WHERE local_id IN (?, ?)').all(a, b)).toEqual([
      { shift_id: created.shiftId },
      { shift_id: created.shiftId }
    ])
    expect(adjustments(db, created.shiftId)).toHaveLength(1)
    expect(adjustments(db, created.shiftId)[0]).toMatchObject({ kind: 'opening', by_staff_id: null, sales_count: 2, cash_total: 500, mpesa_total: 300 })
    expect(count(db, 'sync_queue')).toBe(0)
  })

  it('makes one shift for a Night across midnight, dated by the evening', () => {
    const db = freshDb()
    sale(db, '2026-10-05T23:50:00')
    sale(db, '2026-10-06T00:10:00')
    sale(db, '2026-10-06T06:30:00')

    const result = db.autoAssignUnattachedSales(NOW)

    expect(result.touched).toEqual([expect.objectContaining({ created: true, windowType: 'night', windowDate: '2026-10-05', count: 3 })])
  })

  it('leaves the current window\'s sales waiting when it has no shift yet', () => {
    const db = freshDb()
    const id = sale(db, '2026-10-06T09:30:00')

    const result = db.autoAssignUnattachedSales(NOW)

    expect(result).toEqual({ touched: [], waiting: 1 })
    expect(conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(id)).toEqual({ shift_id: null })
    expect(snapshot(db).shifts).toBe(0)
  })

  it('gives a sale made inside another window\'s shift to that shift (S8): a Day shift left open past 17:31', () => {
    const db = freshDb()
    const day = insertShift(db, { clockIn: '2026-10-05T16:00:00', clockOut: '2026-10-05T20:00:00', endingCash: 100, type: 'day' })
    sale(db, '2026-10-05T18:30:00') // Night window, inside the Day shift's times

    const result = db.autoAssignUnattachedSales(ms('2026-10-06T10:00:00'))

    expect(result.touched).toEqual([expect.objectContaining({ shiftId: day, created: false })])
    expect(adjustments(db, day)[0].reason).toContain('inside its times')
  })

  it('holds a made shift off the neighbouring shifts: its period starts 1 ms after a shift that ends before its first sale', () => {
    const plan = planAutoAssignment(
      [{ local_id: 1, created_at: iso('2026-10-05T20:00:20') }],
      [{ id: 1, clock_in: iso('2026-10-05T16:00:00'), clock_out: iso('2026-10-05T20:00:00') }],
      ms('2026-10-06T10:00:00')
    )

    expect(plan.creates).toHaveLength(1)
    expect(plan.creates[0].startIso).toBe(new Date(ms('2026-10-05T20:00:00') + 1).toISOString())
    expect(plan.creates[0].endIso).toBe(new Date(ms('2026-10-05T20:01:00') - 1).toISOString())
  })

  it('chooses the nearest shift when a window holds two, the lower id on a tie, and says so', () => {
    const db = freshDb()
    const first = insertShift(db, { clockIn: '2026-10-05T18:00:00', clockOut: '2026-10-05T18:10:00', endingCash: 0 })
    const second = insertShift(db, { clockIn: '2026-10-05T19:00:00', clockOut: '2026-10-05T19:10:00', endingCash: 0 })
    const nearFirst = sale(db, '2026-10-05T18:20:00')
    const nearSecond = sale(db, '2026-10-05T18:50:00')
    const tie = sale(db, '2026-10-05T18:35:00') // 25 minutes from each: 18:10 and 19:00 -> 25 and 25

    const result = db.autoAssignUnattachedSales(NOW)

    const shiftIdOf = (id: number): number => (conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(id) as { shift_id: number }).shift_id
    expect(shiftIdOf(nearFirst)).toBe(first)
    expect(shiftIdOf(nearSecond)).toBe(second)
    expect(shiftIdOf(tie)).toBe(first)
    expect(result.touched.map((t) => t.shiftId).sort()).toEqual([first, second])
    expect(adjustments(db, first)[0].reason).toContain('the nearest of 2 shifts in their window')
  })

  it('never takes a voided sale, and never touches a sale that already has a shift', () => {
    const db = freshDb()
    const id = insertShift(db, { clockIn: '2026-10-05T18:00:00', clockOut: '2026-10-05T19:00:00', endingCash: 0 })
    const other = insertShift(db, { clockIn: '2026-10-04T18:00:00', clockOut: '2026-10-04T19:00:00', endingCash: 0 })
    const voided = sale(db, '2026-10-05T18:30:00', 100, 'cash', { status: 'voided' })
    const owned = sale(db, '2026-10-05T18:40:00', 100, 'cash', { shiftId: other })

    const result = db.autoAssignUnattachedSales(NOW)

    expect(result.touched).toEqual([])
    expect(conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(voided)).toEqual({ shift_id: null })
    expect(conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(owned)).toEqual({ shift_id: other })
    expect(adjustments(db, id)).toHaveLength(0)
  })

  it('skips a sale whose time cannot be read, and carries on with the rest', () => {
    const db = freshDb()
    const bad = sale(db, '2026-10-05T10:00:00', 100, 'cash', { createdAt: 'not a time' })
    const good = sale(db, '2026-10-05T11:00:00')

    const result = db.autoAssignUnattachedSales(NOW)

    expect(result.touched).toHaveLength(1)
    expect(conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(bad)).toEqual({ shift_id: null })
    expect((conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(good) as { shift_id: number }).shift_id).toBeGreaterThan(0)
  })

  it('is idempotent: a second run, and a third, change no row anywhere', () => {
    const db = freshDb()
    insertShift(db, { clockIn: '2026-10-05T17:43:21', clockOut: '2026-10-05T17:43:36', endingCash: 3790, type: 'day' })
    sale(db, '2026-10-05T17:35:00', 1000)
    sale(db, '2026-10-05T17:50:00', 2790)
    sale(db, '2026-10-05T10:00:00')
    sale(db, '2026-10-04T10:00:00')
    sale(db, '2026-10-06T09:30:00') // current window, waiting

    const first = db.autoAssignUnattachedSales(NOW)
    const afterFirst = snapshot(db)
    const second = db.autoAssignUnattachedSales(NOW)
    const third = db.autoAssignUnattachedSales(NOW)

    expect(first.touched.length).toBeGreaterThan(0)
    expect(second).toEqual({ touched: [], waiting: 1 })
    expect(third).toEqual({ touched: [], waiting: 1 })
    expect(snapshot(db)).toEqual(afterFirst)
  })

  it('does nothing when called while another run is in progress, and two calls back to back run one after the other', () => {
    const db = freshDb()
    sale(db, '2026-10-05T10:00:00')
    let inner: unknown
    const original = db.listUnattachedSales.bind(db)
    vi.spyOn(db, 'listUnattachedSales').mockImplementation(() => {
      inner = db.autoAssignUnattachedSales(NOW)
      return original()
    })

    const outer = db.autoAssignUnattachedSales(NOW)

    expect(inner).toEqual({ touched: [], waiting: 0, skipped: true })
    expect(outer.touched).toHaveLength(1)
    expect(snapshot(db).shifts).toBe(1)
    vi.restoreAllMocks()
    expect(db.autoAssignUnattachedSales(NOW).touched).toEqual([])
  })

  it('is all or nothing: a failure part-way writes nothing and leaves the sales as they were', () => {
    const db = freshDb()
    sale(db, '2026-10-05T10:00:00')
    sale(db, '2026-10-04T10:00:00')
    const before = snapshot(db)
    let calls = 0
    const recordAdjustment = (db as unknown as { recordAdjustment: (...args: unknown[]) => number }).recordAdjustment.bind(db)
    vi.spyOn(db as unknown as { recordAdjustment: (...args: unknown[]) => number }, 'recordAdjustment').mockImplementation((...args) => {
      calls += 1
      if (calls === 2) throw new Error('disk full')
      return recordAdjustment(...args)
    })

    expect(() => db.autoAssignUnattachedSales(NOW)).toThrow('disk full')

    expect(snapshot(db)).toEqual(before)
    vi.restoreAllMocks()
    // And the next run, with nothing wrong, does it all.
    expect(db.autoAssignUnattachedSales(NOW).touched).toHaveLength(2)
  })

  it('refuses to attach a sale that gained a shift during the run (the guarded UPDATE must match exactly one row)', () => {
    const db = freshDb()
    const id = insertShift(db, { clockIn: '2026-10-05T18:00:00', clockOut: '2026-10-05T19:00:00', endingCash: 0 })
    const other = insertShift(db, { clockIn: '2026-10-04T18:00:00', clockOut: '2026-10-04T19:00:00', endingCash: 0 })
    const contested = sale(db, '2026-10-05T18:30:00')
    // Another writer gives it a shift between the read and the write.
    const original = db.listUnattachedSales.bind(db)
    vi.spyOn(db, 'listUnattachedSales').mockImplementation(() => {
      const rows = original()
      conn(db).prepare('UPDATE orders SET shift_id = ? WHERE local_id = ?').run(other, contested)
      return rows
    })

    expect(() => db.autoAssignUnattachedSales(NOW)).toThrow(/could not be given to shift/)

    // The whole run is rolled back, including the other writer's change made inside the same transaction.
    vi.restoreAllMocks()
    expect(conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(contested)).toEqual({ shift_id: null })
    expect(adjustments(db, id)).toHaveLength(0)
    expect(snapshot(db).attached).toBe(0)
  })

  it('logs a failure to till.log as auto-assign-failed, returns a plain message and throws nothing', () => {
    const logged: string[] = []
    const failing = {
      autoAssignUnattachedSales: () => {
        throw new Error('database is locked')
      },
      autoMergeSameWindowShifts: () => ({ merged: [] }) // ADDED (docs/phase-242): the run merges first
    }

    const result = runAutoAssign(failing, (detail) => logged.push(detail), NOW)

    expect(result).toEqual({ success: false, error: 'Sales with no shift could not be given to a shift. Nothing was changed.' })
    expect(logged).toEqual(['database is locked'])
    expect(TILL_LOG_EVENTS).toContain('auto-assign-failed')
    expect([...RENDERER_TILL_EVENTS]).not.toContain('auto-assign-failed')
  })
})

describe('S6: the sales already made in the window join the shift when it opens', () => {
  const NIGHT_NOW = ms('2026-10-05T18:00:00')

  it('stores the starting cash as the drawer less the earlier cash sales, and records who joined', () => {
    const db = freshDb()
    const a = sale(db, '2026-10-05T17:40:00', 700, 'cash')
    const b = sale(db, '2026-10-05T17:50:00', 500, 'cash')
    const c = sale(db, '2026-10-05T17:55:00', 300, 'mpesa')

    const { shiftId } = db.openShift(1, 4500, 2000, { earlierShown: { count: 3, cash: 1200, mpesa: 300 } }, NIGHT_NOW)

    expect(shiftOf(db, shiftId)).toMatchObject({ starting_cash: 3300, mpesa_opening_balance: 1700, shift_type: 'night' })
    expect(conn(db).prepare('SELECT shift_id FROM orders WHERE local_id IN (?, ?, ?)').all(a, b, c)).toEqual([
      { shift_id: shiftId },
      { shift_id: shiftId },
      { shift_id: shiftId }
    ])
    expect(adjustments(db, shiftId)).toEqual([
      expect.objectContaining({
        kind: 'opening',
        by_staff_id: 1,
        sales_count: 3,
        cash_total: 1200,
        mpesa_total: 300,
        opening_drawer_cash: 4500,
        starting_cash: null,
        reason: 'Earlier sales in this window joined when the shift opened'
      })
    ])
    // Closing at the drawer count: nothing is counted twice, so the difference is 0.
    db.closeShift(shiftId, 4500)
    expect(shiftOf(db, shiftId)).toMatchObject({ expected_cash: 4500, discrepancy: 0 })
  })

  it('opens exactly as before when no earlier sale exists: float as given, no record', () => {
    const db = freshDb()

    const { shiftId } = db.openShift(1, 250, null, { earlierShown: { count: 0, cash: 0, mpesa: 0 } }, NIGHT_NOW)

    expect(shiftOf(db, shiftId)).toMatchObject({ starting_cash: 250, mpesa_opening_balance: null })
    expect(adjustments(db, shiftId)).toEqual([])
  })

  it('does not count a sale that lies inside another window\'s shift, a voided sale, or one that has a shift', () => {
    const db = freshDb()
    insertShift(db, { clockIn: '2026-10-05T16:00:00', clockOut: '2026-10-05T17:40:00', endingCash: 0, type: 'day' })
    sale(db, '2026-10-05T17:35:00', 999) // inside that shift's times
    sale(db, '2026-10-05T17:45:00', 111, 'cash', { status: 'voided' })
    sale(db, '2026-10-05T17:46:00', 222, 'cash', { shiftId: 1 })
    sale(db, '2026-10-05T17:50:00', 50)

    const { shiftId } = db.openShift(1, 200, null, {}, NIGHT_NOW)

    expect(shiftOf(db, shiftId).starting_cash).toBe(150)
  })

  it('refuses, writing nothing, when the sales are not the ones the form showed', () => {
    const db = freshDb()
    sale(db, '2026-10-05T17:40:00', 700)
    const before = snapshot(db)

    expect(() => db.openShift(1, 4500, null, { earlierShown: { count: 1, cash: 600, mpesa: 0 } }, NIGHT_NOW)).toThrow(
      'Sales were made while this form was open. Count the drawer again.'
    )
    expect(() => db.openShift(1, 4500, null, { earlierShown: { count: 0, cash: 0, mpesa: 0 } }, NIGHT_NOW)).toThrow('Count the drawer again.')
    expect(snapshot(db)).toEqual(before)
  })

  it('refuses a drawer below the earlier cash, whoever asks, and writes nothing', () => {
    const db = freshDb()
    sale(db, '2026-10-05T17:40:00', 1200)
    const before = snapshot(db)

    expect(() => db.openShift(1, 800, null, {}, NIGHT_NOW)).toThrow(
      'The drawer (Ksh 800.00) holds less than the cash sales already made in this window (Ksh 1,200.00). Count the drawer again.'
    )
    expect(snapshot(db)).toEqual(before)
  })

  it('lets an admin start at 0, and writes the choice, the drawer count and the shortfall into the opening record', () => {
    const db = freshDb()
    const id = sale(db, '2026-10-05T17:40:00', 1200)

    const { shiftId } = db.openShift(1, 800, null, { startAtZero: true }, NIGHT_NOW)

    expect(shiftOf(db, shiftId).starting_cash).toBe(0)
    expect(conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(id)).toEqual({ shift_id: shiftId })
    expect(adjustments(db, shiftId)[0]).toMatchObject({
      kind: 'opening',
      opening_drawer_cash: 800,
      reason: 'Started at 0 by an admin: the drawer (Ksh 800.00) held Ksh 400.00 less than the earlier cash sales (Ksh 1,200.00)'
    })
    // The shortage shows when the shift closes: expected 0 + 1,200, counted 800.
    db.closeShift(shiftId, 800)
    expect(shiftOf(db, shiftId)).toMatchObject({ expected_cash: 1200, discrepancy: -400 })
  })

  it('treats the M-Pesa balance the same way, and asks for a recount, or a blank, when it is below the earlier sales', () => {
    const db = freshDb()
    sale(db, '2026-10-05T17:40:00', 600, 'mpesa')
    const before = snapshot(db)

    expect(() => db.openShift(1, 0, 400, {}, NIGHT_NOW)).toThrow(
      'The M-Pesa balance (Ksh 400.00) is less than the M-Pesa sales already made in this window (Ksh 600.00). Read the balance again, or leave it blank.'
    )
    expect(snapshot(db)).toEqual(before)

    const { shiftId } = db.openShift(1, 0, null, {}, NIGHT_NOW)
    expect(shiftOf(db, shiftId).mpesa_opening_balance).toBeNull()
  })

  it('shows the same figures on the screen as the main process stores', () => {
    const preview = previewOpenFloat('4500', '2000', { count: 3, cash: 1200, mpesa: 300 })

    expect(preview).toMatchObject({ drawer: 4500, float: 3300, belowZero: false, mpesaOpening: 1700, mpesaBelowZero: false })
    expect(previewOpenFloat('800', '', { count: 3, cash: 1200, mpesa: 0 })).toMatchObject({ belowZero: true, shortfall: 400, float: 0 })
    expect(previewOpenFloat('', '', { count: 3, cash: 1200, mpesa: 0 }).float).toBeNull()
  })

  it('is refused when the window already has its shift, before anything is read for the earlier sales', () => {
    const db = freshDb()
    insertShift(db, { clockIn: '2026-10-05T17:43:21', clockOut: '2026-10-05T17:43:36', endingCash: 0 })
    sale(db, '2026-10-05T17:50:00', 500)

    expect(() => db.openShift(1, 100, null, {}, NIGHT_NOW)).toThrow('already has shift #1')
    expect(snapshot(db).attached).toBe(0)
  })
})

describe('S2: a shift cannot be closed before its window\'s last minute', () => {
  const closeAt = (db: RubisDatabase, shiftId: number, t: string) => closeShiftUnlessHeld(db, shiftId, 0, null, ms(t))

  it('allows a Day shift from 17:30:00 and not at 17:29:59', () => {
    const db = freshDb()
    const { shiftId } = db.openShift(1, 0, null, {}, ms('2026-10-05T10:00:00'))

    const early = closeAt(db, shiftId, '2026-10-05T17:29:59')
    expect(early).toEqual({ success: false, error: 'Day shift can be closed from 17:30. Selling can carry on.' })
    expect(db.getOpenShift()?.id).toBe(shiftId)

    expect(closeAt(db, shiftId, '2026-10-05T17:30:00').success).toBe(true)
  })

  it('allows a Night shift opened in the evening from 06:59:00 the next morning, and not at 06:58:59', () => {
    const db = freshDb()
    const { shiftId } = db.openShift(1, 0, null, {}, ms('2026-10-05T18:30:00'))

    expect(closeAt(db, shiftId, '2026-10-06T06:58:59').success).toBe(false)
    expect(closeAt(db, shiftId, '2026-10-06T06:59:00').success).toBe(true)
  })

  it('works a Night shift opened at 02:00 as the Night that began the evening before: closable at 06:59 the same morning', () => {
    const db = freshDb()
    const { shiftId } = db.openShift(1, 0, null, {}, ms('2026-10-06T02:00:00'))

    expect(windowClosableFrom(shiftOf(db, shiftId).clock_in)).toBe(ms('2026-10-06T06:59:00'))
    expect(closeAt(db, shiftId, '2026-10-06T06:58:59').success).toBe(false)
    expect(closeAt(db, shiftId, '2026-10-06T06:59:00').success).toBe(true)
  })

  it('lets a shift opened in its window\'s last minute close at once', () => {
    const db = freshDb()
    const { shiftId } = db.openShift(1, 0, null, {}, ms('2026-10-05T17:30:30'))

    expect(closeAt(db, shiftId, '2026-10-05T17:30:31').success).toBe(true)
  })

  it('lets a Day shift left open past 17:31 close at any time after, and keeps taking sales until then', () => {
    const db = freshDb()
    const { shiftId } = db.openShift(1, 0, null, {}, ms('2026-10-05T10:00:00'))
    const lateSale = sale(db, '2026-10-05T18:00:00', 100, 'cash', { shiftId })

    expect(closeAt(db, shiftId, '2026-10-05T20:00:00').success).toBe(true)
    expect(conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(lateSale)).toEqual({ shift_id: shiftId })
    expect(shiftWindowOf(shiftOf(db, shiftId).clock_in)).toEqual({ type: 'day', startDate: '2026-10-05' })
  })

  it('gives a sale made in the last minute after the close to that shift, with the difference showing until a correction', () => {
    const db = freshDb()
    const { shiftId } = db.openShift(1, 100, null, {}, ms('2026-10-05T10:00:00'))
    sale(db, '2026-10-05T12:00:00', 400, 'cash', { shiftId })
    closeShiftUnlessHeld(db, shiftId, 500, null, ms('2026-10-05T17:30:10'))
    sale(db, '2026-10-05T17:30:40', 50)

    db.autoAssignUnattachedSales(ms('2026-10-05T17:30:50'))

    expect(adjustments(db, shiftId)[0]).toMatchObject({ kind: 'auto', ending_cash: 500, expected_cash: 550, discrepancy: -50 })
  })

  it('leaves a missing shift to closeShift, which says so, and a closed one to say it is closed', () => {
    const db = freshDb()
    expect(closeShiftUnlessHeld(db, 99, 0, null, ms('2026-10-05T10:00:00'))).toEqual({ success: false, error: 'Shift 99 not found' })
  })

  it('reports the same time to the screens as it enforces', () => {
    const db = freshDb()
    const { shiftId } = db.openShift(1, 0, null, {}, ms('2026-10-05T10:00:00'))

    const before = getShiftWindowStatus(db, ms('2026-10-05T17:29:59'))
    const after = getShiftWindowStatus(db, ms('2026-10-05T17:30:00'))

    expect(before.openShift).toMatchObject({ id: shiftId, closeAllowed: false, closableFromIso: iso('2026-10-05T17:30:00') })
    expect(after.openShift).toMatchObject({ id: shiftId, closeAllowed: true, closeMessage: null, windowName: 'Day shift', endClock: '17:30' })
  })

  it('is enforced in the main process: the close handler goes through the guard', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
    const start = source.indexOf("'shifts:close',")
    const body = source.slice(start, source.indexOf('ipcMain.handle(', start))

    expect(body).toContain('closeShiftUnlessHeld(')
    expect(body).not.toContain('db.closeShift(')
  })
})

describe('the window status the screens read', () => {
  it('names the window, its shift, and the earlier sales an open would bring in', () => {
    const db = freshDb()
    sale(db, '2026-10-05T17:40:00', 700)
    sale(db, '2026-10-05T17:41:00', 100, 'mpesa')

    const status = getShiftWindowStatus(db, ms('2026-10-05T18:00:00'))

    expect(status.window).toMatchObject({ type: 'night', startDate: '2026-10-05', label: 'Night shift (17:31 to 06:59)' })
    expect(status.windowShift).toBeNull()
    expect(status.earlier).toEqual({ count: 2, cash: 700, mpesa: 100 })
    expect(status.openShift).toBeNull()
  })

  it('says the window already has its shift, and then no earlier sales are waiting', () => {
    const db = freshDb()
    insertShift(db, { clockIn: '2026-10-05T17:43:21', clockOut: '2026-10-05T17:43:36', endingCash: 0 })
    sale(db, '2026-10-05T17:50:00', 700)

    const status = getShiftWindowStatus(db, ms('2026-10-05T18:00:00'))

    expect(status.windowShift).toEqual({ id: 1, open: false })
    expect(status.windowShiftMessage).toBe('Night shift, 5 Oct 2026 already has shift #1. A window has one shift.')
    expect(status.earlier.count).toBe(0)
  })
})

describe('S5: an admin moves a sale to another shift', () => {
  /** Two closed counted shifts in different windows, one cash sale of 400 in the first. */
  function twoShifts() {
    const db = freshDb()
    const from = insertShift(db, { clockIn: '2026-10-05T10:00:00', clockOut: '2026-10-05T17:30:00', startingCash: 100, endingCash: 700, type: 'day' })
    const to = insertShift(db, { clockIn: '2026-10-05T18:00:00', clockOut: '2026-10-06T09:00:00', startingCash: 50, endingCash: 50, type: 'night' })
    const id = sale(db, '2026-10-05T18:30:00', 400, 'cash', { shiftId: from })
    return { db, from, to, id }
  }

  it('moves it with one guarded UPDATE, writes two records sharing who, when and why, and recalculates both shifts', () => {
    const { db, from, to, id } = twoShifts()
    const at = ms('2026-10-06T10:00:00')

    expect(db.reassignSale({ orderId: id, toShiftId: to, managerId: 7, reason: 'Rung up on the wrong shift', acknowledgeDifferentWindow: true }, at)).toEqual({
      fromShiftId: from,
      toShiftId: to
    })

    expect(conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(id)).toEqual({ shift_id: to })
    const out = adjustments(db, from)[0]
    const into = adjustments(db, to)[0]
    expect(out).toMatchObject({ kind: 'reassign_out', peer_shift_id: to, by_staff_id: 7, reason: 'Rung up on the wrong shift', sales_count: 1, cash_total: 400, at: new Date(at).toISOString() })
    expect(into).toMatchObject({ kind: 'reassign_in', peer_shift_id: from, by_staff_id: 7, reason: 'Rung up on the wrong shift', at: new Date(at).toISOString() })
    // The "from" shift loses the sale's cash from its expected figure; the "to" shift gains it. Counted cash is kept.
    expect(out).toMatchObject({ starting_cash: 100, ending_cash: 700, expected_cash: 100, discrepancy: 600 })
    expect(into).toMatchObject({ starting_cash: 50, ending_cash: 50, expected_cash: 450, discrepancy: -400 })
    expect(conn(db).prepare('SELECT order_id FROM shift_adjustment_sales WHERE adjustment_id = ?').all(out.id)).toEqual([{ order_id: id }])
  })

  it('shows what both shifts would show before anything is written, and writes nothing for the preview', () => {
    const { db, from, to, id } = twoShifts()
    const before = snapshot(db)

    const preview = db.previewSaleMove(id, to)

    expect(preview).toMatchObject({
      orderId: id,
      fromShiftId: from,
      toShiftId: to,
      problem: null,
      differentWindow: false,
      from: { expectedCash: 100, discrepancy: 600 },
      to: { expectedCash: 450, discrepancy: -400 }
    })
    expect(snapshot(db)).toEqual(before)
  })

  it('needs the tick when the sale was made in a different window from the shift it goes to', () => {
    const db = freshDb()
    const day = insertShift(db, { clockIn: '2026-10-05T10:00:00', clockOut: '2026-10-05T17:30:00', endingCash: 0, type: 'day' })
    const night = insertShift(db, { clockIn: '2026-10-05T18:00:00', clockOut: '2026-10-06T09:00:00', endingCash: 0, type: 'night' })
    const id = sale(db, '2026-10-05T11:00:00', 100, 'cash', { shiftId: day }) // a Day sale
    const before = snapshot(db)

    expect(db.previewSaleMove(id, night).differentWindow).toBe(true)
    expect(() => db.reassignSale({ orderId: id, toShiftId: night, managerId: 7, reason: 'x' })).toThrow('different window')
    expect(snapshot(db)).toEqual(before)
    expect(() => db.reassignSale({ orderId: id, toShiftId: night, managerId: 7, reason: 'x', acknowledgeDifferentWindow: true })).not.toThrow()
  })

  it('does not need the tick for a sale inside the target shift\'s own times', () => {
    const db = freshDb()
    const a = insertShift(db, { clockIn: '2026-10-05T10:00:00', clockOut: '2026-10-05T12:00:00', endingCash: 0, type: 'day' })
    const b = insertShift(db, { clockIn: '2026-10-05T16:00:00', clockOut: '2026-10-05T20:00:00', endingCash: 0, type: 'day' })
    const id = sale(db, '2026-10-05T18:30:00', 100, 'cash', { shiftId: a }) // Night window, inside shift b

    expect(db.previewSaleMove(id, b).differentWindow).toBe(false)
  })

  it('refuses a missing sale, a voided one, one with no shift, the same shift, a missing shift, and a blank reason; nothing is written', () => {
    const { db, from, to, id } = twoShifts()
    const voided = sale(db, '2026-10-05T18:31:00', 10, 'cash', { shiftId: from, status: 'voided' })
    const unattached = sale(db, '2026-10-05T18:32:00', 10)
    const before = snapshot(db)
    const move = (orderId: number, toShiftId: number, reason = 'because') =>
      db.reassignSale({ orderId, toShiftId, managerId: 7, reason, acknowledgeDifferentWindow: true })

    expect(() => move(999, to)).toThrow('Order #999 does not exist')
    expect(() => move(voided, to)).toThrow(`Order #${voided} was voided`)
    expect(() => move(unattached, to)).toThrow('has no shift')
    expect(() => move(id, from)).toThrow(`already in shift #${from}`)
    expect(() => move(id, 999)).toThrow('Shift 999 not found')
    expect(() => move(id, to, '   ')).toThrow('A reason is required to move a sale')
    expect(snapshot(db)).toEqual(before)
  })

  it('run twice changes nothing the second time: the sale is already there', () => {
    const { db, to, id } = twoShifts()
    db.reassignSale({ orderId: id, toShiftId: to, managerId: 7, reason: 'once', acknowledgeDifferentWindow: true })
    const after = snapshot(db)

    expect(() => db.reassignSale({ orderId: id, toShiftId: to, managerId: 7, reason: 'twice', acknowledgeDifferentWindow: true })).toThrow(`already in shift #${to}`)
    expect(snapshot(db)).toEqual(after)
  })

  it('is all or nothing: a failure while recording leaves the sale where it was', () => {
    const { db, from, to, id } = twoShifts()
    const before = snapshot(db)
    vi.spyOn(db as unknown as { recordAdjustment: (...args: unknown[]) => number }, 'recordAdjustment').mockImplementation(() => {
      throw new Error('disk full')
    })

    expect(() => db.reassignSale({ orderId: id, toShiftId: to, managerId: 7, reason: 'x', acknowledgeDifferentWindow: true })).toThrow('disk full')

    vi.restoreAllMocks()
    expect(conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(id)).toEqual({ shift_id: from })
    expect(snapshot(db)).toEqual(before)
  })

  it('is the only way a sale leaves a shift: automatic assignment never moves one', () => {
    const { db, from, id } = twoShifts()
    db.autoAssignUnattachedSales(ms('2026-10-07T10:00:00'))

    expect(conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(id)).toEqual({ shift_id: from })
    expect(adjustments(db, from)).toHaveLength(0)
  })

  it('is admin-gated in the main process: the PIN is re-verified before anything is written', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
    const start = source.indexOf("'shifts:move-sale',")
    const body = source.slice(start, source.indexOf('ipcMain.handle(', start))

    expect(body).toContain('validate(moveSaleSchema')
    expect(body.indexOf('requireAdminPin(db, validation.data.managerId, validation.data.managerPin)')).toBeGreaterThan(-1)
    expect(body.indexOf('requireAdminPin(')).toBeLessThan(body.indexOf('db.reassignSale('))
  })

  it('needs a manager id and PIN, and a reason, in the request', () => {
    const base = { orderId: 1, toShiftId: 2, reason: 'because' }

    expect(moveSaleSchema.safeParse(base).success).toBe(false)
    expect(moveSaleSchema.safeParse({ ...base, managerId: 2, managerPin: '1234' }).success).toBe(true)
    expect(moveSaleSchema.safeParse({ managerId: 2, managerPin: '1234', orderId: 1, toShiftId: 2, reason: '  ' }).success).toBe(false)
  })
})

describe('the Z report with adjustments', () => {
  const settings: PrinterSettings = { interfaceName: 'tcp://x', storeName: 'RUBIS', taxRate: 0.16 }
  const printed = (db: RubisDatabase, shiftId: number): string[] => {
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
      generateZReport(db, shiftId, 0.16),
      settings
    )
    return lines
  }

  it('keeps the original figures, lists each adjustment under them, and says what the shift held at close', () => {
    const db = freshDb()
    const id = insertShift(db, { clockIn: '2026-10-05T17:43:21', clockOut: '2026-10-05T17:43:36', startingCash: 0, endingCash: 3790, type: 'day' })
    sale(db, '2026-10-05T17:35:00', 1000)
    sale(db, '2026-10-05T17:50:00', 2790)
    sale(db, '2026-10-05T17:43:30', 111, 'cash', { shiftId: id }) // a sale that was in the shift at close
    db.autoAssignUnattachedSales(ms('2026-10-06T10:00:00'))

    const report = generateZReport(db, id, 0.16)

    expect(report).toMatchObject({ shiftType: 'night', labelledAs: 'day', orderCount: 3, expectedCash: 0, endingCash: 3790, discrepancy: 3790 })
    expect(report.salesAtClose).toEqual({ orderCount: 1, totalRevenue: 111, cash: 111, mpesa: 0, card: 0 })
    expect(report.adjustments).toHaveLength(1)
    const lines = printed(db, id)
    expect(lines).toContain('Labelled Day when opened')
    expect(lines).toContain('Night shift (17:31 to 06:59)')
    expect(lines.some((l) => l.startsWith('Sales at close: 1 order,'))).toBe(true)
    expect(lines.some((l) => l.includes('joined automatically'))).toBe(true)
    expect(lines.some((l) => l.startsWith('Expected Cash:') && l.includes('3,901.00'))).toBe(true)
    // Original close figures first, then the record: the first "Discrepancy" is the original.
    expect(lines.findIndex((l) => l.startsWith('Discrepancy:'))).toBeLessThan(lines.findIndex((l) => l.includes('joined automatically')))
  })

  it('counts a sale moved out as part of what the shift held at close, and one moved in as not', () => {
    const db = freshDb()
    const a = insertShift(db, { clockIn: '2026-10-05T10:00:00', clockOut: '2026-10-05T17:30:00', startingCash: 0, endingCash: 500, type: 'day' })
    const b = insertShift(db, { clockIn: '2026-10-05T18:00:00', clockOut: '2026-10-06T09:00:00', startingCash: 0, endingCash: 0, type: 'night' })
    const moved = sale(db, '2026-10-05T12:00:00', 300, 'cash', { shiftId: a })
    sale(db, '2026-10-05T13:00:00', 200, 'cash', { shiftId: a })
    db.reassignSale({ orderId: moved, toShiftId: b, managerId: 7, reason: 'x', acknowledgeDifferentWindow: true })

    expect(generateZReport(db, a, 0.16).salesAtClose).toMatchObject({ orderCount: 2, totalRevenue: 500 })
    expect(generateZReport(db, a, 0.16).orderCount).toBe(1)
    expect(generateZReport(db, b, 0.16).salesAtClose).toMatchObject({ orderCount: 0, totalRevenue: 0 })
    expect(generateZReport(db, b, 0.16).orderCount).toBe(1)
  })

  it('does not count a sale that joined at opening as added later, and omits the line when nothing changed', () => {
    const db = freshDb()
    sale(db, '2026-10-05T17:40:00', 700)
    const { shiftId } = db.openShift(1, 1000, null, {}, ms('2026-10-05T18:00:00'))
    closeShiftUnlessHeld(db, shiftId, 1000, null, ms('2026-10-06T09:00:00'))

    const report = generateZReport(db, shiftId, 0.16)

    expect(report.adjustments).toHaveLength(1)
    expect(report.salesAtClose).toBeUndefined()
  })

  it('leaves the report of a shift with no adjustments exactly as it was', () => {
    const db = freshDb()
    const { shiftId } = db.openShift(1, 100, null, {}, ms('2026-10-05T10:00:00'))

    const report = generateZReport(db, shiftId, 0.16)

    expect('adjustments' in report).toBe(false)
    expect('salesAtClose' in report).toBe(false)
    expect('labelledAs' in report).toBe(false)
    expect('createdAutomatically' in report).toBe(false)
  })

  it('says a shift was created automatically, in place of a cashier, on paper and on screen', () => {
    const db = freshDb()
    sale(db, '2026-10-05T10:00:00')
    const { touched } = db.autoAssignUnattachedSales(ms('2026-10-06T10:00:00'))
    const report = generateZReport(db, touched[0].shiftId, 0.16)
    const format = (iso: string): string => `at ${iso}`

    expect(report.createdAutomatically).toBe(true)
    expect(zReportRetroLines(report, format)).toEqual([expect.stringMatching(/^CREATED AUTOMATICALLY at /), 'Reason: Created automatically for sales with no shift'])
    expect(rendererRetroLines(report, format)).toEqual(zReportRetroLines(report, format))
    expect(printed(db, touched[0].shiftId).some((l) => l.startsWith('CREATED AUTOMATICALLY'))).toBe(true)
  })

  it('words every record the same in the renderer twin, merged with the corrections by time', () => {
    const db = freshDb()
    const id = insertShift(db, { clockIn: '2026-10-05T17:43:21', clockOut: '2026-10-05T17:43:36', startingCash: 0, endingCash: 3790, type: 'day' })
    sale(db, '2026-10-05T17:50:00', 2790)
    db.autoAssignUnattachedSales(ms('2026-10-06T10:00:00'))
    db.addShiftCorrection({ shiftId: id, managerId: 2, reason: 'recount', startingCash: 0, endingCash: 2800, mpesaOpeningBalance: null, mpesaClosingBalance: null }, ms('2026-10-06T11:00:00'))
    const report = generateZReport(db, id, 0.16)
    const money = (n: number): string => `K${n}`
    const when = (iso: string): string => iso

    expect(rendererBlocks(report, money, when)).toEqual(zReportAdjustmentBlocks(report, money, when))
    expect(rendererChangeBlocks(report, money, when)).toEqual(zReportChangeBlocks(report, money, when))
    expect(rendererLabelled(report)).toBe(zReportLabelledLine(report))
    expect(rendererAtClose(report, money)).toBe(zReportSalesAtCloseLine(report, money))
    // Oldest first: the addition, then the correction.
    const headings = zReportChangeBlocks(report, money, when).map((block) => block.heading)
    expect(headings).toHaveLength(2)
    expect(headings[0]).toContain('joined automatically')
    expect(headings[1]).toMatch(/^Corrected on /)
  })
})

describe('corrections and adjustments in one shift: the newest record wins', () => {
  it('works an addition after a correction from the correction\'s figures', () => {
    const db = freshDb()
    const id = insertShift(db, { clockIn: '2026-10-05T17:43:21', clockOut: '2026-10-05T17:43:36', startingCash: 0, endingCash: 3790, type: 'night' })
    db.addShiftCorrection({ shiftId: id, managerId: 2, reason: 'recount', startingCash: 100, endingCash: 4000, mpesaOpeningBalance: null, mpesaClosingBalance: null }, ms('2026-10-05T22:00:00'))
    sale(db, '2026-10-05T17:50:00', 3900)

    db.autoAssignUnattachedSales(ms('2026-10-06T10:00:00'))

    expect(adjustments(db, id)[0]).toMatchObject({ starting_cash: 100, ending_cash: 4000, expected_cash: 4000, discrepancy: 0 })
  })

  it('works a correction after an addition from the live sales, so it includes the added ones', () => {
    const db = freshDb()
    const id = insertShift(db, { clockIn: '2026-10-05T17:43:21', clockOut: '2026-10-05T17:43:36', startingCash: 0, endingCash: 3790, type: 'night' })
    sale(db, '2026-10-05T17:50:00', 3790)
    db.autoAssignUnattachedSales(ms('2026-10-06T10:00:00'))

    const correction = db.addShiftCorrection({ shiftId: id, managerId: 2, reason: 'recount', startingCash: 0, endingCash: 3800, mpesaOpeningBalance: null, mpesaClosingBalance: null }, ms('2026-10-06T11:00:00'))

    expect(correction).toMatchObject({ expected_cash: 3790, discrepancy: 10 })
  })

  it('stamps every record after the newest one on that shift, even if the clock was set back', () => {
    const db = freshDb()
    const id = insertShift(db, { clockIn: '2026-10-05T17:43:21', clockOut: '2026-10-05T17:43:36', endingCash: 100, type: 'night' })
    sale(db, '2026-10-05T17:50:00', 10)
    db.autoAssignUnattachedSales(ms('2026-10-06T10:00:00'))
    const adjustmentAt = adjustments(db, id)[0].at

    const correction = db.addShiftCorrection({ shiftId: id, managerId: 2, reason: 'clock was wrong', startingCash: 0, endingCash: 90, mpesaOpeningBalance: null, mpesaClosingBalance: null }, ms('2026-10-05T09:00:00'))

    expect(Date.parse(correction.corrected_at)).toBe(Date.parse(adjustmentAt) + 1)
  })
})

describe('S10: the combined window report', () => {
  it('lists every shift of an older pair, sums the sales and the differences, and never the cash that carries over', () => {
    const db = freshDb()
    const a = insertShift(db, { clockIn: '2026-10-05T18:00:00', clockOut: '2026-10-05T19:00:00', startingCash: 100, expectedCash: 600, endingCash: 600, type: 'night' })
    const b = insertShift(db, { clockIn: '2026-10-05T19:30:00', clockOut: '2026-10-05T20:30:00', startingCash: 600, expectedCash: 900, endingCash: 900, type: 'night' })
    sale(db, '2026-10-05T18:30:00', 500, 'cash', { shiftId: a })
    sale(db, '2026-10-05T20:00:00', 300, 'cash', { shiftId: b })
    sale(db, '2026-10-05T20:10:00', 100, 'mpesa', { shiftId: b })
    const other = insertShift(db, { clockIn: '2026-10-06T10:00:00', clockOut: '2026-10-06T17:30:00', endingCash: 0, type: 'day' })
    expect(other).toBeGreaterThan(b)

    const report = generateWindowReport(db, 0.16, 'night', '2026-10-05')

    expect(report.window.name).toBe('Night shift, 5 Oct 2026')
    expect(report.shifts.map((s) => s.report.shiftId)).toEqual([a, b])
    expect(report.totals).toMatchObject({ orderCount: 3, totalRevenue: 900, differenceSum: 0, notCountedShifts: 0 })
    expect(report.totals.byMethod).toEqual({ cash: 800, mpesa: 100, card: 0 })
    expect('startingCash' in report.totals).toBe(false)
    expect('expectedCash' in report.totals).toBe(false)
  })

  it('counts a shift whose cash was not counted apart, with no difference', () => {
    const db = freshDb()
    insertShift(db, { clockIn: '2026-10-05T18:00:00', clockOut: '2026-10-05T19:00:00', startingCash: 0, endingCash: 100, type: 'night' })
    insertShift(db, { clockIn: '2026-10-05T19:30:00', clockOut: '2026-10-05T20:30:00', notCounted: true, type: 'night' })

    const report = generateWindowReport(db, 0.16, 'night', '2026-10-05')

    expect(report.shifts.map((s) => s.difference)).toEqual([100, null])
    expect(report.totals).toMatchObject({ differenceSum: 100, notCountedShifts: 1 })
  })

  it('uses the newest record\'s difference for a shift that was adjusted', () => {
    const db = freshDb()
    insertShift(db, { clockIn: '2026-10-05T17:43:21', clockOut: '2026-10-05T17:43:36', startingCash: 0, endingCash: 3790, type: 'day' })
    sale(db, '2026-10-05T17:50:00', 3790)
    db.autoAssignUnattachedSales(ms('2026-10-06T10:00:00'))

    const report = generateWindowReport(db, 0.16, 'night', '2026-10-05')

    expect(report.shifts[0].difference).toBe(0)
  })
})

describe('the handlers and triggers in main/index.ts', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
  const body = (channel: string): string => {
    const start = source.indexOf(`'${channel}',`)
    return source.slice(start, source.indexOf('ipcMain.handle(', start))
  }

  it('gives sales to their shifts when the app starts, before Open Shift, and after Close Shift succeeds', () => {
    expect(source).toMatch(/db\.init\(\)[\s\S]{0,700}assignSalesToShifts\(\)/)
    expect(body('shifts:open')).toMatch(/assignSalesToShifts\(\)[\s\S]*openShiftChecked\(db, validation\.data\)/)
    expect(body('shifts:close')).toMatch(/closeShiftUnlessHeld\([\s\S]*if \(closed\.success\) assignSalesToShifts\(\)/)
  })

  it('writes a failure of the run to till.log, through the one wrapper', () => {
    expect(source).toContain("runAutoAssign(db, (detail) => tillLog.record('auto-assign-failed', detail))")
    expect(body('shifts:auto-assign')).toContain('runAutoAssign(db')
  })

  it('no longer has the manual past-shift handlers, and never writes orders from a read', () => {
    expect(source).not.toContain("'shifts:create-past'")
    expect(source).not.toContain("'shifts:unattached-days'")
    expect(source).not.toContain("'shifts:past-preview'")
    expect(body('shifts:window-status')).not.toContain('autoAssign')
  })

  it('leaves checkout alone: the open shift is read, not required, and selling is never refused', () => {
    const checkout = readFileSync(join(process.cwd(), 'src', 'main', 'services', 'checkout.ts'), 'utf8')

    expect(checkout).toContain('const openShift = db.getOpenShift()')
    expect(checkout).toContain('shiftId: openShift?.id')
    expect(checkout).not.toContain('autoAssign')
  })

  it('only ever writes shift_id on orders, and only from NULL (automatic) or from the shift it was read in (a move)', () => {
    const database = readFileSync(join(process.cwd(), 'src', 'main', 'services', 'database.ts'), 'utf8')
    const updates = database.split('UPDATE orders SET shift_id = ?').slice(1).map((rest) => rest.slice(0, 120))

    expect(updates.length).toBeGreaterThanOrEqual(2)
    for (const update of updates) {
      expect(update).toMatch(/^ WHERE local_id = \? AND (shift_id IS NULL|shift_id = \?) AND status <> 'voided'/)
    }
  })
})

describe('merging two shifts of one window (docs/phase-239)', () => {
  /** Two closed, counted shifts in the Night of 5 Oct: #a opened 17:43 (two sales, one voided), #b opened 20:50 (one sale). */
  function twoNightShifts() {
    const db = freshDb()
    const a = insertShift(db, { clockIn: '2026-10-05T17:43:00', clockOut: '2026-10-05T17:44:00', startingCash: 0, endingCash: 500, type: 'day' })
    const b = insertShift(db, { clockIn: '2026-10-05T20:50:00', clockOut: '2026-10-06T06:59:00', startingCash: 500, endingCash: 900, type: 'night' })
    const s1 = sale(db, '2026-10-05T17:43:10', 300, 'cash', { shiftId: a })
    const s2 = sale(db, '2026-10-05T17:43:20', 200, 'mpesa', { shiftId: a })
    const voided = sale(db, '2026-10-05T17:43:30', 50, 'cash', { shiftId: a, status: 'voided' })
    const s3 = sale(db, '2026-10-05T21:00:00', 400, 'cash', { shiftId: b })
    return { db, a, b, s1, s2, s3, voided }
  }
  const merges = (db: RubisDatabase): number => count(db, 'shift_merges')
  const shiftOfOrder = (db: RubisDatabase, id: number): number | null =>
    (conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(id) as { shift_id: number | null }).shift_id

  it('previews what moves and what the survivor would show, writing nothing', () => {
    const { db, a, b } = twoNightShifts()
    const before = snapshot(db)

    const preview = db.previewShiftMerge(a, b)

    // Two live sales (the voided one stays out); the survivor keeps its float 500 and count 900, so expected becomes
    // 500 + 400 + 300 = 1,200 and the difference 900 - 1,200.
    expect(preview).toMatchObject({ absorbedShiftId: a, intoShiftId: b, salesCount: 2, salesTotal: 500, problem: null })
    expect(preview.into).toMatchObject({ expectedCash: 1200, discrepancy: -300 })
    expect(snapshot(db)).toEqual(before)
    expect(merges(db)).toBe(0)
  })

  it('moves every live sale with the guarded UPDATE, writes one record on each shift and one merge row, and recalculates the survivor', () => {
    const { db, a, b, s1, s2, s3, voided } = twoNightShifts()
    const at = ms('2026-10-06T10:00:00')

    expect(db.mergeShifts({ absorbedShiftId: a, intoShiftId: b, managerId: 7, reason: 'Opened twice by mistake' }, at)).toEqual({
      absorbedShiftId: a,
      intoShiftId: b,
      salesCount: 2
    })

    expect([s1, s2, s3].map((id) => shiftOfOrder(db, id))).toEqual([b, b, b])
    expect(shiftOfOrder(db, voided)).toBe(a)
    const out = adjustments(db, a)[0]
    const into = adjustments(db, b)[0]
    const reason = `Merged shift #${a} into shift #${b}: Opened twice by mistake`
    expect(out).toMatchObject({ kind: 'reassign_out', peer_shift_id: b, by_staff_id: 7, reason, sales_count: 2, cash_total: 300, mpesa_total: 200 })
    expect(out).toMatchObject({ starting_cash: 0, ending_cash: 500, expected_cash: 0, discrepancy: 500 })
    expect(into).toMatchObject({ kind: 'reassign_in', peer_shift_id: a, by_staff_id: 7, reason, sales_count: 2 })
    expect(into).toMatchObject({ starting_cash: 500, ending_cash: 900, expected_cash: 1200, discrepancy: -300 })
    expect(db.getShiftMerge(a)).toMatchObject({ into_shift_id: b, by_staff_id: 7, reason: 'Opened twice by mistake', sales_count: 2, at: new Date(at).toISOString() })
    expect(db.getShiftMerge(b)).toBeUndefined()
    // The absorbed shift's own row is untouched.
    expect(shiftOf(db, a)).toMatchObject({ status: 'closed', starting_cash: 0, ending_cash: 500 })
    // The history names the merge; the Z reports say so.
    const rows = db.listShifts(10, 0)
    expect(rows.find((row) => row.id === a)?.merged_into).toBe(b)
    expect(rows.find((row) => row.id === b)?.merged_into).toBeNull()
    const report = generateZReport(db, a, 0.16)
    expect(report.mergedInto).toMatchObject({ shiftId: b, reason: 'Opened twice by mistake', at: new Date(at).toISOString() })
    expect(report.orderCount).toBe(0)
    expect(generateZReport(db, b, 0.16).orderCount).toBe(3)
  })

  it('refuses itself, a missing shift, different windows, an open absorbed shift, a merged shift and a blank reason, and writes nothing', () => {
    const { db, a, b } = twoNightShifts()
    const open = insertShift(db, { clockIn: '2026-10-05T22:00:00', clockOut: null, type: 'night' })
    const day = insertShift(db, { clockIn: '2026-10-05T10:00:00', clockOut: '2026-10-05T12:00:00', endingCash: 0, type: 'day' })
    const before = snapshot(db)

    expect(db.previewShiftMerge(a, a).problem).toMatch(/into itself/)
    expect(db.previewShiftMerge(a, 999).problem).toMatch(/#999 does not exist/)
    expect(db.previewShiftMerge(999, b).problem).toMatch(/#999 does not exist/)
    expect(db.previewShiftMerge(open, b).problem).toMatch(/still open/)
    expect(db.previewShiftMerge(day, b).problem).toMatch(/different windows/)
    expect(() => db.mergeShifts({ absorbedShiftId: day, intoShiftId: b, managerId: 7, reason: 'x' })).toThrow(/different windows/)
    expect(() => db.mergeShifts({ absorbedShiftId: a, intoShiftId: b, managerId: 7, reason: '   ' })).toThrow(/reason/)
    expect(snapshot(db)).toEqual(before)
    expect(merges(db)).toBe(0)

    db.mergeShifts({ absorbedShiftId: a, intoShiftId: b, managerId: 7, reason: 'once' })
    expect(db.previewShiftMerge(a, b).problem).toMatch(/already merged/)
    expect(db.previewShiftMerge(b, a).problem).toMatch(/was merged into another shift/)
    expect(() => db.mergeShifts({ absorbedShiftId: a, intoShiftId: b, managerId: 7, reason: 'twice' })).toThrow(/already merged/)
    expect(merges(db)).toBe(1)
  })

  it('the merge table is append-only', () => {
    const { db, a, b } = twoNightShifts()
    db.mergeShifts({ absorbedShiftId: a, intoShiftId: b, managerId: 7, reason: 'once' })

    expect(() => conn(db).prepare('UPDATE shift_merges SET reason = ? WHERE absorbed_shift_id = ?').run('x', a)).toThrow(/append-only/)
    expect(() => conn(db).prepare('DELETE FROM shift_merges WHERE absorbed_shift_id = ?').run(a)).toThrow(/append-only/)
  })

  it('a shift with no sales can still be merged: the record says 0 sales', () => {
    const db = freshDb()
    const a = insertShift(db, { clockIn: '2026-10-05T17:43:00', clockOut: '2026-10-05T17:44:00', endingCash: 0, type: 'night' })
    const b = insertShift(db, { clockIn: '2026-10-05T20:50:00', clockOut: '2026-10-06T06:59:00', endingCash: 0, type: 'night' })

    expect(db.mergeShifts({ absorbedShiftId: a, intoShiftId: b, managerId: 7, reason: 'empty' }).salesCount).toBe(0)
    expect(db.getShiftMerge(a)?.sales_count).toBe(0)
    expect(adjustments(db, b)[0]).toMatchObject({ kind: 'reassign_in', sales_count: 0 })
  })

  it('the merged line is the same on paper and on screen, and absent for every other shift', () => {
    const { db, a, b } = twoNightShifts()
    db.mergeShifts({ absorbedShiftId: a, intoShiftId: b, managerId: 7, reason: 'Opened twice' }, ms('2026-10-06T10:00:00'))
    const when = (iso: string): string => iso
    const absorbed = generateZReport(db, a, 0.16)
    const survivor = generateZReport(db, b, 0.16)

    const line = zReportMergedLine(absorbed, when)
    expect(line).toBe(`Merged into shift #${b} on ${absorbed.mergedInto?.at} by Unknown: Opened twice. Its sales are counted there now.`)
    expect(rendererMerged(absorbed, when)).toBe(line)
    expect(zReportMergedLine(survivor, when)).toBeNull()
    expect(rendererMerged(survivor, when)).toBeNull()

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
      absorbed,
      { interfaceName: 'tcp://x', storeName: 'RUBIS', taxRate: 0.16 } as PrinterSettings
    )
    expect(lines.some((text) => text.startsWith(`Merged into shift #${b} on `))).toBe(true)
  })

  it('the handler re-verifies the admin PIN and the preview is a plain read', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
    const body = (channel: string): string => {
      const start = source.indexOf(`'${channel}',`)
      return source.slice(start, source.indexOf('ipcMain.handle(', start))
    }
    expect(body('shifts:merge')).toMatch(/requireAdminPin\(db, validation\.data\.managerId, validation\.data\.managerPin\)[\s\S]*db\.mergeShifts\(/)
    expect(body('shifts:merge-preview')).toContain('db.previewShiftMerge(')
    expect(body('shifts:merge-preview')).not.toContain('mergeShifts(')
  })
})
