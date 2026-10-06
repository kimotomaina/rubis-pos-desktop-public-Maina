/**
 * A Z report is scoped to one shift and nothing else: the sales whose `shift_id` is that shift, whenever they were
 * made, and no sale of another shift or of no shift, however close in time. Real in-memory SQLite, so the queries
 * themselves are what is tested.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import { generateZReport } from '../src/main/services/reports.js'
import { renderZReport } from '../src/main/services/printer.js'
import type { PrinterSettings, ThermalPrinterLike } from '../src/main/services/printer.js'
import { zReportRequestSchema } from '../src/main/lib/ipcValidator.js'

const iso = (t: string): string => new Date(`${t}+03:00`).toISOString()
const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn

function sale(
  db: RubisDatabase,
  at: string,
  total: number,
  method: 'cash' | 'mpesa' | 'card',
  shiftId: number | null,
  status = 'synced'
): number {
  return Number(
    conn(db)
      .prepare('INSERT INTO orders (total, status, created_at, payload_json, staff_id, payment_method, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(total, status, iso(at), '{}', 1, method, shiftId).lastInsertRowid
  )
}

function mpesa(db: RubisDatabase, orderId: number, mode: 'manual' | 'daraja', amount: number, reference: string): void {
  conn(db)
    .prepare(
      "INSERT INTO mpesa_payments (order_local_id, mode, verification_status, reference, amount, entered_by_staff_id, created_at) VALUES (?, ?, 'confirmed', ?, ?, 1, ?)"
    )
    .run(orderId, mode, reference, amount, iso('2026-10-05T12:00:00'))
}

/**
 * Shift A (Day, closed 17:30) and shift B (Night, open from 17:43), a sale of each made at a time that sits inside the
 * other's hours, and one sale with no shift inside A's hours.
 */
function build() {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const shiftA = Number(
    conn(db)
      .prepare("INSERT INTO shifts (staff_id, clock_in, clock_out, starting_cash, expected_cash, ending_cash, discrepancy, status, shift_type) VALUES (1, ?, ?, 100, 200, 200, 0, 'closed', 'day')")
      .run(iso('2026-10-05T10:00:00'), iso('2026-10-05T17:30:00')).lastInsertRowid
  )
  const shiftB = Number(
    conn(db)
      .prepare("INSERT INTO shifts (staff_id, clock_in, starting_cash, status, shift_type) VALUES (1, ?, 50, 'open', 'night')")
      .run(iso('2026-10-05T17:43:00')).lastInsertRowid
  )
  const a1 = sale(db, '2026-10-05T11:00:00', 100, 'cash', shiftA)
  const a2 = sale(db, '2026-10-05T12:00:00', 200, 'mpesa', shiftA)
  mpesa(db, a2, 'manual', 200, 'MAN-A2')
  const a3 = sale(db, '2026-10-05T18:30:00', 50, 'card', shiftA) // made after A closed, but it is A's
  const a4 = sale(db, '2026-10-05T13:00:00', 999, 'cash', shiftA, 'voided')
  const b1 = sale(db, '2026-10-05T11:30:00', 300, 'cash', shiftB) // made inside A's hours, but it is B's
  const b2 = sale(db, '2026-10-05T19:00:00', 400, 'mpesa', shiftB)
  mpesa(db, b2, 'daraja', 400, 'DAR-B2')
  const u1 = sale(db, '2026-10-05T12:30:00', 7, 'cash', null) // inside A's hours, belongs to no shift
  return { db, shiftA, shiftB, a1, a2, a3, a4, b1, b2, u1 }
}

