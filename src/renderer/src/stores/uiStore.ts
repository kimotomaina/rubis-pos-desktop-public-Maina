/**
 * Zustand store for UI state.
 *
 * Manages the variant modal and navigation state, keeping
 * UI concerns separate from data stores.
 */

import { create } from 'zustand'
import type { ProductSummary } from '../types/shopify.js'

export type ActiveView = 'catalog' | 'orders' | 'admin'

export interface UiState {
  /** The product whose variants are being displayed in the modal. */
  selectedProductForModal: ProductSummary | null
  /** Currently active view in the main content area. */
  activeView: ActiveView
  /** Sets the product for the variant picker modal (null to close). */
  setSelectedProduct: (product: ProductSummary | null) => void
  /** Switches between catalog and orders views. */
  setActiveView: (view: ActiveView) => void
}

export const useUiStore = create<UiState>()((set) => ({
  selectedProductForModal: null,
  activeView: 'catalog',

  setSelectedProduct: (product) => set({ selectedProductForModal: product }),
  setActiveView: (view) => set({ activeView: view })
}))
