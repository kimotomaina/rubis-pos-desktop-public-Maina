# Phase 2 — Shopify Integration & Display

**Date:** 2026-08-24 · **Branch:** `main` · **Previous:** [Phase 1](./phase-1.md)

## 1. Objective

Display the merchant's **active product catalog** (fetched live from the
Shopify Admin API) in a touch-friendly grid, and add any tapped product's
primary variant to the cart. Cart state (add / remove / quantity /
totals) lives in a Zustand v5 store that is fully unit-tested.

## 2. Key Architectural Decision — GraphQL over REST

The original Phase 2 question (Q1) defaulted to the **REST Admin API**.
During planning we verified against official Shopify documentation and
found that **REST is legacy for new apps** — Shopify deprecated it for
new public apps in April 2025 and all new private/internal apps are
expected to use the **GraphQL Admin API**. RUBIS POS is a new internal
app, so this phase was implemented with **GraphQL** (`2026-07`, the
latest stable version at build time).

| Concern | Decision |
| --- | --- |
| API flavour | GraphQL Admin API (`/admin/api/2026-07/graphql.json`) |
| Auth | `X-Shopify-Access-Token` header |
| Client | `axios` instance with 10 s timeout |
| Error contract | No throws — always resolves `ServiceResult<T>` |
| Images | Live CDN URLs; missing images render an initials placeholder (no HTTP fallback) |
| Persistence | In-memory only (SQLite deferred to Phase 3) |

## 3. Data Flow

```
Renderer (React)                     Preload                    Main (Node)
─────────────────                    ───────                    ───────────
productStore.fetchProducts()
        │
        ├── window.api.fetchProducts() ──► ipcRenderer.invoke('products:fetch')
        │                                                        │
        │                                        env vars read ◄─┘
        │                                        fetchProductsAndInventory()
        │                                          └─ axios POST → Shopify GraphQL
        │                                        mapShopifyToSummary()
        │                                                        │
        ◄──────────── ServiceResult<ProductSummary[]> ◄──────────┘
        │
    set({ status, products })
        │
    ProductCard grid renders
```

Credentials (`VITE_SHOPIFY_STORE_URL`, `VITE_SHOPIFY_ADMIN_API_TOKEN`)
are read **only in the main process** — the renderer receives products,
never secrets.

## 4. Files Created / Modified

| File | Action | Purpose |
| --- | --- | --- |
| `src/main/services/shopify-types.ts` | Create | Wire-format + `ServiceResult<T>` types |
| `src/main/services/shopify.ts` | Create | GraphQL client, query, mapper, error translator |
| `src/main/index.ts` | Modify | `products:fetch` + `app:get-version` IPC handlers |
| `src/preload/index.ts` | Modify | expose `fetchProducts()` via contextBridge |
| `src/preload/index.d.ts` | Modify | `Window.electron` typing (ipc surface moved to `window.d.ts`) |
| `src/preload/window.d.ts` | Create | `Window.api` global contract (shared by both tsconfigs) |
| `src/renderer/src/types/shopify.ts` | Create | `ProductSummary`, `VariantSummary`, `CartItem` |
| `src/renderer/src/stores/cartStore.ts` | Create | Zustand cart slice |
| `src/renderer/src/stores/productStore.ts` | Create | Zustand product-fetch slice |
| `src/renderer/src/components/ProductCard.tsx` | Create | tappable catalog tile |
| `src/renderer/src/components/CartLineItem.tsx` | Create | cart row with ± quantity controls |
| `src/renderer/src/components/EmptyState.tsx` | Create | reusable empty/error/placeholder |
| `src/renderer/src/App.tsx` | Rewrite | 2-pane POS shell wiring stores ↔ UI |
| `tests/cartStore.test.ts` | Create | 10 tests |
| `tests/shopifyService.test.ts` | Create | 15 tests |
| `tests/productStore.test.ts` | Create | 4 tests |
| `tsconfig.node.json` | Modify | load `src/preload/*.d.ts` so tests see `window.api` |
| `docs/phase-2.md` | Create | this document |

## 5. API Contract

### 5.1 GraphQL query (`PRODUCT_LIST_QUERY`)

```graphql
query GetProducts($first: Int!) {
  products(first: $first, query: "status:active") {
    nodes {
      id
      title
      handle
      status
      featuredImage { id url altText }
      variants(first: 10) {
        nodes {
          id
          title
          availableForSale
          inventoryQuantity
          image { id url altText }
          price { amount currencyCode }
        }
      }
    }
  }
}
```

- `status:active` filter excludes drafts/unpublished products.
- Default page size `first: 20` (configurable via `options.first`).
- Variant cap of 10 per product keeps payloads small for the POS grid.

