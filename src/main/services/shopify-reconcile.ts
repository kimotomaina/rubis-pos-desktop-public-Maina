/**
 * Shopify reconciliation lookups (docs/phase-170, commit 1 - the
 * sales-safety check designed in docs/phase-168 and amended in
 * docs/phase-169).
 *
 * Every function here only ever reads. None of them creates, updates,
 * cancels or deletes anything in Shopify - the hard rule for this
 * phase. The axios client is injectable, exactly like shopify.ts and
 * orders.ts, and no function throws: every one resolves a
 * {@link ServiceResult}.
 *
 * GraphQL documentation cited below was read on 2026-09-27 against API
 * version 2026-07, the same version `GRAPHQL_ENDPOINT_SUFFIX`
 * (shopify.ts) already targets.
 */

import { AxiosError, type AxiosInstance, type AxiosResponse } from 'axios'
import type { ServiceResult } from './shopify-types.js'

/**
 * One Shopify order, as returned by every lookup in this file. Never
 * more than these five fields are requested - nothing here needs a
 * line item, a customer, or a financial figure.
 */
export interface ShopifyOrderLookup {
  id: string
  name: string | null
  createdAt: string
  cancelledAt: string | null
  sourceIdentifier: string | null
}

/**
 * `extensions.cost` on every GraphQL response - shape confirmed
 * verbatim from shopify.dev's GraphQL Admin API rate limits page
 * (read 2026-09-27):
 * ```
 * "extensions": { "cost": { "requestedQueryCost": 101, "actualQueryCost": 46,
 *   "throttleStatus": { "maximumAvailable": 1000, "currentlyAvailable": 954, "restoreRate": 50 } } }
 * ```
 */
export interface ShopifyRequestCost {
  requestedQueryCost: number
  actualQueryCost: number
  throttleStatus: {
    maximumAvailable: number
    currentlyAvailable: number
    restoreRate: number
  }
}

interface GraphQLError {
  message: string
  extensions?: Record<string, unknown>
}

/**
 * Wire envelope for every query in this file. Unlike `shopify.ts`'s
 * response types, `extensions` on each error is kept (not dropped) -
 * this phase's own instruction, since a scope-denial or throttle code
 * lives there and this module needs to tell those apart from an
 * ordinary error.
 */
interface GraphQLEnvelope<T> {
  data?: T
  errors?: GraphQLError[]
  extensions?: { cost?: ShopifyRequestCost }
}

/** `currentAppInstallation { accessScopes { handle } }` - no argument, no access scope of its own (shopify.dev, `currentAppInstallation`, read 2026-09-27: "Returns the AppInstallation for the currently authenticated app... Provides access to granted access scopes"). */
export const ACCESS_SCOPES_QUERY = `
query CheckAccessScopes {
  currentAppInstallation {
    accessScopes {
      handle
    }
  }
}
`

/**
 * Looks up orders by the `source_identifier` this app now writes at
 * `orderCreate` time (docs/phase-169 commit 2, `orders.ts:87`).
 * `source_identifier` needs no metafield definition or admin-filterable
 * setting, unlike `metafields.rubis_pos.client_order_uuid` (docs/
 * phase-168 section 1.4) - confirmed on shopify.dev's `orders` query
 * page (read 2026-09-27): `source_identifier:1234-12-1000` is listed
 * as a plain supported filter, no capability switch mentioned.
 *
 * `first: 5` is enough to tell 0, 1 and "more than one" apart without
 * ever needing a second page.
 */
export const FIND_BY_SOURCE_IDENTIFIER_QUERY = `
query FindBySourceIdentifier($query: String!) {
  orders(first: 5, query: $query) {
    nodes {
      id
      name
      createdAt
      cancelledAt
      sourceIdentifier
    }
  }
}
`

/**
 * `nodes(ids:)` - shopify.dev (read 2026-09-27): "Returns the list of
 * nodes... with the given IDs". A node this store no longer has (or
 * never had) comes back as `null` in the same position, which is how
 * `existsByIds` tells "not found" apart from every other node.
 */
