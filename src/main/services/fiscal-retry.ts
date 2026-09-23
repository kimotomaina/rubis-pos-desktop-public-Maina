/**
 * The shared "is this attempt safe to make?" gate for resubmitting a
 * sale's fiscal request — used by both `fiscal-engine.ts`'s
 * queue-draining `tick()` and the manual resend entry point (phase-76,
 * Part C), so Rule 1 (never file a tax invoice twice) holds no matter
 * which caller resubmits, including a race between the two.
 *
 * Three, complementary safeguards:
 *
 *   0. A voided order is refused outright, with no device call and
 *      before any other check (phase-131) — a sale that no longer
 *      exists must never be filed, whatever its fiscal state.
 *   1. Before making any device call, re-check the order's CURRENT
 *      `fiscal_status`. If it's already `'fiscalized'` — because the
 *      other caller won a race, or this is a resend of an
 *      already-settled sale — this returns that stored result directly,
 *      with NO device call. Cheap, local, and closes the race window
 *      between "decide to resubmit" and "actually resubmit".
 *   2. Otherwise, the resubmission is tagged `isRetry: true` on the
 *      request, which lets `RealFiscalizationProvider` recover an
 *      already-filed-but-unacknowledged sale via `ReadCUinvoiceNumber`
 *      instead of risking a second filing (see
 *      `real-etims-provider.ts#submitInvoice`'s `request.isRetry`
 *      branch) — VERIFY-ON-DEVICE, no live duplicate has ever been
 *      captured.
 */

import type { FiscalResendResult, FiscalStatus } from './database.js'
import type { FiscalFailureKind, FiscalInvoiceRequest, FiscalSubmitOutcome } from './integrations/etims.js'
import type { Logger } from './logger.js'
import { routeFiscalOutcome } from './fiscal-routing.js'

/** Why a voided sale is never resubmitted to the fiscal device. */
export const VOIDED_ORDER_NOT_FILED_REASON = 'This sale was voided and will not be filed with KRA.'

/** The order fields `attemptFiscalRetry` needs to read before resubmitting. */
export interface FiscalRetryOrder {
  /** The order's lifecycle status. Optional so fakes that predate the void guard still fit. */
  status?: string
  fiscal_status: FiscalStatus | null
  fiscal_invoice_number: string | null
  fiscal_qr_code: string | null
  fiscal_fiscalized_at: string | null
}

/** Structural slice of {@link RubisDatabase} `attemptFiscalRetry` depends on. */
export interface FiscalRetryDb {
  getOrder(localId: number): FiscalRetryOrder | undefined
}

/** Structural slice of {@link FiscalizationProvider} `attemptFiscalRetry` depends on. */
export interface FiscalRetryProvider {
  submitInvoice(request: FiscalInvoiceRequest): Promise<FiscalSubmitOutcome>
}

/**
 * Resubmits one sale's stored fiscal request as a retry or manual
 * resend. Safe to call on an order in any state — see the file doc
 * above for the two safeguards. Callers remain responsible for writing
 * the outcome to the order row and for any queue-specific bookkeeping
 * (e.g. `fiscal-engine.ts` still owns `markFiscalQueueItemSynced`/
 * `recordFiscalQueueFailure` for its own `sync_queue` rows) — this
 * function only decides whether, and how, to resubmit.
 */
export async function attemptFiscalRetry(
  deps: { db: FiscalRetryDb; fiscalizationProvider: FiscalRetryProvider },
  localId: number,
  request: FiscalInvoiceRequest
): Promise<FiscalSubmitOutcome> {
  const order = deps.db.getOrder(localId)
  // Before the fiscalized short-circuit: a voided sale is refused whatever
  // its fiscal state, so no resubmission route can ever file it.
  if (order?.status === 'voided') {
    return {
      ok: false,
      reason: VOIDED_ORDER_NOT_FILED_REASON,
      kind: 'system',
      retryable: false
    }
  }
  if (order?.fiscal_status === 'fiscalized') {
    return {
      ok: true,
      data: {
        invoiceNumber: order.fiscal_invoice_number ?? '',
        qrCode: order.fiscal_qr_code ?? '',
        fiscalizedAt: order.fiscal_fiscalized_at ?? new Date().toISOString()
      }
    }
  }

  return deps.fiscalizationProvider.submitInvoice({ ...request, isRetry: true })
}

