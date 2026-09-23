import { describe, it, expect, vi } from 'vitest'
import { AxiosError } from 'axios'
import { fetchAllProducts } from '../src/main/services/shopify.js'
import type { ShopifyProduct } from '../src/main/services/shopify-types.js'
import type { AxiosInstance } from 'axios'

/**
 * Builds a mock AxiosInstance whose `.post()` resolves (or rejects)
 * with the supplied value. Injecting this avoids mocking the axios
 * module itself, keeping tests deterministic.
 */
function makeMockClient(postImpl: ReturnType<typeof vi.fn>): AxiosInstance {
  return { post: postImpl } as unknown as AxiosInstance
}

function makeProduct(id: string, variantId: string): ShopifyProduct {
  return {
    id: `gid://shopify/Product/${id}`,
    title: `Product ${id}`,
    handle: `product-${id}`,
    status: 'ACTIVE',
    featuredImage: null,
    variants: {
      nodes: [
        {
          id: `gid://shopify/ProductVariant/${variantId}`,
          title: 'Default Title',
          availableForSale: true,
          price: '10.00',
          image: null,
          barcode: null
        }
      ]
    }
  }
}

/** Builds a mock `location.inventoryLevels` GraphQL response. */
function inventoryLevelsResponse(
  levels: Array<{ variantId: string; available: number }>,
  hasNextPage = false,
  endCursor: string | null = null
) {
  return {
    data: {
      data: {
        location: {
          inventoryLevels: {
            pageInfo: { hasNextPage, endCursor },
            nodes: levels.map((level) => ({
              quantities: [{ name: 'available', quantity: level.available }],
              // `item.id` is the inventory item id a stock-take adjustment
              // is keyed by; a level with no id is not usable and is skipped.
              item: {
                id: level.variantId.replace('ProductVariant', 'InventoryItem'),
                variant: { id: level.variantId }
              }
            }))
          }
        }
      }
    }
  }
}

function pageResponse(
  products: ShopifyProduct[],
  hasNextPage: boolean,
  endCursor: string | null
) {
  return {
    data: {
      data: {
        products: {
          pageInfo: { hasNextPage, endCursor },
          nodes: products
        }
      }
    }
  }
}

describe('fetchAllProducts', () => {
  it('fetches a single page when hasNextPage is false', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(pageResponse([makeProduct('1', '101')], false, null))
    const client = makeMockClient(post)

    const result = await fetchAllProducts('https://rubis-pos.myshopify.com', 'shpat_test', {
      client
    })

    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(1)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('follows the cursor across multiple pages', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        pageResponse([makeProduct('1', '101')], true, 'cursor-1')
      )
      .mockResolvedValueOnce(pageResponse([makeProduct('2', '102')], false, null))
    const client = makeMockClient(post)

    const result = await fetchAllProducts('https://rubis-pos.myshopify.com', 'shpat_test', {
      client
    })

    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(2)
    expect(post).toHaveBeenCalledTimes(2)

    const [, secondBody] = post.mock.calls[1]
    expect(secondBody.variables.after).toBe('cursor-1')
  })

  it('returns an empty array for an empty catalog', async () => {
    const post = vi.fn().mockResolvedValueOnce(pageResponse([], false, null))
    const client = makeMockClient(post)

    const result = await fetchAllProducts('https://rubis-pos.myshopify.com', 'shpat_test', {
      client
    })

    expect(result.success).toBe(true)
    expect(result.data).toEqual([])
  })

  it('returns an error when the first page has GraphQL errors', async () => {
    const post = vi.fn().mockResolvedValueOnce({
      data: { errors: [{ message: 'Invalid API key' }] }
    })
    const client = makeMockClient(post)

    const result = await fetchAllProducts('https://rubis-pos.myshopify.com', 'shpat_test', {
      client
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid API key')
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('returns an error when a later page has GraphQL errors (no partial success)', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        pageResponse([makeProduct('1', '101')], true, 'cursor-1')
      )
      .mockResolvedValueOnce({
        data: { errors: [{ message: 'Throttled' }] }
      })
    const client = makeMockClient(post)

    const result = await fetchAllProducts('https://rubis-pos.myshopify.com', 'shpat_test', {
      client
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Throttled')
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('surfaces a network error that occurs mid-pagination', async () => {
    const networkError = new AxiosError(
      'connect ENOTFOUND rubis-pos.myshopify.com',
      'ENOTFOUND',
      undefined,
      undefined,
      undefined
    )
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        pageResponse([makeProduct('1', '101')], true, 'cursor-1')
      )
      .mockRejectedValueOnce(networkError)
    const client = makeMockClient(post)

    const result = await fetchAllProducts('https://rubis-pos.myshopify.com', 'shpat_test', {
      client
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Store unreachable/i)
  })

  it('merges location-scoped inventory quantities when locationId is provided', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(pageResponse([makeProduct('1', '101')], false, null))
      .mockResolvedValueOnce(
        inventoryLevelsResponse([{ variantId: 'gid://shopify/ProductVariant/101', available: 42 }])
      )
    const client = makeMockClient(post)

    const result = await fetchAllProducts('https://rubis-pos.myshopify.com', 'shpat_test', {
      client,
      locationId: 'gid://shopify/Location/1'
    })

    expect(result.success).toBe(true)
    expect(result.data?.[0].variants[0].inventoryQuantity).toBe(42)
  })

  it('defaults inventoryQuantity to 0 when no locationId is given — never a cross-location aggregate', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(pageResponse([makeProduct('1', '101')], false, null))
    const client = makeMockClient(post)

    const result = await fetchAllProducts('https://rubis-pos.myshopify.com', 'shpat_test', {
      client
    })

    expect(result.success).toBe(true)
    expect(result.data?.[0].variants[0].inventoryQuantity).toBe(0)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('drops a product entirely when none of its variants are stocked at the location', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        pageResponse([makeProduct('1', '101'), makeProduct('2', '102')], false, null)
      )
      .mockResolvedValueOnce(
        inventoryLevelsResponse([{ variantId: 'gid://shopify/ProductVariant/101', available: 5 }])
      )
    const client = makeMockClient(post)

    const result = await fetchAllProducts('https://rubis-pos.myshopify.com', 'shpat_test', {
      client,
      locationId: 'gid://shopify/Location/1'
    })

    expect(result.success).toBe(true)
    // Product 2's only variant (102) has no inventory level at this
    // location — the whole product is dropped, not shown at 0 stock.
    expect(result.data).toHaveLength(1)
    expect(result.data?.[0].id).toBe('gid://shopify/Product/1')
  })

  it('defaults a variant with no matching inventory level to 0, not an aggregate', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(pageResponse([makeProduct('1', '101')], false, null))
      .mockResolvedValueOnce(inventoryLevelsResponse([]))
    const client = makeMockClient(post)

    const result = await fetchAllProducts('https://rubis-pos.myshopify.com', 'shpat_test', {
      client,
      locationId: 'gid://shopify/Location/1'
    })

    expect(result.success).toBe(true)
    expect(result.data?.[0].variants[0].inventoryQuantity).toBe(0)
  })
})
