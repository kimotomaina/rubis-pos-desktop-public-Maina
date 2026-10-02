/**
 * Where the mock provider's test banner may live (docs/phase-198).
 *
 * "TEST. NOT A TAX INVOICE." marks a mock sale's fiscal slip. It exists in
 * `mock-etims-provider.ts` and nowhere else under `src/`, so no real print path
 * can produce it; the build check also fails if it reaches `out/main`.
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { MOCK_SLIP_BANNER } from '../src/main/services/integrations/mock-etims-provider.js'

const ROOT = resolve(__dirname, '..')
const BANNER_WORDS = 'TEST. NOT A TAX INVOICE'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|cjs|js)$/.test(name) ? [path] : []
  })
}

describe('the mock test banner', () => {
  it('says what the compliance rule says', () => {
    expect(MOCK_SLIP_BANNER).toBe('TEST. NOT A TAX INVOICE.')
  })

  it('appears under src/ only in mock-etims-provider.ts', () => {
    const holders = sourceFiles(join(ROOT, 'src'))
      .filter((file) => readFileSync(file, 'utf8').includes(BANNER_WORDS))
      .map((file) => relative(ROOT, file).split('\\').join('/'))

    expect(holders).toEqual(['src/main/services/integrations/mock-etims-provider.ts'])
  })

  it('is on the build check that fails when a mock reaches out/main', () => {
    const guard = readFileSync(join(ROOT, 'scripts', 'verify-no-mock-provider.cjs'), 'utf8')

    expect(guard).toContain(BANNER_WORDS)
    expect(guard).toContain("'KRA-MOCK-'")
  })
})
