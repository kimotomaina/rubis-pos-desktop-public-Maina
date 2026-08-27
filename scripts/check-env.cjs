#!/usr/bin/env node
/**
 * Guards `npm run dist`/`dist:dir` against a missing `.env` (Phase 16).
 * `electron-builder.yml`'s `extraResources` bundles `.env` into every
 * packaged build by literal path — if it's absent, `electron-builder`
 * fails with a raw ENOENT partway through packaging, after typecheck
 * and the full app build have already run. This fails fast, before
 * any of that work happens, with a message that says what to do about
 * it instead of a bare stack trace.
 *
 * Only the file's existence is a hard failure — individual blank
 * Shopify fields are a warning, not an error, since Phase 16 added an
 * Admin-screen path to configure the store URL/token after install
 * without `.env` at all.
 */
const fs = require('fs')
const path = require('path')

const ENV_PATH = path.join(__dirname, '..', '.env')
const RECOMMENDED_KEYS = ['VITE_SHOPIFY_STORE_URL', 'VITE_SHOPIFY_ADMIN_API_TOKEN']

if (!fs.existsSync(ENV_PATH)) {
  console.error(
    '\n✖ .env not found at the project root.\n' +
      '  electron-builder bundles this file into every installer/portable build —\n' +
      '  without it, packaging fails partway through with a raw ENOENT.\n' +
      '  Fix: copy .env.example to .env, then fill in real values (or leave the\n' +
      '  Shopify fields blank and set them from the Admin screen after install).\n'
  )
  process.exit(1)
}

const contents = fs.readFileSync(ENV_PATH, 'utf8')
const missingKeys = RECOMMENDED_KEYS.filter((key) => {
  const match = contents.match(new RegExp(`^${key}=(.*)$`, 'm'))
  return !match || !match[1].trim()
})

if (missingKeys.length > 0) {
  console.warn(
    `\n⚠ .env is missing a value for: ${missingKeys.join(', ')}.\n` +
      '  This is fine if you plan to set them from the Admin screen after install —\n' +
      '  otherwise fill them in before building.\n'
  )
}

console.log('✓ .env found — will be bundled into the packaged app.')
