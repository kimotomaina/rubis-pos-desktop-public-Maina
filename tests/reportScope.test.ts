/**
 * The scope every report takes on the Reports tab (docs/phase-246, R2 and R3): a preset (as before), one shift, or a
 * typed range. Every report keeps calling the function it called; only the range it is given is new. A shift's range is
 * the span of its own sales, so a shift that holds sales its clock times do not cover is read whole. Real in-memory SQLite.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import { generateSalesSummary, generateZReport, generateFiscalStatusByDay, getReportRange } from '../src/main/services/reports.js'
import { customRange, resolveReportRange, shiftScopeRange, MAX_CUSTOM_RANGE_DAYS } from '../src/main/services/report-scope.js'
import { toScopeRequest } from '../src/main/lib/reportScope.js'
import { exportCsvSchema, fiscalByDaySchema, fiscalReconciliationSchema, invoiceListSchema, reportScopeSchema, salesSummarySchema } from '../src/main/lib/ipcValidator.js'

const ms = (t: string): number => Date.parse(`${t}+03:00`)
const iso = (t: string): string => new Date(ms(t)).toISOString()
const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn

function shift(db: RubisDatabase, inn: string, out: string | null): number {
  return Number(
    conn(db)
      .prepare("INSERT INTO shifts (staff_id, clock_in, clock_out, starting_cash, status, shift_type) VALUES (1, ?, ?, 0, ?, 'night')")
      .run(iso(inn), out ? iso(out) : null, out ? 'closed' : 'open').lastInsertRowid
  )
}

function sale(db: RubisDatabase, shiftId: number | null, at: string, total: number, method = 'cash', status = 'synced'): number {
  return Number(
    conn(db)
      .prepare('INSERT INTO orders (total, status, created_at, payload_json, staff_id, payment_method, shift_id) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(total, status, iso(at), '{}', method, shiftId).lastInsertRowid
  )
}

/**
 * The 5 Oct shape: shift 1 was opened and closed within 15 seconds but holds the sales of the night, 17:34 to 09:04 the
 * next morning. A later shift holds today's.
 */
function mergedLike() {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const day = shift(db, '2026-10-05T09:14:00', '2026-10-05T17:30:59')
  const night = shift(db, '2026-10-05T17:43:21', '2026-10-05T17:43:36')
  const today = shift(db, '2026-10-06T11:35:14', null)
  sale(db, day, '2026-10-05T12:00:00', 100)
  sale(db, night, '2026-10-05T17:34:57', 60, 'mpesa')
  sale(db, night, '2026-10-05T22:00:18', 200, 'cash')
  sale(db, night, '2026-10-06T09:04:38', 65, 'cash')
  sale(db, night, '2026-10-06T09:05:00', 999, 'cash', 'voided')
  sale(db, today, '2026-10-06T12:22:00', 6820, 'mpesa')
  return { db, day, night, today }
}

describe('a shift scope', () => {
  it('covers the shift\'s own sales when its clock times do not, so the summary and the Z report agree', () => {
    const { db, night } = mergedLike()

    const range = shiftScopeRange(db, night)
    const summary = generateSalesSummary(db, 0.16, range)
    const z = generateZReport(db, night, 0.16)

    expect(range.startIso).toBe(iso('2026-10-05T17:34:57'))
    expect(Date.parse(range.endIso)).toBe(ms('2026-10-06T09:04:38') + 1)
    expect(summary.orderCount).toBe(z.orderCount)
    expect(summary.orderCount).toBe(3)
    expect(summary.totalRevenue).toBe(z.totalRevenue)
    expect(summary.totalsByMethod).toEqual(z.totalsByMethod)
  })

  it('would show 0 sales if it were only the shift\'s clock times, which is why it is not', () => {
    const { db, night } = mergedLike()
    const shiftRow = db.getShiftById(night)!

    const clockOnly = generateSalesSummary(db, 0.16, { startIso: shiftRow.clock_in, endIso: shiftRow.clock_out as string, label: 'x' })

    expect(clockOnly.orderCount).toBe(0)
  })

  it('keeps the shift\'s clock times when they are the wider, and leaves out voided sales', () => {
    const { db, day } = mergedLike()

    const range = shiftScopeRange(db, day)

    expect(range.startIso).toBe(iso('2026-10-05T09:14:00'))
    expect(range.endIso).toBe(iso('2026-10-05T17:30:59'))
    expect(generateSalesSummary(db, 0.16, range).orderCount).toBe(1)
  })

  it('runs to now for an open shift, and says so in its label', () => {
    const { db, today } = mergedLike()
    const now = new Date(iso('2026-10-06T16:00:00'))

    const range = shiftScopeRange(db, today, now)

    expect(range.endIso).toBe(now.toISOString())
    expect(range.label).toBe('Shift #3 (6 Oct 11:35 to now)')
    expect(generateSalesSummary(db, 0.16, range).orderCount).toBe(1)
  })

  it('is the shift\'s own times for a shift with no sales, and refuses a shift that does not exist', () => {
    const { db } = mergedLike()
    const empty = shift(db, '2026-10-07T07:00:00', '2026-10-07T08:00:00')

    expect(shiftScopeRange(db, empty)).toMatchObject({ startIso: iso('2026-10-07T07:00:00'), endIso: iso('2026-10-07T08:00:00') })
    expect(() => shiftScopeRange(db, 999)).toThrow('Shift 999 not found')
  })

  it('goes to every other report as the same kind of range, unchanged: the fiscal view reads its days', () => {
    const { db, night } = mergedLike()

    const days = generateFiscalStatusByDay(db, shiftScopeRange(db, night))

    expect(days.map((d) => d.localDay)).toEqual(['2026-10-05', '2026-10-06'])
  })
})

