# RUBIS POS Desktop

Custom Windows POS for RUBIS, built on Electron + React, backed by Shopify,
with Kenyan M-Pesa and eTIMS (KRA fiscalization) integrations.

## Prerequisites

- **Node.js 24.x** (`engines` in `package.json` requires `>=24 <25`). Use
  the version pinned in `.nvmrc`:
  ```
  nvm use
  ```
  Every npm script (`dev`, `build`, `test`, `dist`) runs a guard
  (`scripts/check-node-version.cjs`) that hard-fails on any other major
  version — this has bitten people whose PATH picks up a second,
  non-nvm Node install.
- **Windows** — `better-sqlite3` is rebuilt for Electron via
  `electron-rebuild` on `postinstall`, and `dist`/`dist:dir` build a
  Windows installer (`electron-builder --win`).

## Setup

```bash
npm install
```

`postinstall` automatically rebuilds `better-sqlite3` against Electron's
Node ABI — no separate step needed.

Copy the env template and fill in what you have:

```bash
cp .env.example .env
```

`.env` is optional to get the app running — every integration has a
mock/demo fallback (see below) — but copy it anyway so the variables
exist for the app to read.

## Running locally

```bash
npm run dev
```

This starts `electron-vite dev` and launches the app window. Local state
(SQLite DB, credential vault, error log, renderer `localStorage`) lives
under the OS's per-app config directory (Windows:
`%APPDATA%\rubis-pos-desktop`).

To start from a completely clean slate (no staff, no orders, no saved
credentials — as if freshly installed):

```bash
npm run dev:fresh
```

(equivalent to `npm run reset-local-data && npm run dev`)

### Demo mode, with no external services at all

Set these in `.env` to run the full checkout flow with zero live
dependencies (no Shopify store, no M-Pesa, no fiscal device):

```
VITE_DEMO_MODE=true
VITE_MOCK_PRINTER=true
VITE_USE_MOCK_MPESA=true
VITE_USE_MOCK_ETIMS=true
```

- `VITE_DEMO_MODE=true` seeds the local catalog with 10 hardcoded demo
  products instead of fetching from Shopify.
- `VITE_MOCK_PRINTER=true` logs receipts to the console instead of
  requiring a physical ESC/POS printer.
- `VITE_USE_MOCK_MPESA=true` / `VITE_USE_MOCK_ETIMS=true` swap in
  in-process fakes for M-Pesa and eTIMS.

**Note:** once the app has run once, the Admin screen's "Startup
Configuration" panel writes `mock_mpesa_enabled`/`mock_etims_enabled` to
the database, and those DB values take priority over the `.env` flags on
every subsequent launch. Flip the Admin → Integrations toggles (or run
`npm run dev:fresh` to wipe the DB) if changing `.env` alone has no
effect.

### Demo mode with a real (synthetic) fiscal device

To see an actual invoice/QR round-trip against a fake ZFPLabServer
instead of the fully in-process mock:

```bash
npm run mock:zfplab
```

This starts a standalone HTTP server on `http://localhost:4444`. Point
the app at it with `VITE_USE_MOCK_ETIMS=false` (the real provider) and
leave the Admin → Integrations eTIMS base URL at its default. Every
invoice number/QR code this server returns is synthetic and clearly
marked as such — never a real KRA-registered receipt.

### Using real Shopify / M-Pesa / eTIMS

Fill in `VITE_SHOPIFY_STORE_URL` and `VITE_SHOPIFY_ADMIN_API_TOKEN` for a
live product catalog. For M-Pesa/eTIMS, set the relevant `VITE_USE_MOCK_*`
flag to exactly `false` (lowercase, no extra spaces/quotes) and supply
credentials — preferably via the Admin screen's Integrations tab, which
stores secrets in the OS credential vault rather than `.env`.

## Testing

```bash
npm test          # vitest run (single pass)
npm run test:watch
npm run test:live # a separate config for tests that hit real live services
```

## Type checking

```bash
npm run typecheck        # node + web
npm run typecheck:node
npm run typecheck:web
```

## Building a Windows installer

```bash
npm run dist       # full installer via electron-builder
npm run dist:dir   # unpacked build only, for quick local inspection
```

Both run `check-env` first (`scripts/check-env.cjs`) and verify the
output afterward (`scripts/verify-dist.cjs`).

## Troubleshooting

- **"This project requires Node >=24 <25"** — run `nvm use` in this
  directory, then retry.
- **`reset-local-data` fails with EPERM/EBUSY** — close every RUBIS POS
  / `electron.exe` window (including a leftover `electron-vite dev`)
  and re-run.
