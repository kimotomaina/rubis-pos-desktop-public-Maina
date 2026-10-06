/**
 * Every payment figure on the exported copy of the till's database, before and after phase 250 (docs/phase-250): the
 * readers moved onto the shared reader of payment legs must give the same figures to the cent and the same orders CSV
 * byte for byte. Runs only when `RUBIS_COPY_DIR` names the folder holding the copy and `RUBIS_GOLDEN_DIR` names where the
 * golden files are kept (outside the repository: they hold real sales). With `RUBIS_GOLDEN_WRITE=1` it writes them;
 * otherwise it compares. The copy's files are copied to a temp folder first and the copy is never written.
 */

import { describe, it, expect, vi } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../../src/main/services/database.js'
import type { ShiftRow } from '../../src/main/services/database.js'
import {
  generateDailySummary,
  generateEndOfDayReport,
  generateSalesSummary,
  generateShiftEndOfDay,
  generateZReport
} from '../../src/main/services/reports.js'
import type { ReportRange } from '../../src/main/services/reports.js'
import { resolveReportRange } from '../../src/main/services/report-scope.js'
import { buildOrdersCsv } from '../../src/main/services/reportsExport.js'
import { getShiftWindowStatus } from '../../src/main/services/shift-window-status.js'

const COPY_DIR = process.env.RUBIS_COPY_DIR
const GOLDEN_DIR = process.env.RUBIS_GOLDEN_DIR
const WRITE = process.env.RUBIS_GOLDEN_WRITE === '1'
const FILES = ['rubis-pos.db', 'rubis-pos.db-shm', 'rubis-pos.db-wal']
const TAX_RATE = 0.16
/** A time in the night window of 6 Oct, which has no shift on the copy: the window the earlier-sales figures are read in. */
const NIGHT_NOW = Date.parse('2026-10-06T19:30:00.000Z')
/** When the golden files were written under the code before phase 250 (docs/phase-250, the session record): 20:34:55 Nairobi. */
const GOLDEN_WRITTEN_AT = Date.parse('2026-10-06T17:34:55.000Z')

const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn

/** The same object with every time-of-run field and every range label removed, so two runs compare on figures alone. */
function figuresOnly(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(figuresOnly)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !/(^at$|_at$|^startIso$|^endIso$|^label$|^generatedAt$)/.test(key))
        .map(([key, inner]) => [key, figuresOnly(inner)])
    )
  }
  return value
}

