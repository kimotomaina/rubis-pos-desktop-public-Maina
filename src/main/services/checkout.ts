/**
 * Checkout orchestration (phase-73).
 *
 * Extracted, behavior-preserving, from `main/index.ts`'s `orders:checkout`
 * IPC handler — everything the till does once a checkout payload has
 * already passed schema validation: the staff check, the mock-mode
 * M-Pesa manual-code check, persisting the order, kicking the Shopify
 * sync engine, and the whole fiscalization block (submit → route via
 * `fiscal-routing.ts` → write status → enqueue-or-not → the
 * thrown-exception fallback). Kept free of Electron/IPC and with every
 * dependency injected specifically so it can be driven directly by a
 * test with a real in-memory database instead of being re-encoded as a
 * test-local mirror (see `docs/phase-72.md`'s audit for why the old
 * shape was untestable, and `docs/phase-73.md` for this extraction).
 *
 * The four rules this function must never break:
 *   1. Never file a tax invoice twice for one sale.
 *   2. Never print anything that looks like a valid tax receipt for an
 *      unfiscalized sale.
 *   3. Never silently lose a completed-but-unfiscalized sale.
 *   4. Never block the till — the sale always completes for the
 *      customer (the final `return` below is unconditional).
 */

import type {
  CheckoutReceipt,
  CheckoutRequest,
  FiscalStatus,
  OrderRow,
  QueueOrderInput,
  ShiftRow,
  StaffRow
} from './database.js'
import type {
  FiscalFailureKind,
  FiscalInvoiceRequest,
  FiscalSubmitOutcome
} from './integrations/etims.js'
import type { ManualCodeVerification, ManualCodeVerificationResult } from './integrations/mpesa.js'
import type { ServiceResult } from './shopify-types.js'
import type { Logger } from './logger.js'
import { routeFiscalOutcome, classifyThrownFiscalError } from './fiscal-routing.js'

/**
 * Structural slice of {@link RubisDatabase} `runCheckout` depends on.
 * Unit tests supply the real `RubisDatabase` (or a fake with the same
 * shape) rather than a hand-rolled recording of these calls.
 */
export interface CheckoutDb {
  getStaffById(id: number): StaffRow | undefined
  getOpenShift(): ShiftRow | undefined
  queueOrder(input: QueueOrderInput): { localId: number; queueId: number }
  getOrder(localId: number): OrderRow | undefined
  setOrderFiscalInfo(localId: number, invoiceNumber: string, qrCode: string): void
  setOrderFiscalFailure(
    localId: number,
    status: Exclude<FiscalStatus, 'fiscalized'>,
    reason: string,
    kind: FiscalFailureKind,
    dataIssue?: 'wrong-pin' | null
  ): void
  queueFiscalInvoice(localId: number, request: FiscalInvoiceRequest): { queueId: number }
  /** Stores the request just attempted, so a later manual resend (phase-76) has it to resubmit. */
  setOrderFiscalRequest(localId: number, request: FiscalInvoiceRequest): void
}

/** Structural slice of {@link MpesaProvider} `runCheckout` depends on. */
export interface CheckoutMpesaProvider {
  verifyTransactionCode(
    input: ManualCodeVerification
  ): Promise<ServiceResult<ManualCodeVerificationResult>>
}

/** Structural slice of {@link FiscalizationProvider} `runCheckout` depends on. */
export interface CheckoutFiscalizationProvider {
  submitInvoice(request: FiscalInvoiceRequest): Promise<FiscalSubmitOutcome>
}

/** Structural slice of {@link FiscalEngine} `runCheckout` depends on. */
export interface CheckoutFiscalEngine {
  onCheckoutMade(): void
}

/** Structural slice of {@link NetworkMonitor} `runCheckout` depends on. */
export interface CheckoutMonitor {
  isOnline(): boolean
}

/** @deprecated Use {@link Logger} from `./logger.js` directly — kept as an alias so existing imports don't churn. */
export type CheckoutLogger = Logger

/**
 * Every dependency {@link runCheckout} needs. All injected — including
 * `taxRate` and `logger`, which the original IPC handler closed over
 * instead — so the function has no hidden ties to Electron, a specific
 * `printerSettings` object, or the global `console`.
 */
