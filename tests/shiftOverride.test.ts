/**
 * The admin override of phase 243's freeze (docs/phase-244). Phase 243's rules stay the default: a sale cannot leave a
 * closed shift, and only the latest closed shift can be corrected or be given sales. One override lifts them, in the
 * database methods and not only on screen: `override: true`, an active admin's id and a reason of 10 or more characters.
 * Real in-memory SQLite, on the owner's example (yesterday morning and night closed, today open).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import { generateZReport } from '../src/main/services/reports.js'
import { moveSaleSchema, shiftCorrectionSchema, moveSalePreviewSchema } from '../src/main/lib/ipcValidator.js'
import {
  OVERRIDE_ADMIN_ONLY_MESSAGE,
  OVERRIDE_REASON_MESSAGE,
  OVERRIDE_REASON_PREFIX
} from '../src/main/lib/shiftRules.js'

const ms = (t: string): number => Date.parse(`${t}+03:00`)
const iso = (t: string): string => new Date(ms(t)).toISOString()
const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn
const count = (db: RubisDatabase, table: string): number =>
  (conn(db).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const snapshot = (db: RubisDatabase): Record<string, unknown> => ({
  corrections: count(db, 'shift_corrections'),
  adjustments: count(db, 'shift_adjustments'),
  adjustmentSales: count(db, 'shift_adjustment_sales'),
  merges: count(db, 'shift_merges'),
  placing: conn(db).prepare('SELECT local_id, shift_id FROM orders ORDER BY local_id').all()
})
const shiftIdOf = (db: RubisDatabase, orderId: number): number | null =>
  (conn(db).prepare('SELECT shift_id FROM orders WHERE local_id = ?').get(orderId) as { shift_id: number | null }).shift_id

const ADMIN = 11
const CASHIER = 12
const INACTIVE_ADMIN = 13
const REASON = 'Belongs to the day shift of 5 Oct'

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

function sale(db: RubisDatabase, at: string, total: number, shiftId: number | null, method = 'cash', status = 'synced'): number {
  return Number(
    conn(db)
      .prepare('INSERT INTO orders (total, status, created_at, payload_json, staff_id, payment_method, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(total, status, iso(at), '{}', 1, method, shiftId).lastInsertRowid
  )
}

/** Yesterday morning (closed, frozen), yesterday night (closed, the latest closed) and today (open), one cash sale each. */
function threeShifts() {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const insertStaff = conn(db).prepare('INSERT INTO staff (id, name, pin_hash, role, is_active) VALUES (?, ?, ?, ?, ?)')
  insertStaff.run(ADMIN, 'admin a', 'x', 'admin', 1)
  insertStaff.run(CASHIER, 'cashier c', 'x', 'cashier', 1)
  insertStaff.run(INACTIVE_ADMIN, 'admin gone', 'x', 'admin', 0)
  const morning = shift(db, '2026-10-05T10:00:00', '2026-10-05T17:30:00', { start: 100, ending: 300, type: 'day' })
  const night = shift(db, '2026-10-05T18:00:00', '2026-10-06T06:00:00', { start: 50, ending: 250, type: 'night' })
  const today = shift(db, '2026-10-06T09:00:00', null, { start: 20, type: 'day' })
  const m = sale(db, '2026-10-05T12:00:00', 200, morning)
  const n = sale(db, '2026-10-05T20:00:00', 200, night)
  const t = sale(db, '2026-10-06T10:00:00', 40, today)
  return { db, morning, night, today, m, n, t }
}

const move = (db: RubisDatabase, orderId: number, toShiftId: number, extra: Record<string, unknown> = {}): { fromShiftId: number; toShiftId: number } =>
  db.reassignSale({ orderId, toShiftId, managerId: ADMIN, reason: REASON, acknowledgeDifferentWindow: true, override: true, ...extra } as Parameters<RubisDatabase['reassignSale']>[0])
const correction = (shiftId: number, extra: Record<string, unknown> = {}) =>
  ({
    shiftId,
    managerId: ADMIN,
    reason: 'Recount of the drawer',
    startingCash: 1,
    endingCash: 2,
    mpesaOpeningBalance: null,
    mpesaClosingBalance: null,
    override: true,
    ...extra
  }) as Parameters<RubisDatabase['addShiftCorrection']>[0]
const reasonsOf = (db: RubisDatabase, shiftId: number): string[] => db.listShiftAdjustments(shiftId).map((row) => row.reason)

afterEach(() => vi.restoreAllMocks())