export const NODES_BY_ID_QUERY = `
query NodesByIds($ids: [ID!]!) {
  nodes(ids: $ids) {
    id
    ... on Order {
      name
      createdAt
      cancelledAt
      sourceIdentifier
    }
  }
}
`

/** `ordersCount(query:, limit:)` - shopify.dev (read 2026-09-27): needs `read_orders` or `read_marketplace_orders`; `limit` defaults to and is capped at 10,000. */
export const ORDERS_COUNT_QUERY = `
query OrdersCount($query: String!, $limit: Int!) {
  ordersCount(query: $query, limit: $limit) {
    count
    precision
  }
}
`

/**
 * The `nodes` query argument array's own documented cap - shopify.dev,
 * GraphQL Admin API rate limits (read 2026-09-27): "maximum size of
 * 250 for input array arguments".
 */
export const MAX_NODES_PER_BATCH = 250

/** `ordersCount`'s own documented cap (shopify.dev, `ordersCount`, read 2026-09-27). */
export const ORDERS_COUNT_LIMIT = 10_000

/** The plain, operator-facing message every scope-related refusal in this file uses. */
export const SCOPE_MISSING_MESSAGE =
  'This till is not allowed to read Shopify orders - ask whoever manages the Shopify app to add the read_orders permission.'

/** The plain, operator-facing message every abort/time-limit refusal in this file uses. */
export const TIME_LIMIT_MESSAGE = 'Could not finish checking Shopify in time - will try again later.'

/**
 * Tracks this run's GraphQL cost budget from each reply's
 * `extensions.cost.throttleStatus`, and waits before a request that
 * would exceed what is currently available.
 *
 * This is the proactive, documented mechanism (shopify.dev, GraphQL
 * Admin API rate limits, read 2026-09-27: `currentlyAvailable`/
 * `restoreRate`), not a reactive check for a particular throttled
 * error code - that page names a 429 for the separate, resource-based
 * limit, but does not document an `extensions.code` string for the
 * cost-based one. **Not verified**: the exact code, if any; this
 * module never depends on it.
 *
 * One instance is shared across every call in a single check run, so
 * the budget estimate carries over from one lookup to the next.
 */
export class ThrottleBudget {
  /** Optimistic starting point (Standard plan's own documented bucket size); corrected by the first real reply. */
  private currentlyAvailable = 1000
  /** Standard plan's own documented restore rate; corrected by the first real reply. */
  private restoreRate = 50

  /** Updates the tracked budget from a real response's cost, when the response carried one. */
  record(cost?: ShopifyRequestCost): void {
    if (!cost) return
    this.currentlyAvailable = cost.throttleStatus.currentlyAvailable
    this.restoreRate = cost.throttleStatus.restoreRate
  }

  /** @returns {number} the currently tracked budget - exposed for tests, not used to make requests. */
  peek(): number {
    return this.currentlyAvailable
  }

  /**
   * Waits (respecting `signal`) until `nextCost` points are estimated
   * to be affordable, then optimistically marks them spent - the next
   * real reply's `record()` corrects the estimate either way.
   *
   * @param {number} nextCost
   * @param {AbortSignal} [signal]
   * @throws {ReconciliationAbortedError} if `signal` fires first
   */
  async waitForBudget(nextCost: number, signal?: AbortSignal): Promise<void> {
    if (this.currentlyAvailable >= nextCost) {
      this.currentlyAvailable -= nextCost
      return
    }
    const deficit = nextCost - this.currentlyAvailable
    const waitMs = Math.ceil((deficit / this.restoreRate) * 1000)
    await sleep(waitMs, signal)
    this.currentlyAvailable = 0
  }
}

/** Thrown (as a rejection, never left uncaught - see `postGraphQL`) when `signal` fires before or during a wait/request. */
export class ReconciliationAbortedError extends Error {
  constructor() {
    super('Shopify reconciliation check was cancelled')
    this.name = 'ReconciliationAbortedError'
  }
}

