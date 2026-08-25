import { describe, it, expect, vi } from 'vitest'
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import {
  mapShopifyToSummary,
  createShopifyClient,
  fetchProductsAndInventory,
  PRODUCT_LIST_QUERY
} from '../src/main/services/shopify.js'
import type { ShopifyProduct } from '../src/main/services/shopify-types.js'
import type { AxiosInstance } from 'axios'

/**
 * Builds a mock AxiosInstance whose `.post()` resolves (or rejects)
 * with the supplied value.  Injecting this avoids mocking the
 * axios module itself, keeping tests deterministic.
 */
function makeMockClient(
  postImpl: ReturnType<typeof vi.fn>
): AxiosInstance {
  return { post: postImpl } as unknown as AxiosInstance
}

/* ── Sample data ─────────────────────────────────────── */

const shopifyProducts: ShopifyProduct[] = [
  {
    id: 'gid://shopify/Product/632910392',
    title: 'RUBIS Coffee Mug',
    handle: 'rubis-coffee-mug',
    status: 'ACTIVE',
    featuredImage: {
      id: 'gid://shopify/Image/1',
      url: 'https://cdn.shopify.com/s/files/1/mug.jpg',
      altText: 'Coffee mug front view'
    },
    variants: {
      nodes: [
        {
          id: 'gid://shopify/ProductVariant/39072856187534',
          title: 'Small / Red',
          availableForSale: true,
          inventoryQuantity: 10,
          price: '29.99',
          image: {
            id: 'gid://shopify/Image/2',
            url: 'https://cdn.shopify.com/s/files/1/mug-variant.jpg',
            altText: 'Small red mug'
          },
          barcode: '012345678905'
        },
        {
          id: 'gid://shopify/ProductVariant/39072856187535',
          title: 'Large / Blue',
          availableForSale: true,
          inventoryQuantity: 5,
          price: '39.99',
          image: null,
          barcode: null
        }
      ]
    }
  },
  {
    id: 'gid://shopify/Product/632910393',
    title: 'RUBIS T-Shirt',
    handle: 'rubis-t-shirt',
    status: 'ACTIVE',
    featuredImage: null,
    variants: {
      nodes: [
        {
          id: 'gid://shopify/ProductVariant/39072856187536',
          title: 'Default Title',
          availableForSale: true,
          inventoryQuantity: 0,
          price: '19.99',
          image: null,
          barcode: null
        }
      ]
    }
  }
]

const graphqlSuccessResponse = { data: { products: { nodes: shopifyProducts } } }
const graphqlEmptyResponse = { data: { products: { nodes: [] } } }
const graphqlErrorResponse = { errors: [{ message: 'Invalid API key' }] }
/* ── mapShopifyToSummary ─────────────────────────────── */

describe('mapShopifyToSummary', () => {
  it('flattens Shopify products into ProductSummary list', () => {
    const result = mapShopifyToSummary(shopifyProducts)

    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('RUBIS Coffee Mug')
    expect(result[0].id).toBe('gid://shopify/Product/632910392')
    expect(result[0].featuredImage).toBe(
      'https://cdn.shopify.com/s/files/1/mug.jpg'
    )
  })

  it('extracts numeric product id onto each variant', () => {
    const result = mapShopifyToSummary(shopifyProducts)
    const firstVariant = result[0].variants[0]

    expect(firstVariant.productId).toBe('632910392')
    expect(firstVariant.id).toBe(
      'gid://shopify/ProductVariant/39072856187534'
    )
  })

  it('parses price from string to number', () => {
    const result = mapShopifyToSummary(shopifyProducts)
    expect(result[0].variants[0].price).toBe(29.99)
    expect(result[0].variants[1].price).toBe(39.99)
  })

  it('falls back to variant image when product featuredImage is null', () => {
    const result = mapShopifyToSummary(shopifyProducts)
    expect(result[1].featuredImage).toBe(null)
  })

  it('passes through the variant barcode (or null when absent)', () => {
    const result = mapShopifyToSummary(shopifyProducts)
    expect(result[0].variants[0].barcode).toBe('012345678905')
    expect(result[0].variants[1].barcode).toBeNull()
  })

  it('returns an empty array for empty input', () => {
    expect(mapShopifyToSummary([])).toEqual([])
  })
})


