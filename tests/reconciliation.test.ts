/**
 * Shift cash-reconciliation regression tests (Phase 11, Task 1).
 *
 * Unlike the rest of this codebase's database tests, this file runs
 * against a **real** in-memory `better-sqlite3` connection
 * (`:memory:`) rather than the recording fake used elsewhere
 * (`shifts.test.ts`, `database.test.ts`) — the bug being fixed is a
 * `WHERE`/filter omission that a fake connection (which ignores SQL
 * text and just replays pre-registered rows) cannot exercise
 * faithfully. `better-sqlite3`'s native binary is already a hard
 * dependency of this project, so this carries no extra cost.
 */

import { describe, it, expect } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'
import { generateZReport, generateDailySummary, getUtcDayRange } from '../src/main/services/reports.js'
import { hashPin } from '../src/main/services/auth.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

const cashItem: CartItem = {
  id: 'variant-1',
  productId: 'product-1',
  title: 'RUBIS Mug',
  variantTitle: 'Small',
  price: 200,
  quantity: 1,
  image: null
}

describe('closeShift cash reconciliation excludes voided orders (Phase 11)', () => {
  it('does not count a voided cash order toward expected cash', () => {
    const db = freshDb()
    const { staffId } = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' })
    const { shiftId } = db.openShift(staffId, 500)

    const kept = db.queueOrder({
      items: [cashItem],
      total: 200,
      clientOrderUuid: 'uuid-kept',
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 200,
      changeDue: 0,
      shiftId
    })

    const voided = db.queueOrder({
      items: [cashItem],
      total: 200,
      clientOrderUuid: 'uuid-voided',
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 200,
      changeDue: 0,
      shiftId
    })
    db.voidOrder(voided.localId)

    const { expectedCash } = db.closeShift(shiftId, 700)

    // 500 starting + 200 from the kept order only — the voided Ksh 200 sale is excluded.
    expect(expectedCash).toBe(700)
    expect(db.getOrder(kept.localId)?.status).not.toBe('voided')
    expect(db.getOrder(voided.localId)?.status).toBe('voided')
  })

  it('reports a discrepancy of 0 when the counted drawer matches cash sales minus the void', () => {
    const db = freshDb()
    const { staffId } = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' })
    const { shiftId } = db.openShift(staffId, 0)

    const order = db.queueOrder({
      items: [cashItem],
      total: 200,
      clientOrderUuid: 'uuid-a',
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 200,
      changeDue: 0,
      shiftId
    })
    db.voidOrder(order.localId)

    const { expectedCash, discrepancy } = db.closeShift(shiftId, 0)

    expect(expectedCash).toBe(0)
    expect(discrepancy).toBe(0)
  })

  it('still counts a non-voided cash order normally', () => {
    const db = freshDb()
    const { staffId } = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' })
    const { shiftId } = db.openShift(staffId, 100)

    db.queueOrder({
      items: [cashItem],
      total: 200,
      clientOrderUuid: 'uuid-a',
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 200,
      changeDue: 0,
      shiftId
    })

    const { expectedCash } = db.closeShift(shiftId, 300)

    expect(expectedCash).toBe(300)
  })
})

describe('Z-report and daily summary exclude voided orders (Phase 11)', () => {
  it('excludes a voided order from Z-report revenue and order count', () => {
    const db = freshDb()
    const { staffId } = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' })
    const { shiftId } = db.openShift(staffId, 0)

    db.queueOrder({
      items: [cashItem],
      total: 200,
      clientOrderUuid: 'uuid-kept',
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 200,
      changeDue: 0,
      shiftId
    })
    const voided = db.queueOrder({
      items: [cashItem],
      total: 200,
      clientOrderUuid: 'uuid-voided',
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 200,
      changeDue: 0,
      shiftId
    })
    db.voidOrder(voided.localId)

    const report = generateZReport(db, shiftId, 0)

    expect(report.orderCount).toBe(1)
    expect(report.totalRevenue).toBe(200)
    expect(report.totalsByMethod.cash).toBe(200)
  })

  it('excludes a voided order from the daily summary', () => {
    const db = freshDb()
    const { staffId } = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' })
    const { shiftId } = db.openShift(staffId, 0)

    const voided = db.queueOrder({
      items: [cashItem],
      total: 200,
      clientOrderUuid: 'uuid-voided',
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 200,
      changeDue: 0,
      shiftId
    })
    db.voidOrder(voided.localId)

    const summary = generateDailySummary(db, 0, getUtcDayRange(new Date()))

    expect(summary.orderCount).toBe(0)
    expect(summary.totalRevenue).toBe(0)
  })
})
