/**
 * The card settlement counted at close (docs/phase-246, R5): a third counted figure beside cash and M-Pesa, kept on the
 * shift, on its corrections and on the adjustment ledger, shown on the Z report on screen and on paper, and "Not
 * recorded", never 0, when nobody counted it. Real in-memory and file SQLite.
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import { generateZReport, type ZReport } from '../src/main/services/reports.js'
import { renderZReport, type ThermalPrinterLike } from '../src/main/services/printer.js'
import { closeShiftUnlessHeld } from '../src/main/services/held-sales.js'
import { shiftCloseSchema, shiftCorrectionSchema } from '../src/main/lib/ipcValidator.js'
import { workShiftFigures, sameEnteredFigures } from '../src/main/lib/shiftFigures.js'
import { zReportCardLines } from '../src/main/lib/zReportCard.js'
import { zReportCardLines as rendererCardLines } from '../src/renderer/src/lib/zReportCard.js'
import { zReportCorrectionBlocks } from '../src/main/lib/zReportCorrections.js'
import { zReportCorrectionBlocks as rendererCorrectionBlocks } from '../src/renderer/src/lib/zReportCorrections.js'

const ms = (t: string): number => Date.parse(`${t}+03:00`)
const iso = (t: string): string => new Date(ms(t)).toISOString()
const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn
const money = (amount: number): string => `Ksh ${amount.toFixed(2)}`

function openShift(db: RubisDatabase, start = 100): number {
  return Number(
    conn(db)
      .prepare("INSERT INTO shifts (staff_id, clock_in, starting_cash, status, shift_type) VALUES (1, ?, ?, 'open', 'day')")
      .run(iso('2026-10-06T09:00:00'), start).lastInsertRowid
  )
}

function sale(db: RubisDatabase, shiftId: number | null, total: number, method: string, status = 'synced'): number {
  return Number(
    conn(db)
      .prepare('INSERT INTO orders (total, status, created_at, payload_json, staff_id, payment_method, shift_id) VALUES (?, ?, ?, ?, 1, ?, ?)')
      .run(total, status, iso('2026-10-06T10:00:00'), '{}', method, shiftId).lastInsertRowid
  )
}

/** A shift with cash 500, M-Pesa 300, card 1,200 and 800 (and a voided card sale of 999 that counts nowhere). */
function shiftWithSales() {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const id = openShift(db)
  sale(db, id, 500, 'cash')
  sale(db, id, 300, 'mpesa')
  sale(db, id, 1200, 'card')
  sale(db, id, 800, 'card')
  sale(db, id, 999, 'card', 'voided')
  return { db, id }
}

const shiftOf = (db: RubisDatabase, id: number): Record<string, unknown> => conn(db).prepare('SELECT * FROM shifts WHERE id = ?').get(id) as Record<string, unknown>
const cardColumns = (c: SqliteConnection, table: string): string[] =>
  (c.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((col) => col.name).filter((name) => ['card_closing_balance', 'card_expected', 'card_difference'].includes(name))

describe('the migration', () => {
  it('adds the three card columns to the shift, its corrections and its adjustment ledger, and is safe to run again and again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rubis-card-'))
    try {
      const path = join(dir, 'rubis-pos.db')
      const first = new RubisDatabase({ dbPath: path })
      first.init()
      const id = openShift(first)
      sale(first, id, 500, 'cash')
      first.closeShift(id, 600)
      conn(first).close()

      // Make it a database from before the phase: no card columns anywhere.
      const old = new BetterSqlite3(path)
      for (const table of ['shifts', 'shift_corrections', 'shift_adjustments']) {
        for (const column of ['card_closing_balance', 'card_expected', 'card_difference']) old.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
        expect(cardColumns(old, table)).toEqual([])
      }
      old.close()

      for (let run = 0; run < 3; run += 1) {
        const db = new RubisDatabase({ dbPath: path })
        expect(() => db.init()).not.toThrow()
        for (const table of ['shifts', 'shift_corrections', 'shift_adjustments']) {
          expect(cardColumns(conn(db), table)).toEqual(['card_closing_balance', 'card_expected', 'card_difference'])
        }
        expect(shiftOf(db, id)).toMatchObject({ ending_cash: 600, status: 'closed', card_closing_balance: null, card_expected: null, card_difference: null })
        conn(db).close()
      }
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch {
        // Windows may still hold the WAL files for a moment; the folder is in the temp directory and is not the test's subject.
      }
    }
  })

  it('makes the same columns in a new database, and a second init on it changes nothing', () => {
    const db = new RubisDatabase({ dbPath: ':memory:' })
    db.init()

    expect(cardColumns(conn(db), 'shifts')).toEqual(['card_closing_balance', 'card_expected', 'card_difference'])
    expect(() => db.init()).not.toThrow()
  })
})