/** `setTimeout` that also rejects early if `signal` fires - the one primitive both the throttle wait and the overall time limit are built from. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ReconciliationAbortedError())
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new ReconciliationAbortedError())
      },
      { once: true }
    )
  })
}

/**
 * A GraphQL top-level error naming a scope/permission problem. Shopify
 * does not document one single `extensions.code` for this (see
 * `ThrottleBudget`'s own doc comment on the same limitation) — matched
 * on wording instead, which is what this repo's own `shopify.ts` already
 * does for HTTP 403 (`translateAxiosError`, "the token lacks required
 * Shopify API scopes").
 *
 * @param {GraphQLError} error
 * @returns {boolean}
 */
function isScopeDeniedError(error: GraphQLError): boolean {
  const code = error.extensions?.code
  if (typeof code === 'string' && /access|forbidden|scope/i.test(code)) return true
  return /access denied|not approved|doesn'?t have access|not authorized/i.test(error.message)
}

/**
 * Every axios failure this module can see, translated the same way
 * `shopify.ts`'s own `translateAxiosError` does for the same HTTP
 * statuses, except 403 (routed to {@link SCOPE_MISSING_MESSAGE} by the
 * caller before this runs) and 429 (this module never expects one -
 * see `ThrottleBudget`'s own doc comment).
 *
 * @param {AxiosError} err
 * @returns {string}
 */
function translateReconcileAxiosError(err: AxiosError): string {
  if (!err.response) {
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return 'Could not reach Shopify (timed out) - will try again later.'
    }
    return 'Could not reach Shopify - will try again later.'
  }
  const { status } = err.response
  if (status === 401) return 'Shopify rejected the Admin API token - check it in Admin > Integrations'
  return `Shopify API error (${status}) - will try again later.`
}

/** Successful result of {@link postGraphQL}: the caller already knows which shape `T` to expect. */
type GraphQLCallResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * The single HTTP+budget+error-handling path every function below
 * goes through - one place that honours `signal`, waits on the shared
 * {@link ThrottleBudget}, keeps GraphQL `extensions` instead of
 * dropping them, and logs a scope denial's raw code (this phase's own
 * instruction) before translating it to plain language.
 *
 * @param {AxiosInstance} client
 * @param {string} query
 * @param {Record<string, unknown>} variables
 * @param {ThrottleBudget} budget
 * @param {number} estimatedCost - a conservative, undocumented-formula estimate (see call sites); corrected by the real reply either way
 * @param {AbortSignal} [signal]
 * @param {Pick<Console, 'warn'>} [logger]
 * @returns {Promise<GraphQLCallResult<T>>}
 */
async function postGraphQL<T>(
  client: AxiosInstance,
  query: string,
  variables: Record<string, unknown>,
  budget: ThrottleBudget,
  estimatedCost: number,
  signal: AbortSignal | undefined,
  logger: Pick<Console, 'warn'> = console
): Promise<GraphQLCallResult<T>> {
  if (signal?.aborted) return { ok: false, error: TIME_LIMIT_MESSAGE }

  try {
    await budget.waitForBudget(estimatedCost, signal)
  } catch (err) {
    if (err instanceof ReconciliationAbortedError) return { ok: false, error: TIME_LIMIT_MESSAGE }
    throw err
  }

  try {
    const response: AxiosResponse<GraphQLEnvelope<T>> = await client.post(
      '',
      { query, variables },
      { signal }
    )
    budget.record(response.data?.extensions?.cost)

    const topErrors = response.data?.errors
    if (topErrors && topErrors.length > 0) {
      const scopeError = topErrors.find(isScopeDeniedError)
      if (scopeError) {
        logger.warn(
          `[rubis-pos] Shopify reconciliation: access denied (raw extensions: ${JSON.stringify(scopeError.extensions)}, message: ${scopeError.message})`
        )
        return { ok: false, error: SCOPE_MISSING_MESSAGE }
      }
      return { ok: false, error: topErrors.map((e) => e.message).join('; ') }
    }

    if (!response.data?.data) {
      return { ok: false, error: 'Shopify returned an empty response' }
    }

    return { ok: true, data: response.data.data }
  } catch (err) {
    if (err instanceof AxiosError) {
      if (err.code === 'ERR_CANCELED') return { ok: false, error: TIME_LIMIT_MESSAGE }
      if (err.response?.status === 403) return { ok: false, error: SCOPE_MISSING_MESSAGE }
      return { ok: false, error: translateReconcileAxiosError(err) }
    }
    if (err instanceof ReconciliationAbortedError) return { ok: false, error: TIME_LIMIT_MESSAGE }
    return { ok: false, error: err instanceof Error ? err.message : 'An unknown error occurred' }
  }
}

