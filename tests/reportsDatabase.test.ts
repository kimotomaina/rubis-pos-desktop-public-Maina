/**
 * `RubisDatabase`'s new Admin Reports queries (docs/phase-158), against
 * a **real** in-memory SQLite database (`tests/stockTake.test.ts`'s own
 * pattern) rather than a recording fake — pagination, counts and the
 * new index are exactly the kind of thing that must actually execute.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

/** Reaches the private connection for a schema-level assertion only a raw query can make. */
function rawConnection(db: RubisDatabase): { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } } {
  return (db as unknown as { conn: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } } }).conn
}

describe('idx_orders_created_at', () => {
  it('exists after schema setup', () => {
    const db = freshDb()
    const rows = rawConnection(db)
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_orders_created_at'")
      .all()
    expect(rows).toHaveLength(1)
  })

  it('is idempotent - calling init() again does not error', () => {
    const db = freshDb()
    expect(() => db.init()).not.toThrow()
  })
})

describe('listShifts / countShifts', () => {
  let db: RubisDatabase
  let staffId: number

  beforeEach(() => {
    db = freshDb()
    staffId = db.createStaff({ name: 'Ann', pinHash: 'x', role: 'cashier' }).staffId
  })

  it('returns an empty page and a zero count when no shift has ever been opened', () => {
    expect(db.listShifts(10, 0)).toEqual([])
    expect(db.countShifts()).toBe(0)
  })

  it('lists shifts most recently opened first', () => {
    // CHANGED (docs/phase-232). OLD: two shifts opened one after the other at the real clock. NEW: a window holds one shift,
    // so the two are opened in different windows (Day and Night of 2 Oct).
    const first = db.openShift(staffId, 100, null, {}, Date.parse('2026-10-02T07:00:00.000Z'))
    db.closeShift(first.shiftId, 100)
    const second = db.openShift(staffId, 50, null, {}, Date.parse('2026-10-02T17:00:00.000Z'))
    db.closeShift(second.shiftId, 50)

    const shifts = db.listShifts(10, 0)
    expect(shifts.map((s) => s.id)).toEqual([second.shiftId, first.shiftId])
  })

  it('paginates with limit/offset, and countShifts reports the true total regardless of the page size', () => {
    // CHANGED (docs/phase-232). OLD: five shifts at the real clock. NEW: five Day windows, one shift each.
    for (let i = 0; i < 5; i++) {
      const { shiftId } = db.openShift(staffId, 0, null, {}, Date.parse(`2026-10-0${i + 1}T07:00:00.000Z`))
      db.closeShift(shiftId, 0)
    }

    expect(db.countShifts()).toBe(5)
    const page1 = db.listShifts(2, 0)
    const page2 = db.listShifts(2, 2)
    const page3 = db.listShifts(2, 4)
    expect(page1).toHaveLength(2)
    expect(page2).toHaveLength(2)
    expect(page3).toHaveLength(1)
    // No overlap and no gap across pages, newest-first.
    const ids = [...page1, ...page2, ...page3].map((s) => s.id)
    expect(ids).toEqual([5, 4, 3, 2, 1])
  })
})

describe('getOrderRowsForRange', () => {
  let db: RubisDatabase
  let staffId: number

  beforeEach(() => {
    db = freshDb()
    staffId = db.createStaff({ name: 'Ann', pinHash: 'x', role: 'cashier' }).staffId
  })

  function queueOrder(createdAt: string): number {
    return db.queueOrder({
      items: [],
      total: 10,
      clientOrderUuid: `uuid-${createdAt}`,
      staffId,
      staffName: 'Ann',
      paymentMethod: 'cash',
      tenderedAmount: 10,
      changeDue: 0
      // created_at is stamped by queueOrder itself (new Date().toISOString()),
      // so ordering here is asserted by insertion order, not by a spoofed date.
    }).localId
  }

  it('returns a page of orders newest first, and the true total across the whole range', () => {
    const ids = [queueOrder('a'), queueOrder('b'), queueOrder('c')]

    const { rows, total } = db.getOrderRowsForRange(
      '2000-01-01T00:00:00.000Z',
      '2100-01-01T00:00:00.000Z',
      2,
      0
    )

    expect(total).toBe(3)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.local_id)).toEqual([ids[2], ids[1]])
  })

  it('returns an empty page for a range with no orders', () => {
    queueOrder('a')
    const { rows, total } = db.getOrderRowsForRange(
      '1990-01-01T00:00:00.000Z',
      '1990-01-02T00:00:00.000Z',
      10,
      0
    )
    expect(rows).toEqual([])
    expect(total).toBe(0)
  })
})

describe('getMpesaPaymentsForShift', () => {
  it('returns only the payments whose order belongs to the given shift', () => {
    const db = freshDb()
    const staffId = db.createStaff({ name: 'Ann', pinHash: 'x', role: 'cashier' }).staffId
    const { shiftId } = db.openShift(staffId, 0, null, {}, Date.parse('2026-10-02T07:00:00.000Z'))

    const orderInput = {
      items: [],
      total: 50,
      clientOrderUuid: 'uuid-shift-1',
      staffId,
      staffName: 'Ann',
      paymentMethod: 'mpesa' as const,
      tenderedAmount: 50,
      changeDue: 0,
      shiftId
    }
    db.queueOrderRecordingManualPayment(orderInput, {
      mode: 'manual',
      verificationStatus: 'manual_unverified',
      reference: 'ABCD123456',
      amount: 50,
      enteredByStaffId: staffId,
      approvedByStaffId: null
    })

    // A second shift's payment must not leak into the first shift's list.
    db.closeShift(shiftId, 0)
    // CHANGED (docs/phase-232): the second shift is in the Night window, since a window holds one shift.
    const { shiftId: otherShiftId } = db.openShift(staffId, 0, null, {}, Date.parse('2026-10-02T17:00:00.000Z'))
    db.queueOrderRecordingManualPayment(
      { ...orderInput, clientOrderUuid: 'uuid-shift-2', shiftId: otherShiftId },
      {
        mode: 'manual',
        verificationStatus: 'manual_unverified',
        reference: 'EFGH123456',
        amount: 50,
        enteredByStaffId: staffId,
        approvedByStaffId: null
      }
    )

    const payments = db.getMpesaPaymentsForShift(shiftId)
    expect(payments).toHaveLength(1)
    expect(payments[0].reference).toBe('ABCD123456')
  })
})
