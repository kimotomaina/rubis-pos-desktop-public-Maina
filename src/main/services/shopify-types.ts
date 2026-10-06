/**
 * Type definitions for the raw Shopify GraphQL Admin API responses.
 *
 * These describe the *wire format* — the shapes returned by Shopify's
 * GraphQL endpoint.  They are deliberately verbose so the TypeScript
 * compiler catches field renames on the Shopify side.
 */

import type { SalePayment } from '../lib/paymentLegs.js'
import type { AppliedAutoDiscount } from '../lib/autoDiscounts.js'

/** A Shopify product image. */
export interface ShopifyImage {
  id: string
  url: string
  altText: string | null
}

/**
 * A Shopify product variant (the actual sellable unit). Deliberately
 * has no `inventoryQuantity` field — that's Shopify's cross-location
 * aggregate, which this app never queries; stock is always resolved
 * from the location-scoped `inventoryLevels` query instead (see
 * `fetchInventoryLevels`), so it never shows a total across every
 * location as if it were the confirmed location's stock.
 */
export interface ShopifyVariant {
  id: string
  title: string
  availableForSale: boolean
  /** Decimal string in the shop's default currency (API 2026-07 scalar, not MoneyV2). */
  price: string
  image: ShopifyImage | null
  barcode: string | null
}

/** One metafield read with `metafield(namespace, key) { value }`; `null` when the product has none. */
export interface ShopifyMetafieldValue {
  value: string
}

/** A Shopify product with up to N variants. */
export interface ShopifyProduct {
  id: string
  title: string
  handle: string
  status: string
  featuredImage: ShopifyImage | null
  /** Product-level `rubis.vat_class` (docs/phase-194, D3) — absent or `null` when the product has none. */
  vatClass?: ShopifyMetafieldValue | null
  /** Product-level `rubis.hs_code`. */
  hsCode?: ShopifyMetafieldValue | null
  /** Product-level `rubis.hs_name`. */
  hsName?: ShopifyMetafieldValue | null
  variants: {
    nodes: ShopifyVariant[]
  }
}

/** Envelope wrapping the GraphQL `products` query connection. */
export interface ShopifyProductsConnection {
  pageInfo: ShopifyPageInfo
  nodes: ShopifyProduct[]
}

/** Pagination info returned by Shopify connections. */
export interface ShopifyPageInfo {
  hasNextPage: boolean
  endCursor: string | null
}

/** Top-level GraphQL response envelope for the products query. */
export interface ShopifyGraphQLResponse {
  data?: {
    products?: ShopifyProductsConnection
  }
  errors?: Array<{
    message: string
    extensions?: Record<string, unknown>
  }>
}

/**
 * Inventory level at a specific location. `quantity` is not a bare
 * scalar on this API version — it's `quantities(names:)`, an array of
 * named buckets (this app only ever requests `"available"`).
 */
export interface ShopifyInventoryLevel {
  quantities: Array<{ name: string; quantity: number }>
  item: {
    /** The inventory item's own id — what an inventory adjustment is keyed by. */
    id: string
    variant: {
      id: string
    }
  }
}

/** Envelope wrapping the GraphQL `inventoryLevels` query connection. */
export interface ShopifyInventoryLevelsConnection {
  pageInfo: ShopifyPageInfo
  nodes: ShopifyInventoryLevel[]
}

/**
 * Top-level GraphQL response envelope for the inventory levels query
 * — `inventoryLevels` is a connection on `Location`, not a top-level
 * QueryRoot field.
 */
export interface ShopifyInventoryLevelsResponse {
  data?: {
    location?: {
      inventoryLevels?: ShopifyInventoryLevelsConnection
    }
  }
  errors?: Array<{
    message: string
    extensions?: Record<string, unknown>
  }>
}

/**
 * A Shopify location, as handed to the renderer: the address is already
 * flattened to one display line (see `formatLocationAddress`), so no
 * consumer has to know Shopify's `LocationAddress` shape.
 */
export interface ShopifyLocation {
  id: string
  name: string
  /** One line of address, when Shopify holds one — absent for a location with no address. */
  address?: string
}

/**
 * A location as it arrives on the wire. `address` itself is non-null on
 * `Location`, but every field inside it is nullable and `formatted` can
 * come back empty, so both levels are treated as optional here.
 */
export interface ShopifyLocationNode {
  id: string
  name: string
  address?: { formatted?: string[] | null } | null
}

/** Top-level GraphQL response envelope for the locations query. */
export interface ShopifyLocationsResponse {
  data?: {
    locations?: {
      nodes: ShopifyLocation[]
    }
  }
  errors?: Array<{
    message: string
    extensions?: Record<string, unknown>
  }>
}

/**
 * Top-level GraphQL response envelope for the combined shop+locations
 * validation query used by the onboarding wizard's "Connect & Verify" step.
 */
export interface ShopifyValidateStoreResponse {
  data?: {
    shop?: { name: string }
    locations?: {
      pageInfo?: ShopifyPageInfo
      nodes: ShopifyLocationNode[]
    }
  }
  errors?: Array<{
    message: string
    extensions?: Record<string, unknown>
  }>
}

/**
 * Standardized service result returned by
 * {@link fetchProductsAndInventory}.
 *
 * Instead of throwing, the service always resolves with a discriminated
 * object so the IPC caller can pattern-match `result.success`.
 */
export interface ServiceResult<T> {
  success: boolean
  data?: T
  error?: string
}

/**
 * A discount applied at either the line-item or cart level.
 * `percent` is a fraction of the base amount (10 = 10%); `fixed` is a
 * flat currency amount subtracted from the base amount.
 */
export interface Discount {
  type: 'percent' | 'fixed'
  value: number
}

/** A single line of an offline order as persisted in the sync queue. */
export interface OfflineOrderLine {
  variantId: string
  title: string
  variantTitle: string
  quantity: number
  unitPrice: number
  /** Line-level discount/manual markdown, if applied. */
  discount?: Discount
  /** The automatic discount this line's units were sold under, at `unitPrice` (docs/phase-253-2). */
  autoDiscount?: AppliedAutoDiscount
}

/**
 * The persisted payload of an `orderCreate` sync-queue entry.
 *
 * `clientOrderUuid` tags the Shopify order (custom attribute + metafield)
 * so retries can be reconciled against accidental duplicates.
 */
export interface OfflineOrderPayload {
  clientOrderUuid: string
  total: number
  lineItems: OfflineOrderLine[]
  createdAt: string
  staffId: number
  staffName: string
  /** One method, or `split` (docs/phase-252) with {@link OfflineOrderPayload.payments}. */
  paymentMethod: 'cash' | 'mpesa' | 'card' | 'split'
  tenderedAmount: number
  changeDue: number
  referenceNumber?: string
  /** A split sale's payments, in the order recorded (docs/phase-252). Absent for a sale paid one way. */
  payments?: SalePayment[]
  /** Customer's KRA PIN, when captured for a B2B eTIMS invoice — omitted for a walk-in B2C sale. */
  customerPin?: string
  /** Cart-level discount applied on top of the line-item subtotal. */
  cartDiscount?: Discount
  /** The Shopify location the sale was taken at, captured at sale time (docs/phase-210). Absent on a sale queued before that phase. */
  locationId?: string
  /** The name of {@link OfflineOrderPayload.locationId}, as the till had it at sale time. */
  locationName?: string
}