describe('closing a shift with a card figure', () => {
  it('stores what was counted, the shift\'s card sales (voided left out) and the difference', () => {
    const { db, id } = shiftWithSales()

    const result = db.closeShift(id, 600, null, 1900)

    expect(shiftOf(db, id)).toMatchObject({ status: 'closed', card_closing_balance: 1900, card_expected: 2000, card_difference: -100 })
    expect(result).toMatchObject({ expectedCash: 600, discrepancy: 0, cardExpected: 2000, cardDifference: -100 })
  })

  it('keeps a blank figure as not recorded, all three columns NULL, and never 0; a counted 0 is 0', () => {
    const blank = shiftWithSales()
    const zero = shiftWithSales()

    const result = blank.db.closeShift(blank.id, 600)
    zero.db.closeShift(zero.id, 600, null, 0)

    expect(shiftOf(blank.db, blank.id)).toMatchObject({ card_closing_balance: null, card_expected: null, card_difference: null })
    expect(Object.keys(result)).not.toContain('cardExpected')
    expect(shiftOf(zero.db, zero.id)).toMatchObject({ card_closing_balance: 0, card_expected: 2000, card_difference: -2000 })
  })

  it('is refused a second time and changes no row', () => {
    const { db, id } = shiftWithSales()
    db.closeShift(id, 600, null, 2000)
    const before = JSON.stringify([shiftOf(db, id), conn(db).prepare('SELECT * FROM shift_corrections').all(), conn(db).prepare('SELECT * FROM shift_adjustments').all()])

    expect(() => db.closeShift(id, 650, null, 1)).toThrow('already closed')

    expect(JSON.stringify([shiftOf(db, id), conn(db).prepare('SELECT * FROM shift_corrections').all(), conn(db).prepare('SELECT * FROM shift_adjustments').all()])).toBe(before)
  })

  it('passes through the held-sales guard, as the last argument so every other call keeps its meaning', () => {
    const closeShift = vi.fn(() => ({ expectedCash: 1, discrepancy: 0, mpesaExpected: null, mpesaDifference: null }))
    const guarded = { closeShift, listOpenHeldSales: () => [], getShiftById: () => undefined }

    closeShiftUnlessHeld(guarded, 3, 100, 640, Date.now(), 2500)
    closeShiftUnlessHeld(guarded, 3, 100)

    expect(closeShift).toHaveBeenNthCalledWith(1, 3, 100, 640, 2500)
    expect(closeShift).toHaveBeenNthCalledWith(2, 3, 100, null, null)
  })

  it('takes the figure at the IPC boundary as an optional amount of 0 or more', () => {
    const base = { shiftId: 1, endingCash: 10 }

    expect(shiftCloseSchema.safeParse(base).success).toBe(true)
    expect(shiftCloseSchema.safeParse({ ...base, cardClosingBalance: null }).success).toBe(true)
    expect(shiftCloseSchema.safeParse({ ...base, cardClosingBalance: 0 }).success).toBe(true)
    expect(shiftCloseSchema.safeParse({ ...base, cardClosingBalance: -1 }).success).toBe(false)
    expect(shiftCloseSchema.safeParse({ ...base, cardClosingBalance: 'x' }).success).toBe(false)
    const fix = { managerId: 2, managerPin: '1', shiftId: 1, startingCash: 0, endingCash: 0, mpesaOpeningBalance: null, mpesaClosingBalance: null, reason: 'r' }
    expect(shiftCorrectionSchema.safeParse(fix).success).toBe(true)
    expect(shiftCorrectionSchema.safeParse({ ...fix, cardClosingBalance: 1500 }).success).toBe(true)
    expect(shiftCorrectionSchema.safeParse({ ...fix, cardClosingBalance: -5 }).success).toBe(false)
  })
})

