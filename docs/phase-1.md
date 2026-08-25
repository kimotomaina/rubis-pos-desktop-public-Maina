# Phase 1 — Foundation & Scaffold

> **RUBIS POS Desktop** — a custom Windows Point-of-Sale application built with Electron, React, TypeScript, and Vite. Syncs with Shopify as a backend service.

| Attribute | Value |
|---|---|
| Phase | 1 — Foundation & Scaffold |
| Status | ✅ Complete |
| Stack | Electron 43 · electron-vite 5 · Vite 7 · React 19 · TypeScript 5.9 · Tailwind v4 |

---

## 1. Architecture Overview

```
 ┌────────────────────────────────────────────────────────────────────┐
 │                        ELECTRON MAIN PROCESS                        │
 │  src/main/index.ts          (app lifecycle, IPC, BrowserWindow)    │
 │  src/main/window-factory.ts (hardened config builder, testable)   │
 └──────────────────┬───────────────────────────────────┬─────────────┘
                    │                                   │
                    │  preload (contextBridge)           │
                    ▼                                   ▼
 ┌──────────────────────────────┐        ┌──────────────────────────────┐
 │   src/preload/index.ts       │◄──────►│   src/renderer/src/          │
 │  contextBridge.exposeInWorld │        │  App.tsx  (React root)       │
 │  electronAPI  @electron/tl   │        │  main.tsx (createRoot)        │
 │  api.ping, getAppVersion ... │        │  index.css  (@import tw)      │
 └──────────────────────────────┘        │  env.d.ts (Vite types)        │
                                          └──────────────────────────────┘
```

### Process Responsibilities

| Process | Folder | Responsibility |
|---|---|---|
| **Main** | `src/main/` | App lifecycle, window management, IPC handlers, OS integration |
| **Preload** | `src/preload/` | Secure bridge (`contextBridge`) — the *only* channel between main and renderer |
| **Renderer** | `src/renderer/` | React 19 SPA, Tailwind v4 styling, touch-friendly POS UI |
| **Tests** | `tests/` | Vitest unit tests for config + shell logic |

### Security Model

| Setting | Value | Rationale |
|---|---|---|
| `contextIsolation` | `true` | Isolates preload context from renderer JS |
| `sandbox` | `true` | Restricts Node.js APIs in renderer |
| `nodeIntegration` | `false` | Renderer cannot `require()` Node modules |
| `webSecurity` | `true` | Blocks mixed content / insecure loads |

These defaults are centralized in `src/main/window-factory.ts` and **asserted by unit tests**.

## 2. Directory Structure

```
rubis-pos-desktop/
├── package.json              ← manifest (ESM, scripts, deps)
├── .env.example              ← Shopify credential template
├── .gitignore                ← excludes out/, node_modules, .env
├── electron.vite.config.ts   ← orchestrator (main / preload / renderer)
├── vite.config.ts            ← Vitest + renderer dev tooling
├── tsconfig.json             ← root project references
├── tsconfig.node.json        ← TS for main + preload + tests
├── tsconfig.web.json         ← TS for renderer
├── src/
│   ├── main/
│   │   ├── index.ts           ← app lifecycle, IPC handlers, window creation
│   │   └── window-factory.ts  ← pure config builder (unit-testable)
│   ├── preload/
│   │   ├── index.ts           ← contextBridge.exposeInMainWorld
│   │   └── index.d.ts         ← Window type augmentation
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── main.tsx       ← React 19 entry point
│           ├── App.tsx        ← Touch-friendly POS shell
│           ├── index.css      ← @import "tailwindcss"
│           └── env.d.ts       ← Vite env var types
├── tests/
│   ├── setup.ts
│   └── foundation.test.ts     ← Phase 1 unit tests
└── docs/
    └── phase-1.md             ← this file
```

## 3. Stack Decisions

The user mandated "latest packages." The absolute latest of a few packages (vite 8, typescript 7) conflicts with `electron-vite@5` peer ranges and ecosystem stability. We chose the **latest versions that compose into a working stack**:

| Package | Pinned Version | Reason |
|---|---|---|
| `electron-vite` | `^5.0.0` | Latest; the only version line supporting Electron 43 |
| `vite` | `^7.1.0` | Latest within electron-vite's peer range (`^5\|\|6\|\|7`) |
| `@vitejs/plugin-react` | `^4.7.0` | Latest 4.x; 6.x requires Vite 8 |
| `typescript` | `^5.9.0` | Latest 5.x; TS 7.0 is too new for ecosystem tooling |
| `vitest` | `^3.2.0` | Latest 3.x; confirmed Vite 7 compatible |
| `tailwindcss` | `^4.3.3` | Latest v4 — uses `@tailwindcss/vite` plugin (no PostCSS config) |
| `react` / `react-dom` | `^19.2.0` | Latest React 19 |
| `electron` | `^43.4.1` | Latest |


### Tailwind v4 Integration (new in this phase)

Tailwind v4 differs fundamentally from v3.

| v3 (old) | v4 (current) |
|---|---|
| `tailwind.config.js` | CSS `@import "tailwindcss"` + optional `@theme` block |
| `postcss.config.js` with `tailwindcss` + `autoprefixer` | No PostCSS config needed; `@tailwindcss/vite` plugin in Vite |
| `@tailwind base; @tailwind components; @tailwind utilities;` | `@import "tailwindcss";` (single import) |

