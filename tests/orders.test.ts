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
  pushOrderToShopify,
  MissingLocationError
} from '../src/main/services/orders.js'
import type { OfflineOrderPayload } from '../src/main/services/shopify-types.js'

// CHANGED (docs/phase-210). OLD: the sample payload carried no location. NEW: it carries one,
// because buildOrderInput now refuses (throws) without a location. Nothing else in it changed.
const samplePayload: OfflineOrderPayload = {
  locationId: 'gid://shopify/Location/77557989479',
  locationName: 'Rubis Kisumu',
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

  it('sends the client uuid as sourceIdentifier (docs/phase-169 commit 2)', () => {
    const variables = buildOrderInput(samplePayload)

    expect(variables.order.sourceIdentifier).toBe('uuid-offline-1')
    expect(variables.order.sourceIdentifier).toBe(samplePayload.clientOrderUuid)
  })

  // CHANGED (docs/phase-210). OLD: the order's keys, apart from sourceIdentifier, were
  // customAttributes, financialStatus, lineItems, metafields, note. NEW: fulfillment, fulfillmentStatus
  // and tags are added (the location, two ways); every other field and its value is unchanged.
  it('adds sourceIdentifier without changing any other order field', () => {
    const { sourceIdentifier: _added, ...rest } = buildOrderInput(samplePayload).order

    expect(Object.keys(rest).sort()).toEqual(
      [
        'customAttributes',
        'financialStatus',
        'fulfillment',
        'fulfillmentStatus',
        'lineItems',
        'metafields',
        'note',
        'tags'
      ].sort()
    )
    expect(rest.customAttributes).toEqual([{ key: CLIENT_ORDER_UUID_KEY, value: 'uuid-offline-1' }])
    expect(rest.metafields).toEqual([
      {
        namespace: RUBIS_NAMESPACE,
        key: CLIENT_ORDER_UUID_KEY,
        type: 'single_line_text_field',
        value: 'uuid-offline-1'
      }
    ])
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

describe('buildOrderInput: the location (docs/phase-210)', () => {
  it('creates the order fulfilled from the sale\'s location, without notifying the customer', () => {
    const { order } = buildOrderInput(samplePayload)

    expect(order.fulfillment).toEqual({ locationId: 'gid://shopify/Location/77557989479', notifyCustomer: false })
    expect(order.fulfillmentStatus).toBe('FULFILLED')
  })

  it('tags the order with exactly one tag, location:<slug> of the stored name', () => {
    expect(buildOrderInput(samplePayload).order.tags).toEqual(['location:rubis-kisumu'])
    expect(
      buildOrderInput({ ...samplePayload, locationName: 'Enjoy Haile Selassie' }).order.tags
    ).toEqual(['location:enjoy-haile-selassie'])
  })

  it('uses the location captured in the payload even when the till\'s current one has changed', () => {
    const { order } = buildOrderInput(samplePayload, { id: 'gid://shopify/Location/1', name: 'Elsewhere' })

    expect((order.fulfillment as { locationId: string }).locationId).toBe('gid://shopify/Location/77557989479')
    expect(order.tags).toEqual(['location:rubis-kisumu'])
  })

  it('falls back to the till\'s current location for a payload queued before this phase', () => {
    const { locationId: _id, locationName: _name, ...old } = samplePayload

    const { order } = buildOrderInput(old, { id: 'gid://shopify/Location/9', name: 'Westlands' })

    expect((order.fulfillment as { locationId: string }).locationId).toBe('gid://shopify/Location/9')
    expect(order.tags).toEqual(['location:westlands'])
  })

  it.each([
    ['no id and no fallback', { locationName: 'Rubis Kisumu' }, undefined],
    ['no name and no fallback', { locationId: 'gid://shopify/Location/1' }, undefined],
    ['an empty id', { locationId: '', locationName: 'Rubis Kisumu' }, null],
    ['an empty name', { locationId: 'gid://shopify/Location/1', locationName: '' }, null],
    ['a name with no usable characters', { locationId: 'gid://shopify/Location/1', locationName: '###' }, null]
  ])('refuses to build an order with %s', (_label, location, fallback) => {
    const { locationId: _id, locationName: _name, ...old } = samplePayload

    expect(() => buildOrderInput({ ...old, ...location }, fallback)).toThrow(MissingLocationError)
  })

  it('pushOrderToShopify with no location sends nothing and fails with a clear message', async () => {
    const post = vi.fn()
    const { locationId: _id, locationName: _name, ...old } = samplePayload

    const result = await pushOrderToShopify(mockClient(post), old, null)

    expect(post).not.toHaveBeenCalled()
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no shop location/i)
  })

  it('pushOrderToShopify sends the location in the posted variables', async () => {
    const post = vi.fn().mockResolvedValue({
      data: { data: { orderCreate: { order: { id: 'gid://shopify/Order/1', name: '#1' }, userErrors: [] } } }
    })

    await pushOrderToShopify(mockClient(post), samplePayload)

    const [, body] = post.mock.calls[0]
    expect(body.variables.order.fulfillment.locationId).toBe('gid://shopify/Location/77557989479')
    expect(body.variables.order.tags).toEqual(['location:rubis-kisumu'])
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