/**
 * The order fields `resendFiscalization`/`buildFiscalResendResult` need,
 * on top of what `attemptFiscalRetry` reads. `fiscal_error_reason`/
 * `fiscal_error_kind` are only needed for reporting the resend's outcome
 * back to a caller (`buildFiscalResendResult`), not for the resend
 * decision itself.
 */
export interface FiscalResendOrder extends FiscalRetryOrder {
  fiscal_request_json: string | null
  fiscal_error_reason: string | null
  fiscal_error_kind: FiscalFailureKind | null
}

/** Structural slice of {@link RubisDatabase} `resendFiscalization` depends on. */
export interface FiscalResendDb extends FiscalRetryDb {
  getOrder(localId: number): FiscalResendOrder | undefined
  setOrderFiscalInfo(localId: number, invoiceNumber: string, qrCode: string): void
  setOrderFiscalFailure(
    localId: number,
    status: Exclude<FiscalStatus, 'fiscalized'>,
    reason: string,
    kind: FiscalFailureKind,
    dataIssue?: 'wrong-pin' | null
  ): void
  queueFiscalInvoice(localId: number, request: FiscalInvoiceRequest): { queueId: number }
  /** Needed only by `correctPinAndResend`, to rewrite the stored request with a corrected/removed PIN. */
  setOrderFiscalRequest(localId: number, request: FiscalInvoiceRequest): void
}

/**
 * Manually resends one order's fiscalization by `localId` — the
 * function Step 3 (cashier notice) and Step 4 (back-office list) will
 * call. Safe to call on an order in ANY state:
 *
 *   - `'fiscalized'` → no-op success, no device call (delegated entirely
 *     to `attemptFiscalRetry`'s own safeguard once a stored request
 *     exists to check against — but this function also short-circuits
 *     earlier, before even looking for one, since a fiscalized order's
 *     result is already fully known).
 *   - `'needs_fixing'` / `'waiting'` → re-attempts, using the order's
 *     STORED request (`fiscal_request_json`, phase-76) — never a freshly
 *     rebuilt one, so a resend can't accidentally submit different data
 *     than what the sale actually recorded.
 *   - no order, or no stored request yet (fiscalization was never
 *     attempted) → reports a clean failure; nothing to resend.
 *
 * Goes through the same `attemptFiscalRetry` gate `fiscal-engine.ts`
 * uses, so Part B's device-side recovery and the already-fiscalized
 * race guard both apply here too — there is exactly one "resubmit a
 * sale" code path, not two.
 */
export async function resendFiscalization(
  deps: { db: FiscalResendDb; fiscalizationProvider: FiscalRetryProvider; logger?: Logger },
  localId: number
): Promise<FiscalSubmitOutcome> {
  const logger = deps.logger ?? console
  const order = deps.db.getOrder(localId)
  if (!order) {
    logger.error(`[rubis-pos] Sale ${localId}: resend requested but no such order exists`)
    return {
      ok: false,
      reason: `No order found for local id ${localId}`,
      kind: 'system',
      retryable: false
    }
  }
  if (order.fiscal_status === 'fiscalized') {
    logger.log(`[rubis-pos] Sale ${localId}: resend requested but the sale is already fiscalized — no device call made`)
    return {
      ok: true,
      data: {
        invoiceNumber: order.fiscal_invoice_number ?? '',
        qrCode: order.fiscal_qr_code ?? '',
        fiscalizedAt: order.fiscal_fiscalized_at ?? new Date().toISOString()
      }
    }
  }
  if (!order.fiscal_request_json) {
    logger.warn(`[rubis-pos] Sale ${localId}: resend requested but there is no stored fiscal request to resend`)
    return {
      ok: false,
      reason: `No stored fiscal request for local id ${localId} — nothing to resend`,
      kind: 'system',
      retryable: false
    }
  }

  const storedRequest = JSON.parse(order.fiscal_request_json) as FiscalInvoiceRequest
  const outcome = await attemptFiscalRetry(deps, localId, storedRequest)

  if (outcome.ok) {
    deps.db.setOrderFiscalInfo(localId, outcome.data.invoiceNumber, outcome.data.qrCode)
    logger.log(`[rubis-pos] Sale ${localId}: resent, fiscalized (invoice ${outcome.data.invoiceNumber})`)
  } else {
    const { status, enqueue } = routeFiscalOutcome(outcome)
    deps.db.setOrderFiscalFailure(localId, status, outcome.reason, outcome.kind, outcome.dataIssue ?? null)
    if (enqueue) {
      // Still retryable (e.g. the device is unreachable again right
      // now) — hand it back to the background queue rather than
      // silently dropping it (Rule 3: never silently lose an
      // unfiscalized sale).
      deps.db.queueFiscalInvoice(localId, storedRequest)
      logger.log(`[rubis-pos] Sale ${localId}: resend still failing, re-queued for retry — ${outcome.reason}`)
    } else if (outcome.kind === 'system') {
      logger.error(`[rubis-pos] Sale ${localId}: resend failed with a system error, flagged for support — ${outcome.reason}`)
    } else {
      logger.warn(`[rubis-pos] Sale ${localId}: resend rejected, still flagged for correction — ${outcome.reason}`)
    }
  }

  return outcome
}

