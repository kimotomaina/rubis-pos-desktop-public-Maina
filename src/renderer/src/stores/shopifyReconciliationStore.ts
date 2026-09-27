/**
 * Zustand store for the Shopify sales-safety check's latest result
 * (docs/phase-170). Reads the result once on `init()`, then updates
 * live via the `shopify-reconciliation:status` broadcast a completed
 * check pushes - no polling needed, since (unlike the fiscal unfiled
 * count) every update already has a push channel.
 */

import { create } from 'zustand'
import type { ReconciliationResult } from '../../../main/services/reconciliation.js'

export interface ShopifyReconciliationState {
  /** `null` before the first successful read, or permanently in check:fit mode / when the check has never run. */
  result: ReconciliationResult | null
  initialized: boolean
  /** Reads the latest result and subscribes to further updates (idempotent). */
  init: () => Promise<void>
}

export const useShopifyReconciliationStore = create<ShopifyReconciliationState>()((set, get) => ({
  result: null,
  initialized: false,

  init: async () => {
    if (get().initialized) return
    set({ initialized: true })

    try {
      const result = await window.api.getShopifyReconciliationStatus()
      if (result.success && result.data !== undefined) {
        set({ result: result.data })
      }
    } catch {
      // Leaves the last known value (null, on first read) rather than throwing past a caller that just wants the card to render.
    }

    window.api.onShopifyReconciliationStatus((fresh) => set({ result: fresh }))
  }
}))