/* ── fetchProductsAndInventory ───────────────────────── */

describe('fetchProductsAndInventory', () => {
  it('returns mapped products on GraphQL success', async () => {
    const client = makeMockClient(
      vi.fn().mockResolvedValue({ data: graphqlSuccessResponse })
    )

    const result = await fetchProductsAndInventory(
      'https://rubis-pos.myshopify.com',
      'shpat_test',
      { client }
    )

    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(2)
    expect(result.error).toBeUndefined()
  })

  it('returns empty array when Shopify returns no products', async () => {
    const client = makeMockClient(
      vi.fn().mockResolvedValue({ data: graphqlEmptyResponse })
    )

    const result = await fetchProductsAndInventory(
      'https://rubis-pos.myshopify.com',
      'shpat_test',
      { client }
    )

    expect(result.success).toBe(true)
    expect(result.data).toEqual([])
  })

  it('returns error when GraphQL response contains errors', async () => {
    const client = makeMockClient(
      vi.fn().mockResolvedValue({ data: graphqlErrorResponse })
    )

    const result = await fetchProductsAndInventory(
      'https://rubis-pos.myshopify.com',
      'shpat_test',
      { client }
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid API key')
  })

  it('maps HTTP 401 to an authentication error message', async () => {
    const axiosError = new AxiosError(
      'Request failed with status code 401',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        data: undefined,
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        config: {} as unknown as InternalAxiosRequestConfig
      }
    )

    const client = makeMockClient(vi.fn().mockRejectedValue(axiosError))

    const result = await fetchProductsAndInventory(
      'https://rubis-pos.myshopify.com',
      'shpat_test',
      { client }
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Authentication failed/i)
  })

  it('maps network errors (no response) to a network message', async () => {
    const networkError = new AxiosError(
      'connect ENOTFOUND rubis-pos.myshopify.com',
      'ENOTFOUND',
      undefined,
      undefined,
      undefined
    )

    const client = makeMockClient(vi.fn().mockRejectedValue(networkError))

    const result = await fetchProductsAndInventory(
      'https://rubis-pos.myshopify.com',
      'shpat_test',
      { client }
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Network error/i)
  })

  it('maps HTTP 429 to a rate-limit message', async () => {
    const rateLimitError = new AxiosError(
      'Too Many Requests',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        data: undefined,
        status: 429,
        statusText: 'Too Many Requests',
        headers: {},
        config: {} as unknown as InternalAxiosRequestConfig
      }
    )

    const client = makeMockClient(vi.fn().mockRejectedValue(rateLimitError))

    const result = await fetchProductsAndInventory(
      'https://rubis-pos.myshopify.com',
      'shpat_test',
      { client }
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Rate limited/i)
  })

  it('sends the GraphQL query with first=20 by default', async () => {
    const post = vi.fn().mockResolvedValue({ data: graphqlEmptyResponse })
    const client = makeMockClient(post)

    await fetchProductsAndInventory(
      'https://rubis-pos.myshopify.com',
      'shpat_test',
      { client }
    )

    const [, body] = post.mock.calls[0]
    expect(body.query).toBe(PRODUCT_LIST_QUERY)
    expect(body.variables).toEqual({ first: 20 })
  })
})

/* ── createShopifyClient ───────────────────────────── */

describe('createShopifyClient', () => {
  it('throws on an invalid store URL', () => {
    expect(() => createShopifyClient('not-a-url', 'token')).toThrow(
      /Invalid Shopify store URL/i
    )
  })

  it('normalizes baseURL (strips trailing slash, appends endpoint)', () => {
    const client = createShopifyClient(
      'https://rubis-pos.myshopify.com/',
      'shpat_test'
    )

    expect(client.defaults.baseURL).toBe(
      'https://rubis-pos.myshopify.com/admin/api/2026-07/graphql.json'
    )
  })

  it('sets the access-token and content-type headers', () => {
    const client = createShopifyClient(
      'https://rubis-pos.myshopify.com',
      'shpat_secret_token'
    )

    expect(client.defaults.headers['X-Shopify-Access-Token']).toBe(
      'shpat_secret_token'
    )
    expect(client.defaults.headers['Content-Type']).toBe('application/json')
  })
})

