/**
 * Inventory adjustment transport tests.
 *
 * Exercises the app's only inventory write against a stubbed axios
 * client, the same pattern `orders.test.ts` uses for `orderCreate`.
 */

import { describe, it, expect, vi } from 'vitest'
import { AxiosError, type AxiosInstance } from 'axios'
import {
  INVENTORY_ADJUST_MUTATION,
  MAX_CHANGES_PER_CALL,
  STOCK_TAKE_QUANTITY_NAME,
  STOCK_TAKE_REASON,
  batchChanges,
  buildStockTakeReferenceUri,
  pushInventoryAdjustment,
  type InventoryAdjustChange
} from '../src/main/services/inventory-adjust.js'

const CHANGE: InventoryAdjustChange = {
  inventoryItemId: 'gid://shopify/InventoryItem/1',
  delta: -2,
  changeFromQuantity: 8
}

const fakeClient = (post: ReturnType<typeof vi.fn>): AxiosInstance =>
  ({ post }) as unknown as AxiosInstance

const okResponse = {
  data: {
    data: {
      inventoryAdjustQuantities: {
        inventoryAdjustmentGroup: {
          createdAt: '2026-09-23T09:00:00Z',
          reason: STOCK_TAKE_REASON,
          referenceDocumentUri: 'gid://rubis-pos/StockTake/abc',
          changes: [{ name: 'available', delta: -2 }]
        },
        userErrors: []
      }
    }
  }
}

describe('the adjustment mutation', () => {
  it('carries the mandatory @idempotent directive', () => {
    expect(INVENTORY_ADJUST_MUTATION).toContain('@idempotent(key: $idempotencyKey)')
  })

  it('is the delta mutation, not the absolute-set one', () => {
    expect(INVENTORY_ADJUST_MUTATION).toContain('inventoryAdjustQuantities')
    expect(INVENTORY_ADJUST_MUTATION).not.toContain('inventorySetQuantities')
  })

  it('sends a per-session idempotency key and the cycle-count reason', async () => {
    const post = vi.fn().mockResolvedValue(okResponse)

    await pushInventoryAdjustment(fakeClient(post), {
      locationId: 'gid://shopify/Location/1',
      sessionUuid: 'abc',
      batchIndex: 0,
      changes: [CHANGE]
    })

    const [, body] = post.mock.calls[0]
    expect(body.variables.idempotencyKey).toBe('abc:0')
    expect(body.variables.input.reason).toBe(STOCK_TAKE_REASON)
    expect(body.variables.input.name).toBe(STOCK_TAKE_QUANTITY_NAME)
    expect(body.variables.input.referenceDocumentUri).toBe(buildStockTakeReferenceUri('abc'))
    expect(body.variables.input.changes[0].changeFromQuantity).toBe(8)
  })

  it('reports Shopify userErrors as a failure rather than a silent success', async () => {
    const post = vi.fn().mockResolvedValue({
      data: {
        data: {
          inventoryAdjustQuantities: {
            inventoryAdjustmentGroup: null,
            userErrors: [
              { field: ['changes', '0', 'changeFromQuantity'], message: 'Quantity has changed' }
            ]
          }
        }
      }
    })

    const result = await pushInventoryAdjustment(fakeClient(post), {
      locationId: 'gid://shopify/Location/1',
      sessionUuid: 'abc',
      batchIndex: 0,
      changes: [CHANGE]
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Quantity has changed/)
  })

  it('names the missing write_inventory scope on a 403', async () => {
    const err = new AxiosError('forbidden')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    err.response = { status: 403 } as any
    const post = vi.fn().mockRejectedValue(err)

    const result = await pushInventoryAdjustment(fakeClient(post), {
      locationId: 'gid://shopify/Location/1',
      sessionUuid: 'abc',
      batchIndex: 0,
      changes: [CHANGE]
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/write_inventory/)
    expect(result.error).toMatch(/Nothing was changed/)
  })

  it('says plainly that nothing changed when Shopify is unreachable', async () => {
    const post = vi.fn().mockRejectedValue(new AxiosError('offline'))

    const result = await pushInventoryAdjustment(fakeClient(post), {
      locationId: 'gid://shopify/Location/1',
      sessionUuid: 'abc',
      batchIndex: 0,
      changes: [CHANGE]
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/nothing was changed/i)
  })
})

describe('batching', () => {
  it('splits changes at the per-call limit', () => {
    const many = Array.from({ length: MAX_CHANGES_PER_CALL + 1 }, () => CHANGE)
    const batches = batchChanges(many)
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(MAX_CHANGES_PER_CALL)
    expect(batches[1]).toHaveLength(1)
  })

  it('leaves a single small batch alone', () => {
    expect(batchChanges([CHANGE])).toEqual([[CHANGE]])
  })
})
