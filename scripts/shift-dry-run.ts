/**
 * The shift dry run (docs/phase-238): `npm run shift:dry-run -- <path to a COPY of rubis-pos.db>`.
 *
 * Copies the copy into a temporary folder, runs the automatic shift assignment there with no app, no fiscal
 * engine, no Shopify sync and no network, prints what it would do, and proves nothing else changed. The till's
 * own data folder is refused.
 */

import { join } from 'node:path'
import { runShiftDryRun } from '../src/main/lib/shiftDryRun.js'

const source = process.argv[2]
if (!source) {
  console.error('Usage: npm run shift:dry-run -- <path to a copy of rubis-pos.db>')
  process.exit(2)
}

const liveDataDir = join(process.env.APPDATA ?? join(process.env.HOME ?? '', 'AppData', 'Roaming'), 'rubis-pos-desktop')
let outcome: ReturnType<typeof runShiftDryRun>
try {
  outcome = runShiftDryRun({ sourcePath: source, liveDataDir, nowMs: Date.now() })
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

console.log(`Working copy: ${outcome.workingPath}`)
console.log(`Clock: ${new Date().toISOString()}`)
for (const line of outcome.lines) console.log(line)
process.exit(outcome.ok ? 0 : 1)