/**
 * Whether this till's token can read orders at all - the first call
 * every check run makes, so a missing scope is caught before any
 * order lookup is even attempted (fail safe: no lookups, nothing held
 * or linked, one clear message).
 *
 * @param {AxiosInstance} client
 * @param {ThrottleBudget} budget
 * @param {AbortSignal} [signal]
 * @param {Pick<Console, 'warn'>} [logger]
 * @returns {Promise<ServiceResult<{ ready: boolean; scopes: string[] }>>}
 */
export async function checkScopes(
  client: AxiosInstance,
  budget: ThrottleBudget,
  signal?: AbortSignal,
  logger?: Pick<Console, 'warn'>
): Promise<ServiceResult<{ ready: boolean; scopes: string[] }>> {
  const result = await postGraphQL<{
    currentAppInstallation?: { accessScopes?: Array<{ handle: string }> }
  }>(client, ACCESS_SCOPES_QUERY, {}, budget, 1, signal, logger)

  if (!result.ok) return { success: false, error: result.error }

  const scopes = (result.data.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle)
  const ready = scopes.includes('read_orders') || scopes.includes('read_all_orders')
  return { success: true, data: { ready, scopes } }
}

/**
 * Classifies a set of exact-match orders - `none`, `one`, or `many`
 * (docs/phase-170 commit 1's own naming). Kept separate from
 * {@link findBySourceIdentifier} so the classification itself is a
 * plain, dependency-free unit to test.
 */
export type OrderMatchResult =
  | { kind: 'none' }
  | { kind: 'one'; order: ShopifyOrderLookup }
  | { kind: 'many'; orders: ShopifyOrderLookup[] }

export function classifyOrderMatches(orders: ShopifyOrderLookup[]): OrderMatchResult {
  if (orders.length === 0) return { kind: 'none' }
  if (orders.length === 1) return { kind: 'one', order: orders[0] }
  return { kind: 'many', orders }
}

/**
 * Looks up orders by `source_identifier`, keeping only the ones whose
 * value matches `uuid` exactly - Shopify's search is a text match, not
 * an equality test, so a near-match (a uuid that merely contains this
 * one as a substring, or vice versa) must never be trusted blind.
 *
 * @param {AxiosInstance} client
 * @param {string} uuid
 * @param {ThrottleBudget} budget
 * @param {AbortSignal} [signal]
 * @param {Pick<Console, 'warn'>} [logger]
 * @returns {Promise<ServiceResult<ShopifyOrderLookup[]>>}
 */
