/**
 * Tests for the product store Zustand slice.
 *
 * The store calls `window.api.fetchProducts()` at runtime, so these
 * tests stub that global before each case.  Zustand's
 * `setState` is used to reset state between tests (no unmount/re-mount
 * needed for a non-component store).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useProductStore } from '../src/renderer/src/stores/productStore.js'
import type { ProductSummary } from '../src/renderer/src/types/shopify.js'

const mockProducts: ProductSummary[] = [
  {
    id: 'gid://shopify/Product/1',
    title: 'Test Product',
    handle: 'test-product',
    featuredImage: 'https://cdn.shopify.com/test.jpg',
    variants: [
      {
        id: 'gid://shopify/ProductVariant/1',
        productId: '1',
        title: 'Default',
        price: 19.99,
        availableForSale: true,
        inventoryQuantity: 5,
        image: null,
        barcode: null
      }
    ]
  }
]

describe('Product Store', () => {
  beforeEach(() => {
    useProductStore.setState({
      products: [],
      status: 'idle',
      error: undefined,
      cached: false
    })

    // Provide a fresh mock on the global window object
    window.api = {
      fetchProducts: vi.fn(),
      getCachedProducts: vi.fn()
    } as unknown as typeof window.api
  })

  it('starts in idle state with no products', () => {
    const { status, products, error } = useProductStore.getState()
    expect(status).toBe('idle')
    expect(products).toEqual([])
    expect(error).toBeUndefined()
  })

  it('fetchProducts success transitions to ready with mapped data', async () => {
    const mock = window.api.fetchProducts as any
    mock.mockResolvedValue({ success: true, data: mockProducts })

    await useProductStore.getState().fetchProducts()

    const { status, products } = useProductStore.getState()
    expect(status).toBe('ready')
    expect(products).toHaveLength(1)
    expect(products[0].title).toBe('Test Product')
  })

  it('fetchProducts failure transitions to error with message', async () => {
    const mock = window.api.fetchProducts as any
    mock.mockResolvedValue({
      success: false,
      error: 'Authentication failed — check your token'
    })

    await useProductStore.getState().fetchProducts()

    const { status, error, products } = useProductStore.getState()
    expect(status).toBe('error')
    expect(error).toBe('Authentication failed — check your token')
    expect(products).toEqual([])
  })

  it('reset returns to idle empty state', async () => {
    const mock = window.api.fetchProducts as any
    mock.mockResolvedValue({ success: true, data: mockProducts })

    await useProductStore.getState().fetchProducts()
    expect(useProductStore.getState().status).toBe('ready')

    useProductStore.getState().reset()

    const { status, products, error } = useProductStore.getState()
    expect(status).toBe('idle')
    expect(products).toEqual([])
    expect(error).toBeUndefined()
  })

  it('falls back to the SQLite cache when the live fetch fails', async () => {
    const live = window.api.fetchProducts as any
    live.mockResolvedValue({ success: false, error: 'Network error' })
    const cache = window.api.getCachedProducts as any
    cache.mockResolvedValue({ success: true, data: mockProducts })

    await useProductStore.getState().fetchProducts()

    const { status, products, cached } = useProductStore.getState()
    expect(status).toBe('ready')
    expect(cached).toBe(true)
    expect(products).toHaveLength(1)
  })

  it('goes to error when both live fetch and cache are unavailable', async () => {
    const live = window.api.fetchProducts as any
    live.mockResolvedValue({ success: false, error: 'Network error' })
    const cache = window.api.getCachedProducts as any
    cache.mockResolvedValue({ success: true, data: [] })

    await useProductStore.getState().fetchProducts()

    const { status, error, cached } = useProductStore.getState()
    expect(status).toBe('error')
    expect(error).toBe('Network error')
    expect(cached).toBe(false)
  })
})
