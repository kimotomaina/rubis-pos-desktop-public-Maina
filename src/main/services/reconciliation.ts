/**
 * The Shopify sales-safety check (docs/phase-170, commit 2 - design
 * docs/phase-168, amended docs/phase-169). Orchestrates the read-only
 * lookups in `shopify-reconcile.ts` against this till's own local sales
 * (`database.ts`'s `getReconciliationCandidates`), and is the only
 * place that ever writes `linkOrderToShopify`.
 *
 * Two entry points, both consumed by `sync-engine.ts`:
 *   - {@link ReconciliationRunner.runCheck} - the periodic, time-limited
 *     check (docs/phase-168 section 2.1/2.3): every candidate sale is
 *     looked up, a lost-response sale is linked, and the results are
 *     handed to `onResult` for commit 3's Admin card to read.
 *   - {@link ReconciliationRunner.guardPush} - the pre-push guard
 *     (docs/phase-168 section 2.4): decides, for one queue item about
 *     to be pushed, whether it may already be in Shopify.
 *
 * Both share one per-tick lookup cache (`beginTick`), so a sale the
 * periodic check already looked up this tick is never looked up again
 * by the guard for the same push loop.
 */

import type { AxiosInstance } from 'axios'
import {
  checkScopes,
  findBySourceIdentifier,
  existsByIds,
  countRecent,
  classifyOrderMatches,
  ThrottleBudget,
  type ShopifyOrderLookup
} from './shopify-reconcile.js'
import type { ReconciliationCandidateRow } from './database.js'
import type { ServiceResult } from './shopify-types.js'
import type { SyncQueueItem } from './database.js'

/** The window this check covers - never older than this even if `RECONCILIATION_WINDOW_DAYS` were ever widened (docs/phase-168 finding: only the last 60 days of orders are visible to this token at all). */
export const RECONCILIATION_MAX_AGE_DAYS = 60

/** How far back this check looks, by default (docs/phase-168 section 2.3's own choice). */
export const RECONCILIATION_WINDOW_DAYS = 7

/** How long a sale must have gone unpushed-again before the guard trusts a fresh lookup over "wait, Shopify's search may not have caught up yet" (docs/phase-168 section 2.4). */
export const RECENT_PUSH_SKIP_MS = 2 * 60_000

/** One finding the periodic check produced, in the shape commit 3's Admin card reads directly. */
export type ReconciliationFinding =
  | { kind: 'linked'; localId: number; shopifyOrderId: string; shopifyName: string | null }
  | { kind: 'duplicate'; localId: number; shopifyIds: string[]; shopifyNames: Array<string | null> }
  | { kind: 'held-cancelled'; localId: number; shopifyId: string }
  | { kind: 'missing'; localId: number; shopifyOrderId: string }

/** The full outcome of one periodic check run. */
export interface ReconciliationResult {
  /** When this run finished (or gave up), this till's own clock. */
  checkedAt: number
  /** Whether the check ran to completion - `false` means nothing below (other than `failureReason`) should be trusted as exhaustive. */
  ok: boolean
  /** Set only when `ok` is `false` - a scope problem, a timeout, or a network failure. */
  failureReason?: string
  findings: ReconciliationFinding[]
  /** Roughly how many orders the wider store has taken in the window, minus this till's own synced count - `null` when it could not be counted. */
  otherTillsCount: number | null
}

/** The pre-push guard's decision for one queue item. */
export type GuardDecision =
  | { action: 'push' }
  | { action: 'linked'; shopifyOrderId: string }
  | { action: 'hold'; reason: string }

/** Structural slice of {@link RubisDatabase} this module depends on. */
export interface ReconciliationDatabase {
  getReconciliationCandidates(sinceIso: string): ReconciliationCandidateRow[]
  getShopifyPushMarker(localId: number): { count: number; lastPushAt: string | null } | undefined
  linkOrderToShopify(localId: number, shopifyOrderId: string): { linked: boolean }
}

/** The plain message used whenever Shopify credentials are not configured at all. */
export const CREDENTIALS_MISSING_MESSAGE = 'Shopify credentials missing - cannot check Shopify.'