describe('Move a sale: the closed-shift rules stay the default', () => {
  it('refuses both rules without the override, says an override would lift them, and writes nothing', () => {
    const { db, morning, night, today, n, t } = threeShifts()
    const before = snapshot(db)

    expect(db.previewSaleMove(n, morning)).toMatchObject({ overridable: true, overridden: false, problem: 'Shift #2 is closed. A sale cannot be taken out of a closed shift.' })
    expect(db.previewSaleMove(t, morning)).toMatchObject({ overridable: true, problem: expect.stringContaining('not the latest closed shift') })
    expect(db.previewSaleMove(t, night).problem).toBeNull()
    expect(() => db.reassignSale({ orderId: n, toShiftId: morning, managerId: ADMIN, reason: REASON, acknowledgeDifferentWindow: true })).toThrow('closed')
    expect(() => db.reassignSale({ orderId: t, toShiftId: morning, managerId: ADMIN, reason: REASON, acknowledgeDifferentWindow: true })).toThrow('not the latest closed shift')
    expect(() => db.reassignSale({ orderId: n, toShiftId: today, managerId: ADMIN, reason: REASON, override: false })).toThrow('closed')
    expect(snapshot(db)).toEqual(before)
  })
})

describe('Move a sale: with the override', () => {
  it('lets an admin take a sale out of a closed shift and give one to a frozen shift, and marks the reason on both shifts', () => {
    const { db, morning, night, n } = threeShifts()

    expect(move(db, n, morning)).toEqual({ fromShiftId: night, toShiftId: morning })

    expect(shiftIdOf(db, n)).toBe(morning)
    expect(reasonsOf(db, night)).toEqual([`${OVERRIDE_REASON_PREFIX}${REASON}`])
    expect(reasonsOf(db, morning)).toEqual([`${OVERRIDE_REASON_PREFIX}${REASON}`])
    expect(db.listShiftAdjustments(night)[0]).toMatchObject({ kind: 'reassign_out', by_staff_id: ADMIN, peer_shift_id: morning })
    expect(db.listShiftAdjustments(morning)[0]).toMatchObject({ kind: 'reassign_in', by_staff_id: ADMIN, peer_shift_id: night })
    expect(generateZReport(db, morning, 0.16).adjustments?.[0].reason).toBe(`OVERRIDE (closed, not latest): ${REASON}`)
  })

  it('takes a sale out of a frozen closed shift into the open one', () => {
    const { db, morning, today, m } = threeShifts()

    expect(move(db, m, today)).toEqual({ fromShiftId: morning, toShiftId: today })

    expect(shiftIdOf(db, m)).toBe(today)
    expect(reasonsOf(db, morning)[0].startsWith(OVERRIDE_REASON_PREFIX)).toBe(true)
  })

  it('stores a move that needed no override as it is: the mark means a rule was lifted', () => {
    const { db, night, today, t } = threeShifts()

    move(db, t, night)

    expect(reasonsOf(db, night)).toEqual([REASON])
    expect(reasonsOf(db, today)).toEqual([REASON])
  })

  it('previews it with the rules lifted, so the screen can show both shifts afterwards', () => {
    const { db, morning, n } = threeShifts()

    const preview = db.previewSaleMove(n, morning, true)

    expect(preview).toMatchObject({ problem: null, overridden: true, overridable: false })
    expect(preview.from).not.toBeNull()
    expect(preview.to).not.toBeNull()
  })

  it('is refused for an id that is not an active admin, even when a rule would be lifted', () => {
    const { db, morning, n, t } = threeShifts()
    const before = snapshot(db)

    for (const managerId of [CASHIER, INACTIVE_ADMIN, 999]) {
      expect(() => move(db, n, morning, { managerId })).toThrow(OVERRIDE_ADMIN_ONLY_MESSAGE)
      expect(() => move(db, t, morning, { managerId })).toThrow(OVERRIDE_ADMIN_ONLY_MESSAGE)
    }
    expect(snapshot(db)).toEqual(before)
  })

  it('needs a reason of 10 or more characters once trimmed, and a blank reason is still refused', () => {
    const { db, morning, n } = threeShifts()
    const before = snapshot(db)

    expect(() => move(db, n, morning, { reason: 'too short' })).toThrow(OVERRIDE_REASON_MESSAGE)
    expect(() => move(db, n, morning, { reason: '   short    ' })).toThrow(OVERRIDE_REASON_MESSAGE)
    expect(() => move(db, n, morning, { reason: '   ' })).toThrow('A reason is required to move a sale')
    expect(snapshot(db)).toEqual(before)

    expect(() => move(db, n, morning, { reason: '0123456789' })).not.toThrow()
  })

  it('still refuses a voided sale, a missing order, a sale with no shift, the same shift and a missing shift', () => {
    const { db, morning, night, n } = threeShifts()
    const voided = sale(db, '2026-10-05T21:00:00', 5, night, 'cash', 'voided')
    const unattached = sale(db, '2026-10-05T21:30:00', 5, null)
    const before = snapshot(db)

    expect(() => move(db, voided, morning)).toThrow(`Order #${voided} was voided`)
    expect(() => move(db, 999, morning)).toThrow('Order #999 does not exist')
    expect(() => move(db, unattached, morning)).toThrow('has no shift')
    expect(() => move(db, n, night)).toThrow(`already in shift #${night}`)
    expect(() => move(db, n, 999)).toThrow('Shift 999 not found')
    expect(snapshot(db)).toEqual(before)
  })

  it('run twice is refused the second time and changes nothing', () => {
    const { db, morning, n } = threeShifts()
    move(db, n, morning)
    const after = snapshot(db)

    expect(() => move(db, n, morning)).toThrow(`already in shift #${morning}`)
    expect(snapshot(db)).toEqual(after)
  })

  it('is all or nothing: a failure while recording leaves the sale where it was', () => {
    const { db, night, morning, n } = threeShifts()
    const before = snapshot(db)
    vi.spyOn(db as unknown as { recordAdjustment: (...args: unknown[]) => number }, 'recordAdjustment').mockImplementation(() => {
      throw new Error('disk full')
    })

    expect(() => move(db, n, morning)).toThrow('disk full')

    vi.restoreAllMocks()
    expect(shiftIdOf(db, n)).toBe(night)
    expect(snapshot(db)).toEqual(before)
  })
})