describe('a typed range', () => {
  it('reads Nairobi time and gives the same range the presets give: an instant pair', () => {
    const range = customRange('2026-10-05 17:00', '2026-10-06 09:30')

    expect(range.startIso).toBe(iso('2026-10-05T17:00:00'))
    expect(range.endIso).toBe(iso('2026-10-06T09:30:00'))
    expect(range.label).toBe('5 Oct 17:00 to 6 Oct 09:30')
  })

  it('refuses a text that is not a real date and time, an end that is not after the start, and a range over 62 days', () => {
    expect(() => customRange('5 Oct 2026', '2026-10-06 09:30')).toThrow('YYYY-MM-DD HH:MM')
    expect(() => customRange('2026-02-31 10:00', '2026-03-02 10:00')).toThrow('YYYY-MM-DD HH:MM')
    expect(() => customRange('2026-10-05 25:00', '2026-10-06 10:00')).toThrow('YYYY-MM-DD HH:MM')
    expect(() => customRange('2026-10-06 09:30', '2026-10-06 09:30')).toThrow('The end must be after the start')
    expect(() => customRange('2026-10-06 09:30', '2026-10-05 09:30')).toThrow('The end must be after the start')
    expect(() => customRange('2026-08-01 00:00', '2026-10-06 00:00')).toThrow(`at most ${MAX_CUSTOM_RANGE_DAYS} days`)
    expect(() => customRange('2026-08-05 00:00', '2026-10-06 00:00')).not.toThrow()
  })
})

describe('the scope of a request', () => {
  it('turns a preset into the range the preset always gave, a shift into its span and a range into its instants', () => {
    const { db, night } = mergedLike()
    const now = new Date(iso('2026-10-06T16:00:00'))

    expect(resolveReportRange(db, { preset: 'yesterday' }, now)).toEqual(getReportRange('yesterday', now))
    expect(resolveReportRange(db, { shiftId: night }, now)).toEqual(shiftScopeRange(db, night, now))
    expect(resolveReportRange(db, { from: '2026-10-05 17:00', to: '2026-10-06 09:30' }, now)).toEqual(customRange('2026-10-05 17:00', '2026-10-06 09:30'))
    expect(() => resolveReportRange(db, {}, now)).toThrow('Choose a shift, a preset or a range')
  })

  it('is one of the three and nothing else, in every report request', () => {
    const schemas = [reportScopeSchema, salesSummarySchema, fiscalByDaySchema, fiscalReconciliationSchema]
    for (const schema of schemas) {
      expect(schema.safeParse({ preset: 'today' }).success).toBe(true)
      expect(schema.safeParse({ shiftId: 3 }).success).toBe(true)
      expect(schema.safeParse({ from: '2026-10-05 17:00', to: '2026-10-06 09:30' }).success).toBe(true)
      expect(schema.safeParse({}).success).toBe(false)
      expect(schema.safeParse({ preset: 'today', shiftId: 3 }).success).toBe(false)
      expect(schema.safeParse({ shiftId: 3, from: '2026-10-05 17:00', to: '2026-10-06 09:30' }).success).toBe(false)
      expect(schema.safeParse({ from: '2026-10-05 17:00' }).success).toBe(false)
      expect(schema.safeParse({ preset: 'someday' }).success).toBe(false)
      expect(schema.safeParse({ shiftId: 0 }).success).toBe(false)
      expect(schema.safeParse({ from: 'yesterday', to: 'today' }).success).toBe(false)
    }
    expect(invoiceListSchema.parse({ shiftId: 3 })).toEqual({ shiftId: 3, page: 1 })
    expect(invoiceListSchema.safeParse({ page: 2 }).success).toBe(false)
    expect(exportCsvSchema.safeParse({ shiftId: 3, kind: 'orders' }).success).toBe(true)
    expect(exportCsvSchema.safeParse({ preset: 'today', kind: 'pdf' }).success).toBe(false)
  })

  it('is a plain string for a preset, as before, and the request fields for the other two', () => {
    expect(toScopeRequest('today')).toEqual({ preset: 'today' })
    expect(toScopeRequest({ shiftId: 4 })).toEqual({ shiftId: 4 })
    expect(toScopeRequest({ from: 'a', to: 'b' })).toEqual({ from: 'a', to: 'b' })
  })
})

describe('the handlers', () => {
  const index = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
  const body = (channel: string): string => {
    const start = index.indexOf(`'${channel}',`)
    return index.slice(start, index.indexOf('ipcMain.handle(', start + 20))
  }

  it('give every report its own function the range the scope makes, and no handler works a range out itself', () => {
    expect(body('reports:sales-summary')).toContain('const range = resolveReportRange(db, validation.data)')
    expect(body('reports:sales-summary')).toContain('generateSalesSummary(db, printerSettings.taxRate, range)')
    expect(body('reports:fiscal-by-day')).toContain('generateFiscalStatusByDay(db, range)')
    expect(body('reports:fiscal-reconciliation')).toContain('generateFiscalReconciliation(db, range)')
    expect(body('reports:invoice-list')).toContain('const range = resolveReportRange(db, validation.data)')
    expect(body('reports:export-csv')).toContain('const range = resolveReportRange(db, validation.data)')
    for (const channel of ['reports:sales-summary', 'reports:fiscal-by-day', 'reports:fiscal-reconciliation', 'reports:invoice-list', 'reports:export-csv']) {
      expect(body(channel)).not.toContain('getReportRange(')
    }
  })

  it('keeps the Z report on the shift id: a shift scope gives it its shift_id, so merged and moved sales count as today', () => {
    expect(body('reports:z-report')).toContain('generateZReport(db, validation.data.shiftId, printerSettings.taxRate)')
  })
})
