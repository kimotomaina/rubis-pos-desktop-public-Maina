/**
 * Shopify reconciliation lookup tests (docs/phase-170 commit 1).
 *
 * Uses an injected mock axios client, exactly like `orders.test.ts` and
 * `shopifyService.test.ts` - no module-level mocking of axios, no real
 * Shopify call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AxiosInstance } from 'axios'
import { AxiosError } from 'axios'
import {
  checkScopes,
  findBySourceIdentifier,
  existsByIds,
  countRecent,
  classifyOrderMatches,
  ThrottleBudget,
  SCOPE_MISSING_MESSAGE,
  TIME_LIMIT_MESSAGE,
  MAX_NODES_PER_BATCH,
  type ShopifyOrderLookup
} from '../src/main/services/shopify-reconcile.js'

const mockClient = (postImpl: ReturnType<typeof vi.fn>) =>
  ({ post: postImpl }) as unknown as AxiosInstance

const okEnvelope = <T>(data: T, cost?: { currentlyAvailable: number; restoreRate: number }) => ({
  data: {
    data,
    ...(cost
      ? {
          extensions: {
            cost: {
              requestedQueryCost: 1,
              actualQueryCost: 1,
              throttleStatus: { maximumAvailable: 1000, ...cost }
            }
          }
        }
      : {})
  }
})

describe('classifyOrderMatches', () => {
  const order = (overrides: Partial<ShopifyOrderLookup> = {}): ShopifyOrderLookup => ({
    id: 'gid://shopify/Order/1',
    name: '#1001',
    createdAt: '2026-09-01T00:00:00Z',
    cancelledAt: null,
    sourceIdentifier: 'uuid-1',
    ...overrides
  })

  it('none: an empty list', () => {
    expect(classifyOrderMatches([])).toEqual({ kind: 'none' })
  })

  it('one: a single order', () => {
    const single = order()
    expect(classifyOrderMatches([single])).toEqual({ kind: 'one', order: single })
  })

  it('many: two or more orders', () => {
    const a = order({ id: 'gid://shopify/Order/1' })
    const b = order({ id: 'gid://shopify/Order/2' })
    expect(classifyOrderMatches([a, b])).toEqual({ kind: 'many', orders: [a, b] })
  })
})

describe('checkScopes', () => {
  it('is ready when read_orders is present', async () => {
    const post = vi.fn().mockResolvedValue(
      okEnvelope({ currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }, { handle: 'write_orders' }] } })
    )
    const result = await checkScopes(mockClient(post), new ThrottleBudget())

    expect(result).toEqual({ success: true, data: { ready: true, scopes: ['read_orders', 'write_orders'] } })
  })

  it('is ready when only read_all_orders is present', async () => {
    const post = vi.fn().mockResolvedValue(
      okEnvelope({ currentAppInstallation: { accessScopes: [{ handle: 'read_all_orders' }] } })
    )
    const result = await checkScopes(mockClient(post), new ThrottleBudget())

    expect(result.success).toBe(true)
    expect(result.data?.ready).toBe(true)
  })

  it('is not ready when neither scope is present', async () => {
    const post = vi.fn().mockResolvedValue(
      okEnvelope({ currentAppInstallation: { accessScopes: [{ handle: 'read_products' }] } })
    )
    const result = await checkScopes(mockClient(post), new ThrottleBudget())

    expect(result).toEqual({ success: true, data: { ready: false, scopes: ['read_products'] } })
  })
})

describe('findBySourceIdentifier', () => {
  it('keeps only the exact match, filtering out a near-match', async () => {
    const post = vi.fn().mockResolvedValue(
      okEnvelope({
        orders: {
          nodes: [
            {
              id: 'gid://shopify/Order/1',
              name: '#1001',
              createdAt: '2026-09-01T00:00:00Z',
              cancelledAt: null,
              sourceIdentifier: 'uuid-12345'
            },
            {
              id: 'gid://shopify/Order/2',
              name: '#1002',
              createdAt: '2026-09-01T00:00:00Z',
              cancelledAt: null,
              // A search hit that merely contains the uuid as a substring - must never be trusted.
              sourceIdentifier: 'uuid-12345-extra'
            }
          ]
        }
      })
    )

    const result = await findBySourceIdentifier(mockClient(post), 'uuid-12345', new ThrottleBudget())

    expect(result.success).toBe(true)
    expect(result.data).toHaveLength(1)
    expect(result.data?.[0].id).toBe('gid://shopify/Order/1')
  })

  it('none: no match at all', async () => {
    const post = vi.fn().mockResolvedValue(okEnvelope({ orders: { nodes: [] } }))
    const result = await findBySourceIdentifier(mockClient(post), 'uuid-none', new ThrottleBudget())

    expect(result.data).toEqual([])
  })

  it('one: exactly one match', async () => {
    const post = vi.fn().mockResolvedValue(
      okEnvelope({
        orders: {
          nodes: [
            {
              id: 'gid://shopify/Order/1',
              name: '#1001',
              createdAt: '2026-09-01T00:00:00Z',
              cancelledAt: null,
              sourceIdentifier: 'uuid-one'
            }
          ]
        }
      })
    )
    const result = await findBySourceIdentifier(mockClient(post), 'uuid-one', new ThrottleBudget())

    expect(result.data).toHaveLength(1)
  })

  it('many: two exact matches (a genuine duplicate)', async () => {
    const post = vi.fn().mockResolvedValue(
      okEnvelope({
        orders: {
          nodes: [
            {
              id: 'gid://shopify/Order/1',
              name: '#1001',
              createdAt: '2026-09-01T00:00:00Z',
              cancelledAt: null,
              sourceIdentifier: 'uuid-dup'
            },
            {
              id: 'gid://shopify/Order/2',
              name: '#1002',
              createdAt: '2026-09-02T00:00:00Z',
              cancelledAt: null,
              sourceIdentifier: 'uuid-dup'
            }
          ]
        }
      })
    )
    const result = await findBySourceIdentifier(mockClient(post), 'uuid-dup', new ThrottleBudget())

    expect(result.data).toHaveLength(2)
  })

  it('passes cancelledAt through unmodified, for the caller to classify', async () => {
    const post = vi.fn().mockResolvedValue(
      okEnvelope({
        orders: {
          nodes: [
            {
              id: 'gid://shopify/Order/1',
              name: '#1001',
              createdAt: '2026-09-01T00:00:00Z',
              cancelledAt: '2026-09-02T00:00:00Z',
              sourceIdentifier: 'uuid-cancelled'
            }
          ]
        }
      })
    )
    const result = await findBySourceIdentifier(mockClient(post), 'uuid-cancelled', new ThrottleBudget())

    expect(result.data?.[0].cancelledAt).toBe('2026-09-02T00:00:00Z')
  })

  it('sends the exact query string with the uuid quoted', async () => {
    const post = vi.fn().mockResolvedValue(okEnvelope({ orders: { nodes: [] } }))
    await findBySourceIdentifier(mockClient(post), 'abc-123', new ThrottleBudget())

    expect(post).toHaveBeenCalledWith(
      '',
      expect.objectContaining({ variables: { query: 'source_identifier:"abc-123"' } }),
      expect.anything()
    )
  })
})

describe('existsByIds', () => {
  it('a null node means not found', async () => {
    const post = vi.fn().mockResolvedValue(
      okEnvelope({
        nodes: [
          { id: 'gid://shopify/Order/1', name: '#1001', createdAt: '2026-09-01T00:00:00Z', cancelledAt: null, sourceIdentifier: 'a' },
          null
        ]
      })
    )
    const result = await existsByIds(
      mockClient(post),
      ['gid://shopify/Order/1', 'gid://shopify/Order/2'],
      new ThrottleBudget()
    )

    expect(result.success).toBe(true)
    expect(result.data?.get('gid://shopify/Order/1')?.id).toBe('gid://shopify/Order/1')
    expect(result.data?.get('gid://shopify/Order/2')).toBeNull()
  })

  it('batches at 250 ids per call', async () => {
    const ids = Array.from({ length: MAX_NODES_PER_BATCH + 50 }, (_, i) => `gid://shopify/Order/${i}`)
    const post = vi.fn().mockImplementation(async (_url, body) => {
      const batchIds = body.variables.ids as string[]
      return okEnvelope({
        nodes: batchIds.map((id) => ({ id, name: null, createdAt: '2026-09-01T00:00:00Z', cancelledAt: null, sourceIdentifier: null }))
      })
    })

    const result = await existsByIds(mockClient(post), ids, new ThrottleBudget())

    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[0][1].variables.ids).toHaveLength(MAX_NODES_PER_BATCH)
    expect(post.mock.calls[1][1].variables.ids).toHaveLength(50)
    expect(result.data?.size).toBe(ids.length)
  })
})

describe('countRecent', () => {
  it('returns the count and precision, using a fixed clock', async () => {
    const post = vi.fn().mockResolvedValue(okEnvelope({ ordersCount: { count: 340, precision: 'EXACT' } }))
    const now = () => new Date('2026-09-27T00:00:00.000Z')

    const result = await countRecent(mockClient(post), 7, new ThrottleBudget(), undefined, undefined, now)

    expect(result).toEqual({ success: true, data: { count: 340, precision: 'EXACT' } })
    expect(post).toHaveBeenCalledWith(
      '',
      expect.objectContaining({
        variables: { query: "created_at:>='2026-09-20T00:00:00.000Z'", limit: 10_000 }
      }),
      expect.anything()
    )
  })
})

describe('scope missing', () => {
  it('is reported as SCOPE_MISSING_MESSAGE, with the raw code logged', async () => {
    const post = vi.fn().mockResolvedValue({
      data: {
        errors: [{ message: 'Access denied for orders field.', extensions: { code: 'ACCESS_DENIED' } }]
      }
    })
    const logger = { warn: vi.fn() }

    const result = await findBySourceIdentifier(mockClient(post), 'uuid-1', new ThrottleBudget(), undefined, logger)

    expect(result).toEqual({ success: false, error: SCOPE_MISSING_MESSAGE })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ACCESS_DENIED'))
  })

  it('a plain HTTP 403 is also reported as SCOPE_MISSING_MESSAGE', async () => {
    const err = new AxiosError('Forbidden')
    err.response = { status: 403, data: {}, statusText: 'Forbidden', headers: {}, config: {} as never }
    const post = vi.fn().mockRejectedValue(err)

    const result = await checkScopes(mockClient(post), new ThrottleBudget())

    expect(result).toEqual({ success: false, error: SCOPE_MISSING_MESSAGE })
  })
})

describe('ThrottleBudget', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits when currentlyAvailable is below the next request cost', async () => {
    const budget = new ThrottleBudget()
    budget.record({ requestedQueryCost: 1, actualQueryCost: 1, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 5, restoreRate: 50 } })

    let resolved = false
    const wait = budget.waitForBudget(10).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(50)
    await wait
    expect(resolved).toBe(true)
  })

  it('does not wait when enough budget is already available', async () => {
    const budget = new ThrottleBudget()
    budget.record({ requestedQueryCost: 1, actualQueryCost: 1, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 500, restoreRate: 50 } })

    await budget.waitForBudget(10)

    expect(budget.peek()).toBe(490)
  })

  it('rejects with ReconciliationAbortedError when the signal fires mid-wait', async () => {
    const budget = new ThrottleBudget()
    budget.record({ requestedQueryCost: 1, actualQueryCost: 1, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 1 } })
    const controller = new AbortController()

    const wait = budget.waitForBudget(1000, controller.signal)
    controller.abort()

    await expect(wait).rejects.toThrow('Shopify reconciliation check was cancelled')
  })
})

describe('time limit', () => {
  it('a request made with an already-aborted signal never calls the client, and reports TIME_LIMIT_MESSAGE', async () => {
    const post = vi.fn()
    const controller = new AbortController()
    controller.abort()

    const result = await checkScopes(mockClient(post), new ThrottleBudget(), controller.signal)

    expect(result).toEqual({ success: false, error: TIME_LIMIT_MESSAGE })
    expect(post).not.toHaveBeenCalled()
  })

  it('an axios cancellation (ERR_CANCELED) is reported as TIME_LIMIT_MESSAGE', async () => {
    const err = new AxiosError('canceled')
    err.code = 'ERR_CANCELED'
    const post = vi.fn().mockRejectedValue(err)

    const result = await checkScopes(mockClient(post), new ThrottleBudget())

    expect(result).toEqual({ success: false, error: TIME_LIMIT_MESSAGE })
  })
})
