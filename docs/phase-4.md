# Phase 4 — Catalog Completeness, Variants, and Order Management

**Date:** 2026-08-24 · **Branch:** `main` · **Previous:** [Phase 3](./phase-3.md)

## 1. Objective

Remove the Phase 2/3 limitations called out at the end of Phase 3:
paginate the full Shopify catalog instead of the first 20 products,
scope inventory to a single physical location, let cashiers pick a
specific variant on multi-variant products, and give a visible order
history with retry for orders stuck in `pending_sync` / `failed`.

## 2. Decisions (Q1–Q3 accepted as specified)

| # | Decision | Value |
| --- | --- | --- |
| Q1 | Variant flattening | Kept the Phase 3 one-row-per-variant `products` table; added `variant_title` so the offline cache can render a picker without re-fetching |
| Q2 | Modal/view state | New Zustand `uiStore` (`selectedProductForModal`, `activeView`) — kept separate from `productStore`/`cartStore` |
| Q3 | Location resolution | env var → `settings` table → auto-detect first Shopify location, persisted back to `settings` |

## 3. SQLite Schema Additions

```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- products: variant_title TEXT NOT NULL DEFAULT '' added
-- orders:   payload_json TEXT NOT NULL DEFAULT '{}' (already present since Phase 3)
```

New `RubisDatabase` methods: `getSetting(key)`, `setSetting(key, value)`,
`getOrders(limit = 50, offset = 0)` (`ORDER BY created_at DESC`), and
`retryOrderSync(localId)` — re-queues a `failed`/`pending_sync` order
from its stored `sync_queue.payload_json`, throwing if the order is
already `synced` or doesn't exist.

## 4. Shopify Pagination & Inventory Scoping

`fetchAllProducts(storeUrl, token, { pageSize = 250, locationId?, client? })`
loops `products(first, after)` until `pageInfo.hasNextPage` is false,
short-circuiting on the first page (or any page) that returns GraphQL
`errors` — no partial-success results are returned.

Inventory is scoped in a **second, separate query** rather than nested
per-variant: `fetchInventoryLevels(client, locationId)` paginates
`inventoryLevels(locationId, first: 250, after)` and returns a
`Map<variantId, quantity>`, which `fetchAllProducts` merges onto the
already-fetched variants. If no `locationId` is available, variants
keep Shopify's aggregate `inventoryQuantity`. This keeps the products
query response small regardless of location count.

`fetchFirstLocation(client)` queries `locations(first: 1)` and is used
only as a fallback (see §5) — its result is cached in `settings` so
it only runs once per store.

## 5. Location Resolution (main process, startup)

```
VITE_SHOPIFY_LOCATION_ID env var
        │ missing
        ▼
settings.get('location_id')
        │ missing
        ▼
fetchFirstLocation(shopify client)  ── success ──► settings.set('location_id', id)
        │ failure/no credentials
        ▼
locationId stays undefined → fetchAllProducts falls back to aggregate inventory
```

`shopifyEnv()` (env-var reader) is declared *before* this block runs —
it's called synchronously as part of the location-resolution branch,
so it must exist before that point in `main/index.ts` (a same-file
declaration-order bug here previously broke `npm run typecheck` and
would have thrown at runtime).

## 6. IPC Contract (Phase 4 additions)

| Channel | Direction | Payload |
| --- | --- | --- |
| `orders:getLocal` | invoke | `{ limit?, offset? }` → `ServiceResult<OrderRow[]>` |
| `orders:retrySync` | invoke | `localId: number` → `ServiceResult<{ queueId: number }>` |
| `products:fetch` | invoke (changed) | now calls `fetchAllProducts` with the resolved `locationId` instead of the single-page Phase 2 fetch |

Preload exposes `getLocalOrders(limit?, offset?)` and
`retryOrderSync(localId)` on `window.api`.

## 7. Renderer Behavior

- **`uiStore`** — `selectedProductForModal: ProductSummary | null`,
  `activeView: 'catalog' | 'orders'`.
- **`ProductCard`** — single-variant products still add straight to
  the cart on tap; multi-variant products call `onSelectProduct` to
  open the picker instead, and show a `"N variants"` badge over the
  image.
- **`VariantModal`** — lists every variant with its own image/price/
  stock, tapping one adds it to the cart and closes the modal
  (`App.tsx` wires `onSelectVariant` → `addItem` → `setSelectedProduct(null)`).
