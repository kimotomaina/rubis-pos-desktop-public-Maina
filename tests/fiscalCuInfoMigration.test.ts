/**
 * `fiscal_fiscalized_at_source`/`fiscal_cu_serial` upgrade test (docs/phase-164).
 *
 * Same pattern as `fiscalVatGroupsMigration.test.ts` (docs/phase-163): runs
 * against a real, FILE-backed `better-sqlite3` database (not `:memory:`,
 * and not the recording fake `database.test.ts` uses), so this can
 * genuinely simulate "an existing install opening a database created
 * before these two columns existed": one connection builds the OLD
 * `orders` table shape (as of docs/phase-163, before phase-164) and
 * inserts a row, is closed, and then a fresh `RubisDatabase` opens that
 * SAME file and runs its normal `init()` — proving
 * `migrateOrdersFiscalColumns`'s `ALTER TABLE` actually adds both columns
 * to a pre-existing table, and that the pre-existing row reads back with
 * both `null` rather than throwing or silently losing the row.
 *
 * Every connection opened here is explicitly closed before its file is
 * removed — `better-sqlite3` holds an OS file handle for as long as a
 * connection is open, and Windows refuses to delete a file with an open
 * handle (unlike POSIX, which allows it).
 */

import { describe, it, expect, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RubisDatabase } from '../src/main/services/database.js'

/**
 * The `orders` table exactly as it existed before this phase — every
 * column `SCHEMA.orders` declares today, minus
 * `fiscal_fiscalized_at_source` and `fiscal_cu_serial`. Copied by hand
 * from `database.ts`'s `SCHEMA.orders` rather than derived from it, so a
 * future edit to that constant can't silently make this "old" fixture
 * identical to the new schema and defeat the test.
 */
const OLD_ORDERS_TABLE = `CREATE TABLE orders (
  local_id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_order_id TEXT,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_sync' CHECK (status IN ('pending_sync', 'synced', 'failed', 'voided')),
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  staff_id INTEGER,
  payment_method TEXT,
  tendered_amount REAL,
  change_due REAL,
  reference_number TEXT,
  shift_id INTEGER,
  fiscal_invoice_number TEXT,
  fiscal_qr_code TEXT,
  fiscal_fiscalized_at TEXT,
  fiscal_status TEXT CHECK (fiscal_status IN ('fiscalized', 'waiting', 'needs_fixing')),
  fiscal_error_reason TEXT,
  fiscal_error_kind TEXT CHECK (fiscal_error_kind IN ('data', 'system', 'technical')),
  fiscal_request_json TEXT,
  fiscal_data_issue TEXT,
  fiscal_vat_groups_json TEXT
)`

let dbPath: string | undefined

/** A fresh, per-test file path — never reused, so no test depends on another's leftovers. */
function freshDbPath(): string {
  dbPath = join(tmpdir(), `rubis-phase164-upgrade-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  return dbPath
}

afterEach(() => {
  if (dbPath && existsSync(dbPath)) {
    rmSync(dbPath)
  }
  dbPath = undefined
})

describe('an existing database gains fiscal_fiscalized_at_source/fiscal_cu_serial on upgrade, old rows read back NULL', () => {
  it('adds both columns via ALTER TABLE and keeps the pre-existing row intact with both null', () => {
    const path = freshDbPath()

    // Simulate the old install: a database with the pre-phase-164 schema
    // and one already-fiscalized order in it.
    const oldConnection = new BetterSqlite3(path)
    oldConnection.exec(OLD_ORDERS_TABLE)
    oldConnection
      .prepare(
        `INSERT INTO orders (total, status, created_at, fiscal_invoice_number, fiscal_qr_code, fiscal_fiscalized_at, fiscal_status)
         VALUES (?, 'synced', ?, ?, ?, ?, 'fiscalized')`
      )
      .run(139.2, '2026-08-01T09:00:00.000Z', 'KRA-OLD-0001', 'base64qr', '2026-08-01T09:00:01.000Z')
    oldConnection.close()

    // A fresh RubisDatabase, as if the app just restarted after upgrading.
    const db = new RubisDatabase({ dbPath: path })
    db.init()
    try {
      const oldOrder = db.getOrder(1)
      expect(oldOrder).toBeDefined()
      expect(oldOrder?.fiscal_invoice_number).toBe('KRA-OLD-0001')
      expect(oldOrder?.fiscal_fiscalized_at_source).toBeNull()
      expect(oldOrder?.fiscal_cu_serial).toBeNull()

      // The columns are fully functional going forward, not just present.
      // Order 1 is already fiscalized, so the write-once guard leaves its
      // pre-existing fiscal_fiscalized_at untouched — this proves the new
      // columns accept a value on a row where they start out NULL.
      db.setOrderFiscalInfo(1, 'KRA-OLD-0001', 'base64qr', undefined, undefined, 'device', 'CU-SERIAL-UPGRADE')
      const updated = db.getOrder(1)
      expect(updated?.fiscal_fiscalized_at_source).toBe('device')
      expect(updated?.fiscal_cu_serial).toBe('CU-SERIAL-UPGRADE')
    } finally {
      db.close()
    }
  })

  it('is idempotent — running init() again on the same, already-upgraded file does not throw', () => {
    const path = freshDbPath()

    const first = new RubisDatabase({ dbPath: path })
    first.init()
    first.close()

    const second = new RubisDatabase({ dbPath: path })
    try {
      expect(() => second.init()).not.toThrow()
      expect(second.getOrder(1)).toBeUndefined()
    } finally {
      second.close()
    }
  })
})
