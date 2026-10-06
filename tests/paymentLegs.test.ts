/**
 * One reader of payment legs (docs/phase-250). `paymentLegsFor` builds one leg per sale from `orders.payment_method` and
 * `orders.total` in one query; every reader that turns sales into cash, M-Pesa or card figures reads them through it.
 *
 * Two kinds of test, on a real `:memory:` SQLite holding a mixed set of cash, M-Pesa and card sales and a voided one:
 * - each reader's figures are the ones the old code gave (worked out by hand below; the exported copy's golden run is the
 *   proof on real data, `tests/rehearsal/paymentLegsGolden.test.ts`);
 * - each reader follows the legs and nothing else: with the legs relabelled (cash read as card and card as cash) through
 *   the one reader, its figures move with them. A reader that went back to `orders.payment_method` would not move.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import type { PaymentLeg } from '../src/main/lib/paymentLegs.js'
import { generateDailySummary, generateSalesSummary, generateShiftEndOfDay, generateZReport } from '../src/main/services/reports.js'
import { buildOrdersCsv } from '../src/main/services/reportsExport.js'
import { getShiftWindowStatus } from '../src/main/services/shift-window-status.js'

const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn
const RANGE = { startIso: '2026-10-05T00:00:00.000Z', endIso: '2026-10-06T00:00:00.000Z', label: '5 Oct' }
const REASON = 'Checking the shared reader of payments'

let db: RubisDatabase
let admin: number

/**
 * Shift 1, closed, day of 5 Oct: cash 120.50 and 80, M-Pesa 300.25 (and 99.99 voided), card 75; drawer 100, counted 400,
 * M-Pesa 50 at the start and 400 at the end. Shift 2, closed after it in the same window: cash 40, M-Pesa 60, card 25.
 * Shift 3, open, 6 Oct: cash 10, M-Pesa 20; drawer 20, M-Pesa 10.
 */
function seed(): void {
  db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  admin = db.createStaff({ name: 'Admin', pinHash: hashPin('1234'), role: 'admin' }).staffId
  const c = conn(db)
  const shift = c.prepare(
    `INSERT INTO shifts (staff_id, clock_in, clock_out, starting_cash, ending_cash, status, shift_type, mpesa_opening_balance, mpesa_closing_balance)
     VALUES (?, ?, ?, ?, ?, ?, 'day', ?, ?)`
  )
  shift.run(admin, '2026-10-05T04:00:00.000Z', '2026-10-05T10:00:00.000Z', 100, 400, 'closed', 50, 400)
  shift.run(admin, '2026-10-05T10:05:00.000Z', '2026-10-05T11:00:00.000Z', 0, 50, 'closed', null, null)
  shift.run(admin, '2026-10-06T04:00:00.000Z', null, 20, null, 'open', 10, null)
  const sale = c.prepare('INSERT INTO orders (total, status, created_at, payment_method, shift_id, staff_id) VALUES (?, ?, ?, ?, ?, ?)')
  sale.run(120.5, 'pending_sync', '2026-10-05T05:00:00.000Z', 'cash', 1, admin) // 1
  sale.run(80, 'pending_sync', '2026-10-05T05:30:00.000Z', 'cash', 1, admin) // 2
  sale.run(300.25, 'pending_sync', '2026-10-05T06:00:00.000Z', 'mpesa', 1, admin) // 3
  sale.run(99.99, 'voided', '2026-10-05T06:30:00.000Z', 'mpesa', 1, admin) // 4
  sale.run(75, 'pending_sync', '2026-10-05T07:00:00.000Z', 'card', 1, admin) // 5
  sale.run(40, 'pending_sync', '2026-10-05T10:10:00.000Z', 'cash', 2, admin) // 6
  sale.run(60, 'pending_sync', '2026-10-05T10:20:00.000Z', 'mpesa', 2, admin) // 7
  sale.run(25, 'pending_sync', '2026-10-05T10:30:00.000Z', 'card', 2, admin) // 8
  sale.run(10, 'pending_sync', '2026-10-06T04:30:00.000Z', 'cash', 3, admin) // 9
  sale.run(20, 'pending_sync', '2026-10-06T05:00:00.000Z', 'mpesa', 3, admin) // 10
}

