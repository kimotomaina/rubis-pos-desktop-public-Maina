#!/usr/bin/env node
/**
 * Wipes this app's local Electron `userData` directory — the SQLite
 * database (`rubis-pos.db` + its `-wal`/`-shm` files), the encrypted
 * credential vault (`secret-vault.json`), the error log, and Chromium's
 * on-disk storage for the renderer (`localStorage`, used by the cart's
 * `persist` middleware) — so `npm run dev` starts exactly as it would
 * on a freshly installed machine: unconfigured, no staff, no orders,
 * no saved Shopify/M-Pesa/eTIMS credentials.
 *
 * Resolves the same directory Electron's `app.getPath('userData')`
 * would, without needing to launch Electron: `<name>` in `package.json`
 * (no `productName` override exists in this app's main process), under
 * the OS's standard per-app config root. A safety check refuses to
 * delete anything unless the resolved path's last segment is this
 * app's exact name, so a misconfigured environment variable can never
 * point this at something else.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

const { name: appName } = require('../package.json')

function resolveUserDataPath() {
  const home = os.homedir()
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), appName)
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', appName)
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), appName)
  }
}

const userDataPath = resolveUserDataPath()

if (path.basename(userDataPath) !== appName) {
  console.error(`\n✖ Refusing to delete — resolved path doesn't end in "${appName}":\n  ${userDataPath}\n`)
  process.exit(1)
}

if (!fs.existsSync(userDataPath)) {
  console.log(`\nNo local data found at ${userDataPath} — already clean.\n`)
  process.exit(0)
}

try {
  fs.rmSync(userDataPath, { recursive: true, force: true })
} catch (err) {
  if (err.code === 'EPERM' || err.code === 'EBUSY') {
    console.error(
      `\n✖ Could not delete ${userDataPath} — a file inside it is still locked.\n` +
        '  This almost always means RUBIS POS (or a leftover `electron-vite dev`) is\n' +
        '  still running. Close every RUBIS POS / electron.exe window, then re-run\n' +
        '  this command.\n'
    )
    process.exit(1)
  }
  throw err
}

console.log(`\n✔ Cleared local app data:\n  ${userDataPath}\n  (database, credential vault, error log, cart/localStorage)\n`)
