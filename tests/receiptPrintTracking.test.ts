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
import { shouldMarkReceiptPrinted } from '../src/main/services/printer.js'
import type { ReceiptPrintResult } from '../src/main/services/printer.js'
import type { ServiceResult } from '../src/main/services/shopify-types.js'

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

const PHYSICAL_SUCCESS: ServiceResult<ReceiptPrintResult> = {
  success: true,
  data: { printed: true, mock: false }
}

const PDF_FALLBACK_SUCCESS: ServiceResult<ReceiptPrintResult> = {
  success: true,
  data: { printed: false, mock: false, mode: 'pdf', filePath: 'C:\\Desktop\\r.pdf' }
}

/**
 * Replicates `main/index.ts`'s `receipt:print` handler's exact decision
 * sequence — peek `hasReceiptPrinted` for the DUPLICATE flag BEFORE
 * printing, then only mark it when `shouldMarkReceiptPrinted` says so —
 * against a real database, since the handler itself is not unit tested
 * anywhere in this codebase (docs/phase-164-1's audit).
 */
function simulatePrint(
  db: RubisDatabase,
  localId: number,
  fiscalInvoiceNumber: string | null,
  printResult: ServiceResult<ReceiptPrintResult>
): { isDuplicate: boolean } {
  const isDuplicate = db.hasReceiptPrinted(localId)
  if (shouldMarkReceiptPrinted(printResult, fiscalInvoiceNumber)) {
    db.markReceiptPrinted(localId)
  }
  return { isDuplicate }
}

describe('the receipt:print decision sequence (docs/phase-164-1)', () => {
  it('a PDF fallback leaves the receipt unmarked — the next physical print is still the original', () => {
    const db = freshDb()
    const localId = seedOrder(db)

    const first = simulatePrint(db, localId, 'KRA-0001', PDF_FALLBACK_SUCCESS)
    expect(first.isDuplicate).toBe(false)
    expect(db.hasReceiptPrinted(localId)).toBe(false)

    const second = simulatePrint(db, localId, 'KRA-0001', PHYSICAL_SUCCESS)
    expect(second.isDuplicate).toBe(false)
    expect(db.hasReceiptPrinted(localId)).toBe(true)
  })

  it("an unfiled order's physical print leaves the receipt unmarked", () => {
    const db = freshDb()
    const localId = seedOrder(db)

    const result = simulatePrint(db, localId, null, PHYSICAL_SUCCESS)

    expect(result.isDuplicate).toBe(false)
    expect(db.hasReceiptPrinted(localId)).toBe(false)
  })

  it('after filing, the first physical print is the original and the second is a DUPLICATE', () => {
    const db = freshDb()
    const localId = seedOrder(db)

    // Printed once while still unfiled — leaves it unmarked (previous test).
    simulatePrint(db, localId, null, PHYSICAL_SUCCESS)
    expect(db.hasReceiptPrinted(localId)).toBe(false)

    // The sale files.
    db.setOrderFiscalInfo(localId, 'KRA-0002', 'base64qr')

    const originalPrint = simulatePrint(db, localId, 'KRA-0002', PHYSICAL_SUCCESS)
    expect(originalPrint.isDuplicate).toBe(false)
    expect(db.hasReceiptPrinted(localId)).toBe(true)

    const reprint = simulatePrint(db, localId, 'KRA-0002', PHYSICAL_SUCCESS)
    expect(reprint.isDuplicate).toBe(true)
  })
})