export async function findBySourceIdentifier(
  client: AxiosInstance,
  uuid: string,
  budget: ThrottleBudget,
  signal?: AbortSignal,
  logger?: Pick<Console, 'warn'>
): Promise<ServiceResult<ShopifyOrderLookup[]>> {
  const query = `source_identifier:${JSON.stringify(uuid)}`
  // Connection cost is sized by `first` (shopify.dev, rate limits, read
  // 2026-09-27) but no exact formula is given; `first: 5` is small, so a
  // conservative fixed estimate is used here and corrected by the real
  // reply's own cost regardless.
  const result = await postGraphQL<{
    orders?: { nodes?: ShopifyOrderLookup[] }
  }>(client, FIND_BY_SOURCE_IDENTIFIER_QUERY, { query }, budget, 12, signal, logger)

  if (!result.ok) return { success: false, error: result.error }

  const nodes = result.data.orders?.nodes ?? []
  const exact = nodes.filter((node) => node.sourceIdentifier === uuid)
  return { success: true, data: exact }
}

/**
 * Checks whether each of `ids` still exists in Shopify, in batches of
 * {@link MAX_NODES_PER_BATCH}. A `null` node in the reply means that id
 * is gone (or never existed) - `existsByIds`'s only question.
 *
 * @param {AxiosInstance} client
 * @param {string[]} ids - Shopify global ids (`gid://shopify/Order/...`)
 * @param {ThrottleBudget} budget
 * @param {AbortSignal} [signal]
 * @param {Pick<Console, 'warn'>} [logger]
 * @returns {Promise<ServiceResult<Map<string, ShopifyOrderLookup | null>>>} `null` means not found
 */
export async function existsByIds(
  client: AxiosInstance,
  ids: string[],
  budget: ThrottleBudget,
  signal?: AbortSignal,
  logger?: Pick<Console, 'warn'>
): Promise<ServiceResult<Map<string, ShopifyOrderLookup | null>>> {
  const found = new Map<string, ShopifyOrderLookup | null>()

  for (let start = 0; start < ids.length; start += MAX_NODES_PER_BATCH) {
    const batch = ids.slice(start, start + MAX_NODES_PER_BATCH)
    const result = await postGraphQL<{
      nodes?: Array<(ShopifyOrderLookup & { id: string }) | null>
    }>(
      client,
      NODES_BY_ID_QUERY,
      { ids: batch },
      budget,
      batch.length + 1,
      signal,
      logger
    )

    if (!result.ok) return { success: false, error: result.error }

    const nodes = result.data.nodes ?? []
    for (let i = 0; i < batch.length; i++) {
      const node = nodes[i] ?? null
      found.set(batch[i], node)
    }
  }

  return { success: true, data: found }
}

/**
 * The "other tills" number: how many orders the whole store has taken
 * in the last `days` days, counted only, never read individually -
 * `ordersCount` (shopify.dev, read 2026-09-27) needs `read_orders` or
 * `read_marketplace_orders`, the same scope {@link checkScopes} already
 * confirms.
 *
 * @param {AxiosInstance} client
 * @param {number} days
 * @param {ThrottleBudget} budget
 * @param {AbortSignal} [signal]
 * @param {Pick<Console, 'warn'>} [logger]
 * @param {() => Date} [now] - injectable clock for tests
 * @returns {Promise<ServiceResult<{ count: number; precision: string }>>}
 */
export async function countRecent(
  client: AxiosInstance,
  days: number,
  budget: ThrottleBudget,
  signal?: AbortSignal,
  logger?: Pick<Console, 'warn'>,
  now: () => Date = () => new Date()
): Promise<ServiceResult<{ count: number; precision: string }>> {
  const since = new Date(now().getTime() - days * 24 * 60 * 60 * 1000).toISOString()
  // Search syntax: `created_at:>='<ISO 8601>'` (shopify.dev, search
  // syntax, read 2026-09-27).
  const query = `created_at:>='${since}'`
  const result = await postGraphQL<{
    ordersCount?: { count: number; precision: string }
  }>(
    client,
    ORDERS_COUNT_QUERY,
    { query, limit: ORDERS_COUNT_LIMIT },
    budget,
    5,
    signal,
    logger
  )

  if (!result.ok) return { success: false, error: result.error }
  if (!result.data.ordersCount) return { success: false, error: 'Shopify returned no order count' }
  return { success: true, data: result.data.ordersCount }
}
