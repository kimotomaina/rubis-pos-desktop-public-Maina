/**
 * A window with more than one shift is merged into one by the till itself (docs/phase-242): the shift that holds the
 * window is the open one, or else the one opened last; the others are absorbed into it with the same record a merge
 * by hand leaves, made by the till. Real in-memory SQLite.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import { runAutoAssign } from '../src/main/services/auto-assign.js'
import { generateZReport } from '../src/main/services/reports.js'
import { getShiftWindowStatus } from '../src/main/services/shift-window-status.js'
import { zReportAdjustmentBlocks } from '../src/main/lib/zReportAdjustments.js'

const ms = (t: string): number => Date.parse(`${t}+03:00`)
const iso = (t: string): string => new Date(ms(t)).toISOString()
const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn
const count = (db: RubisDatabase, table: string): number =>
  (conn(db).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const snapshot = (db: RubisDatabase): Record<string, number> => ({
  shifts: count(db, 'shifts'),
  merges: count(db, 'shift_merges'),
  adjustments: count(db, 'shift_adjustments'),
  adjustmentSales: count(db, 'shift_adjustment_sales'),
  inShift: (conn(db).prepare('SELECT COUNT(*) AS n FROM orders WHERE shift_id IS NOT NULL').get() as { n: number }).n
})
const shiftIdOf = (db: RubisDatabase, orderId: number): number | null =>
  (conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(orderId) as { shift_id: number | null }).shift_id

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

function shift(
  db: RubisDatabase,
  inn: string,
  out: string | null,
  v: { start?: number; ending?: number; type?: 'day' | 'night' } = {}
): number {
  return Number(
    conn(db)
      .prepare(
        `INSERT INTO shifts (staff_id, clock_in, clock_out, starting_cash, expected_cash, ending_cash, discrepancy, status, shift_type)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        iso(inn),
        out ? iso(out) : null,
        v.start ?? 0,
        out ? (v.start ?? 0) : null,
        out ? (v.ending ?? 0) : null,
        out ? (v.ending ?? 0) - (v.start ?? 0) : null,
        out ? 'closed' : 'open',
        v.type ?? 'night'
      ).lastInsertRowid
  )
}

function sale(db: RubisDatabase, at: string, total: number, shiftId: number | null, method = 'cash', status = 'synced'): number {
  return Number(
    conn(db)
      .prepare('INSERT INTO orders (total, status, created_at, payload_json, staff_id, payment_method, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(total, status, iso(at), '{}', 1, method, shiftId).lastInsertRowid
  )
}

/** The live case: #1 opened 17:43 and closed 15 seconds later, #2 opened 20:50 and is still open, both the Night of 5 Oct. */
function livePair() {
  const db = freshDb()
  const first = shift(db, '2026-10-05T17:43:21', '2026-10-05T17:43:36', { start: 0, ending: 3790, type: 'day' })
  const second = shift(db, '2026-10-05T20:50:00', null, { start: 3790 })
  const a = sale(db, '2026-10-05T17:35:00', 1000, first)
  const b = sale(db, '2026-10-05T17:50:00', 2790, first)
  const voided = sale(db, '2026-10-05T18:00:00', 50, first, 'cash', 'voided')
  const c = sale(db, '2026-10-05T21:00:00', 300, second)
  return { db, first, second, a, b, voided, c }
}

const NOW = ms('2026-10-06T10:00:00')

