/**
 * Shopify inventory adjustment service.
 *
 * The app's **only** inventory write. Everything else it sends Shopify
 * either reads, or states that a sale happened and lets Shopify do its
 * own arithmetic (`orderCreate`'s `inventoryBehaviour`). This module is
 * the one place that names a quantity change to the source of truth, so
 * it stays deliberately small and is called from exactly one caller —
 * `stock-take.ts`'s commit.
 *
 * Mirrors `orders.ts`: the mutation as an exported constant, an
 * injectable axios client, and a function that never throws — it always
 * resolves a {@link ServiceResult}.
 */

import { AxiosError, type AxiosInstance, type AxiosResponse } from 'axios'
import type { ServiceResult } from './shopify-types.js'

/**
 * GraphQL Admin API mutation used to push a stock take (2026-07).
 *
 * `@idempotent` is not optional decoration: Shopify has required an
 * idempotency key on every inventory mutation since API version
 * 2026-04, and a retry carrying the same key returns the original
 * response instead of adjusting a second time.
 *
 * `inventoryAdjustQuantities` (delta) is used rather than
 * `inventorySetQuantities` (absolute) — see
 * {@link buildInventoryAdjustInput} for why.
 */
export const INVENTORY_ADJUST_MUTATION = `
mutation StockTakeAdjust($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
    inventoryAdjustmentGroup {
      createdAt
      reason
      referenceDocumentUri
      changes {
        name
        delta
      }
    }
    userErrors {
      field
      message
    }
  }
}
`

/**
 * The inventory bucket a stock take counts.
 *
 * A stock take counts what is on the shelf, and `"available"` is the
 * only bucket this app ever sells against. Adjusting any other bucket
 * would additionally require a `ledgerDocumentUri` per change.
 */
export const STOCK_TAKE_QUANTITY_NAME = 'available'

/**
 * Shopify's enumerated reason code for a stock take, documented as "an
 * adjusted inventory count due to a discrepancy between actual and
 * recorded quantities". It is what makes the merchant's own inventory
 * history read correctly without us explaining ourselves.
 */
export const STOCK_TAKE_REASON = 'cycle_count_available'

/** Namespace of the `referenceDocumentUri` attached to every stock take. */
export const STOCK_TAKE_REFERENCE_PREFIX = 'gid://rubis-pos/StockTake/'

/**
 * Most changes sent in one mutation.
 *
 * Each batch carries its own idempotency key (see
 * {@link buildIdempotencyKey}) — reusing one key across batches would
 * make Shopify replay the first batch's cached response for the second
 * and silently drop it.
 */
export const MAX_CHANGES_PER_CALL = 250

/** One variant's adjustment, before it becomes GraphQL input. */
export interface InventoryAdjustChange {
  inventoryItemId: string
  /** `counted − snapshot`. Never `counted − fresh` — see `stock-take.ts`. */
  delta: number
  /** Shopify's quantity as freshly re-read at commit; the compare-and-swap guard. */
  changeFromQuantity: number
}

/** Mapped success result of {@link pushInventoryAdjustment}. */
export interface InventoryAdjustResult {
  createdAt: string | null
  referenceDocumentUri: string | null
  /** Verbatim response body, stored on the session for audit. */
  rawResponse: unknown
}

/** Wire envelope of the adjustment mutation response. */
export interface InventoryAdjustGraphQLResponse {
  data?: {
    inventoryAdjustQuantities?: {
      inventoryAdjustmentGroup?: {
        createdAt: string | null
        reason: string | null
        referenceDocumentUri: string | null
        changes?: Array<{ name: string; delta: number }>
      } | null
      userErrors?: Array<{ field: string[] | null; message: string }>
    } | null
  }
  errors?: Array<{ message: string }>
}

/**
 * Builds the `referenceDocumentUri` Shopify records against the
 * adjustment, so our local audit row and the merchant's inventory
 * history point at each other.
 *
 * Same reconciliation trick as `client_order_uuid` on a synced order.
 *
 * @param {string} sessionUuid
 * @returns {string}
 */
export function buildStockTakeReferenceUri(sessionUuid: string): string {
  return `${STOCK_TAKE_REFERENCE_PREFIX}${sessionUuid}`
}

/**
 * Builds the idempotency key for one batch of a session's changes.
 *
 * Derived from the session uuid so a retry of the *same* batch is
 * recognised by Shopify, and suffixed with the batch index so two
 * different batches of one session are never mistaken for each other.
 *
 * @param {string} sessionUuid
 * @param {number} batchIndex
 * @returns {string}
 */
export function buildIdempotencyKey(sessionUuid: string, batchIndex: number): string {
  return `${sessionUuid}:${batchIndex}`
}