export interface RunCheckoutDeps {
  db: CheckoutDb
  mpesaProvider: CheckoutMpesaProvider
  fiscalizationProvider: CheckoutFiscalizationProvider
  fiscalEngine: CheckoutFiscalEngine
  monitor: CheckoutMonitor
  /** Kicks the Shopify sync engine's tick — fire-and-forget, same as the original inline call. */
  engineTick: () => Promise<void>
  /** Generates the order's `clientOrderUuid` (`randomUUID` in production). */
  idGen: () => string
  /** VAT rate applied to every fiscal line and the invoice total (`printerSettings.taxRate` in production). */
  taxRate: number
  /** Gates the mock-mode M-Pesa manual-code check, exactly as the handler's closed-over flag did. */
  mockMpesaEnabled: boolean
  logger: CheckoutLogger
  /**
   * Gates the per-sale, non-essential chatter (the Shopify sync-tick
   * completion line) that has no diagnostic value once the feature is
   * known to work — off by default so a normal sale logs nothing but
   * its fiscal outcome (phase-80). Flip on via `FISCAL_DEBUG_LOGGING=true`
   * when tracing a live issue.
   */
  debugLogging: boolean
}

/** Builds the fiscal invoice request from a checkout, identically on the happy path and the exception-fallback rebuild. */
function buildFiscalRequest(
  input: CheckoutRequest,
  clientOrderUuid: string,
  localId: number,
  taxRate: number
): FiscalInvoiceRequest {
  return {
    clientOrderUuid,
    localId,
    items: input.items.map((item) => ({
      description: item.title,
      quantity: item.quantity,
      unitPrice: item.price,
      taxRate,
      pluCode: item.id,
      // VAT class / HS classification come from the Shopify variant's
      // `rubis` metafields (`vat_class`, `hs_code`, `hs_name`) when the
      // cart carried them through; otherwise this defaults to the
      // standard 16% VAT class with no HS classification.
      vatClass: item.vatClass || 'A',
      hsCode: item.hsCode || '',
      hsName: item.hsName || ''
    })),
    total: input.total,
    taxAmount: input.total * taxRate,
    paymentMethod: input.paymentMethod,
    amountTendered: input.tenderedAmount,
    buyerPin: input.customerPin,
    companyName: input.companyName
  }
}

/**
 * Runs a fully-validated checkout: persists the sale, attempts an
 * immediate Shopify sync, then attempts fiscalization — routing a
 * failure to `waiting`/`needs_fixing` via `fiscal-routing.ts` and
 * queuing it for retry only when appropriate. Always resolves
 * `{ success: true }` once the order is persisted (Rule 4) — a
 * fiscalization failure, of any kind, never surfaces as a checkout
 * error.
 */
