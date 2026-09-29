/**
 * Phase 177: guards the OTA release config as plain text, the same
 * string-check approach `stockTakeGuard.test.ts` and the `.nsh` test
 * below use for files that are not directly executable in Vitest
 * (YAML/NSIS, not TypeScript) — no YAML parser is added as a dependency
 * for this alone.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ELECTRON_BUILDER_YML = join(process.cwd(), 'electron-builder.yml')
const INSTALLER_NSH = join(process.cwd(), 'build', 'installer.nsh')

/** Isolates the `publish:` block so a false positive elsewhere in the file can't pass this test. */
function publishBlock(content: string): string {
  const start = content.indexOf('publish:')
  expect(start).toBeGreaterThan(-1)
  return content.slice(start)
}

describe('electron-builder.yml publish config', () => {
  it('publishes to the public releases-only repo via GitHub', () => {
    const content = readFileSync(ELECTRON_BUILDER_YML, 'utf8')
    const block = publishBlock(content)

    expect(block).toMatch(/provider:\s*github/)
    expect(block).toMatch(/owner:\s*Volcha-Enterprises/)
    expect(block).toMatch(/repo:\s*rubis-pos-releases/)
  })

  it('contains no token-like string anywhere in the file', () => {
    const content = readFileSync(ELECTRON_BUILDER_YML, 'utf8')

    expect(content).not.toMatch(/ghp_/)
    expect(content).not.toMatch(/token\s*:/i)
  })
})

describe('build/installer.nsh update-safety guard', () => {
  it('wraps the app-data removal in the ${isUpdated} guard so an OTA update never wipes it', () => {
    const content = readFileSync(INSTALLER_NSH, 'utf8')
    const macroStart = content.indexOf('!macro customUnInstall')
    const macroEnd = content.indexOf('!macroend', macroStart)
    expect(macroStart).toBeGreaterThan(-1)
    const macroBody = content.slice(macroStart, macroEnd)

    expect(macroBody).toMatch(/\$\{ifNot\}\s*\$\{isUpdated\}/)
    expect(macroBody).toMatch(/RMDir \/r "\$APPDATA\\rubis-pos-desktop"/)
    expect(macroBody).toMatch(/\$\{endIf\}/)

    // The guard must actually wrap the deletion, not merely appear before it.
    const guardIndex = macroBody.search(/\$\{ifNot\}\s*\$\{isUpdated\}/)
    const deleteIndex = macroBody.indexOf('RMDir /r')
    const endIfIndex = macroBody.lastIndexOf('${endIf}')
    expect(guardIndex).toBeLessThan(deleteIndex)
    expect(deleteIndex).toBeLessThan(endIfIndex)
  })
})
