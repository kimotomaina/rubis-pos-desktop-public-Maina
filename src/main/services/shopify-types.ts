/**
 * Type definitions for the raw Shopify GraphQL Admin API responses.
 *
 * These describe the *wire format* — the shapes returned by Shopify's
 * GraphQL endpoint.  They are deliberately verbose so the TypeScript
 * compiler catches field renames on the Shopify side.
 */

/** A Shopify product image. */
export interface ShopifyImage {
  id: string
  url: string
  altText: string | null
}

/** A Shopify product variant (the actual sellable unit). */
export interface ShopifyVariant {
  id: string
  title: string
  availableForSale: boolean
  inventoryQuantity: number
  /** Decimal string in the shop's default currency (API 2026-07 scalar, not MoneyV2). */
  price: string
  image: ShopifyImage | null
  barcode: string | null
}

/** A Shopify product with up to N variants. */
export interface ShopifyProduct {
  id: string
  title: string
  handle: string
  status: string
  featuredImage: ShopifyImage | null
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

/** Inventory level at a specific location. */
export interface ShopifyInventoryLevel {
  quantity: number
  item: {
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

/** Top-level GraphQL response envelope for the inventory levels query. */
export interface ShopifyInventoryLevelsResponse {
  data?: {
    inventoryLevels?: ShopifyInventoryLevelsConnection
  }
  errors?: Array<{
    message: string
    extensions?: Record<string, unknown>
  }>
}

/** A Shopify location. */
export interface ShopifyLocation {
  id: string
  name: string
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
 * A discount applied at either the line-item or cart level (Phase 10).
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
  /** Line-level discount/manual markdown, if applied (Phase 10). */
  discount?: Discount
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
  paymentMethod: 'cash' | 'mpesa' | 'card'
  tenderedAmount: number
  changeDue: number
  referenceNumber?: string
  /** Cart-level discount applied on top of the line-item subtotal (Phase 10). */
  cartDiscount?: Discount
}
