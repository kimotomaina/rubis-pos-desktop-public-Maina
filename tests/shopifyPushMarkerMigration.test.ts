/**
 * `shopify_push_count`/`shopify_last_push_at` upgrade test (docs/phase-169
 * commit 1, the push marker from docs/phase-168 section 2.4).
 *
 * Same pattern as `fiscalCuInfoMigration.test.ts`: a real, FILE-backed
 * `better-sqlite3` database, so this genuinely simulates an existing
 * install opening a database created before these two columns existed.
 * One connection builds the OLD `orders` table and inserts a row, is
 * closed, then a fresh `RubisDatabase` opens the same file and runs its
 * normal `init()`.
 *
 * Every connection is closed before its file is removed: Windows refuses
 * to delete a file with an open handle.
 */

import { describe, it, expect, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RubisDatabase } from '../src/main/services/database.js'

/**
 * The `orders` table exactly as it existed before this phase: every
 * column `SCHEMA.orders` declares today, minus the two push-marker
 * columns. Copied by hand rather than derived, so a future edit to
 * `SCHEMA.orders` can't silently make this "old" fixture match the new
 * schema and defeat the test.
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
  fiscal_vat_groups_json TEXT,
  fiscal_fiscalized_at_source TEXT CHECK (fiscal_fiscalized_at_source IN ('device', 'local-fallback')),
  fiscal_cu_serial TEXT,
  receipt_printed_at TEXT
)`

let dbPath: string | undefined

/** A fresh, per-test file path, never reused. */
function freshDbPath(): string {
  dbPath = join(tmpdir(), `rubis-phase169-upgrade-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  return dbPath
}

afterEach(() => {
  if (dbPath && existsSync(dbPath)) {
    rmSync(dbPath)
  }
  dbPath = undefined
})

describe('an existing database gains the Shopify push marker on upgrade', () => {
  it('adds both columns, keeps the old row intact, and reads it back as count 0 with no push time', () => {
    const path = freshDbPath()

    const oldConnection = new BetterSqlite3(path)
    oldConnection.exec(OLD_ORDERS_TABLE)
    oldConnection
      .prepare(`INSERT INTO orders (total, status, created_at, payload_json) VALUES (?, 'pending_sync', ?, ?)`)
      .run(42.5, '2026-09-01T09:00:00.000Z', '{"clientOrderUuid":"uuid-old"}')
    oldConnection.close()

    const db = new RubisDatabase({ dbPath: path })
    db.init()
    try {
      const oldOrder = db.getOrder(1)
      expect(oldOrder?.total).toBe(42.5)
      expect(oldOrder?.status).toBe('pending_sync')
      expect(db.getShopifyPushMarker(1)).toEqual({ count: 0, lastPushAt: null })

      // The columns work going forward, not just exist.
      db.recordPushStarted(1)
      const marker = db.getShopifyPushMarker(1)
      expect(marker?.count).toBe(1)
      expect(marker?.lastPushAt).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it('is idempotent: init() again on an already-upgraded file does not throw', () => {
    const path = freshDbPath()

    const first = new RubisDatabase({ dbPath: path })
    first.init()
    first.close()

    const second = new RubisDatabase({ dbPath: path })
    try {
      expect(() => second.init()).not.toThrow()
    } finally {
      second.close()
    }
  })
})
