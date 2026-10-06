/**
 * The end-of-day report can be limited to one shift (docs/phase-241). Real in-memory SQLite: the filter is a cut of
 * the day's sales, payments and carry-over by the shift's own sales, and these tests show every cut and that the
 * pieces add back up to the whole day.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import { generateEndOfDayReport } from '../src/main/services/reports.js'
import { endOfDayReportSchema } from '../src/main/lib/ipcValidator.js'

const iso = (t: string): string => new Date(`${t}+03:00`).toISOString()
const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn

function shift(db: RubisDatabase, inn: string, out: string | null, type: string): number {
  return Number(
    conn(db)
      .prepare("INSERT INTO shifts (staff_id, clock_in, clock_out, starting_cash, status, shift_type) VALUES (1, ?, ?, 0, ?, ?)")
      .run(iso(inn), out ? iso(out) : null, out ? 'closed' : 'open', type).lastInsertRowid
  )
}

function sale(
  db: RubisDatabase,
  at: string,
  total: number,
  method: 'cash' | 'mpesa' | 'card',
  staffId: number,
  shiftId: number | null,
  status = 'synced'
): number {
  return Number(
    conn(db)
      .prepare('INSERT INTO orders (total, status, created_at, payload_json, staff_id, payment_method, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(total, status, iso(at), '{}', staffId, method, shiftId).lastInsertRowid
  )
}

function payment(db: RubisDatabase, orderId: number, mode: 'manual' | 'daraja', amount: number, reference: string, staffId: number): number {
  return Number(
    conn(db)
      .prepare(
        "INSERT INTO mpesa_payments (order_local_id, mode, verification_status, reference, amount, entered_by_staff_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(orderId, mode, mode === 'manual' ? 'manual_unverified' : 'confirmed', reference, amount, staffId, iso('2026-10-05T12:00:00')).lastInsertRowid
  )
}

/** Three shifts around 5 Oct, the Night of 4 Oct running into the morning of 5 Oct, and the Night of 5 Oct into 6 Oct. */
function build() {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const n0 = shift(db, '2026-10-04T18:00:00', '2026-10-05T08:00:00', 'night')
  const a = shift(db, '2026-10-05T10:00:00', '2026-10-05T17:30:00', 'day')
  const b = shift(db, '2026-10-05T17:43:00', '2026-10-06T08:00:00', 'night')
  const o1 = sale(db, '2026-10-05T11:00:00', 100, 'cash', 1, a)
  const o2 = sale(db, '2026-10-05T12:00:00', 200, 'mpesa', 2, a)
  const p2 = payment(db, o2, 'manual', 200, 'MAN-A2', 2)
  const o3 = sale(db, '2026-10-05T19:00:00', 300, 'mpesa', 1, b)
  const p3 = payment(db, o3, 'daraja', 300, 'DAR-B3', 1)
  const o4 = sale(db, '2026-10-05T23:30:00', 50, 'cash', 1, b)
  const o5 = sale(db, '2026-10-06T01:00:00', 400, 'mpesa', 2, b) // the next day, still shift B
  const p5 = payment(db, o5, 'manual', 400, 'MAN-B5', 2)
  const o6 = sale(db, '2026-10-05T02:00:00', 25, 'cash', 2, n0)
  const o7 = sale(db, '2026-10-04T22:00:00', 70, 'mpesa', 2, n0) // the day before: carry-over on 5 Oct
  const p7 = payment(db, o7, 'manual', 70, 'MAN-N7', 2)
  const o8 = sale(db, '2026-10-05T13:00:00', 7, 'cash', 1, null) // no shift
  const o9 = sale(db, '2026-10-05T11:30:00', 999, 'cash', 1, a, 'voided')
  return { db, n0, a, b, o1, o2, o3, o4, o5, o6, o7, o8, o9, p2, p3, p5, p7 }
}

const DAY = '2026-10-05'

describe('the whole day, as it always was', () => {
  it('is unchanged without a shift, and lists the shifts that have sales that day', () => {
    const { db, n0, a, b, p2, p7 } = build()

    const report = generateEndOfDayReport(db, DAY)

    expect(report.shiftId).toBeNull()
    expect(report.totalsByMethod).toEqual({ cash: 182, mpesa: 500, card: 0 })
    expect(report.manualEntries.map((e) => e.paymentId)).toEqual([p2])
    expect(report.carryOver.map((e) => e.paymentId)).toEqual([p7])
    expect(report.shiftsOfDay?.map((s) => [s.shiftId, s.orderCount])).toEqual([
      [n0, 1],
      [a, 2],
      [b, 2]
    ])
    expect(report.shiftsOfDay?.[1]).toMatchObject({ windowType: 'day', windowDate: DAY, status: 'closed' })
    expect(report.shiftsOfDay?.[0]).toMatchObject({ windowType: 'night', windowDate: '2026-10-04' })
  })

  it('treats an explicit null shift as the whole day', () => {
    const { db } = build()

    expect(generateEndOfDayReport(db, DAY, null).totalsByMethod).toEqual(generateEndOfDayReport(db, DAY).totalsByMethod)
  })
})

