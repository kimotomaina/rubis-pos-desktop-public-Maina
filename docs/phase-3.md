# Phase 3 — Offline Mode & Local SQLite Sync Engine

**Date:** 2026-08-24 · **Branch:** `main` · **Previous:** [Phase 2](./phase-2.md)

## 1. Objective

Keep the register selling when the internet drops: every checkout is
persisted to a local SQLite database the moment it happens; a background
sync engine pushes queued orders to Shopify automatically once
connectivity returns; the UI reports live network state and shows
"Saved Offline — Will Sync" when an order could not reach Shopify yet.

## 2. Decisions (Q1–Q3 accepted as specified)

| # | Decision | Value |
| --- | --- | --- |
| Q1 | Database library | `better-sqlite3@13.0.3` — synchronous, zero-overhead reads, standard for Electron |
| Q2 | Sync triggers | (a) immediate after checkout · (b) `setInterval` 30 s · (c) immediate on offline→online |
| Q3 | Order mutation | `orderCreate` with `financialStatus: PAID` + `options.inventoryBehaviour: DECREMENT_OBEYING_POLICY`, tagged with `client_order_uuid` (custom attribute + `rubis_pos` metafield) |
| D1 | Backoff storage | `sync_queue.next_attempt_at` (epoch ms) — survives restarts |
| D2 | Queue lifecycle | queue row deleted on sync; `orders.status` is completion source of truth; abandoned after 10 attempts (`failed`) |
| D3 | Cart persistence | Zustand `persist` → `localStorage["rubis-pos-cart"]`; confirmed orders live in SQLite |
| D4 | Idempotency | local claim-based (row removed only after confirmed success) + uuid tag on Shopify order for reconciliation |
| D5 | Network detection | Electron-native `net.isOnline()` polled every 5 s + `powerMonitor` resume; no npm `online` package |
| D6 | Rebuild hook | `"postinstall": "electron-rebuild -f -w better-sqlite3"` (`@electron/rebuild@4.2.0` devDep) |

Verified against official docs (2026-07, latest stable):
`OrderCreateOrderInput` keeps `financialStatus` (only `customerId` is
deprecated), `OrderCreateOptionsInput` exposes
`inventoryBehaviour (default BYPASS) / sendReceipt / sendFulfillmentReceipt`,
and Electron's main `net` module exposes `isOnline()` + `net.online`.

## 3. SQLite Schema

Database file: `app.getPath('userData')/rubis-pos.db` (WAL mode).

```sql
CREATE TABLE IF NOT EXISTS products (
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  variant_id TEXT PRIMARY KEY,
  price REAL NOT NULL,
  inventory_quantity INTEGER NOT NULL,
  image_url TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  local_id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_order_id TEXT,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_sync'
    CHECK (status IN ('pending_sync', 'synced', 'failed')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  next_attempt_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sync_queue_next_attempt
  ON sync_queue (next_attempt_at);
```

**Row semantics**

- `products` — one row per variant; full-replace snapshot after every
  successful live catalog fetch (offline browsing fallback).
- `orders` — ledger of every checkout on this terminal; `synced` carries
  `shopify_order_id`, `failed` means the retry budget was exhausted.
- `sync_queue` — pure work list; `payload_json` holds the
  `OfflineOrderPayload` (`clientOrderUuid`, `total`, `lineItems`,
  `createdAt`).

## 4. Sync State Machine

```
          checkout click
                │
                ▼
   orders.status = pending_sync ──► sync_queue row (attempts=0)
                │
       ┌────────┴─────────┐
       │ engine tick      │  (a) checkout  (b) 30 s interval
       │ while online     │  (c) offline → online
       ▼                  │
  orderCreate push        │
   ┌────┴────┐            │
   ▼         ▼            │
 success   failure ───────┘
   │         │
   │         ▼
   │    attempts += 1
   │    next_attempt_at = now + min(30s · 2^(n-1), 30min)
   │         │
   │         ├── attempts < 10 ──► pending_sync (queue kept)
   │         └── attempts ≥ 10 ──► orders.status = failed,
   │                                    queue row removed
   ▼
 orders.status = synced
 shopify_order_id stored, queue row removed
```

Backoff table: attempt 1 → 30 s · 2 → 60 s · 3 → 120 s · 4 → 240 s ·
5 → 480 s · 6 → 960 s · 7+ → 30 min cap. `computeBackoffMs` is a pure
export covered by unit tests.