/** Dependencies for {@link createReconciliationRunner}. */
export interface ReconciliationRunnerOptions {
  db: ReconciliationDatabase
  /**
   * Resolves this till's current Shopify client, or `null` when the
   * store URL/token are not configured. Called fresh on every
   * `runCheck`/`guardPush`, never cached across calls - matching how
   * `main/index.ts` already rebuilds the Shopify client on every
   * `pushOrder` call, so a token saved via the Admin screen mid-run
   * takes effect on the very next check, not the next launch.
   */
  getClient: () => AxiosInstance | null
  /** Injectable clock, matching every other engine in this codebase. */
  now?: () => number
  /** Receives every completed run (`ok` true or false) - commit 3's Admin card reads the latest one via this. */
  onResult?: (result: ReconciliationResult) => void
  logger?: Pick<Console, 'warn'>
}

/** What `sync-engine.ts` calls; kept deliberately narrow. */
export interface ReconciliationRunner {
  /** Clears the per-tick lookup cache. Call once at the very start of every `tick()`, whether or not the periodic check runs that tick. */
  beginTick(): void
  /** Runs the periodic check, bounded by `signal`. */
  runCheck(signal: AbortSignal): Promise<{ ok: boolean }>
  /** The pre-push guard for one due queue item. */
  guardPush(item: SyncQueueItem): Promise<GuardDecision>
}

