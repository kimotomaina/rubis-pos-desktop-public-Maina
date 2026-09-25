/**
 * `validateAndFetchLocations` fetches EVERY location (phase-141).
 *
 * The load-bearing test of the phase. The query used to be
 * `locations(first: 10)` with no `pageInfo`, so on the ~106-location
 * account this ships to, 96 locations were dropped with no error — and
 * 96 branches could not select their own location at all. These tests
 * fail if that cap, or a partial result, ever comes back.
 *
 * A fake client is injected rather than mocking axios, matching
 * `shopifyService.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  formatLocationAddress,
  validateAndFetchLocations,
  VALIDATE_STORE_QUERY
} from '../src/main/services/shopify.js'
import type { AxiosInstance } from 'axios'

const STORE = 'https://rubis-pos.myshopify.com'
const TOKEN = 'shpat_test'

/** A location node as Shopify returns it. */
function node(n: number): { id: string; name: string; address: { formatted: string[] } } {
  return {
    id: `gid://shopify/Location/${n}`,
    name: `Rubis Station ${n}`,
    address: { formatted: [`${n} Mombasa Road`, 'Nairobi 00100', 'Kenya'] }
  }
}

function makeClient(post: ReturnType<typeof vi.fn>): AxiosInstance {
  return { post } as unknown as AxiosInstance
}

/**
 * A client that serves `pages` in order, threading a cursor exactly as
 * Shopify does, and records the `after` it was asked for each time.
 */
function pagedClient(pages: ReturnType<typeof node>[][]): {
  client: AxiosInstance
  post: ReturnType<typeof vi.fn>
  cursorsRequested: (string | null)[]
} {
  const cursorsRequested: (string | null)[] = []
  let call = 0
  const post = vi.fn().mockImplementation((_url: string, body: { variables?: { after?: string | null } }) => {
    cursorsRequested.push(body.variables?.after ?? null)
    const index = call
    call += 1
    return Promise.resolve({
      data: {
        data: {
          shop: { name: 'Rubis Kenya' },
          locations: {
            pageInfo: {
              hasNextPage: index < pages.length - 1,
              endCursor: `cursor-${index}`
            },
            nodes: pages[index]
          }
        }
      }
    })
  })
  return { client: makeClient(post), post, cursorsRequested }
}

