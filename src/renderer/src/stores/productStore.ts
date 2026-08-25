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

export type ProductStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ProductState {
  /** Currently displayed products. */
  products: ProductSummary[]
  /** Current async status. */
  status: ProductStatus
  /** Last error message, if any. */
  error: string | undefined
  /** True when the displayed catalog came from the SQLite cache. */
  cached: boolean
  /** Trigger a fetch via the IPC bridge. */
  fetchProducts: () => Promise<void>
  /** Reset to idle / empty state (used on auth change). */
  reset: () => void
}

export const useProductStore = create<ProductState>()((set) => ({
  products: [],
  status: 'idle',
  error: undefined,
  cached: false,

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

  reset: () =>
    set({ products: [], status: 'idle', error: undefined, cached: false })
}))
