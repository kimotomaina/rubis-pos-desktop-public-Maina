#!/usr/bin/env node
/**
 * Guards `npm run dist`/`dist:dir` (and so `dist:publish`) before any
 * build work runs.
 *
 * 1. `.env` must exist (Phase 16): `electron-builder.yml`'s
 *    `extraResources` bundles it by literal path, and a missing file
 *    fails packaging partway through with a raw ENOENT.
 * 2. `.env` must carry no credentials (docs/phase-180): it ships as a
 *    loose plaintext file at `resources/.env` in every installer, and
 *    installers are published publicly (docs/phase-177). Each till gets
 *    these values from the first-run wizard or the Admin screen, which
 *    store them in the encrypted vault or the database under `userData`.
 */
const fs = require('fs')
const path = require('path')

const ENV_PATH = path.join(__dirname, '..', '.env')

/** Keys that must be blank in any `.env` that gets bundled into an installer. */
const BUNDLE_FORBIDDEN_KEYS = [
  'VITE_SHOPIFY_STORE_URL',
  'VITE_SHOPIFY_ADMIN_API_TOKEN',
  'VITE_SHOPIFY_LOCATION_ID',
  'MPESA_CONSUMER_KEY',
  'MPESA_CONSUMER_SECRET',
  'MPESA_PASSKEY'
]

/**
 * Returns the forbidden keys that have a non-blank value. A value is
 * whatever follows `=`, with any ` # comment` and surrounding quotes or
 * whitespace removed; commented-out lines never match.
 *
 * @param {string} contents - the `.env` file's text
 * @returns {string[]} offending key names (never their values)
 */
function findBundledCredentialKeys(contents) {
  return BUNDLE_FORBIDDEN_KEYS.filter((key) => {
    const match = contents.match(new RegExp(`^\\s*${key}\\s*=(.*)$`, 'm'))
    if (!match) return false
    const value = match[1].replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2').trim()
    return value.length > 0
  })
}

module.exports = { BUNDLE_FORBIDDEN_KEYS, findBundledCredentialKeys }

if (require.main === module) {
  if (!fs.existsSync(ENV_PATH)) {
    console.error(
      '\n✖ .env not found at the project root.\n' +
        '  electron-builder bundles this file into every installer/portable build —\n' +
        '  without it, packaging fails partway through with a raw ENOENT.\n' +
        '  Fix: copy .env.example to .env (leave the credential fields blank).\n'
    )
    process.exit(1)
  }

  const offending = findBundledCredentialKeys(fs.readFileSync(ENV_PATH, 'utf8'))
  if (offending.length > 0) {
    console.error(
      `\n✖ .env has values for: ${offending.join(', ')}.\n` +
        '  .env is copied into every installer as a plaintext file anyone can read.\n' +
        '  Blank these before building. Each till sets them from the first-run\n' +
        '  wizard or Admin > Integrations, and keeps them across updates.\n'
    )
    process.exit(1)
  }

  console.log('✓ .env found, no credentials — will be bundled into the packaged app.')
}
