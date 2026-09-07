/**
 * Fiscalization (eTIMS) engine.
 *
 * Background worker that drains the SQLite `sync_queue`'s
 * `entity_type = 'etims_invoice'` rows by resubmitting them to
 * {@link FiscalizationProvider.submitInvoice}. Mirrors `sync-engine.ts`'s
 * shape deliberately — same trigger set, same re-entrancy guard — but
 * is kept as a separate engine/table scope so the Shopify sync engine
 * never has to know eTIMS retries exist. Three triggers:
 *
 *   (a) immediately after a checkout queues a failed fiscalization,
 *   (b) every `intervalMs` (default 30 s),
 *   (c) immediately when connectivity flips offline → online (a
 *       LAN-local fiscal device isn't actually gated on internet
 *       reachability, but a network transition is a reasonable
 *       "worth checking now" signal and costs nothing extra to wire
 *       up on the same event `sync-engine.ts` already listens for).
 *
 * Unlike the Shopify queue, this engine never gates a pass on being
 * "online" — `net.isOnline()` reflects internet connectivity, not
 * reachability of the LAN-local fiscal device, so gating on it would
 * incorrectly block retries during an internet outage even when the
 * till can still reach the device.
 *
 * A technical/retryable failure is recorded with exponential backoff by
 * the database service; an exhausted item is left in the queue (not
 * deleted) for manual inspection — see
 * `RubisDatabase.recordFiscalQueueFailure`. A retry that comes back
 * non-retryable (`data`/`system` — phase-76, Part C) is reclassified
 * instead: the order moves to `needs_fixing` and its queue row is
 * removed outright, since retrying the identical data again would just
 * fail the same way every time.
 */

import type { FiscalStatus, FiscalQueueItem } from './database.js'
import type { FiscalFailureKind, FiscalInvoiceRequest, FiscalSubmitOutcome } from './integrations/etims.js'
import type { Logger } from './logger.js'
import { attemptFiscalRetry } from './fiscal-retry.js'
import type { FiscalRetryOrder } from './fiscal-retry.js'
import { routeFiscalOutcome } from './fiscal-routing.js'

/**
 * Structural slice of {@link RubisDatabase} the engine depends on.
 * Unit tests supply a fake with the same shape. `getOrder` feeds
 * `attemptFiscalRetry`'s already-fiscalized safety check (phase-75).
 * `setOrderFiscalFailure`/`removeFiscalQueueItem` feed the phase-76
 * retry-reclassification path — see `tick`.
 */
export interface FiscalEngineDatabase {
  getPendingFiscalQueue(now: number): FiscalQueueItem[]
  markFiscalQueueItemSynced(queueId: number, invoiceNumber: string, qrCode: string): void
  recordFiscalQueueFailure(queueId: number, error: string): { exhausted: boolean }
  removeFiscalQueueItem(queueId: number): void
  setOrderFiscalFailure(
    localId: number,
    status: Exclude<FiscalStatus, 'fiscalized'>,
    reason: string,
    kind: FiscalFailureKind,
    dataIssue?: 'wrong-pin' | null
  ): void
  getOrder(localId: number): FiscalRetryOrder | undefined
}

/** Function that resubmits one invoice; injected so tests can stub it. */
export type SubmitInvoiceFn = (request: FiscalInvoiceRequest) => Promise<FiscalSubmitOutcome>

/** Dependencies for {@link createFiscalEngine}. */
export interface FiscalEngineOptions {
  db: FiscalEngineDatabase
  submitInvoice: SubmitInvoiceFn
  /** Poll interval in milliseconds (default 30 s). */
  intervalMs?: number
  /** Injectable clock for tests. */
  now?: () => number
  /** Defaults to `console` (phase-80) — every notable retry outcome logs through this, none of it silent. */
  logger?: Logger
}

/** Handle returned by {@link createFiscalEngine}. */
export interface FiscalEngine {
  /** Starts the interval timer and runs an immediate tick. */
  start(): void
  /** Stops the interval timer. */
  stop(): void
  /** Runs one retry pass; concurrent calls coalesce. */
  tick(): Promise<void>
  /** Called on offline → online transitions (trigger c). */
  notifyOnline(): void
  /** Called right after a checkout queues a failed fiscalization (trigger a). */
  onCheckoutMade(): void
}

/**
 * Creates the fiscalization engine.
 *
 * @param {FiscalEngineOptions} options
 * @returns {FiscalEngine}
 */
export function createFiscalEngine(options: FiscalEngineOptions): FiscalEngine {
  const { db, submitInvoice } = options
  const intervalMs = options.intervalMs ?? 30_000
  const now = options.now ?? Date.now
  const logger = options.logger ?? console

  let timer: ReturnType<typeof setInterval> | null = null
  let running = false

  /**
   * One retry pass: fetches due queue items and resubmits each in
   * order, deleting successes (after saving the invoice number/QR
   * code) and scheduling backoff on failures.
   */
  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const pending = db.getPendingFiscalQueue(now())
      for (const item of pending) {
        // Every item in this queue is, by construction, a retry — it
        // only got here because a first attempt already failed. Routing
        // through `attemptFiscalRetry` (phase-75) re-checks the order
        // isn't already `fiscalized` (closes a race with a manual
        // resend) before tagging the resubmission `isRetry: true`, which
        // lets the real provider recover an already-filed-but-lost-reply
        // sale instead of risking a second filing.
        const result = await attemptFiscalRetry({ db, fiscalizationProvider: { submitInvoice } }, item.entity_id, item.payload)

        if (result.ok) {
          db.markFiscalQueueItemSynced(item.id, result.data.invoiceNumber, result.data.qrCode)
          logger.log(
            `[rubis-pos] Sale ${item.entity_id}: queued retry succeeded, fiscalized (invoice ${result.data.invoiceNumber})`
          )
        } else {
          // Every item reaching this queue was originally routed here as
          // a retryable/technical failure (`checkout.ts`'s `runCheckout`
          // never enqueues a `needs_fixing` sale) — but a LATER retry can
          // come back differently: with the device password wrong, for
          // instance, every sale first fails on connectivity and only
          // reveals a genuine data problem once the device is actually
          // reachable. Reusing `routeFiscalOutcome` (not re-encoding it)
          // to decide: still retryable → keep backing off in the queue,
          // same as before this step; non-retryable (data/system) → stop
          // retrying, flag the order for a person, and remove it from
          // the queue outright.
          const { status, enqueue } = routeFiscalOutcome(result)
          if (enqueue) {
            const { exhausted } = db.recordFiscalQueueFailure(item.id, result.reason)
            if (exhausted) {
              logger.warn(
                `[rubis-pos] Sale ${item.entity_id}: retry abandoned after repeated failures, still in the queue for manual attention — ${result.reason}`
              )
            }
          } else {
            db.setOrderFiscalFailure(item.entity_id, status, result.reason, result.kind, result.dataIssue ?? null)
            db.removeFiscalQueueItem(item.id)
            if (result.kind === 'system') {
              logger.error(
                `[rubis-pos] Sale ${item.entity_id}: retry reclassified to needs_fixing with a system error, flagged for support — ${result.reason}`
              )
            } else {
              logger.warn(
                `[rubis-pos] Sale ${item.entity_id}: retry reclassified to needs_fixing, flagged for correction — ${result.reason}`
              )
            }
          }
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
