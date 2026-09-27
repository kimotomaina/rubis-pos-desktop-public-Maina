/**
 * Shopify order push service.
 *
 * Converts a locally queued offline order into an `orderCreate`
 * GraphQL mutation so sales completed without internet reach the
 * merchant's Shopify admin once connectivity returns.
 *
 * The axios client is injectable and the function never throws — it
 * always resolves a {@link ServiceResult}.
 */

import { AxiosError, type AxiosInstance, type AxiosResponse } from 'axios'
import type { OfflineOrderPayload, ServiceResult } from './shopify-types.js'

/** GraphQL Admin API mutation used to sync offline orders (2026-07). */
export const ORDER_CREATE_MUTATION = `
mutation CreateOfflineOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) {
    order {
      id
      name
    }
    userErrors {
      field
      message
    }
  }
}
`

/** Deduplication tag attached to every synced order. */
export const CLIENT_ORDER_UUID_KEY = 'client_order_uuid'

/** Metafield namespace used by RUBIS POS on Shopify orders. */
export const RUBIS_NAMESPACE = 'rubis_pos'

/** Wire envelope of the orderCreate mutation response. */
export interface OrderCreateGraphQLResponse {
  data?: {
    orderCreate?: {
      order?: { id: string; name: string | null } | null
      userErrors?: Array<{ field: string[] | null; message: string }>
    } | null
  }
  errors?: Array<{ message: string }>
}

/** Mapped success result of {@link pushOrderToShopify}. */
export interface OrderCreateResult {
  shopifyOrderId: string
  orderName: string | null
}

/**
 * Builds the `orderCreate` variables for a queued offline order.
 *
 * The order is created as already paid (`financialStatus: PAID`) and
 * decrements inventory obeying the store's policy.  The client uuid is
 * attached both as a custom attribute and a metafield for retry
 * reconciliation, and is also sent as `sourceIdentifier` (docs/
 * phase-169 commit 2). Shopify documents that field as "A unique POS or
 * third party order identifier", and the orders query can filter on it
 * (`source_identifier:<value>`) with no metafield definition or other
 * store setting needed, unlike the metafield (docs/phase-168 section
 * 1.4). Both checked on shopify.dev (2026-07 API docs) on 2026-09-27.
 *
 * @param {OfflineOrderPayload} payload
 * @returns the mutation `$order` / `$options` variables
 */
export function buildOrderInput(payload: OfflineOrderPayload): {
  order: Record<string, unknown>
  options: Record<string, unknown>
} {
  const paymentNote =
    payload.paymentMethod === 'cash'
      ? `cash (tendered ${payload.tenderedAmount.toFixed(2)}, change ${payload.changeDue.toFixed(2)})`
      : `${payload.paymentMethod}${payload.referenceNumber ? ` (ref ${payload.referenceNumber})` : ''}`

  return {
    order: {
      lineItems: payload.lineItems.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity
      })),
      financialStatus: 'PAID',
      note: `RUBIS POS offline sale — local UUID ${payload.clientOrderUuid} (taken ${payload.createdAt}) — cashier ${payload.staffName} — payment: ${paymentNote}`,
      sourceIdentifier: payload.clientOrderUuid,
      customAttributes: [
        { key: CLIENT_ORDER_UUID_KEY, value: payload.clientOrderUuid }
      ],
      metafields: [
        {
          namespace: RUBIS_NAMESPACE,
          key: CLIENT_ORDER_UUID_KEY,
          type: 'single_line_text_field',
          value: payload.clientOrderUuid
        }
      ]
    },
    options: {
      inventoryBehaviour: 'DECREMENT_OBEYING_POLICY',
      sendReceipt: false,
      sendFulfillmentReceipt: false
    }
  }
}

/**
 * Maps an axios failure from the order push into a POS-safe message.
 *
 * @param {AxiosError} err
 * @returns {string}
 */
function translatePushError(err: AxiosError): string {
  if (!err.response) {
    return 'Network error while syncing order — will retry automatically'
  }
  const { status } = err.response
  if (status === 401 || status === 403) {
    return 'Shopify rejected the order sync (auth/scopes) — check API token'
  }
  if (status === 429) {
    return 'Shopify rate limit hit during order sync — will retry'
  }
  return `Order sync failed (HTTP ${status}) — will retry`
}

/**
 * Pushes one offline order to Shopify via `orderCreate`.
 *
 * @param {AxiosInstance} client — pre-configured Shopify client
 * @param {OfflineOrderPayload} payload
 * @returns {Promise<ServiceResult<OrderCreateResult>>}
 */
export async function pushOrderToShopify(
  client: AxiosInstance,
  payload: OfflineOrderPayload
): Promise<ServiceResult<OrderCreateResult>> {
  const variables = buildOrderInput(payload)

  try {
    const response: AxiosResponse<OrderCreateGraphQLResponse> =
      await client.post('', {
        query: ORDER_CREATE_MUTATION,
        variables
      })

    const topErrors = response.data?.errors
    if (topErrors && topErrors.length > 0) {
      return {
        success: false,
        error: topErrors.map((e) => e.message).join('; ')
      }
    }

    const result = response.data?.data?.orderCreate
    if (!result) {
      return { success: false, error: 'Shopify returned an empty orderCreate response' }
    }

    const userErrors = result.userErrors ?? []
    if (userErrors.length > 0) {
      return {
        success: false,
        error: userErrors
          .map((e) => `${e.field?.join('.') ?? 'order'}: ${e.message}`)
          .join('; ')
      }
    }

    if (!result.order) {
      return { success: false, error: 'Shopify orderCreate returned no order object' }
    }

    return {
      success: true,
      data: {
        shopifyOrderId: result.order.id,
        orderName: result.order.name
      }
    }
  } catch (err) {
    if (err instanceof AxiosError) {
      return { success: false, error: translatePushError(err) }
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'An unknown error occurred'
    }
  }
}