const attempt = <T,>(read: () => T): T | { error: string } => {
  try {
    return read()
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Every figure the moved readers produce on this database.
 *
 * @param {RubisDatabase} db a temp copy; written to after the read-only figures
 * @returns {{ figures: unknown, csv: string }}
 */
function collect(db: RubisDatabase): { figures: unknown; csv: string } {
  const c = conn(db)
  const shifts = c.prepare('SELECT * FROM shifts ORDER BY id').all() as ShiftRow[]
  const orderIds = (c.prepare('SELECT local_id FROM orders ORDER BY local_id').all() as Array<{ local_id: number }>).map((r) => r.local_id)
  const days = (c.prepare("SELECT DISTINCT substr(datetime(created_at, '+3 hours'), 1, 10) AS day FROM orders ORDER BY day").all() as Array<{ day: string }>).map((r) => r.day)
  const dayRange = (day: string): ReportRange => resolveReportRange(db, { from: `${day} 00:00`, to: `${day} 23:59` })
  const everything: ReportRange = { startIso: '2000-01-01T00:00:00.000Z', endIso: '2100-01-01T00:00:00.000Z', label: 'all' }
  const worked = (db as unknown as { workedFiguresNow: (shift: ShiftRow) => unknown }).workedFiguresNow.bind(db)

  const read = {
    zReports: shifts.map((shift) => attempt(() => generateZReport(db, shift.id, TAX_RATE))),
    shiftEndOfDay: shifts.map((shift) => attempt(() => generateShiftEndOfDay(db, shift.id))),
    shiftSummaries: shifts.map((shift) => attempt(() => generateSalesSummary(db, TAX_RATE, resolveReportRange(db, { shiftId: shift.id })))),
    daySummaries: days.map((day) => attempt(() => generateSalesSummary(db, TAX_RATE, dayRange(day)))),
    dailySummaries: days.map((day) => attempt(() => generateDailySummary(db, TAX_RATE, dayRange(day)))),
    endOfDay: days.map((day) => attempt(() => generateEndOfDayReport(db, day))),
    workedFigures: shifts.map((shift) => attempt(() => worked(shift))),
    movePreviews: orderIds.flatMap((orderId) => shifts.map((shift) => attempt(() => db.previewSaleMove(orderId, shift.id, true)))),
    mergePreviews: shifts.flatMap((a) => shifts.filter((b) => b.id !== a.id).map((b) => attempt(() => db.previewShiftMerge(a.id, b.id, false))))
  }
  const csv = buildOrdersCsv(db, everything, TAX_RATE)

  // The writing readers, on the temp copy only. Shift #8 is the open shift of the copy.
  const admin = (c.prepare("SELECT id FROM staff WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1").get() as { id: number }).id
  const open = shifts.find((shift) => shift.status === 'open')
  const close = open ? attempt(() => db.closeShift(open.id, 5000, 20000, 300)) : null
  const insert = c.prepare("INSERT INTO orders (total, status, created_at, payment_method, shift_id) VALUES (?, 'pending_sync', ?, ?, NULL)")
  insert.run(100, '2026-10-06T18:10:00.000Z', 'cash')
  insert.run(250.5, '2026-10-06T18:20:00.000Z', 'mpesa')
  insert.run(75, '2026-10-06T18:30:00.000Z', 'card')
  const windowStatus = attempt(() => getShiftWindowStatus(db, NIGHT_NOW))
  const opened = attempt(() => db.openShift(admin, 1000, 2000, {}, NIGHT_NOW))
  const openedRow = 'shiftId' in (opened as object) ? c.prepare('SELECT starting_cash, mpesa_opening_balance FROM shifts WHERE id = ?').get((opened as { shiftId: number }).shiftId) : opened
  const repair = attempt(() => {
    const preview = db.previewSaleMove(85, 3, true)
    db.reassignSale({ orderId: 85, toShiftId: 3, managerId: admin, reason: 'Belongs to the day shift of 5 Oct', acknowledgeDifferentWindow: preview.differentWindow, override: true })
    db.addShiftCorrection({ shiftId: 3, managerId: admin, reason: 'Counted figures of the day shift of 5 Oct', startingCash: 0, endingCash: 3790, mpesaOpeningBalance: 0, mpesaClosingBalance: 19180.09, override: true })
    return 'done'
  })
  const ledgers = {
    adjustments: c.prepare('SELECT * FROM shift_adjustments ORDER BY id').all(),
    corrections: c.prepare('SELECT * FROM shift_corrections ORDER BY id').all()
  }

  return { figures: figuresOnly({ read, close, windowStatus, opened: openedRow, repair, ledgers }), csv }
}

describe.skipIf(!COPY_DIR || !GOLDEN_DIR)('payment figures on the exported copy, before and after phase 250', () => {
  it(WRITE ? 'writes the golden figures' : 'are identical to the golden figures, to the cent, and the orders CSV byte for byte', () => {
    const work = mkdtempSync(join(tmpdir(), 'rubis-legs-'))
    try {
      for (const file of FILES) {
        const source = join(COPY_DIR as string, file)
        if (existsSync(source)) copyFileSync(source, join(work, file))
      }
      const db = new RubisDatabase({ dbPath: join(work, 'rubis-pos.db') })
      db.init()
      // CHANGED (docs/phase-252). OLD: collected at the real time. Closing the open shift stamps it with the clock, so
      // from 21:10 Nairobi on 6 Oct the close fell after the three night sales and took them in, and the run no longer
      // matched its golden files. NEW: collected at the instant the golden files were written, under the old code.
      vi.useFakeTimers({ toFake: ['Date'], now: GOLDEN_WRITTEN_AT })
      let collected: { figures: unknown; csv: string }
      try {
        collected = collect(db)
      } finally {
        vi.useRealTimers()
      }
      const { figures, csv } = collected
      conn(db).close()

      const figuresFile = join(GOLDEN_DIR as string, 'payment-figures.golden.json')
      const csvFile = join(GOLDEN_DIR as string, 'orders.golden.csv')
      if (WRITE) {
        writeFileSync(figuresFile, JSON.stringify(figures, null, 1))
        writeFileSync(csvFile, csv)
        return
      }
      expect(JSON.parse(JSON.stringify(figures))).toEqual(JSON.parse(readFileSync(figuresFile, 'utf8')))
      expect(csv === readFileSync(csvFile, 'utf8')).toBe(true)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