### 5.2 `ServiceResult<T>`

```ts
interface ServiceResult<T> {
  success: boolean
  data?: T
  error?: string   // human-readable, safe to show on the POS screen
}
```

Error translation (`translateAxiosError`):

| Condition | User-facing message |
| --- | --- |
| HTTP 401 | `Authentication failed — check VITE_SHOPIFY_ADMIN_API_TOKEN` |
| HTTP 403 | `Access denied — the token lacks required Shopify API scopes` |
| HTTP 404 | `Store not found — check VITE_SHOPIFY_STORE_URL` |
| HTTP 429 | `Rate limited — please wait and try again` |
| `ENOTFOUND` / `ECONNREFUSED` | `Network error — store unreachable` |
| Timeout (`ECONNABORTED` / `ETIMEDOUT`) | `Request timed out — check your network connection` |
| other | `Shopify API error (<status>)` |

### 5.3 Canvas types

`mapShopifyToSummary()` flattens the nested GraphQL tree:

- `gid://shopify/Product/632910392` → `productId: "632910392"` stamped on every variant
- `price.amount: "29.99"` → `price: 29.99` (number)
- `featuredImage` falls back to the first variant's image, else `null` → UI shows initials placeholder

## 6. State Stores (Zustand v5)

### `useCartStore`

```ts
items: CartItem[]
addItem(item, qty = 1)      // merges by variant id
removeItem(id)
updateQuantity(id, qty)     // qty <= 0 removes the line
clearCart()
getTotal(): number          // Σ price × quantity
getItemCount(): number      // Σ quantity
```

Keyed by **variant** id — size/color combos are separate cart rows.

### `useProductStore`

```ts
products: ProductSummary[]
status: 'idle' | 'loading' | 'ready' | 'error'
error: string | undefined
fetchProducts()             // fires the IPC fetch
reset()
```

Two stores (not one) keeps cart mutations from re-rendering the catalog grid.

## 7. Test Matrix

29 new tests across 3 files (40 total including Phase 1's foundation suite).

**`tests/cartStore.test.ts`** — 10 tests: empty start, add, merge
duplicate, explicit qty, remove, set qty, qty-0 removal, total, item
count, clear.

**`tests/shopifyService.test.ts`** — 15 tests:

- `mapShopifyToSummary` (5): flattening, productId extraction, price
  parsing, image fallback, empty input.
- `fetchProductsAndInventory` (7): success, empty catalog, GraphQL
  errors array, 401 / network / 429 mapping, query + variables payload
  verification.
- `createShopifyClient` (3): invalid URL throw, URL normalization,
  auth + content-type headers.

Test technique: a **mock `AxiosInstance`** is injected via
`options.client`, so no module-level `vi.mock('axios')` is needed and
the real client path stays covered by the mapping/pure tests.

**`tests/productStore.test.ts`** — 4 tests with `window.api.fetchProducts`
stubbed per-test: idle start, success → `ready`, failure → `error`,
reset.

Run with:

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit (node + web)
```

## 8. UI Behavior

- **Loading** — 8 pulsing skeleton tiles while the fetch is in flight.
- **Ready** — responsive grid (2–5 columns by viewport), tap adds the
  first variant.
- **Error** — `EmptyState` with the translated error and a hint.
- **Cart** — live line items with `− / +` steppers, remove `✕`, subtotal
  per line, grand total, and a `Checkout` button (disabled when empty;
  wiring comes in Phase 4).
- **No image** — CSS initials placeholder from the product title
  (`bg-slate-200`, no SVG/HTTP).

## 9. Known Limitations (deferred to Phase 3+)

- **No pagination** — 1-page `first: 20` fetch; cursor pagination with
  `pageInfo` is needed for >20-product catalogs.
- **No retry / backoff on 429** — immediate user-facing message only.
- **No caching / offline** — every startup re-fetches; SQLite cache
  planned for Phase 3.
- **Currency** — naive `$xx.xx` formatting; `Intl.NumberFormat` with the
  store currency code comes in Phase 3.
- **Cart is memory-only** — a renderer reload clears it; persistence
  comes in Phase 3.
- **Multi-variant selection** — only the first variant is addable from
  the tile; a variant picker modal is a Phase 3/4 UX story.

## 10. Dependencies

No new packages — Phase 1 already provisioned `axios`, `zustand`,
React 19, TypeScript 5.9, and Vitest 3.2 (see Phase 1 doc for the
full dependency rationale).

---

*Phase 2 status: implementation complete — see the completion report in
the chat history for the exact test/typecheck output.*