export async function runCheckout(
  deps: RunCheckoutDeps,
  input: CheckoutRequest
): Promise<ServiceResult<CheckoutReceipt>> {
  const {
    db,
    mpesaProvider,
    fiscalizationProvider,
    fiscalEngine,
    monitor,
    engineTick,
    idGen,
    taxRate,
    mockMpesaEnabled,
    logger,
    debugLogging
  } = deps

  // Hoisted so the outer catch (below) can still say which sale failed
  // when the throw happens after the order was queued — logging only,
  // never read for control flow.
  let localId: number | undefined

  try {
    const { items, total } = input

    const staff = db.getStaffById(input.staffId)
    if (!staff) {
      return { success: false, error: 'No staff member is logged in' }
    }

    /**
     * When paying by M-Pesa manual code entry (a reference number was
     * captured at the till rather than via a completed STK Push), the
     * code is verified before the order is persisted — an unverified
     * code should never reach the ledger as a completed sale.
     */
    if (mockMpesaEnabled && input.paymentMethod === 'mpesa' && input.referenceNumber) {
      const verification = await mpesaProvider.verifyTransactionCode({
        transactionCode: input.referenceNumber,
        amount: total
      })
      if (!verification.success) {
        return { success: false, error: verification.error ?? 'M-Pesa verification failed' }
      }
      if (!verification.data?.verified) {
        return {
          success: false,
          error: verification.data?.reason ?? 'M-Pesa transaction code could not be verified'
        }
      }
    }

    const openShift = db.getOpenShift()
    const clientOrderUuid = idGen()

    localId = db.queueOrder({
      items,
      total,
      clientOrderUuid,
      staffId: staff.id,
      staffName: staff.name,
      paymentMethod: input.paymentMethod,
      tenderedAmount: input.tenderedAmount,
      changeDue: input.changeDue,
      referenceNumber: input.referenceNumber,
      shiftId: openShift?.id,
      customerPin: input.customerPin,
      cartDiscount: input.cartDiscount
    }).localId

    if (monitor.isOnline()) {
      void engineTick()
        .then(() => {
          if (debugLogging) {
            logger.log(`[rubis-pos] checkout: background Shopify sync tick finished for order ${localId}`)
          }
        })
        .catch((tickError) => {
          logger.error(`[rubis-pos] Sale ${localId}: Shopify sync tick failed:`, tickError)
        })
    }

    const order = db.getOrder(localId)
    const synced = order?.status === 'synced'

    /**
     * Fiscalization never blocks the sale — the cash/stock side of
     * the transaction is already committed. An immediate failure
     * (device unreachable, rejected request, or an unexpected
     * throw) queues the same request in `sync_queue` for
     * `fiscalEngine` to retry in the background instead of losing
     * it, mirroring how a failed Shopify push falls back to
     * `sync_queue` above rather than failing checkout.
     */
    let fiscal: CheckoutReceipt['fiscal']
    let fiscalDataIssue: CheckoutReceipt['fiscalDataIssue'] = null
    let fiscalRequest: FiscalInvoiceRequest | undefined
    try {
      fiscalRequest = buildFiscalRequest(input, clientOrderUuid, localId, taxRate)
      // Stored regardless of outcome — a manual resend (phase-76) needs
      // the sale's original request even if this attempt fails.
      db.setOrderFiscalRequest(localId, fiscalRequest)

      const invoice = await fiscalizationProvider.submitInvoice(fiscalRequest)

      if (invoice.ok) {
        fiscal = { invoiceNumber: invoice.data.invoiceNumber, qrCode: invoice.data.qrCode }
        db.setOrderFiscalInfo(localId, invoice.data.invoiceNumber, invoice.data.qrCode)
      } else {
        const { status, enqueue } = routeFiscalOutcome(invoice)
        if (enqueue) {
          logger.log(`[rubis-pos] Sale ${localId}: fiscalization failed, queued for retry — ${invoice.reason}`)
        } else if (invoice.kind === 'system') {
          logger.error(
            `[rubis-pos] Sale ${localId}: fiscalization failed with a system error, flagged for support — ${invoice.reason}`
          )
        } else {
          logger.warn(
            `[rubis-pos] Sale ${localId}: fiscalization rejected, flagged for correction — ${invoice.reason}`
          )
        }
        // Persisted (phase-88/Step 4) so the back-office list can
        // recognize a fixable rejection later, not just at this attempt.
        db.setOrderFiscalFailure(localId, status, invoice.reason, invoice.kind, invoice.dataIssue ?? null)
        fiscalDataIssue = invoice.dataIssue ?? null
        if (enqueue) {
          db.queueFiscalInvoice(localId, fiscalRequest)
          fiscalEngine.onCheckoutMade()
        }
      }
    } catch (fiscalError) {
      logger.error(`[rubis-pos] Sale ${localId}: fiscalization threw an unhandled exception:`, fiscalError)

      // An unclassified exception (a bug, not a device-reported
      // rejection) is treated the same as a transient/technical
      // failure — keep retrying, don't flag it as a data problem the
      // sale can't fix. The existing ABANDONED-after-10-attempts
      // backoff (`recordFiscalQueueFailure`) is the backstop against
      // an endless loop if it's genuinely unrecoverable.
      const { reason, kind } = classifyThrownFiscalError(fiscalError)
      try {
        const requestToQueue = fiscalRequest ?? buildFiscalRequest(input, clientOrderUuid, localId, taxRate)
        // Only reached here (rather than already having run above) when
        // the throw happened while building the request itself, before
        // it could be stored.
        if (!fiscalRequest) {
          db.setOrderFiscalRequest(localId, requestToQueue)
        }
        db.setOrderFiscalFailure(localId, 'waiting', reason, kind)
        db.queueFiscalInvoice(localId, requestToQueue)
        fiscalEngine.onCheckoutMade()
      } catch (queueError) {
        logger.error(`[rubis-pos] Sale ${localId}: fallback fiscal queue write also failed:`, queueError)
      }
    }

    // Read back rather than hand-tracked through the branches above —
    // guarantees this always reflects what was actually persisted,
    // including the rare double-failure edge where even the
    // exception-fallback DB write didn't run (see that `catch` above).
    const finalOrder = db.getOrder(localId)

    return {
      success: true,
      data: {
        localId,
        mode: synced ? 'synced' : 'queued-offline',
        shopifyOrderId: synced ? (order?.shopify_order_id ?? undefined) : undefined,
        fiscal,
        fiscalStatus: finalOrder?.fiscal_status ?? null,
        fiscalErrorReason: finalOrder?.fiscal_error_reason ?? null,
        fiscalErrorKind: finalOrder?.fiscal_error_kind ?? null,
        fiscalDataIssue
      }
    }
  } catch (err) {
    logger.error(
      `[rubis-pos] checkout: unhandled exception${localId !== undefined ? ` (sale ${localId})` : ''}:`,
      err
    )
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to record checkout'
    }
  }
}
