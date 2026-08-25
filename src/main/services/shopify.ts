import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosResponse
} from 'axios'
import type {
  ServiceResult,
  ShopifyGraphQLResponse,
  ShopifyProduct
} from './shopify-types.js'
import type { ProductSummary } from '../../renderer/src/types/shopify.js'

/**
 * Shopify GraphQL Admin API — version 2026-07 (latest stable at build time).
 */
export const GRAPHQL_ENDPOINT_SUFFIX = '/admin/api/2026-07/graphql.json'

/**
 * GraphQL query to fetch active products with pagination support.
 *
 * Uses cursor-based pagination (`first`/`after`) and returns
 * `pageInfo` for loop termination.
 */
export const PRODUCT_LIST_QUERY = `
query GetProducts($first: Int!, $after: String) {
  products(first: $first, after: $after, query: "status:active") {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      title
      handle
      status
      featuredImage {
        id
        url
        altText
      }
      variants(first: 250) {
        nodes {
          id
          title
          availableForSale
          inventoryQuantity
          barcode
          image {
            id
            url
            altText
          }
          price
        }
      }
    }
  }
}
`

/**
 * GraphQL query to fetch inventory levels at a specific location.
 * Used for location-scoped inventory display.
 */
export const INVENTORY_LEVELS_QUERY = `
query GetInventoryLevels($locationId: ID!, $first: Int!, $after: String) {
  inventoryLevels(locationId: $locationId, first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      quantity
      item {
        variant {
          id
        }
      }
    }
  }
}
`

/**
 * GraphQL query to fetch the first available location.
 * Used as a fallback when VITE_SHOPIFY_LOCATION_ID is not set.
 */
export const FIRST_LOCATION_QUERY = `
query GetFirstLocation {
  locations(first: 1) {
    nodes {
      id
      name
    }
  }
}
`

/**
 * Maps a Shopify product's global id (`gid://shopify/Product/123`)
 * to a plain numeric string for lighter client-side consumption.
 *
 * @param {string} gid — Shopify global id
 * @returns {string} the numeric suffix
 */
function extractNumericId(gid: string): string {
  return gid.split('/').pop() ?? gid
}

/**
 * Converts a Shopify variant into the renderer-facing
 * {@link VariantSummary} shape.
 *
 * @param variant — raw Shopify variant edge
 * @returns the mapped variant summary
 */
function mapVariant(variant: {
  id: string
  title: string
  availableForSale: boolean
  inventoryQuantity: number
  image: { url: string; altText: string | null } | null
  price: string
  barcode: string | null
}): ProductSummary['variants'][number] {
  return {
    id: variant.id,
    productId: '',
    title: variant.title,
    price: parseFloat(variant.price) || 0,
    availableForSale: variant.availableForSale,
    inventoryQuantity: variant.inventoryQuantity,
    image: variant.image?.url ?? null,
    barcode: variant.barcode ?? null
  }
}

/**
 * Flattens Shopify's nested GraphQL response into the flat
 * {@link ProductSummary} list consumed by the renderer.
 *
 * Exported so unit tests can verify mapping logic independently
 * of the network layer.
 *
 * @param {ShopifyProduct[]} products — raw Shopify product nodes
 * @param {Map<string, number>} [inventoryMap] — optional location-scoped inventory quantities keyed by variant id
 * @returns {ProductSummary[]}
 */
export function mapShopifyToSummary(
  products: ShopifyProduct[],
  inventoryMap?: Map<string, number>
): ProductSummary[] {
  return products.map((p) => {
    const firstVariant = p.variants.nodes[0]
    const variants = p.variants.nodes.map((v) => {
      const mapped = mapVariant(v)
      const locationQty = inventoryMap?.get(v.id)
      return {
        ...mapped,
        productId: extractNumericId(p.id),
        inventoryQuantity: locationQty ?? v.inventoryQuantity
      }
    })
    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      featuredImage: p.featuredImage?.url ?? firstVariant?.image?.url ?? null,
      variants
    }
  })
}

/**
 * Builds an `axios` instance pre-configured for the Shopify GraphQL
 * Admin API.
 *
 * @param {string} storeUrl — full store URL with protocol
 * @param {string} token — Admin API access token
 * @returns {AxiosInstance}
 * @throws {Error} if storeUrl is not a valid absolute URL
 */
export function createShopifyClient(
  storeUrl: string,
  token: string
): AxiosInstance {
  const normalized = storeUrl.endsWith('/')
    ? storeUrl.slice(0, -1)
    : storeUrl

  try {
    new URL(normalized)
  } catch {
    throw new Error(
      'Invalid Shopify store URL — ensure VITE_SHOPIFY_STORE_URL is a full URL like https://your-store.myshopify.com'
    )
  }

  return axios.create({
    baseURL: normalized + GRAPHQL_ENDPOINT_SUFFIX,
    timeout: 10_000,
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    }
  })
}

/**
 * Translates an `AxiosError` into a human-readable message
 * suitable for POS display.
 *
 * @param {AxiosError} err
 * @returns {string}
 */
function translateAxiosError(err: AxiosError): string {
  if (!err.response) {
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return 'Request timed out — check your network connection'
    }
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      return 'Network error — store unreachable'
    }
    return 'Network error — check your store URL and token'
  }

  const { status } = err.response
  switch (status) {
    case 401:
      return 'Authentication failed — check VITE_SHOPIFY_ADMIN_API_TOKEN'
    case 403:
      return 'Access denied — the token lacks required Shopify API scopes'
    case 404:
      return 'Store not found — check VITE_SHOPIFY_STORE_URL'
    case 429:
      return 'Rate limited — please wait and try again'
    default:
      return `Shopify API error (${status})`
  }
}