The engine (`createSyncEngine`) is stateless except for its timer and a
re-entrancy guard; all persistence lives in the database service.

## 5. Network Detection Strategy

| Layer | Mechanism |
| --- | --- |
| Probe | Electron main `net.isOnline()` injected into the monitor (no npm package) |
| Poll | every 5 s via `createNetworkMonitor`; emits **only on transitions** |
| Wake-up | `powerMonitor.on('resume')` forces a probe |
| Renderer notify | `webContents.send('network:status', { online })` broadcast |
| Initial state | renderer invokes `network:get-status` on startup |
| Sync reaction | offline → online fires `engine.notifyOnline()` (immediate drain) |

Limitation acknowledged by design: `net.isOnline() === true` is not a
guarantee Shopify is reachable — failed pushes fall back on the queue +
backoff path, which makes the distinction invisible to cashiers.

## 6. IPC Contract (Phase 3 additions)

| Channel | Direction | Payload |
| --- | --- | --- |
| `orders:checkout` | invoke | `{ items: CartItem[], total }` → `ServiceResult<CheckoutReceipt>` |
| `products:cached` | invoke | → `ServiceResult<ProductSummary[]>` (SQLite snapshot) |
| `network:get-status` | invoke | → `{ online: boolean }` |
| `network:status` | event | `{ online: boolean }` on transitions |

`CheckoutReceipt`: `{ localId, mode: 'synced' | 'queued-offline', shopifyOrderId? }`.
Checkout handler policy: **always** queue locally first; if online, run
an immediate `engine.tick()` before answering so the receipt can say
"synced". The renderer shows "✓ Order synced to Shopify" or
"Saved Offline — Will Sync" accordingly.

## 7. Renderer Behavior

- **Cart persistence** — Zustand `persist` middleware, key
  `rubis-pos-cart`, partializes `items` only (checkout status is
  ephemeral). Carts survive renderer restarts.
- **Offline catalog** — `productStore.fetchProducts()` tries the live
  API; on failure reads `products:cached`; the UI badges
  "Cached catalog (offline)" when serving the snapshot.
- **Header indicator** — green "Online" / red "Offline — sales will
  queue" pill driven by `networkStore`.
- **Checkout button** — disabled while empty/submitting; label switches
  to "Processing…" during submit; result banner for synced / queued /
  error (cart preserved on error).

## 8. Files Created / Modified

| File | Action | Purpose |
| --- | --- | --- |
| `package.json` | Modify | `better-sqlite3` dep, `@electron/rebuild` + `@types/better-sqlite3` devDeps, scoped `postinstall` |
| `src/main/services/database.ts` | Create | schema, `queueOrder`, `getPendingSyncQueue`, `markQueueItemSynced`, `recordQueueFailure`, cache methods, `computeBackoffMs` |
| `src/main/services/orders.ts` | Create | `ORDER_CREATE_MUTATION`, `buildOrderInput`, `pushOrderToShopify` |
| `src/main/services/sync-engine.ts` | Create | queue-drain loop, three triggers, re-entrancy guard |
| `src/main/services/network.ts` | Create | `net.isOnline()` polling monitor w/ transition emits |
| `src/main/services/shopify-types.ts` | Modify | `OfflineOrderLine`, `OfflineOrderPayload` |
| `src/main/index.ts` | Modify | Phase 3 wiring: db init, engine, monitor, new IPC handlers, cache mirror on live fetch, `will-quit` cleanup |
| `src/preload/index.ts` | Modify | `checkout`, `getCachedProducts`, `getNetworkStatus`, `onNetworkStatus` |
| `src/preload/window.d.ts` | Modify | `PosApi` + `NetworkStatusPayload` extensions |
| `src/renderer/src/stores/cartStore.ts` | Rewrite | `persist` middleware + `checkout()` action + statuses |
| `src/renderer/src/stores/productStore.ts` | Modify | SQLite cache fallback + `cached` flag |
| `src/renderer/src/stores/networkStore.ts` | Create | connectivity state (idempotent `init`) |
| `src/renderer/src/App.tsx` | Modify | online/offline pill, cached badge, checkout wiring + banners |
| `tests/database.test.ts` | Create | 15 tests |
| `tests/syncEngine.test.ts` | Create | 12 tests |
| `tests/orders.test.ts` | Create | 9 tests |
| `tests/networkMonitor.test.ts` | Create | 4 tests |
| `tests/cartCheckout.test.ts` | Create | 7 tests |
| `tests/productStore.test.ts` | Modify | +2 cache-fallback tests |
| `docs/phase-3.md` | Create | this document |