describe('Correct figures: the freeze stays the default', () => {
  it('refuses a frozen shift without the override, and with override: false', () => {
    const { db, morning } = threeShifts()
    const before = snapshot(db)

    expect(() => db.addShiftCorrection(correction(morning, { override: undefined }))).toThrow('not the latest closed shift')
    expect(() => db.addShiftCorrection(correction(morning, { override: false }))).toThrow('not the latest closed shift')
    expect(snapshot(db)).toEqual(before)
  })
})

describe('Correct figures: with the override', () => {
  it('lets an admin correct a closed shift that is not the latest, and marks the stored reason', () => {
    const { db, morning } = threeShifts()
    const shiftBefore = db.getShiftById(morning)

    const row = db.addShiftCorrection(correction(morning))

    expect(row.reason).toBe('OVERRIDE (closed, not latest): Recount of the drawer')
    expect(row).toMatchObject({ shift_id: morning, corrected_by_staff_id: ADMIN, starting_cash: 1, ending_cash: 2, expected_cash: 201 })
    expect(db.getShiftById(morning)).toEqual(shiftBefore)
    expect(generateZReport(db, morning, 0.16).corrections?.[0].reason).toBe('OVERRIDE (closed, not latest): Recount of the drawer')
  })

  it('is refused for an id that is not an active admin', () => {
    const { db, morning } = threeShifts()
    const before = snapshot(db)

    for (const managerId of [CASHIER, INACTIVE_ADMIN, 999]) {
      expect(() => db.addShiftCorrection(correction(morning, { managerId }))).toThrow(OVERRIDE_ADMIN_ONLY_MESSAGE)
    }
    expect(snapshot(db)).toEqual(before)
  })

  it('needs a reason of 10 or more characters, and a blank reason is still refused', () => {
    const { db, morning } = threeShifts()
    const before = snapshot(db)

    expect(() => db.addShiftCorrection(correction(morning, { reason: 'too short' }))).toThrow(OVERRIDE_REASON_MESSAGE)
    expect(() => db.addShiftCorrection(correction(morning, { reason: '  ' }))).toThrow('A reason is required to correct a shift')
    expect(snapshot(db)).toEqual(before)
  })

  it('still refuses an open shift and a missing shift', () => {
    const { db, today } = threeShifts()
    const before = snapshot(db)

    expect(() => db.addShiftCorrection(correction(today))).toThrow('is still open')
    expect(() => db.addShiftCorrection(correction(999))).toThrow('Shift 999 not found')
    expect(snapshot(db)).toEqual(before)
  })

  it('stores a correction of the latest closed shift as it is, override or not', () => {
    const { db, night } = threeShifts()

    expect(db.addShiftCorrection(correction(night)).reason).toBe('Recount of the drawer')
  })

  it('works with a normal correction of the latest closed shift after it, and refuses a repeat as nothing changed', () => {
    const { db, morning, night } = threeShifts()

    const forced = db.addShiftCorrection(correction(morning))
    const normal = db.addShiftCorrection(correction(night, { override: undefined, reason: 'Recount' }))

    expect(forced.reason.startsWith(OVERRIDE_REASON_PREFIX)).toBe(true)
    expect(normal.reason).toBe('Recount')
    expect(db.listShiftCorrections(morning)).toHaveLength(1)
    expect(db.listShiftCorrections(night)).toHaveLength(1)
    expect(() => db.addShiftCorrection(correction(morning))).toThrow('Nothing has changed from the current figures')
    expect(db.listShiftCorrections(morning)).toHaveLength(1)
  })
})