/**
 * Corrects (or removes) the buyer PIN on a sale's STORED fiscal
 * request — updating ONLY `buyerPin`, nothing else about the request —
 * then resends through {@link resendFiscalization}, the same guarded
 * path `fiscal-engine.ts` and every other resend go through. This is
 * the wrong-PIN fix-and-resend the till offers (phase-78, Part C).
 *
 * Never builds a new submit path: correcting the PIN is purely a
 * targeted rewrite of the already-stored request, so Rule 1 (never
 * file twice) and Part B's device-side recovery keep holding exactly
 * as they do for any other resend.
 *
 * `buyerPin: undefined` removes the PIN (a walk-in B2C sale is valid
 * with no PIN); passing a non-blank string corrects it. Format
 * validation is the caller's job (the renderer reuses
 * `isValidKraPinFormat` before ever calling this) — `submitInvoice`'s
 * own pre-send validation is the last-resort backstop either way.
 */
export async function correctPinAndResend(
  deps: { db: FiscalResendDb; fiscalizationProvider: FiscalRetryProvider; logger?: Logger },
  localId: number,
  buyerPin: string | undefined
): Promise<FiscalSubmitOutcome> {
  const logger = deps.logger ?? console
  const order = deps.db.getOrder(localId)
  if (order?.fiscal_request_json) {
    const storedRequest = JSON.parse(order.fiscal_request_json) as FiscalInvoiceRequest
    deps.db.setOrderFiscalRequest(localId, { ...storedRequest, buyerPin })
    logger.log(`[rubis-pos] Sale ${localId}: buyer PIN ${buyerPin ? 'corrected' : 'removed'}, resending`)
  }
  // No stored request (or no order at all) — nothing to correct;
  // `resendFiscalization` reports the same clean failure it always
  // does for that case, so it stays the single source of truth for it.

  return resendFiscalization(deps, localId)
}

/**
 * Builds the fiscal-outcome shape an IPC caller hands back to the
 * renderer after a resend — reads the order back from the database
 * (same "reflect what was actually persisted" pattern
 * `checkout.ts#runCheckout` uses) rather than hand-tracking the
 * outcome, and folds in `dataIssue` from THIS attempt's in-memory
 * `outcome` (never persisted — see `CheckoutReceipt.fiscalDataIssue`'s
 * own doc for why).
 */
export function buildFiscalResendResult(
  db: Pick<FiscalResendDb, 'getOrder'>,
  localId: number,
  outcome: FiscalSubmitOutcome
): FiscalResendResult {
  const order = db.getOrder(localId)
  return {
    localId,
    fiscal: outcome.ok ? { invoiceNumber: outcome.data.invoiceNumber, qrCode: outcome.data.qrCode } : undefined,
    fiscalStatus: order?.fiscal_status ?? null,
    fiscalErrorReason: order?.fiscal_error_reason ?? null,
    fiscalErrorKind: order?.fiscal_error_kind ?? null,
    fiscalDataIssue: !outcome.ok ? (outcome.dataIssue ?? null) : null
  }
}
