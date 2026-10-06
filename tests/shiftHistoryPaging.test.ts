/**
 * Shift History, newest first and one page at a time (docs/phase-245): the database orders by the time a shift began
 * (an open shift first), never by id; a page is ten shifts and the total comes with it; the handler asks for one page
 * and never for every shift. Real in-memory SQLite.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import { shiftsListSchema } from '../src/main/lib/ipcValidator.js'

const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn

function addShift(db: RubisDatabase, clockIn: string, open = false): number {
  return Number(
    conn(db)
      .prepare(
        `INSERT INTO shifts (staff_id, clock_in, clock_out, starting_cash, expected_cash, ending_cash, discrepancy, status, shift_type)
         VALUES (1, ?, ?, 0, ?, ?, ?, ?, 'day')`
      )
      .run(clockIn, open ? null : clockIn, open ? null : 0, open ? null : 0, open ? null : 0, open ? 'open' : 'closed').lastInsertRowid
  )
}

const day = (n: number): string => new Date(Date.UTC(2026, 8, 1 + n, 5, 0, 0)).toISOString()

/**
 * 25 closed shifts on days 1 to 25, inserted in a shuffled order so ids and times disagree, and an open shift whose
 * start is the oldest of all and whose id is the lowest.
 */
function shuffledFixture(): { db: RubisDatabase; open: number; expected: number[] } {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const open = addShift(db, day(0), true)
  const idByDay = new Map<number, number>()
  for (let step = 1; step <= 25; step += 1) {
    const dayNumber = ((step * 7) % 25) + 1
    idByDay.set(dayNumber, addShift(db, day(dayNumber)))
  }
  const newestFirst = Array.from({ length: 25 }, (_, index) => idByDay.get(25 - index) as number)
  return { db, open, expected: [open, ...newestFirst] }
}

describe('Shift History order', () => {
  it('is the open shift first, then the time each shift began, newest first, whatever the ids say', () => {
    const { db, expected } = shuffledFixture()

    const ids = db.listVisibleShifts(100, 0).map((shift) => shift.id)

    expect(ids).toEqual(expected)
    expect(ids.slice(1)).not.toEqual([...ids.slice(1)].sort((a, b) => b - a))
  })

  it('puts a shift recorded later for an earlier time where its time says, not at the top', () => {
    const { db } = shuffledFixture()
    const recordedLate = addShift(db, day(3).replace('05:00:00', '06:00:00'))

    const ids = db.listVisibleShifts(100, 0).map((shift) => shift.id)

    expect(ids[0]).not.toBe(recordedLate)
    expect(ids.indexOf(recordedLate)).toBeGreaterThan(20)
  })

  it('breaks a tie of two shifts that began together by id, newest first', () => {
    const db = new RubisDatabase({ dbPath: ':memory:' })
    db.init()
    const first = addShift(db, day(1))
    const second = addShift(db, day(1))

    expect(db.listVisibleShifts(10, 0).map((shift) => shift.id)).toEqual([second, first])
  })
})

describe('Shift History pages', () => {
  it('are ten shifts each, and the last holds the rest, with the total beside them', () => {
    const { db, expected } = shuffledFixture()

    const pages = [0, 10, 20].map((offset) => db.listVisibleShifts(10, offset).map((shift) => shift.id))

    expect(pages.map((page) => page.length)).toEqual([10, 10, 6])
    expect(pages.flat()).toEqual(expected)
    expect(db.countVisibleShifts()).toBe(26)
    expect(db.listVisibleShifts(10, 30)).toEqual([])
  })

  it('leave out a shift that was merged into another, in the page and in the total', () => {
    const { db, expected } = shuffledFixture()
    const absorbed = expected[5]
    conn(db)
      .prepare('INSERT INTO shift_merges (absorbed_shift_id, into_shift_id, by_staff_id, at, reason, sales_count) VALUES (?, ?, 1, ?, ?, 0)')
      .run(absorbed, expected[6], day(30), 'same window')

    expect(db.countVisibleShifts()).toBe(25)
    expect(db.listVisibleShifts(100, 0).map((shift) => shift.id)).not.toContain(absorbed)
  })
})

describe('the shifts-list handler', () => {
  const index = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
  const start = index.indexOf("'reports:shifts-list',")
  const handler = index.slice(start, index.indexOf('ipcMain.handle(', start + 20))

  it('returns one page of ten and the total, never every shift', () => {
    expect(index).toContain('const REPORTS_PAGE_SIZE = 10')
    expect(handler).toContain('const offset = (page - 1) * REPORTS_PAGE_SIZE')
    expect(handler).toContain('.listVisibleShifts(REPORTS_PAGE_SIZE, offset)')
    expect(handler).toContain('total: db.countVisibleShifts()')
    expect(handler).not.toMatch(/listShifts\(|listShiftWindows\(\)\.map|countShifts\(/)
  })

  it('takes a page number of 1 or more, and asks for page 1 when none is sent', () => {
    expect(shiftsListSchema.parse({})).toEqual({ page: 1 })
    expect(shiftsListSchema.safeParse({ page: 0 }).success).toBe(false)
    expect(shiftsListSchema.safeParse({ page: 2 }).success).toBe(true)
  })
})
