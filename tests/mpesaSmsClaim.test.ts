/**
 * Spending an M-Pesa confirmation message when a sale uses it.
 *
 * The failure this exists to prevent is not fraud, it is an ordinary
 * mistake: the SMS flow is a cashier picking a payment from a list, so a
 * payment that stays on the list after paying for a sale gets picked
 * again for the next one. That is a double credit through normal use.
 *
 * Two properties matter, and both are asserted here rather than reasoned
 * about:
 *
 *   1. **Atomic.** The sale and the spent payment land together or not at
 *      all. Queue-then-claim could leave a completed sale whose payment
 *      still reads as available; claim-then-queue could consume a real
 *      payment for a sale that never existed.
 *   2. **Idempotent.** Re-running for the same sale is a no-op, so a
 *      retry cannot double-mark or un-mark.
 */

import { describe, it, expect } from 'vitest'
import {
  RubisDatabase,
  type InsertMpesaSmsMessageInput,
  type QueueOrderInput
} from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

function seedStaff(db: RubisDatabase, name = 'Alex'): number {
  return db.createStaff({ name, pinHash: hashPin('1234'), role: 'cashier' }).staffId
}

function storePayment(db: RubisDatabase, transactionCode = 'UI7N55IAAT'): void {
  const message: InsertMpesaSmsMessageInput = {
    transactionCode,
    amount: 500,
    payerName: 'Nelson Elijah Onyango',
    payerAlias: null,
    maskedPhone: '254719350972',
    accountReference: null,
    occurredAt: '2026-09-07T13:44:00.000Z',
    sourceFile: 'IN20260907_134401_00_MPESA_00.txt',
    rawText: 'UI7N55IAAT Confirmed. Ksh500.00 received.',
    createdAt: '2026-09-07T13:44:05.000Z'
  }
  db.insertMpesaSmsMessage(message)
}

function order(staffId: number, uuid: string): QueueOrderInput {
  return {
    items: [],
    total: 500,
    clientOrderUuid: uuid,
    staffId,
    staffName: 'Alex',
    paymentMethod: 'mpesa',
    tenderedAmount: 500,
    changeDue: 0,
    referenceNumber: 'UI7N55IAAT'
  }
}

describe('queueOrderClaimingSmsPayment', () => {
  it('queues the sale and spends the payment together', () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    storePayment(db)

    const queued = db.queueOrderClaimingSmsPayment(order(staffId, 'uuid-1'), {
      transactionCode: 'UI7N55IAAT',
      staffId
    })

    expect(queued).not.toBeNull()
    expect(db.getOrders()).toHaveLength(1)

    const row = db.getMpesaSmsMessageByCode('UI7N55IAAT')
    expect(row?.matched_order_local_id).toBe(queued!.localId)
    expect(row?.approved_by_staff_id).toBe(staffId)
    expect(row?.approved_at).not.toBeNull()
  })

  it('refuses a second sale for the same payment, and writes no order for it', () => {
    // The whole point: the second cashier gets nothing, not a sale.
    const db = freshDb()
    const staffId = seedStaff(db)
    storePayment(db)

    const first = db.queueOrderClaimingSmsPayment(order(staffId, 'uuid-1'), {
      transactionCode: 'UI7N55IAAT',
      staffId
    })
    const second = db.queueOrderClaimingSmsPayment(order(staffId, 'uuid-2'), {
      transactionCode: 'UI7N55IAAT',
      staffId
    })

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    // Atomic: the losing sale was rolled back, not left behind unpaid.
    expect(db.getOrders()).toHaveLength(1)
    expect(db.getMpesaSmsMessageByCode('UI7N55IAAT')?.matched_order_local_id).toBe(first!.localId)
  })

  it('leaves the payment attached to the sale that won, not the one that tried', () => {
    const db = freshDb()
    const alex = seedStaff(db, 'Alex')
    const sam = seedStaff(db, 'Sam')
    storePayment(db)

    const first = db.queueOrderClaimingSmsPayment(order(alex, 'uuid-1'), {
      transactionCode: 'UI7N55IAAT',
      staffId: alex
    })
    db.queueOrderClaimingSmsPayment(order(sam, 'uuid-2'), {
      transactionCode: 'UI7N55IAAT',
      staffId: sam
    })

    const row = db.getMpesaSmsMessageByCode('UI7N55IAAT')
    expect(row?.matched_order_local_id).toBe(first!.localId)
    expect(row?.approved_by_staff_id).toBe(alex)
  })

  it('writes no order at all when the payment cannot be claimed', () => {
    // Claim-then-queue and queue-then-claim both have a failure that
    // costs money. One transaction means neither happens.
    const db = freshDb()
    const staffId = seedStaff(db)
    storePayment(db)
    db.queueOrderClaimingSmsPayment(order(staffId, 'uuid-1'), {
      transactionCode: 'UI7N55IAAT',
      staffId
    })
    const ordersBefore = db.getOrders().length
    const queueBefore = db.getPendingSyncQueue(Date.now()).length

    const blocked = db.queueOrderClaimingSmsPayment(order(staffId, 'uuid-2'), {
      transactionCode: 'UI7N55IAAT',
      staffId
    })

    expect(blocked).toBeNull()
    expect(db.getOrders()).toHaveLength(ordersBefore)
    // The sync queue entry rolled back with the order.
    expect(db.getPendingSyncQueue(Date.now())).toHaveLength(queueBefore)
  })

  it('writes no order when the payment does not exist at all', () => {
    const db = freshDb()
    const staffId = seedStaff(db)

    const queued = db.queueOrderClaimingSmsPayment(order(staffId, 'uuid-1'), {
      transactionCode: 'NEVERSEEN1',
      staffId
    })

    expect(queued).toBeNull()
    expect(db.getOrders()).toHaveLength(0)
  })

  it('matches the code case-insensitively and ignores stray spaces', () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    storePayment(db)

    const queued = db.queueOrderClaimingSmsPayment(order(staffId, 'uuid-1'), {
      transactionCode: '  ui7n55iaat  ',
      staffId
    })

    expect(queued).not.toBeNull()
    expect(db.getMpesaSmsMessageByCode('UI7N55IAAT')?.matched_order_local_id).toBe(queued!.localId)
  })

  it('excludes a spent payment from the list a cashier picks from', () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    storePayment(db)

    expect(db.listUnmatchedMpesaSmsMessages('2026-01-01T00:00:00.000Z')).toHaveLength(1)
    db.queueOrderClaimingSmsPayment(order(staffId, 'uuid-1'), {
      transactionCode: 'UI7N55IAAT',
      staffId
    })

    expect(db.listUnmatchedMpesaSmsMessages('2026-01-01T00:00:00.000Z')).toHaveLength(0)
  })

  it('does not disturb other payments waiting on the list', () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    storePayment(db, 'UI7N55IAAT')
    storePayment(db, 'BBB2222222')

    db.queueOrderClaimingSmsPayment(order(staffId, 'uuid-1'), {
      transactionCode: 'UI7N55IAAT',
      staffId
    })

    const remaining = db.listUnmatchedMpesaSmsMessages('2026-01-01T00:00:00.000Z')
    expect(remaining.map((row) => row.transaction_code)).toEqual(['BBB2222222'])
  })
})
