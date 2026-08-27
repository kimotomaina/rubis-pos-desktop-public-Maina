/**
 * Product and cart type definitions shared between the renderer store,
 * the renderer components, and the Zustand cart state.
 *
 * These types sit in the renderer layer because they describe the
 * *consumable* shape of a product after the main-process Shopify
 * service has transformed the raw GraphQL response.
 */

/**
 * A single sellable variant of a product, as consumed by the renderer.
 */
export interface VariantSummary {
  id: string
  productId: string
  title: string
  price: number
  availableForSale: boolean
  inventoryQuantity: number
  image: string | null
  barcode: string | null
}

/**
 * A product as displayed in the POS grid and added to the cart.
 */
export interface ProductSummary {
  id: string
  title: string
  handle: string
  featuredImage: string | null
  variants: VariantSummary[]
}

import type { Discount } from '../../../main/services/shopify-types.js'
export type { Discount }

/**
 * An item in the cart, derived from a product variant.
 * `id` is the variant gid so that multiple variants of the
 * same product are tracked as separate cart rows.
 */
export interface CartItem {
  id: string
  productId: string
  title: string
  variantTitle: string
  price: number
  quantity: number
  image: string | null
  /** Line-item discount, PIN-gated above 10%. */
  discount?: Discount
  /**
   * Original catalog price, captured once when the item is first added
   * to the cart — the ceiling for manual price overrides is checked
   * against this, not the (possibly already-overridden) `price`.
   */
  basePrice?: number
}