describe('limited to one shift', () => {
  it("shows only that shift's sales, cashiers and manual M-Pesa entries that day", () => {
    const { db, a, p2 } = build()

    const report = generateEndOfDayReport(db, DAY, a)

    expect(report.shiftId).toBe(a)
    expect(report.totalsByMethod).toEqual({ cash: 100, mpesa: 200, card: 0 })
    expect(report.cashiers.map((c) => [c.staffId, c.orderCount]).sort()).toEqual([[1, 1], [2, 1]])
    expect(report.manualEntries.map((e) => e.paymentId)).toEqual([p2])
    expect(report.carryOver).toEqual([])
    expect(report.pendingIds).toEqual([p2])
    expect(report.pendingManualTotal).toBe(200)
  })

  it('leaves out the other shift\'s Daraja payment and the unattached sale', () => {
    const { db, b } = build()

    const report = generateEndOfDayReport(db, DAY, b)

    expect(report.totalsByMethod).toEqual({ cash: 50, mpesa: 300, card: 0 })
    expect(report.manualEntries).toEqual([])
    expect(report.cashiers.map((c) => c.staffId)).toEqual([1])
    expect(report.pendingIds).toEqual([])
  })

  it('keeps the carry-over that belongs to the shift, and drops the rest', () => {
    const { db, n0, a, p7 } = build()

    expect(generateEndOfDayReport(db, DAY, n0).carryOver.map((e) => e.paymentId)).toEqual([p7])
    expect(generateEndOfDayReport(db, DAY, n0).pendingIds).toEqual([p7])
    expect(generateEndOfDayReport(db, DAY, a).carryOver).toEqual([])
  })

  it('cuts a Night that runs past midnight by day: each day shows its own part', () => {
    const { db, b, p5 } = build()

    const first = generateEndOfDayReport(db, DAY, b)
    const second = generateEndOfDayReport(db, '2026-10-06', b)

    expect(first.totalsByMethod).toEqual({ cash: 50, mpesa: 300, card: 0 })
    expect(second.totalsByMethod).toEqual({ cash: 0, mpesa: 400, card: 0 })
    expect(second.manualEntries.map((e) => e.paymentId)).toEqual([p5])
    expect(second.shiftsOfDay?.map((s) => s.shiftId)).toEqual([b])
  })

  it('adds back up: every shift of the day plus the sales with no shift is the whole day', () => {
    const { db } = build()
    const whole = generateEndOfDayReport(db, DAY)

    const parts = (whole.shiftsOfDay ?? []).map((s) => generateEndOfDayReport(db, DAY, s.shiftId).totalsByMethod)
    const sum = (key: 'cash' | 'mpesa' | 'card'): number => parts.reduce((total, p) => total + p[key], 0)

    expect(sum('cash') + 7).toBe(whole.totalsByMethod.cash) // 7 is the one sale with no shift
    expect(sum('mpesa')).toBe(whole.totalsByMethod.mpesa)
    expect(sum('card')).toBe(whole.totalsByMethod.card)
  })

  it('never counts a voided sale, and a shift with no sales that day is empty, not the whole day', () => {
    const { db, a } = build()

    expect(generateEndOfDayReport(db, DAY, a).totalsByMethod.cash).toBe(100) // not 1,099
    const other = generateEndOfDayReport(db, '2026-10-07', a)
    expect(other.cashiers).toEqual([])
    expect(other.totalsByMethod).toEqual({ cash: 0, mpesa: 0, card: 0 })
    expect(other.manualEntries).toEqual([])
  })

  it('still lists every shift of the day while one is chosen, so the choice can be changed', () => {
    const { db, a } = build()

    expect(generateEndOfDayReport(db, DAY, a).shiftsOfDay).toEqual(generateEndOfDayReport(db, DAY).shiftsOfDay)
  })

  it('refuses a shift that does not exist, rather than showing the whole day', () => {
    const { db } = build()

    expect(() => generateEndOfDayReport(db, DAY, 999)).toThrow('Shift 999 not found')
  })

  it('is a read: nothing is written, and what is pending is a subset of the whole day\'s', () => {
    const { db, a } = build()
    const counts = (): number[] =>
      ['orders', 'mpesa_payments', 'mpesa_day_approvals', 'shifts', 'shift_adjustments'].map(
        (t) => (conn(db).prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
      )
    const before = counts()

    const whole = generateEndOfDayReport(db, DAY)
    const limited = generateEndOfDayReport(db, DAY, a)

    expect(counts()).toEqual(before)
    expect(limited.pendingIds.every((id) => whole.pendingIds.includes(id))).toBe(true)
  })
})

describe('the request, and approving', () => {
  it('takes an optional positive whole shift number', () => {
    expect(endOfDayReportSchema.safeParse({ localDay: DAY }).success).toBe(true)
    expect(endOfDayReportSchema.safeParse({ localDay: DAY, shiftId: 3 }).success).toBe(true)
    expect(endOfDayReportSchema.safeParse({ shiftId: 0 }).success).toBe(false)
    expect(endOfDayReportSchema.safeParse({ shiftId: -2 }).success).toBe(false)
    expect(endOfDayReportSchema.safeParse({ shiftId: 1.5 }).success).toBe(false)
    expect(endOfDayReportSchema.safeParse({ shiftId: '3' }).success).toBe(false)
  })

  it('reaches the report from the handler, and approving knows nothing of a shift filter', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8').replace(/\r?\n/g, '\n')
    const body = (channel: string): string => {
      const start = source.indexOf(`'${channel}',`)
      return source.slice(start, source.indexOf('ipcMain.handle(', start))
    }

    expect(body('reports:end-of-day')).toContain('generateEndOfDayReport(db, validation.data.localDay, validation.data.shiftId ?? null)')
    expect(body('reports:approve-day')).not.toContain('shiftId')
  })
})
