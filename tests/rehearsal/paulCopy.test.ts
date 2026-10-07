/**
 * Rehearsal of the repair of 5 Oct on an exported copy of the live till's database (docs/phase-244). Runs only when
 * `RUBIS_COPY_DIR` names the folder holding the copy (`rubis-pos.db`, `-shm`, `-wal`); skipped otherwise, so CI is
 * unaffected. The three files are copied to a temp folder first and the copy is never written. Through the real
 * methods with the admin override: order #85 moves from shift #1 to shift #3, then shifts #3 and #1 are corrected, and
 * the Z reports are asserted and printed as the printer lays them out.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../../src/main/services/database.js'
import { generateZReport, type ZReport } from '../../src/main/services/reports.js'
import { renderZReport, type ThermalPrinterLike } from '../../src/main/services/printer.js'
import { OVERRIDE_REASON_PREFIX } from '../../src/main/lib/shiftRules.js'

const COPY_DIR = process.env.RUBIS_COPY_DIR
const FILES = ['rubis-pos.db', 'rubis-pos.db-shm', 'rubis-pos.db-wal']
const TAX_RATE = 0.16
const MOVE_REASON = 'Belongs to the day shift of 5 Oct'

const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn

function tableCounts(connection: SqliteConnection): Record<string, number> {
  const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'sqlite_sequence' ORDER BY name").all() as Array<{ name: string }>
  return Object.fromEntries(tables.map(({ name }) => [name, (connection.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n]))
}

/** The Z report as the printer lays it out: one string per printed line. */
function printed(report: ZReport): string[] {
  const lines: string[] = []
  const sink = new Proxy({} as ThermalPrinterLike, {
    get: (_target, key) =>
      key === 'println' ? (text: string) => lines.push(String(text)) : key === 'drawLine' ? () => lines.push('-'.repeat(48)) : () => undefined
  })
  renderZReport(sink, report, { interfaceName: '', storeName: 'RUBIS', taxRate: TAX_RATE, mock: true })
  return lines
}

