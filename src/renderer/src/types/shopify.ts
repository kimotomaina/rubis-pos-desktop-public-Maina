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
  /** Device VAT class (A-E), from the product's `rubis.vat_class` metafield. Absent means class A. */
  vatClass?: string
  /** Harmonized System code, from the product's `rubis.hs_code` metafield. */
  hsCode?: string
  /** Harmonized System name, from the product's `rubis.hs_name` metafield. */
  hsName?: string
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
  /** Device VAT class (A-E), read from the product's `rubis.vat_class` metafield when present. */
  vatClass?: string
  /** Harmonized System code, read from the product's `rubis.hs_code` metafield when present. */
  hsCode?: string
  /** Harmonized System name, read from the product's `rubis.hs_name` metafield when present. */
  hsName?: string
}

/**
 * `held:hold` payload (docs/phase-217): the cart being parked. No payment state: a
 * held sale never carries a payment method, a tendered amount or a typed code.
 */
export interface HoldSaleRequest {
  cartToken: string
  /** The cashier signed in. */
  staffId: number
  /** Display only; the real total is recomputed when the sale is checked out. */
  total: number
  items: CartItem[]
  cartDiscount?: Discount
  customerPin?: string
  companyName?: string
}

/** `held:discard` payload (docs/phase-217): the main process re-verifies `managerPin`. */
export interface DiscardHeldSaleRequest {
  id: number
  /** The cashier signed in. */
  staffId: number
  managerId: number
  managerPin: string
  reason: string
}

/**
 * `cart:record-removals` payload (docs/phase-197): manager-approved removals
 * or reductions of cart lines. The main process re-verifies `managerPin`.
 */
export interface CartRemovalRequest {
  /** Identifies the cart, so checkout can stamp only its rows with the order id. */
  cartToken: string
  /** The cashier signed in. */
  staffId: number
  managerId: number
  managerPin: string
  changes: { variantId: string; qtyBefore: number; qtyAfter: number }[]
}
