import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosResponse
} from 'axios'
import type {
  ServiceResult,
  ShopifyGraphQLResponse,
  ShopifyLocation,
  ShopifyLocationNode,
  ShopifyProduct,
  ShopifyValidateStoreResponse
} from './shopify-types.js'
import type { ProductSummary, VariantSummary } from '../../renderer/src/types/shopify.js'

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
      vatClass: metafield(namespace: "rubis", key: "vat_class") {
        value
      }
      hsCode: metafield(namespace: "rubis", key: "hs_code") {
        value
      }
      hsName: metafield(namespace: "rubis", key: "hs_name") {
        value
      }
      variants(first: 250) {
        nodes {
          id
          title
          availableForSale
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
 *
 * There is no top-level `inventoryLevels(locationId:)` field on this
 * API version's QueryRoot (confirmed against the live API — that
 * shape returns an `undefinedField` GraphQL error) — inventory levels
 * are a connection on `Location` instead, and `InventoryLevel` no
 * longer exposes a bare `quantity` scalar; it's `quantities(names:)`,
 * an array of named buckets. Only `"available"` is requested since
 * that's the only bucket this app sells against.
 *
 * `item { id }` is the inventory item's own id, which
 * `inventoryAdjustQuantities` is keyed by (it will not take a variant
 * id). It is read here and carried in a stock-take session's snapshot;
 * it is deliberately never persisted onto the `products` cache, which
 * would make this app keep a permanent local shadow of Shopify's
 * inventory model.
 */
export const INVENTORY_LEVELS_QUERY = `
query GetInventoryLevels($locationId: ID!, $first: Int!, $after: String) {
  location(id: $locationId) {
    inventoryLevels(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        quantities(names: ["available"]) {
          name
          quantity
        }
        item {
          id
          variant {
            id
          }
        }
      }
    }
  }
}
`

/**
 * GraphQL query used by the first-run onboarding wizard's
 * "Connect & Verify" step and by the location-confirmation gate — one
 * round trip that both confirms `storeUrl`/`token` are valid (via
 * `shop.name`) and returns a page of the locations the operator picks
 * from, instead of two separate requests.
 *
 * Paginated: this used to be `locations(first: 10)` with no `pageInfo`,
 * which silently dropped every location past the tenth — on an account
 * with ~106 of them that left 96 branches unable to select their own
 * location at all. `includeInactive` and `includeLegacy` are deliberately
 * left at their Shopify defaults of `false`, so deactivated locations
 * (which can no longer stock inventory or fulfil orders) and
 * fulfillment-service locations stay out of the picker. `sortKey` is left
 * at its default of `NAME`, so pages read alphabetically.
 *
 * `shop { name }` is re-requested on every page rather than split into a
 * second query: it costs ~1 point, keeps this a single query string, and
 * only ever happens at all on a store with more than
 * {@link LOCATION_PAGE_SIZE} locations.
 */
export const VALIDATE_STORE_QUERY = `
query ValidateStore($first: Int!, $after: String) {
  shop {
    name
  }
  locations(first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      name
      address {
        formatted
      }
    }
  }
}
`

/** Shopify's maximum page size for a connection (shopify.dev, GraphQL pagination, checked 2026-09-25). */
const LOCATION_PAGE_SIZE = 250

/**
 * Hard stop on the pagination loop. A malformed or repeating cursor must
 * fail loudly rather than spin forever; at {@link LOCATION_PAGE_SIZE} this
 * allows 10,000 locations, far beyond any real store and well inside
 * Shopify's own 25,000-object deep-pagination limit.
 */
const MAX_LOCATION_PAGES = 40

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
    // Overwritten by the location-scoped fetchInventoryLevels merge
    // below whenever a location is available; Shopify's cross-location
    // aggregate is deliberately not queried here — a location's stock
    // count must never be the store's total across every location.
    inventoryQuantity: 0,
    image: variant.image?.url ?? null,
    barcode: variant.barcode ?? null
  }
}

/**
 * The product's tax classification, for each of its variants (docs/phase-194,
 * D3: the metafields are product-level). Only a non-blank value is carried, so
 * a product without the metafields maps to exactly what it always did and is
 * sold as class A.
 *
 * @param {ShopifyProduct} product
 * @returns {Pick<VariantSummary, 'vatClass' | 'hsCode' | 'hsName'>}
 */