describe.skipIf(!COPY_DIR)('the repair of 5 Oct, rehearsed on the exported copy', () => {
  let work: string
  let db: RubisDatabase
  let adminId: number
  let before: { counts: Record<string, number>; orders: unknown[]; shift8: unknown }
  let afterFirstRun: { counts: Record<string, number>; orders: unknown[] }
  const z = (shiftId: number): ZReport => generateZReport(db, shiftId, TAX_RATE)
  const orderRows = (): unknown[] => conn(db).prepare('SELECT * FROM orders ORDER BY local_id').all()

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'rubis-copy-'))
    for (const file of FILES) {
      const source = join(COPY_DIR as string, file)
      if (existsSync(source)) copyFileSync(source, join(work, file))
    }
    const baseline = new BetterSqlite3(join(work, 'rubis-pos.db'), { readonly: true })
    before = {
      counts: tableCounts(baseline),
      orders: baseline.prepare('SELECT * FROM orders ORDER BY local_id').all(),
      shift8: baseline.prepare('SELECT * FROM shifts WHERE id = 8').get()
    }
    adminId = (baseline.prepare("SELECT id FROM staff WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1").get() as { id: number }).id
    baseline.close()

    db = new RubisDatabase({ dbPath: join(work, 'rubis-pos.db') })
    db.init()

    // The sale was made after shift #3's last second, so it is a different window from it: the tick the screen shows.
    const preview = db.previewSaleMove(85, 3, true)
    expect(preview.problem).toBeNull()
    db.reassignSale({
      orderId: 85,
      toShiftId: 3,
      managerId: adminId,
      reason: MOVE_REASON,
      acknowledgeDifferentWindow: preview.differentWindow,
      override: true
    })
    db.addShiftCorrection({ shiftId: 3, managerId: adminId, reason: 'Counted figures of the day shift of 5 Oct', startingCash: 0, endingCash: 3790, mpesaOpeningBalance: 0, mpesaClosingBalance: 19180.09, override: true })
    db.addShiftCorrection({ shiftId: 1, managerId: adminId, reason: 'Counted figures of the night shift of 5 Oct', startingCash: 0, endingCash: 5210, mpesaOpeningBalance: 0, mpesaClosingBalance: 12351.14, override: true })
    afterFirstRun = { counts: tableCounts(conn(db)), orders: orderRows() }
  })

  afterAll(() => {
    conn(db)?.close()
    rmSync(work, { recursive: true, force: true })
  })

  it('gives shift #3 the sale: 42 orders, cash 3790.00, M-Pesa 19180.09, card 280.00, and its counted figures reconcile', () => {
    const report = z(3)
    const latest = report.corrections?.[report.corrections.length - 1]

    expect(report.orderCount).toBe(42)
    expect(report.totalsByMethod.cash).toBeCloseTo(3790, 2)
    expect(report.totalsByMethod.mpesa).toBeCloseTo(19180.09, 2)
    expect(report.totalsByMethod.card).toBeCloseTo(280, 2)
    expect(report.totalRevenue).toBeCloseTo(23250.09, 2)
    expect(latest?.reason.startsWith(OVERRIDE_REASON_PREFIX)).toBe(true)
    expect(latest?.endingCash).toBe(3790)
    expect(latest?.discrepancy).toBeCloseTo(0, 2)
    expect(latest?.mpesaDifference).toBeCloseTo(0, 2)
  })

  it('leaves shift #1 the night: 59 orders, cash 4271.14, M-Pesa 13445.00, expected 4271.14, counted 5210, +938.86 and -1093.86', () => {
    const report = z(1)
    const latest = report.corrections?.[report.corrections.length - 1]

    expect(report.orderCount).toBe(59)
    expect(report.totalsByMethod.cash).toBeCloseTo(4271.14, 2)
    expect(report.totalsByMethod.mpesa).toBeCloseTo(13445, 2)
    expect(report.totalsByMethod.card).toBe(0)
    expect(latest?.expectedCash).toBeCloseTo(4271.14, 2)
    expect(latest?.endingCash).toBe(5210)
    expect(latest?.discrepancy).toBeCloseTo(938.86, 2)
    expect(latest?.mpesaDifference).toBeCloseTo(-1093.86, 2)
  })

  it("marks the forced move on both shifts, and the move is the only change to the orders: order #85's shift_id", () => {
    for (const shiftId of [1, 3]) {
      const forced = db.listShiftAdjustments(shiftId).filter((row) => row.reason === `${OVERRIDE_REASON_PREFIX}${MOVE_REASON}`)
      expect(forced).toHaveLength(1)
    }
    // CHANGED (docs/phase-249). OLD: every column of every order was compared. NEW: opening the copy with this build adds
    // `checkout_key` (NULL on every old order), so the comparison is of the columns the orders had, and the new one must read NULL.
    const changed = afterFirstRun.orders.flatMap((row, index) => {
      const old = before.orders[index] as Record<string, unknown>
      const now = row as Record<string, unknown>
      return Object.keys(old).filter((key) => old[key] !== now[key]).map((key) => `#${now.local_id}.${key}: ${String(old[key])} -> ${String(now[key])}`)
    })
    expect(changed).toEqual(['#85.shift_id: 1 -> 3'])
    expect(afterFirstRun.orders.every((row) => (row as Record<string, unknown>).checkout_key === null)).toBe(true)
  })

  it('keeps every order in exactly one shift: 180 in all, none counted in two Z reports', () => {
    const shifts = (conn(db).prepare('SELECT id FROM shifts').all() as Array<{ id: number }>).map((row) => row.id)
    const seen = new Set<number>()
    let listed = 0
    for (const id of shifts) {
      for (const order of db.getOrdersForShift(id)) {
        listed += 1
        seen.add(order.local_id)
      }
    }

    expect(conn(db).prepare('SELECT COUNT(*) AS n, COUNT(shift_id) AS placed FROM orders').get()).toEqual({ n: 180, placed: 180 })
    expect(listed).toBe(180)
    expect(seen.size).toBe(180)
    expect(shifts.reduce((sum, id) => sum + z(id).orderCount, 0)).toBe(180)
  })

  it('leaves shift #8 byte-identical and open', () => {
    const now = conn(db).prepare('SELECT * FROM shifts WHERE id = 8').get() as Record<string, unknown>
    // CHANGED (docs/phase-246, R5). OLD: the whole row was compared. NEW: opening the copy with this build adds the three card columns
    // (NULL), so the comparison is of the columns the shift had, and the new ones must read NULL.
    // CHANGED (docs/phase-254). OLD: only the card columns were left out. NEW: `closed_by_staff_id` is added the same way, NULL.
    const hadColumns = Object.fromEntries(Object.entries(now).filter(([key]) => !key.startsWith('card_') && key !== 'closed_by_staff_id'))
    expect(['card_closing_balance', 'card_expected', 'card_difference', 'closed_by_staff_id'].map((key) => now[key])).toEqual([null, null, null, null])

    expect(JSON.stringify(hadColumns)).toBe(JSON.stringify(before.shift8))
    expect(now).toMatchObject({ status: 'open', clock_out: null })
  })

  it('changes only the ledgers: orders and shifts same; adjustments +2, adjustment sales +2, corrections +2; the rest same', () => {
    const expected = {
      ...before.counts,
      shift_adjustments: before.counts.shift_adjustments + 2,
      shift_adjustment_sales: before.counts.shift_adjustment_sales + 2,
      shift_corrections: before.counts.shift_corrections + 2,
      // ADDED (docs/phase-252): opening the copy adds the payments table, empty; the repair writes no payment.
      order_payments: 0,
      // ADDED (docs/phase-253-1): opening the copy adds the discount copy's table, empty; the repair writes no discount.
      auto_discounts: 0
    }

    expect(afterFirstRun.counts).toEqual(expected)
    expect(afterFirstRun.counts.orders).toBe(before.counts.orders)
    expect(afterFirstRun.counts.shifts).toBe(before.counts.shifts)
  })

  it('refuses a second run of the move and changes nothing', () => {
    expect(() =>
      db.reassignSale({ orderId: 85, toShiftId: 3, managerId: adminId, reason: MOVE_REASON, acknowledgeDifferentWindow: true, override: true })
    ).toThrow('already in shift #3')

    expect(tableCounts(conn(db))).toEqual(afterFirstRun.counts)
    expect(orderRows()).toEqual(afterFirstRun.orders)
  })

  it('prints both final Z reports as the printer lays them out', () => {
    for (const shiftId of [3, 1]) {
      const lines = printed(z(shiftId))
      console.log(`\n######## Z-REPORT shift #${shiftId}\n${lines.join('\n')}\n`)
      expect(lines).toContain(`Shift #${shiftId}`)
    }
  })
})