describe('the merge the till makes by itself', () => {
  it('merges an older closed shift into the open shift of the window: the open one holds the window', () => {
    const { db, first, second, a, b, voided, c } = livePair()

    const result = db.autoMergeSameWindowShifts(NOW)

    expect(result.merged).toEqual([{ absorbedShiftId: first, intoShiftId: second, salesCount: 2 }])
    expect([a, b, c].map((id) => shiftIdOf(db, id))).toEqual([second, second, second])
    expect(shiftIdOf(db, voided)).toBe(first) // a voided sale stays where it was
  })

  it('writes the same record a merge by hand does, made by the till: a merge row and an adjustment on each shift', () => {
    const { db, first, second } = livePair()

    db.autoMergeSameWindowShifts(NOW)

    expect(conn(db).prepare('SELECT * FROM shift_merges').all()).toEqual([
      expect.objectContaining({
        absorbed_shift_id: first,
        into_shift_id: second,
        by_staff_id: 0,
        reason: 'Merged automatically: a window has one shift',
        sales_count: 2,
        at: new Date(NOW).toISOString()
      })
    ])
    const out = db.listShiftAdjustments(first).find((r) => r.kind === 'reassign_out')
    const into = db.listShiftAdjustments(second).find((r) => r.kind === 'reassign_in')
    expect(out).toMatchObject({ by_staff_id: null, peer_shift_id: second, sales_count: 2, cash_total: 3790 })
    expect(into).toMatchObject({ by_staff_id: null, peer_shift_id: first, sales_count: 2 })
    expect(into?.reason).toBe(`Merged shift #${first} into shift #${second}: Merged automatically: a window has one shift`)
  })

  it('leaves both shift rows exactly as they were', () => {
    const { db, first, second } = livePair()
    const before = [first, second].map((id) => conn(db).prepare('SELECT * FROM shifts WHERE id = ?').get(id))

    db.autoMergeSameWindowShifts(NOW)

    expect([first, second].map((id) => conn(db).prepare('SELECT * FROM shifts WHERE id = ?').get(id))).toEqual(before)
  })

  it('keeps the surviving shift\'s own float and count, as a merge by hand does: its expected cash is its float plus every cash sale it holds', () => {
    const { db, second } = livePair()

    db.autoMergeSameWindowShifts(NOW)

    // 3,790 float + 1,000 + 2,790 moved in + 300 of its own. A float that already held the first shift's cash is counted twice
    // here: that is the rule the owner ruled in phase 239 and it is not changed.
    const adjustment = db.listShiftAdjustments(second).find((r) => r.kind === 'reassign_in')
    const report = generateZReport(db, second, 0.16)
    expect(report.orderCount).toBe(3)
    expect(report.totalsByMethod.cash).toBe(4090)
    expect(adjustment?.sales_count).toBe(2)
    expect(report.expectedCash).toBe(3790 + 4090)
  })

  it('makes the latest shift hold the window when all are closed, and absorbs the others earliest first', () => {
    const db = freshDb()
    const a = shift(db, '2026-10-03T18:00:00', '2026-10-03T18:10:00', { ending: 10 })
    const b = shift(db, '2026-10-03T19:00:00', '2026-10-03T19:10:00', { ending: 20 })
    const c = shift(db, '2026-10-03T21:00:00', '2026-10-03T22:00:00', { ending: 30 })
    sale(db, '2026-10-03T18:05:00', 10, a)
    sale(db, '2026-10-03T19:05:00', 20, b)

    const result = db.autoMergeSameWindowShifts(NOW)

    expect(result.merged.map((m) => [m.absorbedShiftId, m.intoShiftId])).toEqual([
      [a, c],
      [b, c]
    ])
    expect(generateZReport(db, c, 0.16).orderCount).toBe(2)
    expect(generateZReport(db, a, 0.16).orderCount).toBe(0)
  })

  it('leaves a window with one shift, and shifts of different windows, alone', () => {
    const db = freshDb()
    shift(db, '2026-10-05T10:00:00', '2026-10-05T17:30:00', { type: 'day' })
    shift(db, '2026-10-05T18:00:00', '2026-10-06T08:00:00')
    shift(db, '2026-10-06T10:00:00', '2026-10-06T17:30:00', { type: 'day' })
    const before = snapshot(db)

    expect(db.autoMergeSameWindowShifts(NOW).merged).toEqual([])
    expect(snapshot(db)).toEqual(before)
  })

  it('does nothing for a window with two open shifts, and carries on with the others', () => {
    const db = freshDb()
    shift(db, '2026-10-05T18:00:00', null)
    shift(db, '2026-10-05T19:00:00', null)
    const d1 = shift(db, '2026-10-04T18:00:00', '2026-10-04T18:10:00')
    const d2 = shift(db, '2026-10-04T19:00:00', '2026-10-04T19:10:00')

    const result = db.autoMergeSameWindowShifts(NOW)

    expect(result.merged.map((m) => [m.absorbedShiftId, m.intoShiftId])).toEqual([[d1, d2]])
    expect(count(db, 'shift_merges')).toBe(1)
  })

  it('does not merge again what was merged by hand, and a second and third run change nothing', () => {
    const { db, first, second } = livePair()
    db.mergeShifts({ absorbedShiftId: first, intoShiftId: second, managerId: 2, reason: 'by hand' }, NOW)
    const afterHand = snapshot(db)

    expect(db.autoMergeSameWindowShifts(NOW).merged).toEqual([])
    expect(snapshot(db)).toEqual(afterHand)

    const fresh = livePair()
    fresh.db.autoMergeSameWindowShifts(NOW)
    const afterFirst = snapshot(fresh.db)
    expect(fresh.db.autoMergeSameWindowShifts(NOW).merged).toEqual([])
    expect(fresh.db.autoMergeSameWindowShifts(NOW).merged).toEqual([])
    expect(snapshot(fresh.db)).toEqual(afterFirst)
  })

  it('is all or nothing: a failure while recording leaves every sale and shift as it was', () => {
    const { db } = livePair()
    const before = snapshot(db)
    vi.spyOn(db as unknown as { recordAdjustment: (...a: unknown[]) => number }, 'recordAdjustment').mockImplementation(() => {
      throw new Error('disk full')
    })

    expect(() => db.autoMergeSameWindowShifts(NOW)).toThrow('disk full')

    vi.restoreAllMocks()
    expect(snapshot(db)).toEqual(before)
    expect(db.autoMergeSameWindowShifts(NOW).merged).toHaveLength(1)
  })

  it('does nothing when called while another run is in progress', () => {
    const { db } = livePair()
    let inner: unknown
    const original = db.listAbsorbedShiftIds.bind(db)
    vi.spyOn(db, 'listAbsorbedShiftIds').mockImplementation(() => {
      inner = db.autoMergeSameWindowShifts(NOW)
      return original()
    })

    const outer = db.autoMergeSameWindowShifts(NOW)

    expect(inner).toEqual({ merged: [], skipped: true })
    expect(outer.merged).toHaveLength(1)
    vi.restoreAllMocks()
  })
})