/** Reads cash as card and card as cash, through the one reader only. */
function relabel(target: RubisDatabase): void {
  const real = target.paymentLegsFor.bind(target)
  const swap = { cash: 'card', card: 'cash', mpesa: 'mpesa' } as const
  vi.spyOn(target, 'paymentLegsFor').mockImplementation((ids) => {
    const legs = real(ids)
    return new Map(Array.from(legs, ([id, list]) => [id, list.map((leg): PaymentLeg => ({ ...leg, method: leg.method ? swap[leg.method] : null }))]))
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  seed()
})

describe('paymentLegsFor', () => {
  it('gives one leg per sale, its method and its total, a voided sale flagged as today', () => {
    const legs = db.paymentLegsFor([1, 3, 4, 5])

    expect(Object.fromEntries(legs)).toEqual({
      1: [{ orderId: 1, method: 'cash', amount: 120.5, voided: false }],
      3: [{ orderId: 3, method: 'mpesa', amount: 300.25, voided: false }],
      4: [{ orderId: 4, method: 'mpesa', amount: 99.99, voided: true }],
      5: [{ orderId: 5, method: 'card', amount: 75, voided: false }]
    })
  })

  it('gives nothing for no sales, and no entry for a sale that does not exist', () => {
    const prepare = vi.spyOn(conn(db), 'prepare')

    expect(db.paymentLegsFor([]).size).toBe(0)
    expect(prepare).not.toHaveBeenCalled()
    expect(db.paymentLegsFor([999]).has(999)).toBe(false)
  })

  it('reads a whole list in one query, never one per sale', () => {
    const prepare = vi.spyOn(conn(db), 'prepare')

    const legs = db.paymentLegsFor([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    expect(legs.size).toBe(10)
    expect(prepare).toHaveBeenCalledTimes(1)
  })
})

describe('every reader gives the figures it gave before, and follows the legs', () => {
  const totals = (t: { cash: number; mpesa: number; card: number }) => [t.cash, t.mpesa, t.card]

  it('the Z report', () => {
    expect(totals(generateZReport(db, 1, 0.16).totalsByMethod)).toEqual([200.5, 300.25, 75])
    relabel(db)
    expect(totals(generateZReport(db, 1, 0.16).totalsByMethod)).toEqual([75, 300.25, 200.5])
  })

  it('the sales summary and the daily summary', () => {
    expect(totals(generateSalesSummary(db, 0.16, RANGE).totalsByMethod)).toEqual([240.5, 360.25, 100])
    expect(totals(generateDailySummary(db, 0.16, RANGE).totalsByMethod)).toEqual([240.5, 360.25, 100])
    relabel(db)
    expect(totals(generateSalesSummary(db, 0.16, RANGE).totalsByMethod)).toEqual([100, 360.25, 240.5])
    expect(totals(generateDailySummary(db, 0.16, RANGE).totalsByMethod)).toEqual([100, 360.25, 240.5])
  })

  it('the End of Day, overall and per cashier', () => {
    const report = generateShiftEndOfDay(db, 1)
    expect(totals(report.totalsByMethod)).toEqual([200.5, 300.25, 75])
    expect(totals(report.cashiers[0].totalsByMethod)).toEqual([200.5, 300.25, 75])
    relabel(db)
    const swapped = generateShiftEndOfDay(db, 1)
    expect(totals(swapped.totalsByMethod)).toEqual([75, 300.25, 200.5])
    expect(totals(swapped.cashiers[0].totalsByMethod)).toEqual([75, 300.25, 200.5])
  })

  it('closing a shift: expected cash, M-Pesa and card', () => {
    const closed = db.closeShift(3, 30, 40, 0)
    expect([closed.expectedCash, closed.mpesaExpected, closed.cardExpected]).toEqual([30, 30, 0])

    seed()
    relabel(db)
    const swapped = db.closeShift(3, 30, 40, 0)
    expect([swapped.expectedCash, swapped.mpesaExpected, swapped.cardExpected]).toEqual([20, 30, 10])
  })

  it('the figures a closed shift shows now (moving an M-Pesa sale changes no cash)', () => {
    expect(db.previewSaleMove(3, 2, true).from?.expectedCash).toBe(300.5)
    relabel(db)
    expect(db.previewSaleMove(3, 2, true).from?.expectedCash).toBe(175)
  })

  it('the move preview: the sale that moves', () => {
    expect(db.previewSaleMove(1, 2, true).from?.expectedCash).toBe(180)
    relabel(db)
    // Its own sale is read as card too, so it takes no cash out: 100 + 75 (card read as cash).
    expect(db.previewSaleMove(1, 2, true).from?.expectedCash).toBe(175)
  })

  it('the merge preview', () => {
    expect(db.previewShiftMerge(2, 1, true).into?.expectedCash).toBe(340.5)
    relabel(db)
    expect(db.previewShiftMerge(2, 1, true).into?.expectedCash).toBe(200)
  })

  it('the adjustment ledger, and the Z report\'s sales at close after a move', () => {
    db.reassignSale({ orderId: 1, toShiftId: 2, managerId: admin, reason: REASON, acknowledgeDifferentWindow: true, override: true })
    const row = db.listShiftAdjustments(1).find((r) => r.kind === 'reassign_out')!
    expect([row.cash_total, row.mpesa_total, row.card_total]).toEqual([120.5, 0, 0])
    expect(generateZReport(db, 1, 0.16).salesAtClose).toMatchObject({ cash: 200.5, mpesa: 300.25, card: 75 })

    seed()
    relabel(db)
    db.reassignSale({ orderId: 1, toShiftId: 2, managerId: admin, reason: REASON, acknowledgeDifferentWindow: true, override: true })
    const swapped = db.listShiftAdjustments(1).find((r) => r.kind === 'reassign_out')!
    expect([swapped.cash_total, swapped.mpesa_total, swapped.card_total]).toEqual([0, 0, 120.5])
    expect(generateZReport(db, 1, 0.16).salesAtClose).toMatchObject({ cash: 75, mpesa: 300.25, card: 200.5 })
  })

  it('a correction', () => {
    const correct = () =>
      db.addShiftCorrection({ shiftId: 1, managerId: admin, reason: REASON, startingCash: 100, endingCash: 410, mpesaOpeningBalance: 50, mpesaClosingBalance: 400, override: true })
    expect(correct().expected_cash).toBe(300.5)
    seed()
    relabel(db)
    expect(correct().expected_cash).toBe(175)
  })

  it('the orders CSV payment method', () => {
    const methodOf = (csv: string, row: number): string => csv.split('\n')[row].split(',')[5]
    expect(methodOf(buildOrdersCsv(db, RANGE, 0.16), 1)).toBe('cash')
    relabel(db)
    expect(methodOf(buildOrdersCsv(db, RANGE, 0.16), 1)).toBe('card')
  })
})

describe('the earlier sales of a window with no shift', () => {
  /** The night of 6 Oct has no shift: three sales were made in it with no shift, cash 100, M-Pesa 50.50, card 30. */
  const NOW = Date.parse('2026-10-06T19:30:00.000Z')
  function nightSales(): void {
    const sale = conn(db).prepare("INSERT INTO orders (total, status, created_at, payment_method, shift_id) VALUES (?, 'pending_sync', ?, ?, NULL)")
    sale.run(100, '2026-10-06T18:10:00.000Z', 'cash')
    sale.run(50.5, '2026-10-06T18:20:00.000Z', 'mpesa')
    sale.run(30, '2026-10-06T18:30:00.000Z', 'card')
    db.closeShift(3, 30)
  }

  it('the shift-window status shown to Open Shift', () => {
    nightSales()
    expect(getShiftWindowStatus(db, NOW).earlier).toEqual({ count: 3, cash: 100, mpesa: 50.5 })
    relabel(db)
    expect(getShiftWindowStatus(db, NOW).earlier).toEqual({ count: 3, cash: 30, mpesa: 50.5 })
  })

  it('opening the shift: the float is the drawer less the earlier cash', () => {
    nightSales()
    const { shiftId } = db.openShift(admin, 1000, 500, {}, NOW)
    expect(db.getShiftById(shiftId)).toMatchObject({ starting_cash: 900, mpesa_opening_balance: 449.5 })

    seed()
    nightSales()
    relabel(db)
    const swapped = db.openShift(admin, 1000, 500, {}, NOW)
    expect(db.getShiftById(swapped.shiftId)).toMatchObject({ starting_cash: 970, mpesa_opening_balance: 449.5 })
  })
})

describe('no moved reader reads the column itself', () => {
  const source = (...parts: string[]): string => readFileSync(join(process.cwd(), 'src', 'main', ...parts), 'utf8')

  it('the reports, the CSV export and the window status never read orders.payment_method', () => {
    for (const file of ['reports.ts', 'reportsExport.ts', 'shift-window-status.ts']) expect(source('services', file)).not.toContain('payment_method')
  })

  it('in the database, the one reader builds legs from it; only the Move a sale preview shows it, as text', () => {
    const db = source('services', 'database.ts')

    expect(db).not.toMatch(/payment_method\s*===/)
    // The doc comment of the reader names `orders.payment_method`; code reads it as a row's field.
    expect(db.match(/\b(?!orders\b)\w+\.payment_method\b/g)).toEqual(['row.payment_method', 'o.payment_method', 'order.payment_method'])
    expect(db).toContain('method: row.payment_method, amount: row.total')
    expect(db).toContain('paymentMethod: order.payment_method,')
  })
})