## 9. Testing Strategy

Primary rule: **mock the native module and the network, never touch
either for real.** `better-sqlite3` is replaced with a recording fake
(`vi.mock('better-sqlite3')`), so the service's exact SQL and
parameter traffic is asserted without any `.node` binding; the Shopify
push uses an injected mock axios client (Phase 2 pattern).

```bash
npm test          # vitest run — 9 files / 89 tests
npm run typecheck # tsc --noEmit (node + web)
```

| Suite | Coverage highlights |
| --- | --- |
| `database.test.ts` (15) | WAL + DDL execution, idempotent init, per-variant cache replace, queue-order transaction + payload JSON, due-date query param, sync marking, failure/backoff scheduling, exhaustion → `failed`, cache rehydration, `computeBackoffMs` curve |
| `syncEngine.test.ts` (12) | success drain, failure recording, offline no-op, mid-batch offline stop, exhaustion continuation, re-entrancy coalescing, interval timing, stop/idempotent start, online + checkout triggers (fake timers) |
| `orders.test.ts` (9) | variable shape (`PAID`, `DECREMENT_OBEYING_POLICY`, uuid attribute + metafield), success mapping, `userErrors`, transport `errors[]`, 429/401 mapping, non-axios error passthrough |
| `networkMonitor.test.ts` (4) | silent baseline, transition-only emits, `checkNow`, stop |
| `cartCheckout.test.ts` (7) | empty-cart guard, request shape, synced/queued receipts + cart clearing, error keeps cart, exception path, localStorage persistence |
| `productStore.test.ts` (+2) | cache fallback + both-fail error |


## 10. Manual Offline-Mode Runbook

To verify the full loop on the developer machine (`npm run dev`):

1. **Seed while online.** Start the app, confirm the live catalog loads
   (green pill). Close the app and reopen — the cart survives
   (localStorage persistence).
2. **Go offline.** Toggle Wi-Fi off (Windows Action Center), or for a
   renderer-only view use DevTools → Network → Offline. The header
   flips to the red "Offline — sales will queue" pill within ≤5 s.
3. **Take a sale offline.** Add items and hit Checkout — expect
   "Saved Offline — Will Sync". Relaunching offline serves the
   "Cached catalog (offline)" snapshot and sales still complete.
4. **Restore connectivity.** Turn Wi-Fi back on — the monitor emits
   within ≤5 s, `notifyOnline()` fires, and the queued order reaches
   Shopify. Verify in the Shopify admin: paid status, correct line
   items, `rubis_pos.client_order_uuid` metafield present.
5. **Crash-restart check (optional).** While offline with a queued
   sale, quit and relaunch; the `sync_queue` row survives in SQLite
   and syncs after reconnect.

Note: trial/dev stores cap `orderCreate` at 5 orders/minute — expect
rate-limit paths during load testing.

## 11. Known Limitations (candidate backlog for Phase 4)

- **Ambiguous outcomes** — a push that times out *after* Shopify
  creates the order will retry; the `client_order_uuid` tag supports
  manual reconciliation, an automatic dedupe query is not implemented.
- **Catalog cache fidelity** — the `products` table stores the spec's
  columns only; rehydrated cached cards lose variant titles (defaults
  to `''`) and `handle`; `availableForSale` is derived from stock.
- **No partial-sync UI** — `failed` orders are visible only in the DB;
  a retry/inspect screen is deferred.
- **Currency** — orders omit `currency` and use the store default;
  totals are POS-computed, not recomputed server-side.
- **Single-machine assumption** — no multi-terminal conflict handling.
- **No pagination** — catalog cache limited to Phase 2's 20-product
  first page until cursor pagination lands.

## 12. Dependencies Added

| Package | Version | Location | Why |
| --- | --- | --- | --- |
| `better-sqlite3` | `^13.0.3` | dependencies | local SQLite (native, prebuilt for Electron ABI) |
| `@electron/rebuild` | `^4.2.0` | devDependencies | recompiles native modules against Electron's ABI (`postinstall`) |
| `@types/better-sqlite3` | `^9.6.0` | devDependencies | typings for the native module |

`electron-vite`'s `externalizeDepsPlugin()` already externalizes
runtime dependencies from the main bundle, so the native `.node`
binding loads from `node_modules` unchanged — no bundler config change
was required.

---

*Phase 3 status: implementation complete — see the completion report in
the chat history for exact test/typecheck output.*