describe('the till never uses the override', () => {
  it('files a late sale into a frozen shift by its own rule: no override mark, nobody named', () => {
    const { db, morning } = threeShifts()
    const late = sale(db, '2026-10-05T17:20:00', 15, null)

    db.autoAssignUnattachedSales(ms('2026-10-06T12:00:00'))

    expect(shiftIdOf(db, late)).toBe(morning)
    const auto = db.listShiftAdjustments(morning).filter((row) => row.kind === 'auto')
    expect(auto).toHaveLength(1)
    expect(auto[0].reason.startsWith(OVERRIDE_REASON_PREFIX)).toBe(false)
    expect(auto[0].by_staff_id).toBeNull()
  })

  it('has no override in the automatic code at all', () => {
    const database = readFileSync(join(process.cwd(), 'src', 'main', 'services', 'database.ts'), 'utf8').replace(/\r\n/g, '\n')
    const auto = database.slice(database.indexOf('autoAssignUnattachedSales(nowMs: number'), database.indexOf('this.autoAssigning = false'))

    expect(auto.length).toBeGreaterThan(500)
    expect(auto).not.toMatch(/override|OVERRIDE|previewSaleMove|reassignSale/)
  })
})

describe('what is enforced in the main process', () => {
  const index = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
  const body = (channel: string): string => {
    const start = index.indexOf(`'${channel}',`)
    return index.slice(start, index.indexOf('ipcMain.handle(', start + 20))
  }

  it('re-verifies the admin PIN before either write, and passes the override on', () => {
    for (const [channel, call] of [['shifts:move-sale', 'db.reassignSale('], ['shifts:correct', 'db.addShiftCorrection(']] as const) {
      const handler = body(channel)
      expect(handler.indexOf('requireAdminPin(db, validation.data.managerId, validation.data.managerPin)')).toBeGreaterThan(-1)
      expect(handler.indexOf('requireAdminPin(')).toBeLessThan(handler.indexOf(call))
      expect(handler).toContain('override: data.override')
    }
    expect(body('shifts:move-sale-preview')).toContain('validation.data.override === true')
  })

  it('checks the admin and the reason in the database methods, not only in the handlers', () => {
    const database = readFileSync(join(process.cwd(), 'src', 'main', 'services', 'database.ts'), 'utf8').replace(/\r\n/g, '\n')

    expect(database.split('if (input.override === true) this.requireOverrideAllowed(input.managerId, reason)')).toHaveLength(3)
  })

  it('takes override as an optional boolean in the three requests, and nothing else', () => {
    const move = { managerId: 2, managerPin: '1', orderId: 1, toShiftId: 2, reason: 'r' }
    const fix = { managerId: 2, managerPin: '1', shiftId: 1, startingCash: 0, endingCash: 0, mpesaOpeningBalance: null, mpesaClosingBalance: null, reason: 'r' }

    expect(moveSaleSchema.safeParse({ ...move, override: true }).success).toBe(true)
    expect(moveSaleSchema.safeParse(move).success).toBe(true)
    expect(moveSaleSchema.safeParse({ ...move, override: 'yes' }).success).toBe(false)
    expect(shiftCorrectionSchema.safeParse({ ...fix, override: true }).success).toBe(true)
    expect(shiftCorrectionSchema.safeParse({ ...fix, override: 1 }).success).toBe(false)
    expect(moveSalePreviewSchema.safeParse({ orderId: 1, toShiftId: 2, override: true }).success).toBe(true)
  })
})
