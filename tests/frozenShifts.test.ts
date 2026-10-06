/**
 * A closed shift keeps its sales, and only the latest closed shift can be updated (docs/phase-243). With a morning shift
 * and a night shift yesterday and a shift open today, only yesterday's night can be corrected or be given sales; the
 * morning is frozen. The till's own automatic assignment and merge are not people and are not held to this.
 * Real in-memory SQLite.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'

const ms = (t: string): number => Date.parse(`${t}+03:00`)
const iso = (t: string): string => new Date(ms(t)).toISOString()
const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn
const count = (db: RubisDatabase, table: string): number =>
  (conn(db).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const snapshot = (db: RubisDatabase): Record<string, number> => ({
  corrections: count(db, 'shift_corrections'),
  adjustments: count(db, 'shift_adjustments'),
  merges: count(db, 'shift_merges'),
  inShift: (conn(db).prepare('SELECT COUNT(*) AS n FROM orders WHERE shift_id IS NOT NULL').get() as { n: number }).n
})
const shiftIdOf = (db: RubisDatabase, orderId: number): number | null =>
  (conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(orderId) as { shift_id: number | null }).shift_id

function shift(db: RubisDatabase, inn: string, out: string | null, v: { start?: number; ending?: number; type?: 'day' | 'night' } = {}): number {
  return Number(
    conn(db)
      .prepare(
        `INSERT INTO shifts (staff_id, clock_in, clock_out, starting_cash, expected_cash, ending_cash, discrepancy, status, shift_type)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(iso(inn), out ? iso(out) : null, v.start ?? 0, out ? (v.start ?? 0) : null, out ? (v.ending ?? 0) : null, out ? (v.ending ?? 0) - (v.start ?? 0) : null, out ? 'closed' : 'open', v.type ?? 'night')
      .lastInsertRowid
  )
}

function sale(db: RubisDatabase, at: string, total: number, shiftId: number | null, method = 'cash'): number {
  return Number(
    conn(db)
      .prepare('INSERT INTO orders (total, status, created_at, payload_json, staff_id, payment_method, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(total, 'synced', iso(at), '{}', 1, method, shiftId).lastInsertRowid
  )
}

/** Yesterday morning (closed), yesterday night (closed), and today's shift (open), each with one cash sale. */
function threeShifts() {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const morning = shift(db, '2026-10-05T10:00:00', '2026-10-05T17:30:00', { start: 100, ending: 300, type: 'day' })
  const night = shift(db, '2026-10-05T18:00:00', '2026-10-06T06:00:00', { start: 50, ending: 250, type: 'night' })
  const today = shift(db, '2026-10-06T09:00:00', null, { start: 20, type: 'day' })
  const m = sale(db, '2026-10-05T12:00:00', 200, morning)
  const n = sale(db, '2026-10-05T20:00:00', 200, night)
  const t = sale(db, '2026-10-06T10:00:00', 40, today)
  return { db, morning, night, today, m, n, t }
}

const correction = (shiftId: number) => ({
  shiftId,
  managerId: 2,
  reason: 'recount',
  startingCash: 1,
  endingCash: 2,
  mpesaOpeningBalance: null,
  mpesaClosingBalance: null
})

describe('the latest closed shift', () => {
  it('is the closed shift opened last: yesterday night, with today\'s shift still open', () => {
    const { db, night } = threeShifts()

    expect(db.latestClosedShiftId()).toBe(night)
  })

  it('moves on to today\'s shift when it closes, and yesterday night is frozen from then', () => {
    const { db, morning, night, today } = threeShifts()

    db.closeShift(today, 60)

    expect(db.latestClosedShiftId()).toBe(today)
    const frozen = (id: number): boolean => db.isFrozenShift(db.getShiftById(id)!)
    expect([morning, night, today].map(frozen)).toEqual([true, true, false])
  })

  it('is null when nothing is closed, and never an open shift', () => {
    const db = new RubisDatabase({ dbPath: ':memory:' })
    db.init()
    expect(db.latestClosedShiftId()).toBeNull()
    const open = shift(db, '2026-10-06T09:00:00', null)

    expect(db.latestClosedShiftId()).toBeNull()
    expect(db.isFrozenShift(db.getShiftById(open)!)).toBe(false)
  })

  it('leaves out a shift that was merged into another', () => {
    const db = new RubisDatabase({ dbPath: ':memory:' })
    db.init()
    const older = shift(db, '2026-10-05T10:00:00', '2026-10-05T17:30:00', { type: 'day' })
    const absorbed = shift(db, '2026-10-06T18:00:00', '2026-10-06T18:10:00')
    const open = shift(db, '2026-10-06T20:00:00', null)
    expect(db.latestClosedShiftId()).toBe(absorbed)

    db.mergeShifts({ absorbedShiftId: absorbed, intoShiftId: open, managerId: 2, reason: 'one window' }, ms('2026-10-06T21:00:00'))

    expect(db.latestClosedShiftId()).toBe(older)
  })
})

