/**
 * Order push service tests.
 *
 * Uses an injected mock axios client — no module-level mocking of axios.
 */

import { describe, it, expect, vi } from 'vitest'
import { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import {
  ORDER_CREATE_MUTATION,
  CLIENT_ORDER_UUID_KEY,
  RUBIS_NAMESPACE,
  buildOrderInput,
  pushOrderToShopify
} from '../src/main/services/orders.js'
import type { OfflineOrderPayload } from '../src/main/services/shopify-types.js'

const samplePayload: OfflineOrderPayload = {
  clientOrderUuid: 'uuid-offline-1',
  total: 25,
  createdAt: '2026-08-24T10:00:00.000Z',
  staffId: 1,
  staffName: 'Admin',
  paymentMethod: 'cash',
  tenderedAmount: 30,
  changeDue: 5,
  lineItems: [
    {
      variantId: 'gid://shopify/ProductVariant/201',
      title: 'RUBIS Mug',
      variantTitle: 'Small',
      quantity: 2,
      unitPrice: 12.5
    }
  ]
}

const mockClient = (postImpl: ReturnType<typeof vi.fn>) =>
  ({ post: postImpl }) as unknown as Parameters<
    typeof pushOrderToShopify
  >[0]

describe('buildOrderInput', () => {
  it('maps payload to a paid orderCreate with obeys-policy inventory', () => {
    const variables = buildOrderInput(samplePayload)

    expect(variables.order.lineItems).toEqual([
      { variantId: 'gid://shopify/ProductVariant/201', quantity: 2 }
    ])
    expect(variables.order.financialStatus).toBe('PAID')
    expect(variables.options.inventoryBehaviour).toBe(
      'DECREMENT_OBEYING_POLICY'
    )
    expect(variables.options.sendReceipt).toBe(false)
  })

  it('tags the order with the client uuid attribute and metafield', () => {
    const variables = buildOrderInput(samplePayload)

    expect(variables.order.customAttributes).toEqual([
      { key: CLIENT_ORDER_UUID_KEY, value: 'uuid-offline-1' }
    ])
    expect(variables.order.metafields).toEqual([
      {
        namespace: RUBIS_NAMESPACE,
        key: CLIENT_ORDER_UUID_KEY,
        type: 'single_line_text_field',
        value: 'uuid-offline-1'
      }
    ])
    expect(String(variables.order.note)).toContain('uuid-offline-1')
  })

  it('includes the cashier name and payment method in the note', () => {
    const variables = buildOrderInput(samplePayload)
    expect(String(variables.order.note)).toContain('cashier Admin')
    expect(String(variables.order.note)).toContain('cash (tendered 30.00, change 5.00)')
  })

  it('includes the reference number for non-cash payments', () => {
    const variables = buildOrderInput({
      ...samplePayload,
      paymentMethod: 'mpesa',
      referenceNumber: 'QGH7XJ2K1L'
    })
    expect(String(variables.order.note)).toContain('mpesa (ref QGH7XJ2K1L)')
  })
})

describe('pushOrderToShopify', () => {
  it('sends the ORDER_CREATE_MUTATION with built variables', async () => {
    const post = vi.fn().mockResolvedValue({
      data: {
        data: {
          orderCreate: {
            order: { id: 'gid://shopify/Order/55', name: '#1055' },
            userErrors: []
          }
        }
      }
    })

    await pushOrderToShopify(mockClient(post), samplePayload)

    const [, body] = post.mock.calls[0]
    expect(body.query).toBe(ORDER_CREATE_MUTATION)
    expect(body.variables.order.financialStatus).toBe('PAID')
  })

  it('returns the created order id and name on success', async () => {
    const client = mockClient(
      vi.fn().mockResolvedValue({
        data: {
          data: {
            orderCreate: {
              order: { id: 'gid://shopify/Order/55', name: '#1055' },
              userErrors: []
            }
          }
        }
      })
    )

    const result = await pushOrderToShopify(client, samplePayload)

    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      shopifyOrderId: 'gid://shopify/Order/55',
      orderName: '#1055'
    })
  })

  it('fails with combined userErrors messages', async () => {
    const client = mockClient(
      vi.fn().mockResolvedValue({
        data: {
          data: {
            orderCreate: {
              order: null,
              userErrors: [
                { field: ['order', 'lineItems', '0'], message: 'Variant not found' }
              ]
            }
          }
        }
      })
    )

    const result = await pushOrderToShopify(client, samplePayload)

    expect(result.success).toBe(false)
    expect(result.error).toContain('Variant not found')
    expect(result.error).toContain('order.lineItems.0')
  })

  it('fails on transport-level GraphQL errors array', async () => {
    const client = mockClient(
      vi.fn().mockResolvedValue({
        data: { errors: [{ message: 'Throttled' }] }
      })
    )

    const result = await pushOrderToShopify(client, samplePayload)

    expect(result.success).toBe(false)
    expect(result.error).toBe('Throttled')
  })

  it('maps a 429 AxiosError to a retry message', async () => {
    const error = new AxiosError(
      'Too Many Requests',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        status: 429,
        statusText: 'Too Many Requests',
        headers: {},
        config: {} as unknown as InternalAxiosRequestConfig,
        data: undefined
      }
    )

    const client = mockClient(vi.fn().mockRejectedValue(error))
    const result = await pushOrderToShopify(client, samplePayload)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/rate limit/i)
  })

  it('maps an auth AxiosError to a scopes message', async () => {
    const error = new AxiosError(
      'Unauthorized',
      'ERR_BAD_REQUEST',
      undefined,
      undefined,
      {
        status: 401,
        statusText: 'Unauthorized',
        headers: {},
        config: {} as unknown as InternalAxiosRequestConfig,
        data: undefined
      }
    )

    const client = mockClient(vi.fn().mockRejectedValue(error))
    const result = await pushOrderToShopify(client, samplePayload)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/auth\/scopes/i)
  })

  it('returns the raw message for non-axios errors', async () => {
    const client = mockClient(
      vi.fn().mockRejectedValue(new Error('boom'))
    )

    const result = await pushOrderToShopify(client, samplePayload)

    expect(result.success).toBe(false)
    expect(result.error).toBe('boom')
  })
})