function isoDaysAgo(now: () => number, days: number): string {
  return new Date(now() - days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Creates the reconciliation runner. One instance is built at app
 * startup (`main/index.ts`) and passed into `createSyncEngine` - it
 * owns the lookup cache and the throttle budget across the whole
 * app's lifetime, so a burst of requests late in one tick still
 * benefits from what an earlier tick learned about Shopify's rate
 * limit.
 *
 * @param {ReconciliationRunnerOptions} options
 * @returns {ReconciliationRunner}
 */
export function createReconciliationRunner(options: ReconciliationRunnerOptions): ReconciliationRunner {
  const { db, getClient } = options
  const now = options.now ?? Date.now
  const logger = options.logger ?? console
  const budget = new ThrottleBudget()

  /** This tick's lookups, keyed by client_order_uuid - shared between runCheck and guardPush (docs/phase-168 section 2.4's own "reuse this run's result"). */
  let cache = new Map<string, ServiceResult<ShopifyOrderLookup[]>>()

  async function lookup(
    client: AxiosInstance,
    uuid: string,
    signal: AbortSignal
  ): Promise<ServiceResult<ShopifyOrderLookup[]>> {
    const cached = cache.get(uuid)
    if (cached) return cached
    const result = await findBySourceIdentifier(client, uuid, budget, signal, logger)
    cache.set(uuid, result)
    return result
  }

  return {
    beginTick(): void {
      cache = new Map()
    },

    async runCheck(signal: AbortSignal): Promise<{ ok: boolean }> {
      const client = getClient()
      if (!client) {
        options.onResult?.({
          checkedAt: now(),
          ok: false,
          failureReason: CREDENTIALS_MISSING_MESSAGE,
          findings: [],
          otherTillsCount: null
        })
        return { ok: false }
      }

      const scopeCheck = await checkScopes(client, budget, signal, logger)
      if (!scopeCheck.success || !scopeCheck.data) {
        const result: ReconciliationResult = {
          checkedAt: now(),
          ok: false,
          failureReason: scopeCheck.error ?? 'Could not check Shopify permissions',
          findings: [],
          otherTillsCount: null
        }
        options.onResult?.(result)
        return { ok: false }
      }
      if (!scopeCheck.data.ready) {
        const result: ReconciliationResult = {
          checkedAt: now(),
          ok: false,
          failureReason:
            'This till is not allowed to read Shopify orders - ask whoever manages the Shopify app to add the read_orders permission.',
          findings: [],
          otherTillsCount: null
        }
        options.onResult?.(result)
        return { ok: false }
      }

      const sinceIso = isoDaysAgo(now, RECONCILIATION_WINDOW_DAYS)
      const candidates = db.getReconciliationCandidates(sinceIso)
      const findings: ReconciliationFinding[] = []
      let synchedCount = 0

      for (const candidate of candidates) {
        if (signal.aborted) return finish(false, 'Timed out checking Shopify')

        if (candidate.status === 'pending_sync' || candidate.status === 'failed') {
          const found = await lookup(client, candidate.client_order_uuid, signal)
          if (!found.success || !found.data) continue // reported, if it matters, via the guard next tick; the periodic check does not fail outright on one candidate's lookup

          const classification = classifyOrderMatches(found.data)
          if (classification.kind === 'none') continue // leave for the normal push
          if (classification.kind === 'one' && !classification.order.cancelledAt) {
            const { linked } = db.linkOrderToShopify(candidate.local_id, classification.order.id)
            if (linked) {
              findings.push({
                kind: 'linked',
                localId: candidate.local_id,
                shopifyOrderId: classification.order.id,
                shopifyName: classification.order.name
              })
            }
          } else if (classification.kind === 'one') {
            findings.push({ kind: 'held-cancelled', localId: candidate.local_id, shopifyId: classification.order.id })
          } else {
            findings.push({
              kind: 'duplicate',
              localId: candidate.local_id,
              shopifyIds: classification.orders.map((o) => o.id),
              shopifyNames: classification.orders.map((o) => o.name)
            })
          }
        } else if (candidate.status === 'synced' && candidate.shopify_order_id) {
          synchedCount++
        }
      }

      // Batch every synced sale's existence check in one pass, after the loop above, rather than one lookup per candidate.
      const syncedIds = candidates
        .filter((c) => c.status === 'synced' && c.shopify_order_id)
        .map((c) => ({ localId: c.local_id, shopifyOrderId: c.shopify_order_id as string }))
      if (syncedIds.length > 0) {
        if (signal.aborted) return finish(false, 'Timed out checking Shopify')
        const existsResult = await existsByIds(
          client,
          syncedIds.map((s) => s.shopifyOrderId),
          budget,
          signal,
          logger
        )
        if (existsResult.success && existsResult.data) {
          for (const { localId, shopifyOrderId } of syncedIds) {
            if (existsResult.data.get(shopifyOrderId) === null) {
              findings.push({ kind: 'missing', localId, shopifyOrderId })
            }
          }
        }
      }

      let otherTillsCount: number | null = null
      if (!signal.aborted) {
        const countResult = await countRecent(client, RECONCILIATION_WINDOW_DAYS, budget, signal, logger, () => new Date(now()))
        if (countResult.success && countResult.data) {
          otherTillsCount = Math.max(0, countResult.data.count - synchedCount)
        }
      }

      return finish(true, undefined, findings, otherTillsCount)

      function finish(
        ok: boolean,
        failureReason?: string,
        finalFindings: ReconciliationFinding[] = findings,
        finalOtherTills: number | null = null
      ): { ok: boolean } {
        const result: ReconciliationResult = {
          checkedAt: now(),
          ok,
          failureReason,
          findings: finalFindings,
          otherTillsCount: finalOtherTills
        }
        options.onResult?.(result)
        return { ok }
      }
    },

    async guardPush(item: SyncQueueItem): Promise<GuardDecision> {
      const marker = db.getShopifyPushMarker(item.entity_id)
      if (!marker || marker.count === 0) return { action: 'push' }

      if (marker.lastPushAt) {
        const elapsed = now() - new Date(marker.lastPushAt).getTime()
        if (elapsed >= 0 && elapsed < RECENT_PUSH_SKIP_MS) {
          return { action: 'hold', reason: 'sent to Shopify moments ago - waiting to see if it already arrived' }
        }
      }

      const clientOrderUuid = item.payload.clientOrderUuid
      if (!clientOrderUuid) return { action: 'push' } // should never happen; fail open rather than hold forever on a malformed payload

      const client = getClient()
      if (!client) return { action: 'hold', reason: CREDENTIALS_MISSING_MESSAGE }

      // A short, bounded lookup of its own - independent of, and much
      // smaller than, the periodic check's 45 s overall budget, since
      // the guard runs inline in the push loop and must not stall it
      // for long.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)
      let result: ServiceResult<ShopifyOrderLookup[]>
      try {
        result = await lookup(client, clientOrderUuid, controller.signal)
      } finally {
        clearTimeout(timer)
      }

      if (!result.success || !result.data) {
        // Offline, timed out, scope missing - never push blind (docs/phase-168 section 2.4).
        return { action: 'hold', reason: result.error ?? 'could not check whether this sale is already in Shopify' }
      }

      const classification = classifyOrderMatches(result.data)
      if (classification.kind === 'none') return { action: 'push' }
      if (classification.kind === 'one' && !classification.order.cancelledAt) {
        const { linked } = db.linkOrderToShopify(item.entity_id, classification.order.id)
        return linked
          ? { action: 'linked', shopifyOrderId: classification.order.id }
          : { action: 'hold', reason: 'already moved on locally' }
      }
      return {
        action: 'hold',
        reason: classification.kind === 'many' ? 'more than one matching order found in Shopify' : 'the only matching order is cancelled'
      }
    }
  }
}
