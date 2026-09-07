/**
 * Polls Daraja's STK Push status on a fixed interval until the
 * payment resolves or a timeout elapses — the renderer-side
 * counterpart to `queryStkPushStatus`, driving `PaymentModal`'s
 * "Waiting for M-Pesa Confirmation" overlay without that component
 * owning timer bookkeeping itself.
 *
 * Kept free of React so it is unit-testable with plain fake timers.
 */

import type { ServiceResult } from '../../../main/services/shopify-types.js'
import type { StkPushStatusResult } from '../../../main/services/integrations/mpesa.js'

/** Interval between STK Push status checks, in milliseconds. */
export const MPESA_POLL_INTERVAL_MS = 5000

/**
 * Total time to keep polling before treating the payment as timed
 * out, in milliseconds. Daraja STK Pushes expire after ~2 minutes;
 * 90s gives the customer time to enter their PIN without leaving the
 * cashier waiting indefinitely.
 */
export const MPESA_POLL_TIMEOUT_MS = 90_000

/** Callbacks driving the UI in response to a poller's progress. */
export interface MpesaPaymentPollerCallbacks {
  /** Called after each inconclusive poll (including a failed status query, treated as still-pending) with the time left before timeout. */
  onPending: (msRemaining: number) => void
  /** Called exactly once, when the payment resolves successfully. */
  onSuccess: (receiptNumber: string | undefined) => void
  /** Called exactly once, when the payment resolves as failed/cancelled. */
  onFailed: (reason: string) => void
  /** Called exactly once, when polling exhausts `timeoutMs` without a definitive result. */
  onTimeout: () => void
}

/** Options accepted by {@link createMpesaPaymentPoller}. */
export interface MpesaPaymentPollerOptions {
  checkoutRequestId: string
  queryStatus: (checkoutRequestId: string) => Promise<ServiceResult<StkPushStatusResult>>
  callbacks: MpesaPaymentPollerCallbacks
  /** Defaults to {@link MPESA_POLL_INTERVAL_MS}. */
  intervalMs?: number
  /** Defaults to {@link MPESA_POLL_TIMEOUT_MS}. */
  timeoutMs?: number
}

/** Handle returned by {@link createMpesaPaymentPoller}. */
export interface MpesaPaymentPoller {
  /** Starts the interval timer. A no-op if already started or already settled. */
  start(): void
  /** Stops the interval timer. Idempotent — safe to call any number of times, including after settling or before `start()`. */
  stop(): void
}

/**
 * Creates a poller for one STK Push's `checkoutRequestId`. Never
 * drives more than one of `onSuccess`/`onFailed`/`onTimeout`, and
 * never after `stop()` — a response that arrives after `stop()` was
 * called (e.g. the cashier cancelled) is discarded. A poll still in
 * flight is never overlapped by the next tick, so a slow response
 * can't produce two concurrent status queries for the same request.
 *
 * @param {MpesaPaymentPollerOptions} options
 * @returns {MpesaPaymentPoller}
 */
export function createMpesaPaymentPoller(options: MpesaPaymentPollerOptions): MpesaPaymentPoller {
  const { checkoutRequestId, queryStatus, callbacks } = options
  const intervalMs = options.intervalMs ?? MPESA_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? MPESA_POLL_TIMEOUT_MS

  let timer: ReturnType<typeof setInterval> | null = null
  let elapsedMs = 0
  let inFlight = false
  let settled = false

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    settled = true
  }

  async function tick(): Promise<void> {
    if (settled || inFlight) return

    elapsedMs += intervalMs
    if (elapsedMs >= timeoutMs) {
      stop()
      callbacks.onTimeout()
      return
    }

    inFlight = true
    try {
      const result = await queryStatus(checkoutRequestId)
      if (settled) return

      if (!result.success || !result.data || result.data.status === 'pending') {
        callbacks.onPending(Math.max(0, timeoutMs - elapsedMs))
        return
      }

      stop()
      if (result.data.status === 'success') {
        callbacks.onSuccess(result.data.receiptNumber)
      } else {
        callbacks.onFailed(result.data.resultDesc ?? 'M-Pesa payment failed or was cancelled')
      }
    } finally {
      inFlight = false
    }
  }

  function start(): void {
    if (timer !== null || settled) return
    timer = setInterval(() => void tick(), intervalMs)
  }

  return { start, stop }
}