describe('after a merge the window is one shift', () => {
  it('never gives a sale to the absorbed shift: not by its times, not as the nearest', () => {
    const { db, first, second } = livePair()
    db.autoMergeSameWindowShifts(NOW)
    const inside = sale(db, '2026-10-05T17:43:30', 11, null) // inside the absorbed shift's own times
    const near = sale(db, '2026-10-05T17:45:00', 12, null) // nearest to the absorbed shift

    db.autoAssignUnattachedSales(NOW)

    expect(shiftIdOf(db, inside)).toBe(second)
    expect(shiftIdOf(db, near)).toBe(second)
    expect(db.listShiftAdjustments(first).filter((r) => r.kind === 'auto')).toEqual([])
  })

  it('names the shift that holds the window, not the absorbed one, when a new shift is refused', () => {
    const db = freshDb()
    const a = shift(db, '2026-10-05T17:43:21', '2026-10-05T17:43:36')
    const b = shift(db, '2026-10-05T20:50:00', '2026-10-05T22:00:00')
    db.autoMergeSameWindowShifts(NOW)

    expect(() => db.openShift(1, 0, null, {}, ms('2026-10-05T23:00:00'))).toThrow(`already has shift #${b}.`)
    expect(a).toBeLessThan(b)
    const status = getShiftWindowStatus(db, ms('2026-10-05T23:00:00'))
    expect(status.windowShift).toEqual({ id: b, open: false })
    expect(status.windowShiftMessage).toContain(`shift #${b}`)
  })

  it('shows the window once in Shift History, with the absorbed shift named on the one that holds it', () => {
    const { db, first, second } = livePair()
    shift(db, '2026-10-04T10:00:00', '2026-10-04T17:30:00', { type: 'day' })
    db.autoMergeSameWindowShifts(NOW)

    const rows = db.listVisibleShifts(10, 0)

    expect(rows.map((r) => r.id)).toEqual([3, second])
    expect(rows.find((r) => r.id === second)?.absorbed_shifts).toEqual([
      { id: first, clock_in: iso('2026-10-05T17:43:21'), clock_out: iso('2026-10-05T17:43:36') }
    ])
    expect(rows.find((r) => r.id === 3)?.absorbed_shifts).toBeUndefined()
    expect(db.countVisibleShifts()).toBe(2)
    expect(db.countShifts()).toBe(3) // the absorbed shift still exists
  })

  it('pages through visible shifts only, newest first', () => {
    const db = freshDb()
    for (let day = 1; day <= 4; day++) shift(db, `2026-10-0${day}T10:00:00`, `2026-10-0${day}T17:30:00`, { type: 'day' })

    expect(db.listVisibleShifts(2, 0).map((r) => r.id)).toEqual([4, 3])
    expect(db.listVisibleShifts(2, 2).map((r) => r.id)).toEqual([2, 1])
  })

  it('says on the absorbed shift\'s Z report that the till merged it, and lists the move on the survivor', () => {
    const { db, first, second } = livePair()
    db.autoMergeSameWindowShifts(NOW)

    const absorbed = generateZReport(db, first, 0.16)
    const survivor = generateZReport(db, second, 0.16)

    expect(absorbed.mergedInto).toMatchObject({ shiftId: second, byName: 'the till' })
    expect(absorbed.orderCount).toBe(0)
    const headings = zReportAdjustmentBlocks(survivor, (n) => `K${n}`, (t) => t).map((b) => b.heading)
    expect(headings.some((h) => h.includes('the till moved') && h.includes(`from shift #${first}`))).toBe(true)
  })
})

