/**
 * End of Day approval per shift (docs/phase-246, the amendment): a shift's manual M-Pesa entries are approved by an
 * admin once the shift is closed, with the PIN as before, once; the approval covers the shift's own entries and its
 * carry-over from earlier shifts and nothing else. Old per-day reviews stay as history. Real in-memory and file SQLite.
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import { generateShiftEndOfDay, listShiftApprovalRows, generateEndOfDayReport, getReportRange } from '../src/main/services/reports.js'
import { approveShiftReportSchema, shiftEndOfDaySchema } from '../src/main/lib/ipcValidator.js'

const ms = (t: string): number => Date.parse(`${t}+03:00`)
const iso = (t: string): string => new Date(ms(t)).toISOString()
const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn
const ADMIN = 11

function shift(db: RubisDatabase, inn: string, out: string | null, type: 'day' | 'night' = 'day'): number {
  return Number(
    conn(db)
      .prepare("INSERT INTO shifts (staff_id, clock_in, clock_out, starting_cash, status, shift_type) VALUES (1, ?, ?, 0, ?, ?)")
      .run(iso(inn), out ? iso(out) : null, out ? 'closed' : 'open', type).lastInsertRowid
  )
}

let reference = 0
/** A sale paid by M-Pesa, with its manual payment (mode, status and amount as given). */
function mpesaSale(db: RubisDatabase, shiftId: number, at: string, amount: number, extra: { mode?: 'manual' | 'daraja'; status?: string; reconciled?: boolean } = {}): { order: number; payment: number } {
  const order = Number(
    conn(db)
      .prepare("INSERT INTO orders (total, status, created_at, payload_json, staff_id, payment_method, shift_id) VALUES (?, ?, ?, '{}', 1, 'mpesa', ?)")
      .run(amount, extra.status ?? 'synced', iso(at), shiftId).lastInsertRowid
  )
  reference += 1
  const mode = extra.mode ?? 'manual'
  const payment = Number(
    conn(db)
      .prepare(
        `INSERT INTO mpesa_payments (order_local_id, mode, verification_status, reference, amount, entered_by_staff_id, created_at, reconciled_at, reconciled_by_staff_id)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
      .run(order, mode, mode === 'manual' ? 'manual_unverified' : 'confirmed', `REF${reference}`, amount, iso(at), extra.reconciled ? iso(at) : null, extra.reconciled ? 1 : null).lastInsertRowid
  )
  return { order, payment }
}

/** Two closed shifts (A then B) and an open one (C), each with manual M-Pesa entries. */
function fixture() {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const a = shift(db, '2026-10-04T09:00:00', '2026-10-04T17:00:00')
  const b = shift(db, '2026-10-05T09:00:00', '2026-10-05T17:00:00')
  const c = shift(db, '2026-10-06T09:00:00', null)
  const a1 = mpesaSale(db, a, '2026-10-04T10:00:00', 100)
  const a2 = mpesaSale(db, a, '2026-10-04T11:00:00', 200)
  const b1 = mpesaSale(db, b, '2026-10-05T10:00:00', 300)
  const b2 = mpesaSale(db, b, '2026-10-05T11:00:00', 400)
  const c1 = mpesaSale(db, c, '2026-10-06T10:00:00', 500)
  return { db, a, b, c, a1, a2, b1, b2, c1 }
}

const count = (db: RubisDatabase, table: string): number => (conn(db).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const snapshot = (db: RubisDatabase): string =>
  JSON.stringify([
    conn(db).prepare('SELECT * FROM mpesa_day_approvals ORDER BY id').all(),
    conn(db).prepare('SELECT * FROM mpesa_day_exclusions ORDER BY id').all(),
    conn(db).prepare('SELECT id, reconciled_at, reconciled_by_staff_id, reconciliation_note FROM mpesa_payments ORDER BY id').all()
  ])
const approve = (db: RubisDatabase, shiftId: number, approvedIds: number[], excluded: Array<{ paymentId: number; reason: string | null }> = [], note: string | null = null) =>
  db.approveShiftMpesa({ shiftId, approvedIds, excluded, managerId: ADMIN, note })

describe('the migration', () => {
  it('adds shift_id and its unique index, keeps a review of a day as it was, and runs again and again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rubis-approval-'))
    try {
      const path = join(dir, 'rubis-pos.db')
      const first = new RubisDatabase({ dbPath: path })
      first.init()
      conn(first)
        .prepare('INSERT INTO mpesa_day_approvals (local_day, approved_by_staff_id, approved_at, entry_count, excluded_count, total_amount, note) VALUES (?, 1, ?, 19, 0, 6025, NULL)')
        .run('2026-10-05', iso('2026-10-05T11:27:40'))
      conn(first).exec('DROP INDEX idx_mpesa_day_approvals_shift')
      conn(first).exec('ALTER TABLE mpesa_day_approvals DROP COLUMN shift_id')
      conn(first).close()

      for (let run = 0; run < 3; run += 1) {
        const db = new RubisDatabase({ dbPath: path })
        expect(() => db.init()).not.toThrow()
        const columns = (conn(db).prepare('PRAGMA table_info(mpesa_day_approvals)').all() as Array<{ name: string }>).map((c) => c.name)
        expect(columns).toContain('shift_id')
        expect(conn(db).prepare("SELECT name FROM sqlite_master WHERE name = 'idx_mpesa_day_approvals_shift'").all()).toHaveLength(1)
        expect(conn(db).prepare('SELECT local_day, entry_count, total_amount, shift_id FROM mpesa_day_approvals').all()).toEqual([
          { local_day: '2026-10-05', entry_count: 19, total_amount: 6025, shift_id: null }
        ])
        conn(db).close()
      }
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch {
        // The temp folder is not the test's subject.
      }
    }
  })

  it('lets many reviews of days (no shift) stand together, and refuses a second review of the same shift at the index', () => {
    const { db, a } = fixture()
    const insert = (shiftId: number | null): void => {
      conn(db)
        .prepare('INSERT INTO mpesa_day_approvals (local_day, approved_by_staff_id, approved_at, entry_count, excluded_count, total_amount, shift_id) VALUES (?, 1, ?, 1, 0, 1, ?)')
        .run('2026-10-05', iso('2026-10-05T12:00:00'), shiftId)
    }

    insert(null)
    insert(null)
    insert(a)

    expect(() => insert(a)).toThrow(/UNIQUE/)
  })
})

describe('the shift report', () => {
  it('holds the shift\'s own manual entries and, as carry-over, the unapproved entries of earlier shifts only', () => {
    const { db, a, b, c, a1, a2, b1, b2, c1 } = fixture()

    const forB = generateShiftEndOfDay(db, b)
    const forA = generateShiftEndOfDay(db, a)
    const forC = generateShiftEndOfDay(db, c)

    expect(forB.manualEntries.map((e) => e.paymentId)).toEqual([b1.payment, b2.payment])
    expect(forB.carryOver.map((e) => e.paymentId)).toEqual([a1.payment, a2.payment])
    expect(forA.carryOver).toEqual([])
    expect(forC.carryOver.map((e) => e.paymentId)).toEqual([a1.payment, a2.payment, b1.payment, b2.payment])
    expect(forB.pendingIds).toEqual([b1.payment, b2.payment, a1.payment, a2.payment])
    expect(forB.pendingManualTotal).toBe(1000)
    expect(forB.totalsByMethod.mpesa).toBe(700)
    expect(forC.manualEntries.map((e) => e.paymentId)).toEqual([c1.payment])
  })

  it('leaves out voided sales, entries already approved, and every entry that is not manual', () => {
    const { db, a, b } = fixture()
    const voided = mpesaSale(db, a, '2026-10-04T12:00:00', 50, { status: 'voided' })
    const done = mpesaSale(db, a, '2026-10-04T13:00:00', 60, { reconciled: true })
    const daraja = mpesaSale(db, a, '2026-10-04T14:00:00', 70, { mode: 'daraja' })

    const report = generateShiftEndOfDay(db, b)

    const ids = report.carryOver.map((e) => e.paymentId)
    expect(ids).not.toContain(voided.payment)
    expect(ids).not.toContain(daraja.payment)
    expect(report.carryOver.find((e) => e.paymentId === done.payment)).toBeUndefined()
    expect(generateShiftEndOfDay(db, a).manualEntries.map((e) => e.paymentId)).toContain(done.payment)
  })

  it('says why Approve is not offered: open, nothing pending, merged, already approved', () => {
    const { db, a, b, c } = fixture()

    expect(generateShiftEndOfDay(db, c)).toMatchObject({ canApprove: false, cannotApproveBecause: expect.stringContaining('still open') })
    const empty = shift(db, '2026-10-07T09:00:00', '2026-10-07T17:00:00')
    conn(db).prepare("UPDATE mpesa_payments SET reconciled_at = ? WHERE mode = 'manual'").run(iso('2026-10-07T18:00:00'))
    expect(generateShiftEndOfDay(db, empty)).toMatchObject({ canApprove: false, cannotApproveBecause: 'There is nothing waiting to be approved.' })
    conn(db).prepare('UPDATE mpesa_payments SET reconciled_at = NULL').run()
    expect(generateShiftEndOfDay(db, b)).toMatchObject({ canApprove: true, cannotApproveBecause: null, approval: null, shiftStatus: 'closed' })

    approve(db, a, [1])
    const done = generateShiftEndOfDay(db, a)
    expect(done).toMatchObject({ canApprove: false, approval: { entryCount: 1, excludedCount: 0, totalAmount: 100 } })
    expect(done.cannotApproveBecause).toContain('Approved by')

    conn(db).prepare('INSERT INTO shift_merges (absorbed_shift_id, into_shift_id, by_staff_id, at, reason, sales_count) VALUES (?, ?, 1, ?, ?, 0)').run(b, empty, iso('2026-10-08T09:00:00'), 'same')
    expect(generateShiftEndOfDay(db, b)).toMatchObject({ canApprove: false, mergedInto: empty, cannotApproveBecause: expect.stringContaining('merged into shift') })
  })

  it('is the day report\'s own body: the same cashier totals and entry shapes for the same sales', () => {
    const { db, a } = fixture()
    const day = generateEndOfDayReport(db, '2026-10-04')
    const shiftReport = generateShiftEndOfDay(db, a)

    expect(shiftReport.cashiers).toEqual(day.cashiers)
    expect(shiftReport.totalsByMethod).toEqual(day.totalsByMethod)
    expect(shiftReport.manualEntries).toEqual(day.manualEntries)
  })

  it('refuses a shift that does not exist', () => {
    const { db } = fixture()

    expect(() => generateShiftEndOfDay(db, 999)).toThrow('Shift 999 not found')
  })
})

describe('approving a shift', () => {
  it('approves the ticked entries of the shift and its carry-over, records who, when and for which shift, and leaves the rest pending', () => {
    const { db, a1, a2, b, b1, b2 } = fixture()

    const result = approve(db, b, [b1.payment, a1.payment], [{ paymentId: b2.payment, reason: 'not on the statement' }], 'checked')

    expect(result).toMatchObject({ approvedCount: 2, excludedCount: 1, alreadyApproved: false })
    expect(result.approval).toMatchObject({ shift_id: b, approved_by_staff_id: ADMIN, entry_count: 2, excluded_count: 1, total_amount: 400, note: 'checked', local_day: '2026-10-05' })
    const rows = conn(db).prepare('SELECT id, reconciled_by_staff_id, reconciled_at IS NOT NULL AS done FROM mpesa_payments ORDER BY id').all() as Array<{ id: number; reconciled_by_staff_id: number | null; done: number }>
    expect(rows.filter((r) => r.done === 1).map((r) => r.id)).toEqual([a1.payment, b1.payment])
    expect(rows.find((r) => r.id === a1.payment)?.reconciled_by_staff_id).toBe(ADMIN)
    expect(conn(db).prepare('SELECT payment_id, reason FROM mpesa_day_exclusions').all()).toEqual([{ payment_id: b2.payment, reason: 'not on the statement' }])
    expect(a2.payment).toBeGreaterThan(0)
    expect(generateShiftEndOfDay(db, b).pendingIds).toEqual([b2.payment, a2.payment])
  })

  it('is refused a second time, naming who and when, and changes no row', () => {
    const { db, b, b1, b2 } = fixture()
    approve(db, b, [b1.payment])
    const before = snapshot(db)

    expect(() => approve(db, b, [b2.payment])).toThrow(/Shift #\d+ was already approved by .* on /)
    expect(snapshot(db)).toBe(before)
    expect(count(db, 'mpesa_day_approvals')).toBe(1)
  })

  it('is refused for an open shift, a missing shift and a shift merged into another, writing nothing', () => {
    const { db, a, b, c, c1, a1 } = fixture()
    conn(db).prepare('INSERT INTO shift_merges (absorbed_shift_id, into_shift_id, by_staff_id, at, reason, sales_count) VALUES (?, ?, 1, ?, ?, 0)').run(a, b, iso('2026-10-08T09:00:00'), 'same')
    const before = snapshot(db)

    expect(() => approve(db, c, [c1.payment])).toThrow('is still open')
    expect(() => approve(db, 999, [1])).toThrow('Shift 999 not found')
    expect(() => approve(db, a, [a1.payment])).toThrow('was merged into shift')
    expect(snapshot(db)).toBe(before)
  })

  it('refuses every entry outside the shift and its carry-over, and the whole call with it', () => {
    const { db, a, b, c1, a1, b1 } = fixture()
    const voided = mpesaSale(db, a, '2026-10-04T12:00:00', 50, { status: 'voided' })
    const daraja = mpesaSale(db, a, '2026-10-04T14:00:00', 70, { mode: 'daraja' })
    const done = mpesaSale(db, a, '2026-10-04T15:00:00', 80, { reconciled: true })
    const before = snapshot(db)

    // A is the earlier shift: B's own entry is not A's, and neither is the open shift's (docs/phase-246: nothing outside).
    expect(() => approve(db, a, [a1.payment, b1.payment])).toThrow('not pending manual entries of this shift or its carry-over')
    expect(() => approve(db, a, [c1.payment])).toThrow('not pending manual entries of this shift or its carry-over')
    for (const outside of [voided.payment, daraja.payment, done.payment, 99999]) {
      expect(() => approve(db, b, [outside])).toThrow('not pending manual entries of this shift or its carry-over')
      expect(() => approve(db, b, [], [{ paymentId: outside, reason: null }])).toThrow('not pending manual entries of this shift or its carry-over')
    }
    expect(() => approve(db, b, [])).toThrow('No entries given to record')
    expect(snapshot(db)).toBe(before)
  })

  it('is all or nothing: a failure while marking the entries leaves no review and no change', () => {
    const { db, b, b1 } = fixture()
    const before = snapshot(db)
    vi.spyOn(db as unknown as { markMpesaPaymentsApproved: (...args: unknown[]) => void }, 'markMpesaPaymentsApproved').mockImplementation(() => {
      throw new Error('disk full')
    })

    expect(() => approve(db, b, [b1.payment])).toThrow('disk full')

    vi.restoreAllMocks()
    expect(snapshot(db)).toBe(before)
    expect(() => approve(db, b, [b1.payment])).not.toThrow()
  })

  it('is not held to the freeze: an older closed shift that is not the latest can be approved', () => {
    const { db, a, b, a1 } = fixture()

    expect(db.latestClosedShiftId()).toBe(b)
    expect(() => approve(db, a, [a1.payment])).not.toThrow()
  })

  it('leaves the day review as it was: a review of a day records no shift', () => {
    const { db, a1 } = fixture()

    const result = db.approveMpesaEntries([a1.payment], [], ADMIN, '2026-10-04', null)

    expect(result.approval?.shift_id ?? null).toBeNull()
  })
})

describe('the shifts of a scope', () => {
  it('lists the shifts with sales in the range, the open one first then newest, with where each stands', () => {
    const { db, a, b, c, a1, a2 } = fixture()
    conn(db).prepare('UPDATE mpesa_payments SET reconciled_at = ?, reconciled_by_staff_id = 1, reconciliation_note = ? WHERE id IN (?, ?)').run(iso('2026-10-05T11:27:40'), 'Approved in day report #1', a1.payment, a2.payment)
    const nothing = shift(db, '2026-10-06T07:00:00', '2026-10-06T08:00:00')
    conn(db).prepare("INSERT INTO orders (total, status, created_at, payload_json, staff_id, payment_method, shift_id) VALUES (50, 'synced', ?, '{}', 1, 'cash', ?)").run(iso('2026-10-06T07:30:00'), nothing)
    approve(db, b, [3])

    const rows = listShiftApprovalRows(db, { startIso: iso('2026-10-04T00:00:00'), endIso: iso('2026-10-07T00:00:00'), label: 'x' })

    expect(rows.map((r) => [r.shiftId, r.state])).toEqual([
      [c, 'open'],
      [nothing, 'nothing-to-approve'],
      [b, 'approved'],
      [a, 'approved-earlier']
    ])
    expect(rows.find((r) => r.shiftId === b)).toMatchObject({ pendingCount: 1, pendingAmount: 400, approvedByName: expect.any(String), orderCount: 2 })
    expect(rows.find((r) => r.shiftId === a)).toMatchObject({ manualCount: 2, pendingCount: 0 })
  })

  it('counts only the sales inside the range, and lists a shift with none in it never', () => {
    const { db, a, b } = fixture()

    const rows = listShiftApprovalRows(db, { startIso: iso('2026-10-05T10:30:00'), endIso: iso('2026-10-05T12:00:00'), label: 'x' })

    expect(rows.map((r) => [r.shiftId, r.orderCount])).toEqual([[b, 1]])
    expect(rows.map((r) => r.shiftId)).not.toContain(a)
  })

  it('says "not approved" for a shift with entries still pending', () => {
    const { db, a } = fixture()

    const rows = listShiftApprovalRows(db, getReportRange('today', new Date(iso('2026-10-04T12:00:00'))))

    expect(rows.find((r) => r.shiftId === a)).toMatchObject({ state: 'not-approved', pendingCount: 2, pendingAmount: 300 })
  })
})

describe('what is enforced in the main process', () => {
  const index = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
  const body = (channel: string): string => {
    const start = index.indexOf(`'${channel}',`)
    return index.slice(start, index.indexOf('ipcMain.handle(', start + 20))
  }

  it('re-verifies the admin PIN before the approval is written', () => {
    const handler = body('reports:approve-shift')

    expect(handler).toContain('validate(approveShiftReportSchema')
    expect(handler.indexOf('requireAdminPin(db, validation.data.managerId, validation.data.managerPin)')).toBeGreaterThan(-1)
    expect(handler.indexOf('requireAdminPin(')).toBeLessThan(handler.indexOf('db.approveShiftMpesa('))
  })

  it('has the day approval refuse with "approve a shift", never writing', () => {
    const handler = body('reports:approve-day')

    expect(handler).toContain('Approve a shift, not a day')
    expect(handler).not.toContain('approveMpesaEntries')
    expect(handler).not.toContain('db.')
  })

  it('reads the report and the list without a PIN, as every reports read', () => {
    expect(body('reports:shift-end-of-day')).toContain('generateShiftEndOfDay(db, validation.data.shiftId)')
    expect(body('reports:end-of-day-shifts')).toContain('listShiftApprovalRows(db, resolveReportRange(db, validation.data))')
    expect(body('reports:shift-end-of-day')).not.toContain('requireAdminPin')
  })

  it('takes a complete review request, and refuses the shapes a day review also refused', () => {
    const base = { managerId: 2, managerPin: '1234', shiftId: 3, approvedIds: [1], excluded: [] }

    expect(approveShiftReportSchema.safeParse(base).success).toBe(true)
    expect(approveShiftReportSchema.safeParse({ ...base, approvedIds: [], excluded: [] }).success).toBe(false)
    expect(approveShiftReportSchema.safeParse({ ...base, excluded: [{ paymentId: 1 }] }).success).toBe(false)
    expect(approveShiftReportSchema.safeParse({ ...base, approvedIds: [1, 1] }).success).toBe(false)
    expect(approveShiftReportSchema.safeParse({ ...base, shiftId: 0 }).success).toBe(false)
    expect(approveShiftReportSchema.safeParse({ ...base, managerPin: undefined }).success).toBe(false)
    expect(shiftEndOfDaySchema.safeParse({ shiftId: 3 }).success).toBe(true)
    expect(shiftEndOfDaySchema.safeParse({}).success).toBe(false)
  })
})