describe('correcting a closed shift', () => {
  it('is allowed on the latest closed shift only: yesterday night, not yesterday morning', () => {
    const { db, morning, night } = threeShifts()
    const before = snapshot(db)

    expect(() => db.addShiftCorrection(correction(morning), ms('2026-10-06T11:00:00'))).toThrow(
      `Shift #${morning} is closed and is not the latest closed shift (#${night}). Only the latest closed shift can be corrected or be given sales.`
    )
    expect(snapshot(db)).toEqual(before)
    expect(() => db.addShiftCorrection(correction(night), ms('2026-10-06T11:00:00'))).not.toThrow()
    expect(count(db, 'shift_corrections')).toBe(1)
  })

  it('stops being allowed on yesterday night once today\'s shift closes, and starts on today\'s', () => {
    const { db, night, today } = threeShifts()
    db.closeShift(today, 60)

    expect(() => db.addShiftCorrection(correction(night), ms('2026-10-06T20:00:00'))).toThrow('not the latest closed shift')
    expect(() => db.addShiftCorrection(correction(today), ms('2026-10-06T20:00:00'))).not.toThrow()
  })

  it('still refuses an open shift as before', () => {
    const { db, today } = threeShifts()

    expect(() => db.addShiftCorrection(correction(today), ms('2026-10-06T11:00:00'))).toThrow('is still open')
  })
})

describe('moving a sale', () => {
  it('never takes a sale out of a closed shift, by hand, and says why; nothing is written', () => {
    const { db, night, m, n } = threeShifts()
    const before = snapshot(db)

    expect(db.previewSaleMove(m, night).problem).toBe('Shift #1 is closed. A sale cannot be taken out of a closed shift.')
    expect(() => db.reassignSale({ orderId: m, toShiftId: night, managerId: 2, reason: 'x', acknowledgeDifferentWindow: true })).toThrow(
      'A sale cannot be taken out of a closed shift.'
    )
    expect(() => db.reassignSale({ orderId: n, toShiftId: 1, managerId: 2, reason: 'x', acknowledgeDifferentWindow: true })).toThrow('closed')
    expect(snapshot(db)).toEqual(before)
    expect(shiftIdOf(db, m)).toBe(1)
  })

  it('can take a sale out of the open shift, into the latest closed shift: yesterday night', () => {
    const { db, night, today, t } = threeShifts()

    db.reassignSale({ orderId: t, toShiftId: night, managerId: 2, reason: 'rung up on the wrong shift', acknowledgeDifferentWindow: true })

    expect(shiftIdOf(db, t)).toBe(night)
    expect(db.listShiftAdjustments(today).filter((r) => r.kind === 'reassign_out')).toHaveLength(1)
  })

  it('will not give a sale to an older closed shift: yesterday morning is frozen', () => {
    const { db, morning, night, t } = threeShifts()
    const before = snapshot(db)

    expect(db.previewSaleMove(t, morning).problem).toBe(
      `Shift #${morning} is closed and is not the latest closed shift (#${night}). Only the latest closed shift can be corrected or be given sales.`
    )
    expect(() => db.reassignSale({ orderId: t, toShiftId: morning, managerId: 2, reason: 'x', acknowledgeDifferentWindow: true })).toThrow(
      'not the latest closed shift'
    )
    expect(snapshot(db)).toEqual(before)
  })
})

