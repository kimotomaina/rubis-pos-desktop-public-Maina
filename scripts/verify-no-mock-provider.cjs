#!/usr/bin/env node
/**
 * Post-`build` guard: asserts neither mock provider is in the
 * production main-process bundle.
 *
 * `resolveFiscalizationProvider` reaches `mock-etims-provider.ts` only
 * through a dynamic import inside an `import.meta.env.DEV` branch, which
 * Rollup should drop from a production build. "Should" is not good
 * enough here: shipping the mock means a till could mint `KRA-MOCK-`
 * invoice numbers and print them on receipts for sales that were never
 * filed with KRA, breaching Rule 2. This turns a silent bundler
 * regression into a failed build.
 *
 * The same applies to `mock-mpesa-provider.ts`, reached only through
 * `resolveMpesaProvider`'s dev-only dynamic import. Its
 * `verifyTransactionCode` approves almost any transaction code, so a
 * shipped M-Pesa mock lets a till complete sales for payments that never
 * happened — the payment-side twin of the same breach.
 */
const fs = require('fs')
const path = require('path')

/** Strings that only exist in a mock provider's compiled output. */
const FORBIDDEN = ['KRA-MOCK-', 'MockFiscalizationProvider', 'MockMpesaProvider', 'TEST. NOT A TAX INVOICE']

const BUNDLE_DIR = path.join(__dirname, '..', 'out', 'main')

if (!fs.existsSync(BUNDLE_DIR)) {
  console.error('\n✖ out/main not found — did electron-vite actually produce a build?\n')
  process.exit(1)
}

const bundleFiles = fs
  .readdirSync(BUNDLE_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => path.join(BUNDLE_DIR, entry.name))

if (bundleFiles.length === 0) {
  console.error('\n✖ No .js files under out/main — cannot verify the mock provider was excluded.\n')
  process.exit(1)
}

const hits = []

for (const filePath of bundleFiles) {
  const contents = fs.readFileSync(filePath, 'utf8')
  for (const needle of FORBIDDEN) {
    if (contents.includes(needle)) {
      hits.push(`${path.relative(path.join(__dirname, '..'), filePath)} contains "${needle}"`)
    }
  }
}

if (hits.length > 0) {
  console.error(
    '\n✖ A mock provider reached the production bundle:\n' +
      hits.map((hit) => `    ${hit}\n`).join('') +
      '\n  A shipped mock can print a fiscal receipt for a sale that was never filed,\n' +
      '  or confirm an M-Pesa payment that never happened.\n' +
      '  Check that the only path to mock-etims-provider.ts is the dynamic import\n' +
      '  inside the import.meta.env.DEV branch in fiscal-provider-factory.ts, and\n' +
      '  likewise for mock-mpesa-provider.ts in mpesa-provider-factory.ts.\n'
  )
  process.exit(1)
}

console.log('✓ Confirmed: neither mock provider is in out/main.')
