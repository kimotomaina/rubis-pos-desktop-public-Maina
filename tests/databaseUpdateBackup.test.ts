/**
 * `RubisDatabase`'s phase-178 additions, against a **real** SQLite
 * database (`tests/reportsDatabase.test.ts`'s own pattern) rather than a
 * recording fake — the four counts and `backup()` are exactly the kind
 * of thing that must actually execute against better-sqlite3, not just
 * be assumed to exist.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

/** Reaches the private connection for a raw status update only a direct query can make (`reportsDatabase.test.ts`'s own pattern). */
function rawConnection(db: RubisDatabase): { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } {
  return (db as unknown as { conn: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } })
    .conn
}

let staffId: number

function seededDb(): RubisDatabase {
  const db = freshDb()
  staffId = db.createStaff({ name: 'Ann', pinHash: 'x', role: 'cashier' }).staffId
  return db
}

function queueOrder(db: RubisDatabase, uuid: string): number {
  return db.queueOrder({
    items: [],
    total: 10,
    clientOrderUuid: uuid,
    staffId,
    staffName: 'Ann',
    paymentMethod: 'cash',
    tenderedAmount: 10,
    changeDue: 0
  }).localId
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('carry-over counts', () => {
  it('getTotalOrderCount counts every order', () => {
    const db = seededDb()
    queueOrder(db, 'a')
    queueOrder(db, 'b')
    expect(db.getTotalOrderCount()).toBe(2)
  })

  it('getUnpushedOrderCount counts pending_sync/failed, not synced or voided', () => {
    const db = seededDb()
    queueOrder(db, 'a') // stays pending_sync
    const synced = queueOrder(db, 'b')
    const failed = queueOrder(db, 'c')
    const voided = queueOrder(db, 'd')
    rawConnection(db).prepare("UPDATE orders SET status = 'synced' WHERE local_id = ?").run(synced)
    rawConnection(db).prepare("UPDATE orders SET status = 'failed' WHERE local_id = ?").run(failed)
    db.voidOrder(voided)

    expect(db.getUnpushedOrderCount()).toBe(2)
  })

  it('getMpesaPaymentCount counts every mpesa_payments row', () => {
    const db = seededDb()
    db.queueOrderRecordingMpesaPayment(
      {
        items: [],
        total: 10,
        clientOrderUuid: 'm1',
        staffId,
        staffName: 'Ann',
        paymentMethod: 'mpesa',
        tenderedAmount: 10,
        changeDue: 0
      },
      {
        mode: 'daraja',
        verificationStatus: 'confirmed',
        reference: 'ABC123',
        amount: 10,
        enteredByStaffId: staffId
      }
    )
    expect(db.getMpesaPaymentCount()).toBe(1)
  })

  it('getUnfiledOrderCount still matches its own pre-phase-178 behaviour', () => {
    const db = seededDb()
    const localId = queueOrder(db, 'a')
    // fiscal_status is NULL until the fiscal engine sets it — queueOrder
    // alone never produces a 'waiting' row (database.ts:1617's own note).
    rawConnection(db)
      .prepare("UPDATE orders SET fiscal_status = 'waiting' WHERE local_id = ?")
      .run(localId)

    expect(db.getUnfiledOrderCount()).toBe(1)
  })
})

describe('settings: deleteSetting', () => {
  it('removes a key so getSetting no longer returns it', () => {
    const db = freshDb()
    db.setSetting('pendingUpdateCheck', '{"x":1}')
    expect(db.getSetting('pendingUpdateCheck')).toBe('{"x":1}')

    db.deleteSetting('pendingUpdateCheck')
    expect(db.getSetting('pendingUpdateCheck')).toBeUndefined()
  })

  it('is a no-op when the key does not exist', () => {
    const db = freshDb()
    expect(() => db.deleteSetting('does-not-exist')).not.toThrow()
  })
})

describe('backup', () => {
  it('writes a real, independently-openable SQLite file with the same data', async () => {
    const db = seededDb()
    queueOrder(db, 'a')
    queueOrder(db, 'b')

    const dir = mkdtempSync(join(tmpdir(), 'rubis-backup-test-'))
    tempDirs.push(dir)
    const destPath = join(dir, 'backup.sqlite')

    await db.backup(destPath)

    const reopened = new BetterSqlite3(destPath, { readonly: true })
    try {
      const row = reopened.prepare('SELECT COUNT(*) as count FROM orders').get() as {
        count: number
      }
      expect(row.count).toBe(2)
    } finally {
      reopened.close()
    }
  })
})
