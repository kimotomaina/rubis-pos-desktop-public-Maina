/**
 * The "stock-take history is never current stock" guard.
 *
 * A comment saying "do not read these tables as stock" will not survive
 * six months of other people's changes. This test will: it fails the
 * build the moment any module outside the stock-take service, its
 * schema and its IPC handlers so much as names the history tables.
 *
 * That is the enforcement. Everything else — the column naming, the
 * file-header JSDoc — is signposting for whoever trips it.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SRC_ROOT = join(process.cwd(), 'src')

/**
 * Files allowed to name the stock-take history tables, by repo-relative
 * path.
 *
 * `database.ts` owns the schema and the only statements that touch
 * these tables. `stock-take.ts` is the service. `index.ts` holds the
 * IPC handlers that expose it. Nothing else has any business here, and
 * the POS read path is not on this list at all.
 */
const ALLOWED = [
  join('src', 'main', 'services', 'database.ts'),
  join('src', 'main', 'services', 'stock-take.ts'),
  join('src', 'main', 'index.ts')
]

/** Table names no other module may reference. */
const HISTORY_TABLES = ['stock_take_items', 'stock_take_sessions']

/**
 * Every `.ts`/`.tsx` file under `src`.
 *
 * @param {string} dir
 * @returns {string[]} absolute paths
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

describe('stock-take history is never read as current stock', () => {
  it('is referenced only by the schema, the service and its IPC handlers', () => {
    const offenders: string[] = []

    for (const file of sourceFiles(SRC_ROOT)) {
      const repoPath = relative(process.cwd(), file)
      if (ALLOWED.includes(repoPath)) continue

      const contents = readFileSync(file, 'utf8')
      for (const table of HISTORY_TABLES) {
        if (contents.includes(table)) {
          offenders.push(`${repoPath.split(sep).join('/')} references ${table}`)
        }
      }
    }

    expect(offenders).toEqual([])
  })

  /**
   * The allow-list is only meaningful if the paths on it exist — a
   * renamed file would otherwise silently widen the guard to nothing.
   */
  it('has an allow-list that still points at real files', () => {
    for (const allowed of ALLOWED) {
      const contents = readFileSync(join(process.cwd(), allowed), 'utf8')
      expect(contents.length).toBeGreaterThan(0)
    }
  })

  it('names no history column "quantity", so none can be mistaken for a live one', () => {
    const schema = readFileSync(
      join(SRC_ROOT, 'main', 'services', 'database.ts'),
      'utf8'
    )
    const tableBodies = HISTORY_TABLES.map((table) => {
      const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`)
      expect(start).toBeGreaterThan(-1)
      return schema.slice(start, schema.indexOf(')`', start))
    })

    for (const body of tableBodies) {
      expect(body).not.toMatch(/^\s*quantity\s/m)
    }
  })

  /**
   * The POS read path must keep taking its quantities from Shopify and
   * the display cache, never from a count someone took last Tuesday.
   */
  it('leaves the product read path untouched', () => {
    const database = readFileSync(join(SRC_ROOT, 'main', 'services', 'database.ts'), 'utf8')
    const getCachedProducts = database.slice(
      database.indexOf('getCachedProducts('),
      database.indexOf('queueOrder(')
    )
    expect(getCachedProducts).not.toMatch(/stock_take/)
  })
})