describe('a Z report is scoped to one shift', () => {
  it("counts exactly the shift's own sales, whatever time they were made, and no other shift's or unattached sale", () => {
    const { db, shiftA } = build()

    const report = generateZReport(db, shiftA, 0.16)

    expect(report.shiftId).toBe(shiftA)
    expect(report.orderCount).toBe(3)
    expect(report.totalRevenue).toBe(350)
    expect(report.totalsByMethod).toEqual({ cash: 100, mpesa: 200, card: 50 })
    expect(report.mpesaByMode).toEqual({ manual: 200, daraja: 0 })
  })

  it("does the same for the other shift: its sale made inside A's hours is B's, A's late sale is not", () => {
    const { db, shiftB } = build()

    const report = generateZReport(db, shiftB, 0.16)

    expect(report.orderCount).toBe(2)
    expect(report.totalsByMethod).toEqual({ cash: 300, mpesa: 400, card: 0 })
    expect(report.mpesaByMode).toEqual({ manual: 0, daraja: 400 })
    // An open shift's expected cash is live, from its own float and its own cash sales only.
    expect(report.expectedCash).toBe(350)
  })

  it('never double counts: the two reports plus the sales with no shift are every sale, once', () => {
    const { db, shiftA, shiftB } = build()

    const a = generateZReport(db, shiftA, 0.16)
    const b = generateZReport(db, shiftB, 0.16)
    const unattached = db.listUnattachedSales().reduce((sum, s) => sum + s.total, 0)
    const all = (conn(db).prepare("SELECT SUM(total) AS t FROM orders WHERE status <> 'voided'").get() as { t: number }).t

    expect(a.totalRevenue + b.totalRevenue + unattached).toBe(all)
    expect(unattached).toBe(7)
  })

  it('leaves out a voided sale, and a report for a shift with no sales is empty, not everyone\'s', () => {
    const { db } = build()
    const empty = Number(
      conn(db)
        .prepare("INSERT INTO shifts (staff_id, clock_in, clock_out, starting_cash, status, cash_not_counted) VALUES (1, ?, ?, 0, 'closed', 1)")
        .run(iso('2026-10-04T10:00:00'), iso('2026-10-04T12:00:00')).lastInsertRowid
    )

    const report = generateZReport(db, empty, 0.16)

    expect(report.orderCount).toBe(0)
    expect(report.totalRevenue).toBe(0)
    expect(report.totalsByMethod).toEqual({ cash: 0, mpesa: 0, card: 0 })
  })

  it("follows a sale when an admin moves it: it leaves the first shift's report and joins the second's", () => {
    const { db, shiftA, shiftB, a1 } = build()

    db.reassignSale({ orderId: a1, toShiftId: shiftB, managerId: 2, reason: 'wrong shift', acknowledgeDifferentWindow: true })

    expect(generateZReport(db, shiftA, 0.16).totalsByMethod.cash).toBe(0)
    expect(generateZReport(db, shiftB, 0.16).totalsByMethod.cash).toBe(400)
  })

  it('does not move a report when sales with no shift are given one: only the shift that receives them changes', () => {
    const { db, shiftA, shiftB } = build()
    const beforeA = generateZReport(db, shiftA, 0.16)
    const beforeB = generateZReport(db, shiftB, 0.16)

    db.autoAssignUnattachedSales(Date.parse('2026-10-07T10:00:00+03:00'))

    const afterA = generateZReport(db, shiftA, 0.16)
    const afterB = generateZReport(db, shiftB, 0.16)
    const changed = [afterA.orderCount !== beforeA.orderCount, afterB.orderCount !== beforeB.orderCount]
    // The 12:30 sale lies inside A's own hours, so it joins A (S8) and not B: exactly one report grows, by that sale.
    expect(changed).toEqual([true, false])
    expect(afterA.totalsByMethod.cash).toBe(beforeA.totalsByMethod.cash + 7)
    expect(afterB).toMatchObject({ orderCount: beforeB.orderCount, totalRevenue: beforeB.totalRevenue })
  })

  it('refuses a shift that does not exist, rather than reporting something wider', () => {
    const { db } = build()

    expect(() => generateZReport(db, 999, 0.16)).toThrow('Shift 999 not found')
  })

  it('prints the same scope on paper', () => {
    const { db, shiftA, shiftB } = build()
    const settings: PrinterSettings = { interfaceName: 'tcp://x', storeName: 'RUBIS', taxRate: 0.16 }
    const printed = (shiftId: number): string[] => {
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

    expect(printed(shiftA)).toContain('Shift #' + shiftA)
    expect(printed(shiftA)).toContain('Orders: 3')
    expect(printed(shiftB)).toContain('Orders: 2')
  })

  it('is asked for by shift number alone: no date, range or window can widen it', () => {
    expect(zReportRequestSchema.safeParse({ shiftId: 1 }).success).toBe(true)
    expect(zReportRequestSchema.safeParse({ shiftId: 1, from: '2026-10-01', to: '2026-10-09' }).success).toBe(true)
    // Unknown keys are dropped by the schema, so they never reach the report.
    expect(zReportRequestSchema.parse({ shiftId: 1, from: 'x', to: 'y' })).toEqual({ shiftId: 1 })
    expect(zReportRequestSchema.safeParse({}).success).toBe(false)

    const source = readFileSync(join(process.cwd(), 'src', 'main', 'services', 'reports.ts'), 'utf8').replace(/\r?\n/g, '\n')
    const start = source.indexOf('export function generateZReport(')
    const signature = source.slice(start, source.indexOf('{', source.indexOf(')', start)))
    expect(signature.replace(/\s+/g, ' ')).toContain('db: RubisDatabase, shiftId: number, taxRate: number')
    const body = source.slice(start, source.indexOf('\n}\n', start))
    expect(body).toContain('db.getOrdersForShift(shiftId)')
    expect(body).toContain('db.getMpesaPaymentsForShift(shiftId)')
    expect(body).not.toMatch(/getOrdersBetween|listOrders|startIso|endIso|clock_in\s*[<>]|created_at\s*[<>]/)
  })

  it('reads its sales by shift_id in both queries, never by time', () => {
    const database = readFileSync(join(process.cwd(), 'src', 'main', 'services', 'database.ts'), 'utf8').replace(/\r?\n/g, '\n')
    const orders = database.slice(database.indexOf('getOrdersForShift(shiftId: number)'), database.indexOf('getOrdersForShift(shiftId: number)') + 600)
    const payments = database.slice(database.indexOf('getMpesaPaymentsForShift('), database.indexOf('getMpesaPaymentsForShift(') + 900)

    expect(orders).toContain('WHERE shift_id = ?')
    expect(orders).not.toMatch(/created_at\s*(>=|<=|>|<|BETWEEN)/i)
    expect(payments).toContain('WHERE o.shift_id = ?')
    expect(payments).not.toMatch(/created_at\s*(>=|<=|>|<|BETWEEN)/i)
  })
})
