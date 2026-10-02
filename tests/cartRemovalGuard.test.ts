/**
 * The "cart removals are an audit, not a data source" guard (docs/phase-197).
 *
 * Same idea as `stockTakeGuard.test.ts`: a comment saying "nothing in the
 * POS path reads this" will not survive six months of other people's
 * changes, so this fails the build the moment any module outside the
 * database layer and the service that writes the rows so much as names the
 * table or its read method.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SRC_ROOT = join(process.cwd(), 'src')

/** `database.ts` owns the table and every statement that touches it. */
const ALLOWED = [join('src', 'main', 'services', 'database.ts')]

const AUDIT_TABLE = 'cart_line_removals'
const READ_METHOD = 'listCartLineRemovals'

/**
 * @param {string} dir
 * @returns {string[]} every `.ts`/`.tsx` file under `dir`, absolute
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

describe('cart removals are never read in the POS path', () => {
  it('names the table and its read method only in the database layer', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(SRC_ROOT)) {
      const repoPath = relative(process.cwd(), file)
      if (ALLOWED.includes(repoPath)) continue
      const contents = readFileSync(file, 'utf8')
      for (const name of [AUDIT_TABLE, READ_METHOD]) {
        if (contents.includes(name)) offenders.push(`${repoPath.split(sep).join('/')} references ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('has an allow-list that still points at a real file', () => {
    for (const allowed of ALLOWED) {
      expect(readFileSync(join(process.cwd(), allowed), 'utf8').length).toBeGreaterThan(0)
    }
  })

  it('selects from the table in exactly one place: the support/test reader', () => {
    const database = readFileSync(join(SRC_ROOT, 'main', 'services', 'database.ts'), 'utf8')
    const selects = database.match(new RegExp(`FROM ${AUDIT_TABLE}`, 'g')) ?? []
    expect(selects).toHaveLength(1)

    const reader = database.slice(database.indexOf(`${READ_METHOD}(`))
    expect(reader.slice(0, 300)).toContain(`FROM ${AUDIT_TABLE}`)
  })

  it('keeps the order and product read paths free of the table', () => {
    const database = readFileSync(join(SRC_ROOT, 'main', 'services', 'database.ts'), 'utf8')
    const getCachedProducts = database.slice(database.indexOf('getCachedProducts('), database.indexOf('queueOrder('))
    expect(getCachedProducts).not.toContain(AUDIT_TABLE)

    const getOrders = database.slice(database.indexOf('  getOrders('), database.indexOf('  getOrdersNeedingAttention('))
    expect(getOrders).not.toContain(AUDIT_TABLE)
  })
})
