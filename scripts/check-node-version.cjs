#!/usr/bin/env node
/**
 * Guards npm scripts against running under an incompatible Node major
 * version. `engine-strict` in .npmrc only checks `npm install`, not
 * `npm run <script>`, so a wrong-but-installed Node (picked up from PATH
 * ordering, e.g. a second non-nvm install) would otherwise run silently —
 * as happened with Node 26's experimental global `localStorage` breaking
 * jsdom-based tests under Node 22-targeted tooling.
 */
const MIN_MAJOR = 24
const MAX_MAJOR_EXCLUSIVE = 25

const [major] = process.versions.node.split('.').map(Number)

if (major < MIN_MAJOR || major >= MAX_MAJOR_EXCLUSIVE) {
  console.error(
    `\n✖ This project requires Node >=${MIN_MAJOR} <${MAX_MAJOR_EXCLUSIVE} (see .nvmrc / package.json "engines").\n` +
      `  Currently running Node ${process.version}.\n` +
      `  Fix: run "nvm use" in this directory, then retry.\n`
  )
  process.exit(1)
}