describe('the run that merges and then gives sales their shift', () => {
  it('merges first, so the sales that follow go to the shift that holds the window; the failures are logged', () => {
    const order: string[] = []
    const db = {
      autoMergeSameWindowShifts: () => {
        order.push('merge')
        return { merged: [{ absorbedShiftId: 1, intoShiftId: 2, salesCount: 3 }] }
      },
      autoAssignUnattachedSales: () => {
        order.push('assign')
        return { touched: [], waiting: 0 }
      }
    }
    const logged: string[] = []

    const result = runAutoAssign(db, (d) => logged.push(d), NOW)

    expect(order).toEqual(['merge', 'assign'])
    expect(result).toEqual({
      success: true,
      data: { touched: [], waiting: 0, merged: [{ absorbedShiftId: 1, intoShiftId: 2, salesCount: 3 }] }
    })
    expect(logged).toEqual([])
  })

  it('logs a failed merge as auto-assign-failed and still gives the sales their shift', () => {
    const logged: string[] = []
    const db = {
      autoMergeSameWindowShifts: () => {
        throw new Error('database is locked')
      },
      autoAssignUnattachedSales: () => ({ touched: [], waiting: 2 })
    }

    const result = runAutoAssign(db, (d) => logged.push(d), NOW)

    expect(logged).toEqual(['merge: database is locked'])
    expect(result).toMatchObject({ success: true, data: { waiting: 2, merged: [] } })
  })

  it('runs at start, before Open Shift and after Close Shift through the one wrapper, and Shift History reads visible shifts', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
    const start = source.indexOf("'reports:shifts-list',")
    const body = source.slice(start, source.indexOf('ipcMain.handle(', start + 20))

    expect(source).toContain("runAutoAssign(db, (detail) => tillLog.record('auto-assign-failed', detail))")
    // CHANGED (docs/phase-243). OLD: `db.listVisibleShifts(` on one line. NEW: the handler also marks frozen shifts, so the call is
    // written over several lines: `.listVisibleShifts(`.
    expect(body).toContain('.listVisibleShifts(')
    expect(body).toContain('db.countVisibleShifts()')
    expect(body).toContain('!absorbed.has(shift.id)')
  })
})