describe('the figures', () => {
  it('work card expected and difference only with a counted figure, and tell a changed card figure from an unchanged one', () => {
    const entered = { startingCash: 100, endingCash: 600, mpesaOpeningBalance: null, mpesaClosingBalance: null }

    expect(workShiftFigures(entered, 500, 300, 2000)).toEqual({ expectedCash: 600, discrepancy: 0, mpesaExpected: null, mpesaDifference: null })
    expect(workShiftFigures({ ...entered, cardClosingBalance: 1900 }, 500, 300, 2000)).toMatchObject({ cardExpected: 2000, cardDifference: -100 })
    expect(workShiftFigures({ ...entered, cardClosingBalance: 0 }, 500, 300, 2000)).toMatchObject({ cardExpected: 2000, cardDifference: -2000 })
    expect(sameEnteredFigures(entered, { ...entered, cardClosingBalance: null })).toBe(true)
    expect(sameEnteredFigures(entered, { ...entered, cardClosingBalance: 0 })).toBe(false)
    expect(sameEnteredFigures({ ...entered, cardClosingBalance: 5 }, { ...entered, cardClosingBalance: 6 })).toBe(false)
  })
})

describe('corrections with a card figure', () => {
  const correction = (shiftId: number, card: number | null | undefined, extra: Record<string, unknown> = {}) =>
    ({ shiftId, managerId: 2, reason: 'Counted the PDQ slip', startingCash: 100, endingCash: 600, mpesaOpeningBalance: null, mpesaClosingBalance: null, ...(card === undefined ? {} : { cardClosingBalance: card }), ...extra }) as Parameters<RubisDatabase['addShiftCorrection']>[0]

  it('stores the counted card figure with the shift\'s card sales and the difference, worked now', () => {
    const { db, id } = shiftWithSales()
    db.closeShift(id, 600)

    const row = db.addShiftCorrection(correction(id, 2050))

    expect(row).toMatchObject({ card_closing_balance: 2050, card_expected: 2000, card_difference: 50 })
    expect(conn(db).prepare('SELECT card_closing_balance, card_expected, card_difference FROM shift_corrections').get()).toEqual({ card_closing_balance: 2050, card_expected: 2000, card_difference: 50 })
  })

  it('counts a card figure alone as a change, refuses a repeat, and a later one without it clears it, never to 0', () => {
    const { db, id } = shiftWithSales()
    db.closeShift(id, 600)
    db.addShiftCorrection(correction(id, 2050))

    expect(() => db.addShiftCorrection(correction(id, 2050))).toThrow('Nothing has changed from the current figures')
    const cleared = db.addShiftCorrection(correction(id, undefined))
    expect(cleared).toMatchObject({ card_closing_balance: null, card_expected: null, card_difference: null })
    expect(db.listShiftCorrections(id)).toHaveLength(2)
  })

  it('refuses a card figure below 0, writing nothing', () => {
    const { db, id } = shiftWithSales()
    db.closeShift(id, 600)

    expect(() => db.addShiftCorrection(correction(id, -1))).toThrow('0 or more')
    expect(db.listShiftCorrections(id)).toHaveLength(0)
  })

  it('shows on the Z report only when counted, in the main and the renderer twin alike', () => {
    const { db, id } = shiftWithSales()
    db.closeShift(id, 600)
    const none = generateZReport(db, id, 0.16)
    db.addShiftCorrection(correction(id, 2050))
    const counted = generateZReport(db, id, 0.16)

    expect(none.corrections).toEqual([])
    expect(counted.corrections?.[0]).toMatchObject({ cardClosingBalance: 2050, cardExpected: 2000, cardDifference: 50 })
    const blocks = zReportCorrectionBlocks(counted, money, (at) => at)
    expect(blocks[0].details).toEqual(expect.arrayContaining(['Card counted: Ksh 2050.00', 'Check against the PDQ settlement: Ksh 50.00']))
    expect(rendererCorrectionBlocks(counted, money, (at) => at)).toEqual(blocks)
    expect(zReportCorrectionBlocks(none, money, (at) => at)).toEqual([])
  })
})

