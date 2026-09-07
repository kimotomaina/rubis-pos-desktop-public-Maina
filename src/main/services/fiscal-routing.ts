/**
 * Pure routing rules for a `submitInvoice` outcome — kept separate from
 * `main/index.ts`'s checkout handler (which owns all the actual I/O:
 * writing the order's fiscal status, enqueuing a retry, kicking
 * `fiscalEngine`) so the classification-to-status/queue mapping itself is
 * directly unit-testable without mocking Electron IPC, the database, or
 * the fiscal engine. See `docs/phase-70.md`/`docs/phase-71.md` for the
 * three-state model this implements.
 */

import type { FiscalFailureKind, FiscalSubmitOutcome } from './integrations/etims.js'
import type { FiscalStatus } from './database.js'

/** What to do with a `submitInvoice` outcome. */
export interface FiscalRoutingDecision {
  /** The order's new `fiscal_status`. */
  status: FiscalStatus
  /**
   * Whether to enqueue the request in `sync_queue` for `fiscal-engine.ts`
   * to retry in the background. `false` on success (nothing to retry)
   * and on a non-retryable rejection (retrying identical data is
   * pointless — see {@link FiscalFailureKind}'s doc).
   */
  enqueue: boolean
}

/**
 * Routes a `submitInvoice` outcome to a `fiscal_status` and an
 * enqueue-or-not decision:
 *
 *   - success                → `'fiscalized'`, never enqueued;
 *   - failure, `retryable`   → `'waiting'`, enqueued (the transient/
 *     technical codes 19/30/31/53, and the STE1=52 "opened receipt"
 *     recovery when it's still unresolved after its one-shot retry);
 *   - failure, non-retryable → `'needs_fixing'`, never enqueued — the
 *     device rejected the sale's own data (`kind: 'data'`) or this build
 *     hit a bug/anomaly (`kind: 'system'`). Resubmitting the identical
 *     request would fail again the same way, so looping it in the retry
 *     queue would be pointless and would hide the problem from a person
 *     for hours (see `docs/phase-70.md`'s audit of the pre-existing
 *     attempt-count-only backoff/abandon mechanism).
 *
 * Overloaded so a caller that already knows `outcome.ok` is `false` (the
 * common case — `main/index.ts`'s checkout handler calls this from inside
 * an `else` branch on `invoice.ok`) gets back a return type that
 * statically excludes `'fiscalized'`, matching
 * `RubisDatabase.setOrderFiscalFailure`'s parameter type without a cast.
 *
 * @param {FiscalSubmitOutcome} outcome
 * @returns {FiscalRoutingDecision}
 */
export function routeFiscalOutcome(
  outcome: Extract<FiscalSubmitOutcome, { ok: true }>
): { status: 'fiscalized'; enqueue: false }
export function routeFiscalOutcome(
  outcome: Extract<FiscalSubmitOutcome, { ok: false }>
): { status: Exclude<FiscalStatus, 'fiscalized'>; enqueue: boolean }
export function routeFiscalOutcome(outcome: FiscalSubmitOutcome): FiscalRoutingDecision {
  if (outcome.ok) {
    return { status: 'fiscalized', enqueue: false }
  }
  return { status: outcome.retryable ? 'waiting' : 'needs_fixing', enqueue: outcome.retryable }
}

/**
 * Classifies an unexpected thrown exception from `submitInvoice` (a bug
 * in this build, not a device-reported rejection) the same as a
 * transient/technical failure — worth retrying, not a data problem the
 * sale can't fix. The pre-existing ABANDONED-after-10-attempts backoff
 * (`RubisDatabase.recordFiscalQueueFailure`) is the backstop against an
 * endless loop if it's genuinely unrecoverable.
 *
 * @param {unknown} error
 * @returns {{ reason: string; kind: 'technical' }}
 */
export function classifyThrownFiscalError(error: unknown): {
  reason: string
  kind: Extract<FiscalFailureKind, 'technical'>
} {
  return {
    reason: error instanceof Error ? error.message : String(error),
    kind: 'technical'
  }
}
