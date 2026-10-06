/**
 * The shift dry run (docs/phase-238) runs the automatic assignment on a throwaway copy and proves it touched
 * nothing fiscal, nothing in the sync queue and nothing in any other table; it refuses the live data folder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import { changedTables, fingerprint, prepareWorkingCopy, runShiftDryRun } from '../src/main/lib/shiftDryRun.js'

/** A Nairobi wall-clock time as the stored UTC instant. */
const iso = (t: string): string => new Date(`${t}+03:00`).toISOString()
const NOW = Date.parse(iso('2026-10-06T12:00:00'))

let dir: string
let sourcePath: string
let liveDir: string

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** A database file holding sales with no shift, two of them filed with KRA, and one sync-queue row. */
function buildSource(path: string): void {
  const db = new RubisDatabase({ dbPath: path })
  db.init()
  const conn = (db as unknown as { conn: BetterSqlite3.Database }).conn
  const insert = conn.prepare(
    `INSERT INTO orders (total, status, created_at, payload_json, staff_id, payment_method, shift_id, fiscal_status, fiscal_invoice_number, fiscal_vat_groups_json)
     VALUES (?, 'synced', ?, '{}', 1, 'cash', NULL, ?, ?, ?)`
  )
  insert.run(90, iso('2026-10-04T10:00:00'), 'fiscalized', '0110605040001000810', '{"A":"90.00"}')
  insert.run(60, iso('2026-10-04T23:50:00'), 'fiscalized', '0110605040001000811', '{"A":"60.00"}')
  insert.run(20, iso('2026-10-05T06:30:00'), 'waiting', null, null)
  insert.run(50, iso('2026-10-06T11:00:00'), null, null, null) // the current Day window, still open: waits
  conn
    .prepare("INSERT INTO sync_queue (entity_type, entity_id, action, payload_json, created_at) VALUES ('order', 3, 'create', '{}', ?)")
    .run(iso('2026-10-05T06:31:00'))
  db.close()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rubis-dry-run-test-'))
  sourcePath = join(dir, 'copy', 'rubis-pos.db')
  liveDir = join(dir, 'live')
  mkdirSync(dirname(sourcePath), { recursive: true })
  mkdirSync(liveDir, { recursive: true })
  buildSource(sourcePath)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the shift dry run', () => {
  it('creates the ended windows\' shifts in the copy, leaves the current window waiting, and changes nothing else', () => {
    const sourceBefore = fileHash(sourcePath)

    const outcome = runShiftDryRun({ sourcePath, liveDataDir: liveDir, nowMs: NOW })

    expect(outcome.ok).toBe(true)
    expect(outcome.changedTables).toEqual([])
    expect(outcome.migratedTables).toEqual([]) // built by the current schema, so nothing to migrate
    expect(outcome.result.waiting).toBe(1)
    expect(outcome.result.touched.map((t) => [t.created, t.windowType, t.windowDate, t.count])).toEqual([
      [true, 'day', '2026-10-04', 1],
      [true, 'night', '2026-10-04', 2]
    ])
    expect(outcome.lines.join('\n')).toContain('Would create a shift for Day shift, 2026-10-04: 1 sale')
    expect(outcome.lines.join('\n')).toContain('Would create a shift for Night shift, 2026-10-04: 2 sales')
    expect(outcome.lines.join('\n')).toContain('1 sale waits')
    expect(outcome.lines.at(-1)).toContain('nothing outside shifts, orders.shift_id and the shift adjustments changed')

    // The owner's copy is untouched: the run worked on its own copy elsewhere.
    expect(fileHash(sourcePath)).toBe(sourceBefore)
    expect(outcome.workingPath).not.toBe(sourcePath)
    expect(outcome.workingPath.startsWith(tmpdir())).toBe(true)

    // In the working copy the fiscal columns and the sync queue read exactly as before.
    const working = new BetterSqlite3(outcome.workingPath, { readonly: true })
    const fiscal = working
      .prepare('SELECT fiscal_status, fiscal_invoice_number, fiscal_vat_groups_json FROM orders ORDER BY local_id')
      .all()
    expect(fiscal).toEqual([
      { fiscal_status: 'fiscalized', fiscal_invoice_number: '0110605040001000810', fiscal_vat_groups_json: '{"A":"90.00"}' },
      { fiscal_status: 'fiscalized', fiscal_invoice_number: '0110605040001000811', fiscal_vat_groups_json: '{"A":"60.00"}' },
      { fiscal_status: 'waiting', fiscal_invoice_number: null, fiscal_vat_groups_json: null },
      { fiscal_status: null, fiscal_invoice_number: null, fiscal_vat_groups_json: null }
    ])
    expect((working.prepare('SELECT COUNT(*) AS n FROM sync_queue').get() as { n: number }).n).toBe(1)
    expect((working.prepare('SELECT COUNT(*) AS n FROM shifts').get() as { n: number }).n).toBe(2)
    expect((working.prepare('SELECT COUNT(*) AS n FROM orders WHERE shift_id IS NULL').get() as { n: number }).n).toBe(1)
    working.close()
  })

  it('refuses a database inside the live data folder, and copies nothing', () => {
    const livePath = join(liveDir, 'rubis-pos.db')
    buildSource(livePath)
    expect(() => prepareWorkingCopy(livePath, liveDir)).toThrow(/Refused/)
    expect(() => runShiftDryRun({ sourcePath: livePath, liveDataDir: liveDir, nowMs: NOW })).toThrow(/inside the till's own data folder/)
  })

  it('refuses a path that does not exist', () => {
    expect(() => prepareWorkingCopy(join(dir, 'missing.db'), liveDir)).toThrow(/Not found/)
  })

  it('the fingerprint sees a fiscal change, a sync-queue change and a product change, and ignores shift_id', () => {
    const working = prepareWorkingCopy(sourcePath, liveDir)
    const before = fingerprint(working)
    expect(Object.keys(before)).toContain('orders')
    expect(Object.keys(before)).toContain('sync_queue')
    expect(Object.keys(before)).not.toContain('shifts')
    expect(Object.keys(before)).not.toContain('shift_adjustments')

    const conn = new BetterSqlite3(working)
    conn.prepare('UPDATE orders SET shift_id = 42 WHERE local_id = 1').run()
    expect(changedTables(before, fingerprint(working))).toEqual([])

    conn.prepare("UPDATE orders SET fiscal_status = 'needs_fixing' WHERE local_id = 1").run()
    expect(changedTables(before, fingerprint(working))).toEqual(['orders'])

    conn.prepare("INSERT INTO sync_queue (entity_type, entity_id, action, payload_json, created_at) VALUES ('order', 1, 'create', '{}', 'x')").run()
    conn.prepare("INSERT INTO products (id, title, variant_id, variant_title, price, inventory_quantity) VALUES ('p', 't', 'v', 'Default Title', 1, 0)").run()
    expect(changedTables(before, fingerprint(working))).toEqual(['orders', 'products', 'sync_queue'])
    conn.close()
  })

  it('running the dry run twice on the same copy reports nothing to do the second time', () => {
    const first = runShiftDryRun({ sourcePath, liveDataDir: liveDir, nowMs: NOW })
    const second = runShiftDryRun({ sourcePath: first.workingPath, liveDataDir: liveDir, nowMs: NOW })
    expect(second.ok).toBe(true)
    expect(second.result.touched).toEqual([])
    expect(second.result.waiting).toBe(1)
  })
})