**Removed from dependency list**: `postcss`, `autoprefixer`. Tailwind v4 ships its own vendor prefixing and is loaded as a Vite plugin (`@tailwindcss/vite`), so no separate PostCSS configuration file is required.

## 4. Prerequisites

- **Node.js** ≥ 20 (tested on 22.23.1)
- **npm** ≥ 10
- **Windows** 10/11 (this project targets Windows POS)

## 5. Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create .env from the example
cp .env.example .env
# Edit .env and add your Shopify store URL + admin token

# 3. Start in development mode
npm run dev
# → Vite dev server + Electron window with HMR
```

## 6. Available Scripts

| Script | Command | Description |
|---|---|---|
| `dev` | `electron-vite dev` | Start dev server + Electron with HMR |
| `start` | `electron-vite preview` | Preview production build |
| `build` | `npm run typecheck && electron-vite build` | Type-check + production build |
| `typecheck` | `tsc --noEmit -p {node,web}` | Validate TypeScript across all projects |
| `test` | `vitest run` | Run all tests once |
| `test:watch` | `vitest` | Watch mode for TDD |

## 7. Testing Strategy

### Tooling

- **Vitest 3** — Vite-native test runner, runs in Node with jsdom environment
- **jsdom 30** — simulates DOM for renderer-touching tests (future phases)

### Test File: tests/foundation.test.ts

11 tests across two suites.

#### Environment Configuration (6 tests)
Validates the `.env.example` contract:
- Empty env vars do not throw
- `VITE_SHOPIFY_STORE_URL` parses as HTTPS with `.myshopify.com` hostname
- `VITE_SHOPIFY_ADMIN_API_TOKEN` is non-empty and matches `shpat_` prefix
- Syntactically malformed URLs raise `TypeError`
- Non-HTTPS protocols are rejected
- Non-myshopify hostnames are rejected

#### App Shell Instantiation (5 tests)
Validates the `window-factory.ts` config builder:
- Production config enforces: `contextIsolation=true`, `sandbox=true`, `nodeIntegration=false`, `webSecurity=true`
- Dev config has the same hardened defaults
- Dev + dev-server URL → `LoadTarget.type === 'url'`
- Production → `LoadTarget.type === 'file'`
- Dev without server URL → graceful fallback to `file`


### Running Tests

```bash
npm test              # run all tests
npm test -- --watch   # watch mode
npm run typecheck     # verify TS compiles before testing
```

## 8. Environment Variables

| Variable | Prefix | Purpose | Required |
|---|---|---|---|
| `VITE_SHOPIFY_STORE_URL` | `VITE_` | Shopify store URL (e.g. `https://rubis-pos.myshopify.com`) | Phase 2+ |
| `VITE_SHOPIFY_ADMIN_API_TOKEN` | `VITE_` | Shopify Admin API access token (`shpat_…`) | Phase 2+ |

The `VITE_` prefix ensures Vite statically injects these at build time and makes them available as `import.meta.env` in the renderer.

⚠️ **`.env` is never committed.** The `.gitignore` excludes it; `.env.example` is the template.

## 9. What's Next (Phase Preview)

| Phase | Focus |
|---|---|
| **Phase 2** | Zustand cart store, Shopify REST API client (`src/main/shopify/`), product-list IPC channel, product grid rendering |
| **Phase 3** | Cart checkout flow, order submission to Shopify, receipt printing |
| **Phase 4** | Packaging (electron-builder for Windows), code signing, auto-update |

## 10. Troubleshooting

**Q: `Error: Cannot find module` in tests**
A: Ensure `npm install` completed. The preload and main imports use `.js` extensions — Vite/electron-vite and the TS path aliases handle resolution.

**Q: `Cannot read properties of undefined (reading 'contextIsolated')`**
A: This error means the preload loaded in a non-Isolated context. Ensure `contextIsolation: true` (set by `createBrowserWindowConfig`).

**Q: Tailwind classes not applied**
A: Confirm `@import "tailwindcss"` is in `src/renderer/src/index.css` and that the `@tailwindcss/vite` plugin is registered in `electron.vite.config.ts`.

## Phase 5.1 Hardening Addendum

A branch audit of Phases 1–5 (see `docs/phase-10.md`-era hardening
work) found that this phase's `BrowserWindow` hardening
(`contextIsolation`, `sandbox`, `webSecurity`, `nodeIntegration: false`
— all in `window-factory.ts`) had no accompanying Content-Security-Policy
header, leaving script/style/connect origins unrestricted at the HTTP
response level.

- **`buildCspHeaders()`** (`src/main/window-factory.ts`) — a pure,
  unit-testable function returning the header map for
  `CONTENT_SECURITY_POLICY`:
  `default-src 'self'; script-src 'self'; connect-src 'self' https://*.myshopify.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;`
- **Wiring** (`src/main/index.ts`) — applied session-wide via
  `session.defaultSession.webRequest.onHeadersReceived`, registered at
  the top of the `app.whenReady()` handler before `createWindow()` so
  every response (not just the initial document load) carries the
  header.
- **Tests** — `tests/security.test.ts` asserts the policy string's
  directives and `buildCspHeaders()`'s output shape.

This is additive — no existing IPC channel, preload API, or renderer
behavior changed.

