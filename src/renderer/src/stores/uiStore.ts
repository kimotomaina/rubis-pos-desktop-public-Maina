/**
 * Zustand store for UI state (Phase 4).
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
  /** Whether the payment-method/checkout modal is open. */
  checkoutModalOpen: boolean
  /** Current catalog search query (matches product/variant title or barcode). */
  searchQuery: string
  /** Sets the product for the variant picker modal (null to close). */
  setSelectedProduct: (product: ProductSummary | null) => void
  /** Switches between catalog and orders views. */
  setActiveView: (view: ActiveView) => void
  /** Opens or closes the checkout modal. */
  setCheckoutModalOpen: (open: boolean) => void
  /** Updates the catalog search query. */
  setSearchQuery: (query: string) => void
}

export const useUiStore = create<UiState>()((set) => ({
  selectedProductForModal: null,
  activeView: 'catalog',
  checkoutModalOpen: false,
  searchQuery: '',

  setSelectedProduct: (product) => set({ selectedProductForModal: product }),
  setActiveView: (view) => set({ activeView: view }),
  setCheckoutModalOpen: (open) => set({ checkoutModalOpen: open }),
  setSearchQuery: (query) => set({ searchQuery: query })
}))