/**
 * Builds the mutation's `$input` for one batch.
 *
 * The app sends a **delta**, not an absolute quantity, and this is the
 * whole safety argument of the feature. Shopify's own guidance prefers
 * `inventorySetQuantities` when the caller holds authoritative values
 * "like completed stocktakes" — that assumes a warehouse whose count
 * freezes movement. A till does not freeze: it keeps selling while the
 * shelf is counted. Setting the counted figure would put back every
 * unit sold during the count. Adding `counted − snapshot` to whatever
 * Shopify now holds preserves those sales.
 *
 * `changeFromQuantity` is the freshly re-read quantity, making each
 * change a compare-and-swap: if Shopify moved between our read and the
 * mutation landing, the change is rejected rather than applied to a
 * quantity we never saw.
 *
 * @param {object} params
 * @param {string} params.locationId — the till's own location, resolved in main
 * @param {string} params.sessionUuid
 * @param {InventoryAdjustChange[]} params.changes
 * @returns the mutation `$input` variable
 */
export function buildInventoryAdjustInput(params: {
  locationId: string
  sessionUuid: string
  changes: InventoryAdjustChange[]
}): Record<string, unknown> {
  return {
    name: STOCK_TAKE_QUANTITY_NAME,
    reason: STOCK_TAKE_REASON,
    referenceDocumentUri: buildStockTakeReferenceUri(params.sessionUuid),
    changes: params.changes.map((change) => ({
      inventoryItemId: change.inventoryItemId,
      locationId: params.locationId,
      delta: change.delta,
      changeFromQuantity: change.changeFromQuantity
    }))
  }
}

/**
 * Splits a session's changes into mutation-sized batches.
 *
 * @param {InventoryAdjustChange[]} changes
 * @param {number} [size=MAX_CHANGES_PER_CALL]
 * @returns {InventoryAdjustChange[][]}
 */
export function batchChanges(
  changes: InventoryAdjustChange[],
  size: number = MAX_CHANGES_PER_CALL
): InventoryAdjustChange[][] {
  const batches: InventoryAdjustChange[][] = []
  for (let index = 0; index < changes.length; index += size) {
    batches.push(changes.slice(index, index + size))
  }
  return batches
}

/**
 * Maps an axios failure from the adjustment push into a POS-safe
 * message.
 *
 * A 403 is called out by name: this is the app's first mutation
 * needing the `write_inventory` scope, and a token issued before the
 * feature existed will not carry it.
 *
 * @param {AxiosError} err
 * @returns {string}
 */
function translateAdjustError(err: AxiosError): string {
  if (!err.response) {
    return 'Could not reach Shopify to push the stock take — nothing was changed. Check the connection and try again.'
  }
  const { status } = err.response
  if (status === 401) {
    return 'Shopify rejected the stock take (authentication) — check the Admin API Token in Admin > Integrations. Nothing was changed.'
  }
  if (status === 403) {
    return 'Shopify rejected the stock take — the Admin API Token lacks the write_inventory scope. Nothing was changed.'
  }
  if (status === 429) {
    return 'Shopify rate limited the stock take — nothing was changed. Wait a moment and try again.'
  }
  return `Shopify rejected the stock take (HTTP ${status}) — nothing was changed.`
}

/**
 * Pushes one batch of adjustments to Shopify.
 *
 * @param {AxiosInstance} client — pre-configured Shopify client
 * @param {object} params
 * @param {string} params.locationId
 * @param {string} params.sessionUuid
 * @param {number} params.batchIndex
 * @param {InventoryAdjustChange[]} params.changes
 * @returns {Promise<ServiceResult<InventoryAdjustResult>>}
 */
export async function pushInventoryAdjustment(
  client: AxiosInstance,
  params: {
    locationId: string
    sessionUuid: string
    batchIndex: number
    changes: InventoryAdjustChange[]
  }
): Promise<ServiceResult<InventoryAdjustResult>> {
  const input = buildInventoryAdjustInput(params)

  try {
    const response: AxiosResponse<InventoryAdjustGraphQLResponse> = await client.post('', {
      query: INVENTORY_ADJUST_MUTATION,
      variables: {
        input,
        idempotencyKey: buildIdempotencyKey(params.sessionUuid, params.batchIndex)
      }
    })

    const topErrors = response.data?.errors
    if (topErrors && topErrors.length > 0) {
      return { success: false, error: topErrors.map((e) => e.message).join('; ') }
    }

    const result = response.data?.data?.inventoryAdjustQuantities
    if (!result) {
      return { success: false, error: 'Shopify returned an empty inventory adjustment response' }
    }

    const userErrors = result.userErrors ?? []
    if (userErrors.length > 0) {
      return {
        success: false,
        error: userErrors
          .map((e) => `${e.field?.join('.') ?? 'adjustment'}: ${e.message}`)
          .join('; ')
      }
    }

    if (!result.inventoryAdjustmentGroup) {
      return { success: false, error: 'Shopify applied no inventory adjustment' }
    }

    return {
      success: true,
      data: {
        createdAt: result.inventoryAdjustmentGroup.createdAt,
        referenceDocumentUri: result.inventoryAdjustmentGroup.referenceDocumentUri,
        rawResponse: response.data
      }
    }
  } catch (err) {
    if (err instanceof AxiosError) {
      return { success: false, error: translateAdjustError(err) }
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'An unknown error occurred'
    }
  }
}
