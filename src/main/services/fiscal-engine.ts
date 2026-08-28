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
 * Failures are recorded with exponential backoff by the database
 * service; an exhausted item is left in the queue (not deleted) for
 * manual inspection — see `RubisDatabase.recordFiscalQueueFailure`.
 */

import type { ServiceResult } from './shopify-types.js'
import type { FiscalQueueItem } from './database.js'
import type { FiscalInvoiceRequest, FiscalInvoiceResult } from './integrations/etims.js'

/**
 * Structural slice of {@link RubisDatabase} the engine depends on.
 * Unit tests supply a fake with the same shape.
 */
export interface FiscalEngineDatabase {
  getPendingFiscalQueue(now: number): FiscalQueueItem[]
  markFiscalQueueItemSynced(queueId: number, invoiceNumber: string, qrCode: string): void
  recordFiscalQueueFailure(queueId: number, error: string): { exhausted: boolean }
}

/** Function that resubmits one invoice; injected so tests can stub it. */
export type SubmitInvoiceFn = (
  request: FiscalInvoiceRequest
) => Promise<ServiceResult<FiscalInvoiceResult>>

/** Dependencies for {@link createFiscalEngine}. */
export interface FiscalEngineOptions {
  db: FiscalEngineDatabase
  submitInvoice: SubmitInvoiceFn
  /** Poll interval in milliseconds (default 30 s). */
  intervalMs?: number
  /** Injectable clock for tests. */
  now?: () => number
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
        const result = await submitInvoice(item.payload)

        if (result.success && result.data) {
          db.markFiscalQueueItemSynced(item.id, result.data.invoiceNumber, result.data.qrCode)
        } else {
          db.recordFiscalQueueFailure(item.id, result.error ?? 'Unknown fiscalization error')
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