describe('the adjustment ledger', () => {
  it('records the card figures a closed shift shows when a sale joins it', () => {
    const { db, id } = shiftWithSales()
    db.closeShift(id, 600, null, 2000)
    const other = openShift(db)
    const moved = sale(db, other, 250, 'card')

    db.reassignSale({ orderId: moved, toShiftId: id, managerId: 2, reason: 'Rung up on the wrong shift', acknowledgeDifferentWindow: true })

    const [row] = db.listShiftAdjustments(id)
    expect(row).toMatchObject({ kind: 'reassign_in', card_closing_balance: 2000, card_expected: 2250, card_difference: -250 })
  })

  it('leaves the card columns NULL for a shift whose card was never counted', () => {
    const { db, id } = shiftWithSales()
    db.closeShift(id, 600)
    const other = openShift(db)
    const moved = sale(db, other, 250, 'card')

    db.reassignSale({ orderId: moved, toShiftId: id, managerId: 2, reason: 'Rung up on the wrong shift', acknowledgeDifferentWindow: true })

    expect(db.listShiftAdjustments(id)[0]).toMatchObject({ card_closing_balance: null, card_expected: null, card_difference: null })
  })
})

describe('the Z report', () => {
  const closed = (extra: Partial<ZReport> = {}): ZReport => ({
    shiftId: 1,
    staffName: 'a',
    openedAt: '2026-10-06T06:00:00.000Z',
    closedAt: '2026-10-06T14:00:00.000Z',
    status: 'closed',
    startingCash: 0,
    totalsByMethod: { cash: 0, mpesa: 0, card: 0 },
    mpesaByMode: { manual: 0, daraja: 0 },
    orderCount: 0,
    totalRevenue: 0,
    vatIncluded: 0,
    vatRate: 0.16,
    expectedCash: 0,
    endingCash: 0,
    discrepancy: 0,
    ...extra
  })

  it('carries the stored figures for a closed shift, and no card keys for one that never had them', () => {
    const counted = shiftWithSales()
    counted.db.closeShift(counted.id, 600, null, 1900)
    const blank = shiftWithSales()
    blank.db.closeShift(blank.id, 600)

    expect(generateZReport(counted.db, counted.id, 0.16)).toMatchObject({ cardClosingBalance: 1900, cardExpected: 2000, cardDifference: -100 })
    const without = generateZReport(blank.db, blank.id, 0.16)
    expect(Object.keys(without)).not.toContain('cardClosingBalance')
  })

  it('words the card lines the same on screen and on paper, "Not recorded" and never 0', () => {
    const cases: ZReport[] = [
      closed(),
      closed({ cardClosingBalance: 1900, cardExpected: 2000, cardDifference: -100 }),
      closed({ cardClosingBalance: 0, cardExpected: 2000, cardDifference: -2000 }),
      closed({ status: 'open', closedAt: null })
    ]

    for (const report of cases) expect(rendererCardLines(report, money)).toEqual(zReportCardLines(report, money))
    expect(zReportCardLines(cases[0], money)).toEqual([
      { label: 'Card expected', value: 'Not recorded' },
      { label: 'Card counted', value: 'Not recorded' },
      { label: 'Check against the PDQ settlement', value: 'Not recorded' }
    ])
    expect(zReportCardLines(cases[1], money).map((line) => line.value)).toEqual(['Ksh 2000.00', 'Ksh 1900.00', 'Ksh -100.00'])
    expect(zReportCardLines(cases[2], money)[1].value).toBe('Ksh 0.00')
    expect(zReportCardLines(cases[3], money)[1].value).toBe('Pending')
  })

  it('prints the card lines under the M-Pesa lines, for a counted shift and for one that was not', () => {
    const lines = (report: ZReport): string[] => {
      const out: string[] = []
      const sink = new Proxy({} as ThermalPrinterLike, {
        get: (_t, key) => (key === 'println' ? (text: string) => out.push(String(text)) : key === 'drawLine' ? () => out.push('---') : () => undefined)
      })
      renderZReport(sink, report, { interfaceName: '', storeName: 'S', taxRate: 0.16, mock: true })
      return out.map((line) => line.replace(/ /g, ' '))
    }

    const blank = lines(closed())
    const counted = lines(closed({ cardClosingBalance: 1900, cardExpected: 2000, cardDifference: -100 }))

    expect(blank.slice(blank.indexOf('Check against the M-Pesa statement: Not recorded'))).toEqual([
      'Check against the M-Pesa statement: Not recorded',
      'Card expected: Not recorded',
      'Card counted: Not recorded',
      'Check against the PDQ settlement: Not recorded'
    ])
    expect(counted).toEqual(expect.arrayContaining(['Card expected: Ksh 2,000.00', 'Card counted: Ksh 1,900.00']))
  })
})