/**
 * Fetches active products with their variants and inventory
 * from the Shopify GraphQL Admin API.
 *
 * @param {string} storeUrl
 * @param {string} token
 * @param {object} [options]
 * @param {number} [options.first = 20] — page size
 * @param {AxiosInstance} [options.client] — injected client for testing
 * @returns {Promise<ServiceResult<ProductSummary[]>>}
 */
export async function fetchProductsAndInventory(
  storeUrl: string,
  token: string,
  options?: { first?: number; client?: AxiosInstance }
): Promise<ServiceResult<ProductSummary[]>> {
  const client = options?.client ?? createShopifyClient(storeUrl, token)

  try {
    const response: AxiosResponse<ShopifyGraphQLResponse> = await client.post(
      '',
      {
        query: PRODUCT_LIST_QUERY,
        variables: { first: options?.first ?? 20 }
      }
    )

    const errors = response.data?.errors
    if (errors && errors.length > 0) {
      return {
        success: false,
        error:
          errors.map((e) => e.message).join('; ') ||
          'Shopify returned an unknown error'
      }
    }

    const productNodes = response.data?.data?.products?.nodes ?? []

    if (productNodes.length === 0) {
      return { success: true, data: [] }
    }

    const mapped = mapShopifyToSummary(productNodes)
    return { success: true, data: mapped }
  } catch (err) {
    if (err instanceof AxiosError) {
      return { success: false, error: translateAxiosError(err) }
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'An unknown error occurred'
    }
  }
}

/**
 * Fetches inventory levels at a specific location, paginated.
 *
 * @param {AxiosInstance} client
 * @param {string} locationId
 * @returns {Promise<Map<string, number>>} variant id → quantity
 */
export async function fetchInventoryLevels(
  client: AxiosInstance,
  locationId: string
): Promise<Map<string, number>> {
  const inventoryMap = new Map<string, number>()
  let cursor: string | null = null
  let hasNextPage = true

  while (hasNextPage) {
    const response = await client.post('', {
      query: INVENTORY_LEVELS_QUERY,
      variables: { locationId, first: 250, after: cursor }
    })

    const data = response.data?.data?.inventoryLevels
    if (!data) break

    for (const level of data.nodes ?? []) {
      const variantId = level.item?.variant?.id
      if (variantId) {
        inventoryMap.set(variantId, level.quantity)
      }
    }

    hasNextPage = data.pageInfo?.hasNextPage ?? false
    cursor = data.pageInfo?.endCursor ?? null
  }

  return inventoryMap
}

/**
 * Fetches the first available location from Shopify.
 *
 * @param {AxiosInstance} client
 * @returns {Promise<{ id: string; name: string } | null>}
 */
export async function fetchFirstLocation(
  client: AxiosInstance
): Promise<{ id: string; name: string } | null> {
  try {
    const response = await client.post('', {
      query: FIRST_LOCATION_QUERY
    })

    const nodes = response.data?.data?.locations?.nodes
    if (nodes && nodes.length > 0) {
      return { id: nodes[0].id, name: nodes[0].name }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Fetches all active products with pagination, optionally scoped
 * to a specific location's inventory.
 *
 * @param {string} storeUrl
 * @param {string} token
 * @param {object} [options]
 * @param {number} [options.pageSize=250] — products per page
 * @param {string} [options.locationId] — scope inventory to this location
 * @param {AxiosInstance} [options.client] — injected client for testing
 * @returns {Promise<ServiceResult<ProductSummary[]>>}
 */
export async function fetchAllProducts(
  storeUrl: string,
  token: string,
  options?: {
    pageSize?: number
    locationId?: string
    client?: AxiosInstance
  }
): Promise<ServiceResult<ProductSummary[]>> {
  const client = options?.client ?? createShopifyClient(storeUrl, token)
  const pageSize = options?.pageSize ?? 250

  try {
    let allProducts: ProductSummary[] = []
    let cursor: string | null = null
    let hasNextPage = true

    while (hasNextPage) {
      const response: AxiosResponse<ShopifyGraphQLResponse> =
        await client.post('', {
          query: PRODUCT_LIST_QUERY,
          variables: { first: pageSize, after: cursor }
        })

      const errors = response.data?.errors
      if (errors && errors.length > 0) {
        return {
          success: false,
          error: errors.map((e) => e.message).join('; ') || 'Shopify returned an unknown error'
        }
      }

      const connection = response.data?.data?.products
      const productNodes = connection?.nodes ?? []

      if (productNodes.length > 0) {
        const mapped = mapShopifyToSummary(productNodes)
        allProducts.push(...mapped)
      }

      hasNextPage = connection?.pageInfo?.hasNextPage ?? false
      cursor = connection?.pageInfo?.endCursor ?? null
    }

    if (options?.locationId && allProducts.length > 0) {
      const inventoryMap = await fetchInventoryLevels(client, options.locationId)
      if (inventoryMap.size > 0) {
        allProducts = allProducts.map((product) => ({
          ...product,
          variants: product.variants.map((variant) => ({
            ...variant,
            inventoryQuantity: inventoryMap.get(variant.id) ?? variant.inventoryQuantity
          }))
        }))
      }
    }

    return { success: true, data: allProducts }
  } catch (err) {
    if (err instanceof AxiosError) {
      return { success: false, error: translateAxiosError(err) }
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'An unknown error occurred'
    }
  }
}