describe('merging shifts by hand', () => {
  it('cannot merge into a closed shift that is not the latest closed one, but the sales may leave the absorbed closed shift', () => {
    const db = new RubisDatabase({ dbPath: ':memory:' })
    db.init()
    const a = shift(db, '2026-10-03T18:00:00', '2026-10-03T18:10:00')
    const b = shift(db, '2026-10-03T19:00:00', '2026-10-03T19:10:00') // an older pair in one window
    const latest = shift(db, '2026-10-05T18:00:00', '2026-10-05T19:00:00')
    sale(db, '2026-10-03T18:05:00', 10, a)

    expect(db.previewShiftMerge(a, b).problem).toContain('not the latest closed shift')
    expect(() => db.mergeShifts({ absorbedShiftId: a, intoShiftId: b, managerId: 2, reason: 'x' })).toThrow('not the latest closed shift')

    const c = shift(db, '2026-10-05T19:30:00', '2026-10-05T20:30:00') // now c is the latest closed, in the window of `latest`
    expect(db.latestClosedShiftId()).toBe(c)
    sale(db, '2026-10-05T18:05:00', 20, latest)
    expect(db.previewShiftMerge(latest, c).problem).toBeNull()
    expect(db.mergeShifts({ absorbedShiftId: latest, intoShiftId: c, managerId: 2, reason: 'one window' }).salesCount).toBe(1)
  })

  it('is not held against the till: its own merge of an older pair still happens', () => {
    const db = new RubisDatabase({ dbPath: ':memory:' })
    db.init()
    const a = shift(db, '2026-10-03T18:00:00', '2026-10-03T18:10:00')
    const b = shift(db, '2026-10-03T19:00:00', '2026-10-03T19:10:00')
    shift(db, '2026-10-05T10:00:00', '2026-10-05T17:30:00', { type: 'day' })
    sale(db, '2026-10-03T18:05:00', 10, a)

    expect(db.autoMergeSameWindowShifts(ms('2026-10-06T10:00:00')).merged).toEqual([{ absorbedShiftId: a, intoShiftId: b, salesCount: 1 }])
  })
})

describe('the till\'s own assignment is not held to it', () => {
  it('still files a late sale into its window\'s shift, though that shift is frozen', () => {
    const { db, morning } = threeShifts()
    const late = sale(db, '2026-10-05T17:20:00', 15, null) // a late sale in the morning shift's window

    db.autoAssignUnattachedSales(ms('2026-10-06T12:00:00'))

    expect(shiftIdOf(db, late)).toBe(morning)
    expect(db.listShiftAdjustments(morning).some((r) => r.kind === 'auto')).toBe(true)
  })
})

describe('what the screens are told', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
  const body = (channel: string): string => {
    const start = source.indexOf(`'${channel}',`)
    return source.slice(start, source.indexOf('ipcMain.handle(', start + 20))
  }

  it('marks a frozen shift in the shift list and in its Z report', () => {
    expect(body('reports:shifts-list')).toContain('latestClosedShiftId()')
    expect(body('reports:shifts-list')).toContain('frozen: true as const')
    expect(body('reports:z-report')).toContain('db.isFrozenShift(shift)')
  })

  it('is enforced in the main process: the database methods refuse, not only the screens', () => {
    const database = readFileSync(join(process.cwd(), 'src', 'main', 'services', 'database.ts'), 'utf8').replace(/\r\n/g, '\n')

    expect(database).toContain('closedShiftKeepsSalesMessage(from.id)')
    // CHANGED (docs/phase-244). Old: `if (this.isFrozenShift(shift)) {` and `if (this.isFrozenShift(to)) return`. New: the same
    // two refusals, now lifted only by an admin's override (shiftOverride.test.ts).
    expect(database).toContain('if (overridden && input.override !== true) {\n        throw new Error(frozenShiftMessage(')
    expect(database).toContain('this.isFrozenShift(to)\n          ? frozenShiftMessage(')
  })
})