describe('validateAndFetchLocations — every location arrives', () => {
  it('returns all 106 locations across 3 pages, in order, with no duplicates', async () => {
    const all = Array.from({ length: 106 }, (_, i) => node(i + 1))
    const { client, post, cursorsRequested } = pagedClient([
      all.slice(0, 50),
      all.slice(50, 100),
      all.slice(100)
    ])

    const result = await validateAndFetchLocations(STORE, TOKEN, { client })

    expect(result.success).toBe(true)
    expect(result.data?.locations).toHaveLength(106)
    expect(result.data?.locations.map((l) => l.id)).toEqual(all.map((l) => l.id))
    expect(new Set(result.data?.locations.map((l) => l.id)).size).toBe(106)
    expect(result.data?.shopName).toBe('Rubis Kenya')
    expect(post).toHaveBeenCalledTimes(3)
    expect(cursorsRequested).toEqual([null, 'cursor-0', 'cursor-1'])
  })

  it('asks for 250 at a time, so the old 10-location cap cannot come back', async () => {
    const { client, post } = pagedClient([[node(1)]])

    await validateAndFetchLocations(STORE, TOKEN, { client })

    const [, body] = post.mock.calls[0]
    expect(body.query).toBe(VALIDATE_STORE_QUERY)
    expect(body.variables.first).toBe(250)
    expect(VALIDATE_STORE_QUERY).not.toContain('first: 10')
  })

  it('leaves deactivated and fulfillment-service locations out, by using Shopify’s defaults', () => {
    expect(VALIDATE_STORE_QUERY).not.toContain('includeInactive')
    expect(VALIDATE_STORE_QUERY).not.toContain('includeLegacy')
  })

  it('handles a store with no locations', async () => {
    const { client, post } = pagedClient([[]])

    const result = await validateAndFetchLocations(STORE, TOKEN, { client })

    expect(result.success).toBe(true)
    expect(result.data?.locations).toEqual([])
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('handles a store with one location', async () => {
    const { client } = pagedClient([[node(1)]])

    const result = await validateAndFetchLocations(STORE, TOKEN, { client })

    expect(result.success).toBe(true)
    expect(result.data?.locations).toHaveLength(1)
  })

  it('stops after one request when a full page is all there is', async () => {
    const full = Array.from({ length: 250 }, (_, i) => node(i + 1))
    const { client, post } = pagedClient([full])

    const result = await validateAndFetchLocations(STORE, TOKEN, { client })

    expect(result.success).toBe(true)
    expect(result.data?.locations).toHaveLength(250)
    expect(post).toHaveBeenCalledTimes(1)
  })
})

describe('validateAndFetchLocations — a partial list is never returned as complete', () => {
  it('fails the whole call when page 2 returns a GraphQL error, rather than returning page 1', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          data: {
            shop: { name: 'Rubis Kenya' },
            locations: {
              pageInfo: { hasNextPage: true, endCursor: 'cursor-0' },
              nodes: Array.from({ length: 50 }, (_, i) => node(i + 1))
            }
          }
        }
      })
      .mockResolvedValueOnce({
        data: { errors: [{ message: 'Throttled' }] }
      })

    const result = await validateAndFetchLocations(STORE, TOKEN, { client: makeClient(post) })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Throttled')
    expect(result.data).toBeUndefined()
  })

  it('fails the whole call when page 2 throws', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          data: {
            shop: { name: 'Rubis Kenya' },
            locations: {
              pageInfo: { hasNextPage: true, endCursor: 'cursor-0' },
              nodes: [node(1)]
            }
          }
        }
      })
      .mockRejectedValueOnce(new Error('socket hang up'))

    const result = await validateAndFetchLocations(STORE, TOKEN, { client: makeClient(post) })

    expect(result.success).toBe(false)
    expect(result.error).toBe('socket hang up')
    expect(result.data).toBeUndefined()
  })

  it('errors instead of looping forever when the cursor never ends', async () => {
    const post = vi.fn().mockResolvedValue({
      data: {
        data: {
          shop: { name: 'Rubis Kenya' },
          locations: {
            pageInfo: { hasNextPage: true, endCursor: 'same-cursor-every-time' },
            nodes: [node(1)]
          }
        }
      }
    })

    const result = await validateAndFetchLocations(STORE, TOKEN, { client: makeClient(post) })

    expect(result.success).toBe(false)
    expect(result.error).toContain('stopping rather than returning a partial list')
    expect(result.data).toBeUndefined()
    expect(post).toHaveBeenCalledTimes(40)
  })

  it('still rejects a first page with no shop name, before collecting anything', async () => {
    const post = vi.fn().mockResolvedValue({
      data: {
        data: {
          locations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(1)] }
        }
      }
    })

    const result = await validateAndFetchLocations(STORE, TOKEN, { client: makeClient(post) })

    expect(result.success).toBe(false)
    expect(result.error).toContain('did not return shop details')
    expect(post).toHaveBeenCalledTimes(1)
  })
})

describe('formatLocationAddress', () => {
  it('keeps the first two lines, dropping the country that repeats on every card', () => {
    expect(
      formatLocationAddress({ formatted: ['12 Mombasa Road', 'Nairobi 00100', 'Kenya'] })
    ).toBe('12 Mombasa Road, Nairobi 00100')
  })

  it('takes a single line as it is', () => {
    expect(formatLocationAddress({ formatted: ['Westlands'] })).toBe('Westlands')
  })

  it('gives undefined for an empty, blank, missing or null address', () => {
    expect(formatLocationAddress({ formatted: [] })).toBeUndefined()
    expect(formatLocationAddress({ formatted: ['   ', ''] })).toBeUndefined()
    expect(formatLocationAddress({})).toBeUndefined()
    expect(formatLocationAddress(null)).toBeUndefined()
    expect(formatLocationAddress(undefined)).toBeUndefined()
  })

  it('reaches the returned locations as a flat display line', async () => {
    const { client } = pagedClient([[node(7)]])

    const result = await validateAndFetchLocations(STORE, TOKEN, { client })

    expect(result.data?.locations[0]).toEqual({
      id: 'gid://shopify/Location/7',
      name: 'Rubis Station 7',
      address: '7 Mombasa Road, Nairobi 00100'
    })
  })
})
