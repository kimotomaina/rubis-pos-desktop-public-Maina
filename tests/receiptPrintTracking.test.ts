/**
 * `hasReceiptPrinted`/`markReceiptPrinted` tests (docs/phase-164).
 *
 * Runs against a real in-memory `better-sqlite3` connection, matching
 * `fiscalIntegration.test.ts`'s precedent for write-once behavior — a
 * mocked recording fake can't prove a second write is actually a no-op,
 * only that a second call happened.
 *
 * These two methods are the entire "original vs duplicate" decision for
 * `main/index.ts`'s `receipt:print` IPC handler — the single call site
 * for every print of a sale's receipt (docs/phase-164's audit found no
 * other). `hasReceiptPrinted` is read before printing to decide whether
 * to stamp DUPLICATE; `markReceiptPrinted` is called only after a print
 * actually succeeds.
 */

import { describe, it, expect, vi } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

let uuidCounter = 0

/** Queues a bare order and returns its localId — no fiscal data needed for these tests. */
function seedOrder(db: RubisDatabase): number {
  const { staffId } = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' })
  uuidCounter += 1
  const { localId } = db.queueOrder({
    items: [],
    total: 10,
    clientOrderUuid: `uuid-receipt-print-${uuidCounter}`,
    staffId,
    staffName: 'Alex',
    paymentMethod: 'cash',
    tenderedAmount: 10,
    changeDue: 0
  })
  return localId
}

describe('RubisDatabase.hasReceiptPrinted / markReceiptPrinted', () => {
  it('is false for an order that has never been printed', () => {
    const db = freshDb()
    const localId = seedOrder(db)

    expect(db.hasReceiptPrinted(localId)).toBe(false)
  })

  it('becomes true after markReceiptPrinted', () => {
    const db = freshDb()
    const localId = seedOrder(db)

    db.markReceiptPrinted(localId)

    expect(db.hasReceiptPrinted(localId)).toBe(true)
  })

  it('is write-once: a second markReceiptPrinted call does not move the stored timestamp', () => {
    // Fake timers force a real gap between the two writes, so this test
    // cannot pass by coincidence (two `new Date().toISOString()` calls
    // landing in the same millisecond) — only the write-once guard itself
    // can make the second write leave the first timestamp in place.
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-27T10:00:00.000Z'))
      const db = freshDb()
      const localId = seedOrder(db)

      db.markReceiptPrinted(localId)
      const firstStamp = db.getOrder(localId)?.receipt_printed_at

      vi.setSystemTime(new Date('2026-08-27T12:00:00.000Z'))
      db.markReceiptPrinted(localId)
      const secondStamp = db.getOrder(localId)?.receipt_printed_at

      expect(firstStamp).toBe('2026-08-27T10:00:00.000Z')
      expect(secondStamp).toBe('2026-08-27T10:00:00.000Z')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not affect a different order', () => {
    const db = freshDb()
    const printed = seedOrder(db)
    const untouched = seedOrder(db)

    db.markReceiptPrinted(printed)

    expect(db.hasReceiptPrinted(printed)).toBe(true)
    expect(db.hasReceiptPrinted(untouched)).toBe(false)
  })
})