function mapTaxFields(product: ShopifyProduct): Pick<VariantSummary, 'vatClass' | 'hsCode' | 'hsName'> {
  const fields: Pick<VariantSummary, 'vatClass' | 'hsCode' | 'hsName'> = {}
  const vatClass = product.vatClass?.value?.trim()
  const hsCode = product.hsCode?.value?.trim()
  const hsName = product.hsName?.value?.trim()
  if (vatClass) fields.vatClass = vatClass
  if (hsCode) fields.hsCode = hsCode
  if (hsName) fields.hsName = hsName
  return fields
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
    const taxFields = mapTaxFields(p)
    const variants = p.variants.nodes.map((v) => {
      const mapped = mapVariant(v)
      const locationQty = inventoryMap?.get(v.id)
      return {
        ...mapped,
        ...taxFields,
        productId: extractNumericId(p.id),
        inventoryQuantity: locationQty ?? 0
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
 * Resolves the Shopify store URL a fresh install should use, without
 * requiring a `.env` file on every device. Priority:
 *
 *   1. `envUrl` — `VITE_SHOPIFY_STORE_URL`, for a dev checkout or a
 *      deliberately pre-baked installer (`electron-builder`'s
 *      `extraResources` still bundles whatever `.env` built the
 *      installer).
 *   2. `storedUrl` — set once via the Admin screen's Integrations tab
 *      and persisted to the local `settings` table, mirroring how
 *      `secretStore.ts`'s `resolveShopifyToken` already lets the
 *      Shopify Admin API token skip `.env` entirely.
 *   3. `null` — genuinely unconfigured; the caller surfaces this as
 *      "Shopify credentials missing" and points at the Admin screen.
 *
 * @param {string | undefined} envUrl
 * @param {string | undefined} storedUrl
 * @returns {string | null}
 */
export function resolveShopifyStoreUrl(
  envUrl: string | undefined,
  storedUrl: string | undefined
): string | null {
  return envUrl || storedUrl || null
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
 * Translates an `AxiosError` into a human-readable message suitable
 * for POS display. Includes the host the request was actually aimed
 * at (from the failed request's own config) wherever the failure
 * mode could plausibly be a wrong store URL — a bare "request timed
 * out" gives an operator nothing to act on, but "timed out reaching
 * wrong-store.myshopify.com" immediately shows whether the configured
 * URL itself is the problem.
 *
 * @param {AxiosError} err
 * @returns {string}
 */
export function translateAxiosError(err: AxiosError): string {
  const host = (() => {
    try {
      return err.config?.baseURL ? new URL(err.config.baseURL).host : null
    } catch {
      return null
    }
  })()
  const target = host ? ` (${host})` : ''

  if (!err.response) {
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return `Request timed out${target} — check your network connection, or a firewall/proxy may be blocking this app`
    }
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      return `Store unreachable${target} — check the Store URL in Admin > Integrations`
    }
    return `Network error${target} — check the Store URL/Admin API Token in Admin > Integrations`
  }

  const { status } = err.response
  switch (status) {
    case 401:
      return 'Authentication failed — check the Admin API Token in Admin > Integrations'
    case 403:
      return 'Access denied — the token lacks required Shopify API scopes'
    case 404:
      return `Store not found${target} — check the Store URL in Admin > Integrations`
    case 429:
      return 'Rate limited — please wait and try again'
    default:
      return `Shopify API error (${status})`
  }
}

/**
 * Flattens Shopify's `LocationAddress.formatted` (a list of lines, e.g.
 * `["Mombasa Road", "Nairobi 00100", "Kenya"]`) into the single line a
 * location card shows under its name.
 *
 * The first two lines are kept — street plus city/region is what
 * distinguishes one branch from another; the country repeats on every
 * card and earns no space. An address Shopify holds nothing for comes
 * back as an empty list, which yields `undefined` so the card simply
 * shows no second line.
 *
 * @param {ShopifyLocationNode['address']} address
 * @returns {string | undefined}
 */
export function formatLocationAddress(address: ShopifyLocationNode['address']): string | undefined {
  const lines = (address?.formatted ?? []).map((line) => line.trim()).filter((line) => line !== '')
  return lines.length > 0 ? lines.slice(0, 2).join(', ') : undefined
}

/**
 * Verifies a store URL/token pair works and fetches **every** one of the
 * store's locations — the onboarding wizard's "Connect & Verify" step and
 * the location-confirmation gate. A non-empty `shop.name` in the first
 * response is what proves the token actually authenticated; a bad token
 * or wrong store URL surfaces as a GraphQL error or an HTTP 401/404, both
 * already handled by {@link translateAxiosError}.
 *
 * Follows `pageInfo.hasNextPage`/`endCursor` to exhaustion, in the same
 * loop shape as {@link fetchAllProducts}. At {@link LOCATION_PAGE_SIZE}
 * every realistic store answers in a single request, so this is normally
 * one round trip, as it was before; the loop is here for correctness
 * rather than for any store's current size.
 *
 * A page that fails fails the **whole** call. Returning the pages that
 * did arrive would hand the caller a truncated list indistinguishable
 * from a complete one, which is the exact bug this pagination fixes.
 *
 * @param {string} storeUrl
 * @param {string} token
 * @param {object} [options]
 * @param {AxiosInstance} [options.client] — injected client for testing
 * @returns {Promise<ServiceResult<{ shopName: string; locations: ShopifyLocation[] }>>}
 */
export async function validateAndFetchLocations(
  storeUrl: string,
  token: string,
  options?: { client?: AxiosInstance }
): Promise<ServiceResult<{ shopName: string; locations: ShopifyLocation[] }>> {
  let client: AxiosInstance
  try {
    client = options?.client ?? createShopifyClient(storeUrl, token)
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Invalid store URL' }
  }

  try {
    const locations: ShopifyLocation[] = []
    /** Read and checked on the first page only; later pages re-request it but it cannot change. */
    let shopName = ''
    let cursor: string | null = null
    let hasNextPage = true
    let pages = 0

    while (hasNextPage) {
      if (pages >= MAX_LOCATION_PAGES) {
        return {
          success: false,
          error: `Shopify kept returning more locations after ${MAX_LOCATION_PAGES * LOCATION_PAGE_SIZE} of them — stopping rather than returning a partial list`
        }
      }
      pages += 1

      const response: AxiosResponse<ShopifyValidateStoreResponse> = await client.post('', {
        query: VALIDATE_STORE_QUERY,
        variables: { first: LOCATION_PAGE_SIZE, after: cursor }
      })

      const errors = response.data?.errors
      if (errors && errors.length > 0) {
        return {
          success: false,
          error: errors.map((e) => e.message).join('; ') || 'Shopify returned an unknown error'
        }
      }

      if (pages === 1) {
        shopName = response.data?.data?.shop?.name ?? ''
        if (!shopName) {
          return {
            success: false,
            error: 'Shopify did not return shop details — check the store URL and token'
          }
        }
      }

      const connection = response.data?.data?.locations
      for (const node of connection?.nodes ?? []) {
        locations.push({
          id: node.id,
          name: node.name,
          address: formatLocationAddress(node.address)
        })
      }

      hasNextPage = connection?.pageInfo?.hasNextPage ?? false
      cursor = connection?.pageInfo?.endCursor ?? null
    }

    return { success: true, data: { shopName, locations } }
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

/** One variant's location-scoped level, as read from Shopify. */
export interface InventoryLevelDetail {
  /** What `inventoryAdjustQuantities` is keyed by — not the variant id. */
  inventoryItemId: string
  /** The `"available"` bucket at this location. */
  available: number
}

/**
 * Fetches inventory levels at a specific location, paginated, keeping
 * each variant's inventory item id alongside its quantity.
 *
 * The single paginator behind both {@link fetchInventoryLevels} (the
 * catalog merge, which needs only the number) and the stock take
 * (which needs the inventory item id to adjust it).
 *
 * @param {AxiosInstance} client
 * @param {string} locationId
 * @returns {Promise<Map<string, InventoryLevelDetail>>} variant id → level
 * @throws {Error} when any page carries errors or no levels, so a caller never gets part of the stock
 */
export async function fetchInventoryLevelDetails(
  client: AxiosInstance,
  locationId: string
): Promise<Map<string, InventoryLevelDetail>> {
  const levels = new Map<string, InventoryLevelDetail>()
  let cursor: string | null = null
  let hasNextPage = true

  while (hasNextPage) {
    const response = await client.post('', {
      query: INVENTORY_LEVELS_QUERY,
      variables: { locationId, first: 250, after: cursor }
    })

    // docs/phase-253-1: a page with errors or no levels fails the whole read. Stopping there instead would hand back
    // part of the stock, and the catalogue merge would then drop every variant not yet read.
    const errors = response.data?.errors as Array<{ message: string }> | undefined
    if (errors && errors.length > 0) {
      throw new Error(`The stock read failed: ${errors.map((e) => e.message).join('; ')}`)
    }
    const data = response.data?.data?.location?.inventoryLevels
    if (!data) throw new Error('The stock read stopped part-way: Shopify returned no stock levels for a page')

    for (const level of data.nodes ?? []) {
      const variantId = level.item?.variant?.id
      const inventoryItemId = level.item?.id
      const available = level.quantities?.find((q) => q.name === 'available')?.quantity
      if (variantId && inventoryItemId && available !== undefined) {
        levels.set(variantId, { inventoryItemId, available })
      }
    }

    hasNextPage = data.pageInfo?.hasNextPage ?? false
    cursor = data.pageInfo?.endCursor ?? null
  }

  return levels
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
  const details = await fetchInventoryLevelDetails(client, locationId)
  return new Map([...details].map(([variantId, level]) => [variantId, level.available]))
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
      // Shopify's `inventoryLevels(locationId)` only returns a level
      // record for a variant when that variant is actually stocked at
      // that location — a variant with no record there (never
      // assigned to it) isn't "0 in stock", it's not sold from this
      // till at all, so it's dropped rather than shown. Only applied
      // when the fetch actually returned something: an empty map from
      // a partial/failed inventory fetch must never be read as "this
      // location stocks nothing" and wipe the whole catalog.
      if (inventoryMap.size > 0) {
        allProducts = allProducts
          .map((product) => ({
            ...product,
            variants: product.variants
              .filter((variant) => inventoryMap.has(variant.id))
              .map((variant) => ({
                ...variant,
                inventoryQuantity: inventoryMap.get(variant.id) ?? 0
              }))
          }))
          .filter((product) => product.variants.length > 0)
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

