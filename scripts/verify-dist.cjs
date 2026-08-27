#!/usr/bin/env node
/**
 * Post-`dist`/`dist:dir` verification (Phase 16): confirms `.env`
 * actually made it into the packaged output. `check-env.cjs` only
 * proves the source file existed before the build started —
 * `electron-builder` config could still fail to copy it (a typo in
 * `extraResources`, a future edit that removes it) without failing
 * the build itself. This catches that immediately, in the terminal,
 * instead of surfacing as "missing env vars" on a till three weeks
 * from now with nobody in the room who remembers this script exists.
 *
 * Checks every `*-unpacked` directory under `release/` rather than
 * hardcoding `win-unpacked`, since electron-builder names it per
 * architecture (e.g. `win-ia32-unpacked`) if that's ever built too.
 */
const fs = require('fs')
const path = require('path')

const RELEASE_DIR = path.join(__dirname, '..', 'release')

if (!fs.existsSync(RELEASE_DIR)) {
  console.error('\n✖ release/ not found — did the build actually produce output?\n')
  process.exit(1)
}

const unpackedDirs = fs
  .readdirSync(RELEASE_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.endsWith('-unpacked'))
  .map((entry) => entry.name)

if (unpackedDirs.length === 0) {
  console.error(
    '\n✖ No *-unpacked directory found under release/ — cannot verify .env was bundled.\n'
  )
  process.exit(1)
}

let allBundled = true

for (const dirName of unpackedDirs) {
  const bundledEnvPath = path.join(RELEASE_DIR, dirName, 'resources', '.env')
  if (fs.existsSync(bundledEnvPath)) {
    console.log(`✓ Confirmed: ${dirName}/resources/.env is bundled.`)
  } else {
    console.error(`✖ ${dirName}/resources/.env is MISSING from the packaged output.`)
    allBundled = false
  }
}

if (!allBundled) {
  console.error(
    '\n  A machine installing this build will have no Shopify/printer config baked in —\n' +
      '  check electron-builder.yml\'s `extraResources` entry for `.env`.\n'
  )
  process.exit(1)
}

console.log('✓ .env bundling verified — a fresh install of this build needs no manual .env setup.')
