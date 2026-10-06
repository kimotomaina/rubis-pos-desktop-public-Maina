/**
 * The shift dry run (docs/phase-238): shows what the first start of a build with docs/phase-232 would do to the
 * sales that have no shift, without the app. It opens no engine and no network: the only code it runs is
 * `RubisDatabase.autoAssignUnattachedSales`, against a throwaway copy of the copy it is given, and it proves
 * afterwards that nothing changed except `shifts`, `orders.shift_id` and the two shift-adjustment tables.
 *
 * It refuses the live data folder outright, so it can never run on the till's own database.
 */

import BetterSqlite3 from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { RubisDatabase, type AutoAssignResult } from '../services/database.js'

/** The tables the assignment is allowed to write, and the one column of `orders` it may set. */
export const ALLOWED_TABLES: readonly string[] = ['shifts', 'shift_adjustments', 'shift_adjustment_sales']
export const ALLOWED_ORDERS_COLUMN = 'shift_id'

/** A SHA-256 per table of every row and column the assignment must leave alone. */
export type Fingerprint = Record<string, string>

export interface DryRunOptions {
  /** The owner's copy of `rubis-pos.db`; its `-wal` and `-shm` neighbours are copied too when present. */
  sourcePath: string
  /** The till's own data folder. A source inside it is refused. */
  liveDataDir: string
  /** The clock the assignment runs at. */
  nowMs: number
}

export interface DryRunOutcome {
  /** Where the throwaway working copy was written. */
  workingPath: string
  result: AutoAssignResult
  /** Tables the schema step (`init`) added or altered: what a first start migrates before any assignment. */
  migratedTables: string[]
  /** Tables whose protected content the assignment changed. Empty when it kept to what it may touch. */
  changedTables: string[]
  ok: boolean
  /** The report, one line each. */
  lines: string[]
}

/**
 * Hashes every table except the allowed ones, and `orders` without its one allowed column, so a change anywhere
 * else (a fiscal column, the sync queue, a payment, a product) shows up as a different hash.
 *
 * @param {string} dbPath
 * @returns {Fingerprint}
 */
export function fingerprint(dbPath: string): Fingerprint {
  const connection = new BetterSqlite3(dbPath, { readonly: true })
  try {
    const tables = (
      connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>
    ).map((row) => row.name)
    const out: Fingerprint = {}
    for (const table of tables) {
      if (ALLOWED_TABLES.includes(table)) continue
      const columns = (connection.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
        .map((column) => column.name)
        .filter((name) => !(table === 'orders' && name === ALLOWED_ORDERS_COLUMN))
      const select = columns.map((name) => `"${name}"`).join(', ')
      const rows = connection.prepare(`SELECT ${select} FROM "${table}" ORDER BY rowid`).all()
      out[table] = createHash('sha256').update(JSON.stringify(rows)).digest('hex')
    }
    return out
  } finally {
    connection.close()
  }
}

/**
 * @param {Fingerprint} before
 * @param {Fingerprint} after
 * @returns {string[]} the tables whose hash differs, or that appeared or disappeared
 */
export function changedTables(before: Fingerprint, after: Fingerprint): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...names].filter((name) => before[name] !== after[name]).sort()
}

/**
 * Copies the database (and its WAL and shm files when present) into a fresh temporary folder.
 *
 * @param {string} sourcePath
 * @param {string} liveDataDir
 * @returns {string} the working copy's path
 * @throws {Error} when the source is missing or lies inside the live data folder
 */
export function prepareWorkingCopy(sourcePath: string, liveDataDir: string): string {
  const source = resolve(sourcePath)
  const live = resolve(liveDataDir)
  if (source === live || source.startsWith(live + sep)) {
    throw new Error(`Refused: ${source} is inside the till's own data folder. Run the dry run on a copy.`)
  }
  if (!existsSync(source)) throw new Error(`Not found: ${source}`)
  const dir = mkdtempSync(join(tmpdir(), 'rubis-shift-dry-run-'))
  const working = join(dir, basename(source))
  copyFileSync(source, working)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(source + suffix)) copyFileSync(source + suffix, working + suffix)
  }
  return working
}

/**
 * The report lines for one outcome.
 *
 * @param {AutoAssignResult} result
 * @param {string[]} changed
 * @returns {string[]}
 */
export function describeDryRun(result: AutoAssignResult, changed: string[], migrated: string[] = []): string[] {
  const lines: string[] = []
  if (migrated.length > 0) {
    lines.push(`Opening the database first brings its schema up to date: ${migrated.join(', ')}. That is the same step every start performs; no sale or shift is written by it.`)
  }
  if (result.skipped) lines.push('Nothing ran: another assignment was in progress.')
  if (result.touched.length === 0) lines.push('No sale without a shift needed a shift.')
  for (const touched of result.touched) {
    const window = `${touched.windowType === 'day' ? 'Day' : 'Night'} shift, ${touched.windowDate}`
    lines.push(
      touched.created
        ? `Would create a shift for ${window}: ${touched.count} ${touched.count === 1 ? 'sale' : 'sales'} (shift #${touched.shiftId} in the copy).`
        : `Would add ${touched.count} ${touched.count === 1 ? 'sale' : 'sales'} to shift #${touched.shiftId} (${window}).`
    )
  }
  if (result.waiting > 0) {
    lines.push(`${result.waiting} ${result.waiting === 1 ? 'sale waits' : 'sales wait'} for the current window's shift to open.`)
  }
  lines.push(
    changed.length === 0
      ? 'Checked: nothing outside shifts, orders.shift_id and the shift adjustments changed. No fiscal column, no sync queue row, no payment, no product.'
      : `STOP: these tables changed and must not have: ${changed.join(', ')}.`
  )
  return lines
}

/**
 * Runs the dry run end to end on a working copy.
 *
 * @param {DryRunOptions} options
 * @returns {DryRunOutcome}
 */
export function runShiftDryRun(options: DryRunOptions): DryRunOutcome {
  const workingPath = prepareWorkingCopy(options.sourcePath, options.liveDataDir)
  const original = fingerprint(workingPath)
  const db = new RubisDatabase({ dbPath: workingPath })
  db.init()
  const afterSchema = fingerprint(workingPath)
  let result: AutoAssignResult
  try {
    result = db.autoAssignUnattachedSales(options.nowMs)
  } finally {
    db.close()
  }
  const migrated = changedTables(original, afterSchema)
  const changed = changedTables(afterSchema, fingerprint(workingPath))
  return {
    workingPath,
    result,
    migratedTables: migrated,
    changedTables: changed,
    ok: changed.length === 0,
    lines: describeDryRun(result, changed, migrated)
  }
}
