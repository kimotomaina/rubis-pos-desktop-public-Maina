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
import type { SalePayment } from '../lib/paymentLegs.js'
import { locationTag } from '../lib/locationSlug.js'
import { resolveCheckoutLocation, type TillLocation } from '../lib/checkoutLocation.js'

/** Raised when an order has no usable location (docs/phase-210): it is never pushed without one. */
export class MissingLocationError extends Error {
  constructor() {
    super('This sale has no shop location, so it was not sent to Shopify. Set the till location in Admin.')
    this.name = 'MissingLocationError'
  }
}

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
 * One payment of a split sale in the Shopify note (docs/phase-252): `mpesa 500.00 (ref QAB45GH6IJ)`, or
 * `cash 1000.00 (tendered 1200.00, change 200.00)`.
 *
 * @param {SalePayment} payment
 * @returns {string}
 */
function splitPaymentNote(payment: SalePayment): string {
  const amount = `${payment.method} ${payment.amount.toFixed(2)}`
  if (payment.method === 'cash') {
    return `${amount} (tendered ${(payment.tendered ?? payment.amount).toFixed(2)}, change ${(payment.changeDue ?? 0).toFixed(2)})`
  }
  return payment.reference ? `${amount} (ref ${payment.reference})` : amount
}

/** The shop's currency, as every amount on this till is (`currency.ts`). */
const SHOP_CURRENCY = 'KES'

/**
 * The note's discount part (docs/phase-253-2): each automatic discount's title and what it took off this sale, e.g.
 * ` — discounts: Probakery Bread 2 @99/= -31.00`. Empty for a sale with none.
 *
 * @param {OfflineOrderPayload['lineItems']} lines
 * @returns {string}
 */
function discountNote(lines: OfflineOrderPayload['lineItems']): string {
  const byTitle = new Map<string, number>()
  for (const line of lines) {
    if (!line.autoDiscount) continue
    const cents = Math.round(line.autoDiscount.amountOffEach * 100) * line.quantity
    byTitle.set(line.autoDiscount.title, (byTitle.get(line.autoDiscount.title) ?? 0) + cents)
  }
  if (byTitle.size === 0) return ''
  return ` — discounts: ${[...byTitle].map(([title, cents]) => `${title} -${(cents / 100).toFixed(2)}`).join(', ')}`
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
 * docs/phase-210: the order also carries the shop that sold it, two ways.
 * `fulfillment.locationId` creates the order fulfilled from that location
 * ("The ID of the location to fulfill the order from", shopify.dev 2026-07),
 * and a `location:<slug>` tag lets the Shopify order list filter by shop.
 * `fulfillmentStatus: FULFILLED` is sent as well, because the reference does
 * not say whether `fulfillment` alone implies it. NOT documented: that the
 * fulfillment location is the one stock is decremented at; verified by one
 * real order (docs/phase-210-1). The location is the sale's own (captured at
 * sale time into the payload), or `fallback` for a payload queued before
 * that phase.
 *
 * docs/phase-253-2 (D4, option b): a sale with an automatically discounted line sends Shopify the lines the device
 * got, each with `priceSet` at the price it was sold at, and the discount in the note. Shopify applies no automatic
 * discount to an order made this way ("Automatic discounts won't be applied unless you replicate the logic of those
 * discounts in your custom implementation", shopify.dev orderCreate, 2026-10, read 2026-10-07). A sale with no
 * automatic discount sends exactly the lines it always has.
 *
 * @param {OfflineOrderPayload} payload
 * @param {TillLocation | null} [fallback] this till's current location
 * @returns the mutation `$order` / `$options` variables
 * @throws {MissingLocationError} when no usable location id and name exist
 */
export function buildOrderInput(
  payload: OfflineOrderPayload,
  fallback?: TillLocation | null
): {
  order: Record<string, unknown>
  options: Record<string, unknown>
} {
  const location =
    resolveCheckoutLocation(payload.locationId, payload.locationName) ?? fallback ?? null
  const tag = location ? locationTag(location.name) : null
  if (!location || !tag) throw new MissingLocationError()

  // docs/phase-252 (D2, S7): a split sale is still one paid order with no transactions; its payments go in the note
  // and as `pay:` tags. A sale paid one way keeps exactly the note and tags it had.
  const payments = payload.paymentMethod === 'split' ? (payload.payments ?? []) : []
  const paymentNote =
    payload.paymentMethod === 'split'
      ? `split: ${payments.map(splitPaymentNote).join(' + ')}`
      : payload.paymentMethod === 'cash'
        ? `cash (tendered ${payload.tenderedAmount.toFixed(2)}, change ${payload.changeDue.toFixed(2)})`
        : `${payload.paymentMethod}${payload.referenceNumber ? ` (ref ${payload.referenceNumber})` : ''}`
  const payTags = [...new Set(payments.map((payment) => `pay:${payment.method}`))]
  const discounted = payload.lineItems.some((line) => line.autoDiscount)

  return {
    order: {
      lineItems: discounted
        ? payload.lineItems.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity,
            priceSet: { shopMoney: { amount: line.unitPrice.toFixed(2), currencyCode: SHOP_CURRENCY } }
          }))
        : payload.lineItems.map((line) => ({
            variantId: line.variantId,
            quantity: line.quantity
          })),
      financialStatus: 'PAID',
      fulfillmentStatus: 'FULFILLED',
      fulfillment: { locationId: location.id, notifyCustomer: false },
      tags: [tag, ...payTags],
      note: `RUBIS POS offline sale — local UUID ${payload.clientOrderUuid} (taken ${payload.createdAt}) — cashier ${payload.staffName} — payment: ${paymentNote}${discountNote(payload.lineItems)}`,
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
 * @param {TillLocation | null} [fallbackLocation] used only when the payload carries no location
 * @returns {Promise<ServiceResult<OrderCreateResult>>}
 */
export async function pushOrderToShopify(
  client: AxiosInstance,
  payload: OfflineOrderPayload,
  fallbackLocation?: TillLocation | null
): Promise<ServiceResult<OrderCreateResult>> {
  let variables: ReturnType<typeof buildOrderInput>
  try {
    variables = buildOrderInput(payload, fallbackLocation)
  } catch (err) {
    if (err instanceof MissingLocationError) return { success: false, error: err.message }
    throw err
  }

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
