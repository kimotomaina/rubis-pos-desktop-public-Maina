/**
 * `fiscal_vat_groups_json` upgrade test (docs/phase-163, Commit 1).
 *
 * Runs against a real, FILE-backed `better-sqlite3` database (not
 * `:memory:`, and not the recording fake `database.test.ts` uses) so
 * this can genuinely simulate "an existing install opening a database
 * created before this column existed": one connection builds the OLD
 * `orders` table shape and inserts a row, is closed, and then a fresh
 * `RubisDatabase` opens that SAME file and runs its normal `init()` —
 * proving `migrateOrdersFiscalColumns`'s `ALTER TABLE` actually adds the
 * column to a pre-existing table, and that the pre-existing row reads
 * back with `fiscal_vat_groups_json: null` rather than throwing or
 * silently losing the row.
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
 * column `SCHEMA.orders` declares today, minus `fiscal_vat_groups_json`.
 * Copied by hand from `database.ts`'s `SCHEMA.orders` rather than
 * derived from it, so a future edit to that constant can't silently
 * make this "old" fixture identical to the new schema and defeat the
 * test.
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
  fiscal_data_issue TEXT
)`

let dbPath: string | undefined

/** A fresh, per-test file path — never reused, so no test depends on another's leftovers. */
function freshDbPath(): string {
  dbPath = join(tmpdir(), `rubis-phase163-upgrade-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  return dbPath
}

afterEach(() => {
  if (dbPath && existsSync(dbPath)) {
    rmSync(dbPath)
  }
  dbPath = undefined
})

describe('an existing database gains fiscal_vat_groups_json on upgrade, old rows read back NULL', () => {
  it('adds the column via ALTER TABLE and keeps the pre-existing row intact with fiscal_vat_groups_json: null', () => {
    const path = freshDbPath()

    // Simulate the old install: a database with the pre-phase-163 schema
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
      expect(oldOrder?.fiscal_vat_groups_json).toBeNull()

      // The column is fully functional going forward, not just present.
      db.setOrderFiscalInfo(1, 'KRA-OLD-0001', 'base64qr', { A: '139.20' })
      expect(JSON.parse(db.getOrder(1)?.fiscal_vat_groups_json as string)).toEqual({ A: '139.20' })
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
