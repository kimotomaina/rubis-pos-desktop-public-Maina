/**
 * Zustand store for the fetched product catalog.
 *
 * Separated from the cart store because products are *server-derived data*
 * (read-only after fetch) while cart items are *user mutations*.
 * Keeping them apart avoids unnecessary re-renders of the product grid
 * when the cart changes.
 */

import { create } from 'zustand'
import type { ProductSummary } from '../types/shopify.js'
import type { ServiceResult } from '../../../main/services/shopify-types.js'
import type { CatalogSyncResult } from '../../../main/services/catalog-sync.js'
import type { AutoDiscount, SkippedDiscount } from '../../../main/lib/autoDiscounts.js'

export type ProductStatus = 'idle' | 'loading' | 'ready' | 'error'

/** What the last sync did, for the Sync button's message (docs/phase-253-1). */
export interface CatalogSyncSummary {
  productCount: number
  discountCount: number
  skipped: SkippedDiscount[]
  /** One line per part not refreshed; empty when everything was. */
  messages: string[]
}

export interface ProductState {
  /** Currently displayed products. */
  products: ProductSummary[]
  /** Current async status. */
  status: ProductStatus
  /** Last error message, if any. */
  error: string | undefined
  /** True when the displayed catalog came from the SQLite cache. */
  cached: boolean
  /** The till's copy of Shopify's automatic discounts (docs/phase-253-1). */
  discounts: AutoDiscount[]
  /** When the products were last read in full, as the main process stamped it. */
  lastSyncedAt: string | null
  /** True while a sync runs; a second one is not started. */
  syncing: boolean
  /** Trigger a fetch via the IPC bridge. */
  fetchProducts: () => Promise<void>
  /**
   * The catalogue sync (docs/phase-253-1): at start, after each login and from the Sync button. Resolves with what it
   * did, or `null` when one was already running. Never throws.
   */
  sync: () => Promise<CatalogSyncSummary | null>
  /** Reset to idle / empty state (used on auth change). */
  reset: () => void
}

export const useProductStore = create<ProductState>()((set, get) => ({
  products: [],
  status: 'idle',
  error: undefined,
  cached: false,
  discounts: [],
  lastSyncedAt: null,
  syncing: false,

  fetchProducts: async () => {
    set({ status: 'loading', error: undefined, cached: false })

    if (!window.api) {
      set({ status: 'error', error: 'App bridge unavailable — please restart RUBIS POS.' })
      return
    }

    const response: ServiceResult<ProductSummary[]> =
      await window.api.fetchProducts()

    if (response.success && response.data) {
      set({ status: 'ready', products: response.data })
      return
    }

    try {
      const cacheResult: ServiceResult<ProductSummary[]> =
        await window.api.getCachedProducts()

      if (
        cacheResult.success &&
        cacheResult.data &&
        cacheResult.data.length > 0
      ) {
        set({ status: 'ready', products: cacheResult.data, cached: true })
        return
      }
    } catch {
      // cache read failed — fall through to the error state below
    }

    set({ status: 'error', error: response.error ?? 'Failed to load products' })
  },

  sync: async () => {
    if (get().syncing) return null
    set({ syncing: true, ...(get().products.length === 0 ? { status: 'loading' as const, error: undefined } : {}) })
    try {
      const result = await window.api.catalogSync()
      if (!result.success || !result.data) {
        const message = result.error ?? 'The catalogue sync failed'
        if (get().products.length === 0) set({ status: 'error', error: message })
        return { productCount: get().products.length, discountCount: get().discounts.length, skipped: [], messages: [message] }
      }
      const data: CatalogSyncResult = result.data
      if (data.products.length > 0) {
        set({ products: data.products, status: 'ready', error: undefined, cached: !data.productsRefreshed && !data.refused })
      } else {
        set({ status: 'error', error: data.messages[0] ?? 'Failed to load products' })
      }
      set({ discounts: data.discounts, lastSyncedAt: data.lastSyncedAt })
      return {
        productCount: data.products.length,
        discountCount: data.discounts.length,
        skipped: data.skipped,
        messages: data.messages
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The catalogue sync failed'
      if (get().products.length === 0) set({ status: 'error', error: message })
      return { productCount: get().products.length, discountCount: get().discounts.length, skipped: [], messages: [message] }
    } finally {
      set({ syncing: false })
    }
  },

  reset: () =>
    set({ products: [], status: 'idle', error: undefined, cached: false })
}))
