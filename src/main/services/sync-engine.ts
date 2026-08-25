/**
 * Sync engine (Phase 3 — Offline Mode).
 *
 * Background worker that drains the SQLite `sync_queue` by pushing
 * queued offline orders to Shopify.  Exactly three triggers exist
 * (per the Phase 3 plan, decision Q2):
 *
 *   (a) immediately after a checkout,
 *   (b) every `intervalMs` (default 30 s),
 *   (c) immediately when connectivity flips offline → online.
 *
 * Failures are recorded with exponential backoff by the database
 * service; the engine itself is stateless apart from its timer and a
 * re-entrancy guard.
 */

import type { OfflineOrderPayload, ServiceResult } from './shopify-types.js'
import type { SyncQueueItem } from './database.js'
import type { OrderCreateResult } from './orders.js'

/**
 * Structural slice of {@link RubisDatabase} the engine depends on.
 * Unit tests supply a fake with the same shape.
 */
export interface SyncEngineDatabase {
  getPendingSyncQueue(now: number): SyncQueueItem[]
  markQueueItemSynced(queueId: number, shopifyOrderId: string): void
  recordQueueFailure(queueId: number, error: string): { exhausted: boolean }
}

/** Function that pushes one payload; injected so tests can stub it. */
export type PushOrderFn = (
  payload: OfflineOrderPayload
) => Promise<ServiceResult<OrderCreateResult>>

/** Dependencies for {@link createSyncEngine}. */
export interface SyncEngineOptions {
  db: SyncEngineDatabase
  isOnline: () => boolean
  pushOrder: PushOrderFn
  /** Poll interval in milliseconds (default 30 s). */
  intervalMs?: number
  /** Injectable clock for tests. */
  now?: () => number
}

/** Handle returned by {@link createSyncEngine}. */
export interface SyncEngine {
  /** Starts the interval timer and runs an immediate tick. */
  start(): void
  /** Stops the interval timer. */
  stop(): void
  /** Runs one sync pass; concurrent calls coalesce. */
  tick(): Promise<void>
  /** Called on offline → online transitions (trigger c). */
  notifyOnline(): void
  /** Called right after a checkout is queued (trigger a). */
  onCheckoutMade(): void
}

/**
 * Creates the sync engine.
 *
 * @param {SyncEngineOptions} options
 * @returns {SyncEngine}
 */
export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { db, isOnline, pushOrder } = options
  const intervalMs = options.intervalMs ?? 30_000
  const now = options.now ?? Date.now

  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  /**
   * One sync pass: fetches due queue items and, while online, pushes
   * each one in order — marking successes synced and scheduling
   * backoff on failures.
   */
  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      if (!isOnline()) return

      const pending = db.getPendingSyncQueue(now())
      for (const item of pending) {
        if (!isOnline()) break

        const result = await pushOrder(item.payload)

        if (result.success && result.data) {
          db.markQueueItemSynced(item.id, result.data.shopifyOrderId)
        } else {
          db.recordQueueFailure(item.id, result.error ?? 'Unknown sync error')
        }
      }
    } finally {
      running = false
    }
  }

  return {
    start(): void {
      if (timer) return
      timer = setInterval(() => void tick(), intervalMs)
      void tick()
    },

    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },

    tick,

    notifyOnline(): void {
      void tick()
    },

    onCheckoutMade(): void {
      void tick()
    }
  }
}