- **`OrderHistory`** — fetches `getLocalOrders(50, 0)` on mount, shows
  a status badge per order (`Synced` / `Syncing…` / `Failed`), and a
  "Retry Sync" button on `failed`/`pending_sync` rows that calls
  `retryOrderSync` then re-fetches.
- **`App.tsx` navigation** — header tabs toggle `activeView`; the
  Catalog tab renders the existing product grid + cart sidebar, the
  Orders tab renders `<OrderHistory />` in the same main region (the
  cart sidebar is catalog-only). The variant modal renders as an
  overlay above whichever view is active whenever
  `selectedProductForModal` is set.

## 8. Files Created / Modified

| File | Action | Purpose |
| --- | --- | --- |
| `src/main/services/shopify.ts` | Modify | `fetchAllProducts`, `fetchInventoryLevels`, `fetchFirstLocation`, `INVENTORY_LEVELS_QUERY`, `FIRST_LOCATION_QUERY` |
| `src/main/services/shopify-types.ts` | Modify | `ShopifyPageInfo`, `ShopifyInventoryLevel` |
| `src/main/services/database.ts` | Modify | `settings` table, `variant_title` column, `getSetting`/`setSetting`, `getOrders`, `retryOrderSync` |
| `src/main/index.ts` | Modify | location resolution, `orders:getLocal`/`orders:retrySync` handlers, `products:fetch` now uses `fetchAllProducts`; fixed `shopifyEnv` declared-after-use bug and dropped the unused `fetchProductsAndInventory` import |
| `src/preload/index.ts` | Modify | `getLocalOrders`, `retryOrderSync` |
| `src/preload/window.d.ts` | Modify | extended `PosApi` |
| `src/renderer/src/stores/uiStore.ts` | Create | `selectedProductForModal`, `activeView` |
| `src/renderer/src/components/VariantModal.tsx` | Create | variant picker overlay |
| `src/renderer/src/components/ProductCard.tsx` | Modify | multi-variant → modal, single-variant → add to cart, variant-count badge |
| `src/renderer/src/components/OrderHistory.tsx` | Create | order list, status badges, retry |
| `src/renderer/src/App.tsx` | Modify | nav tabs actually gate `activeView`, `VariantModal`/`OrderHistory` rendered, `onSelectProduct` wired into `ProductCard` |
| `tests/pagination.test.ts` | Create | 8 tests |
| `tests/orderHistory.test.ts` | Create | 7 tests |
| `tests/database.test.ts` | Modify | updated the per-variant cache-replace assertion for the new `variant_title` column |
| `docs/phase-4.md` | Create | this document |

## 9. Testing Strategy

Same rule as Phase 3: mock `better-sqlite3` with a recording fake and
inject a mock axios client — no native binding or network access in
tests.

```bash
npm test          # vitest run — 11 files / 104 tests
npm run typecheck # tsc --noEmit (node + web)
```

| Suite | Coverage highlights |
| --- | --- |
| `pagination.test.ts` (8) | single page, multi-page cursor following, empty catalog, GraphQL errors on page 1 and on a later page (no partial success), network error mid-pagination, inventory-map merge with a `locationId`, aggregate-quantity fallback without one |
| `orderHistory.test.ts` (7) | `getOrders` SQL shape + default/custom limit-offset, `retryOrderSync` queue-insert from `payload_json`, status reset to `pending_sync`, rejects an already-`synced` order, rejects a non-existent order |
| `database.test.ts` (15, 1 updated) | per-variant cache replace now asserts the `variant_title` param |

## 10. Known Limitations (candidate backlog)

- **`OrderRow.payload_json`** — the type declares it but `getOrders`'s
  `SELECT` doesn't project it; only `retryOrderSync`'s own lookup reads
  that column directly. Not a bug today (no caller reads
  `.payload_json` off a `getOrders` row) but worth tightening if the
  order-history UI ever needs to show the raw payload.
- **No pagination UI** — `OrderHistory` always requests the first 50
  orders; `getOrders(limit, offset)` supports paging but nothing calls
  it with a non-zero offset yet.
- **Rate limits** — `fetchAllProducts`/`fetchInventoryLevels` page back
  to back with no inter-page delay; large catalogs may need a small
  delay or Shopify's cost-based throttling headers respected.

---

*Phase 4 status: implementation complete — `npm test` (104/104) and
`npm run typecheck` both pass.*
