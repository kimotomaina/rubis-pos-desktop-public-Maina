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
  CardApproval,
  CheckoutPaymentLeg,
  CheckoutReceipt,
  CheckoutRequest,
  FiscalStatus,
  ManualMpesaApproval,
  MpesaPaymentMode,
  MpesaVerificationStatus,
  OrderRow,
  QueuedOrder,
  QueueOrderInput,
  RecordMpesaPaymentInput,
  ShiftRow,
  StaffRow
} from './database.js'
import type { SalePayment } from '../lib/paymentLegs.js'
import type {
  FiscalFailureKind,
  FiscalInvoiceRequest,
  FiscalInvoiceResult,
  FiscalSubmitOutcome
} from './integrations/etims.js'
import type { ManualCodeVerification, ManualCodeVerificationResult } from './integrations/mpesa.js'
import type { ServiceResult } from './shopify-types.js'
import type { Logger } from './logger.js'
import { routeFiscalOutcome, classifyThrownFiscalError } from './fiscal-routing.js'
import { DEFAULT_VAT_CLASS, resolveVatClass } from '../lib/vatClass.js'
import { findVatClassRefusal } from '../lib/vatClassGate.js'

/**
 * Structural slice of {@link RubisDatabase} `runCheckout` depends on.
 * Unit tests supply the real `RubisDatabase` (or a fake with the same
 * shape) rather than a hand-rolled recording of these calls.
 */
export interface CheckoutDb {
  getStaffById(id: number): StaffRow | undefined
  getOpenShift(): ShiftRow | undefined
  /** The payment gate's confirmation source on a Daraja till — see {@link RubisDatabase.hasConfirmedStkPayment}. */
  hasConfirmedStkPayment(reference: string): boolean
  /** Whether this reference already settled a sale in any mode — the manual route's cross-mode guard. */
  hasRecordedMpesaPayment(reference: string): boolean
  /** Queues the order and spends the confirmation message that paid for it, in one transaction. */
  queueOrderClaimingSmsPayment(
    input: QueueOrderInput,
    claim: { transactionCode: string; staffId: number },
    payment?: RecordMpesaPaymentInput
  ): QueuedOrder | null
  /** Queues the order and records the confirmed payment that settled it, in one transaction. */
  queueOrderRecordingMpesaPayment(input: QueueOrderInput, payment: RecordMpesaPaymentInput): QueuedOrder
  /** Queues the order and records a manually entered, unverified payment, in one transaction. */
  queueOrderRecordingManualPayment(input: QueueOrderInput, payment: RecordMpesaPaymentInput): QueuedOrder | null
  /** Queues a split sale and records each of its M-Pesa payments, in one transaction (docs/phase-252). */
  queueOrderRecordingPayments(input: QueueOrderInput, mpesa: SplitMpesaWrite[]): QueuedOrder | null
  queueOrder(input: QueueOrderInput): QueuedOrder
  getOrder(localId: number): OrderRow | undefined
  /** The order a checkout already made, by its key (docs/phase-249). */
  getOrderByCheckoutKey(checkoutKey: string): OrderRow | undefined
  /** Records the first filing and deletes the sale's fiscal row, in one transaction. Returns `false` when the CU number is refused because another sale holds it (docs/phase-208). */
  settleCheckoutFiscalSuccess(localId: number, fiscalQueueId: number, invoice: FiscalInvoiceResult): boolean | void
  /** Records a failed first filing; `needs_fixing` also deletes the fiscal row, in the same transaction. */
  settleCheckoutFiscalFailure(
    localId: number,
    fiscalQueueId: number,
    status: Exclude<FiscalStatus, 'fiscalized'>,
    reason: string,
    kind: FiscalFailureKind,
    dataIssue?: 'wrong-pin' | null
  ): void
}

/**
 * Shown when an M-Pesa sale is asked to complete without a confirmed
 * payment behind it.
 *
 * Says what is wrong and what to do, because a disabled button with no
 * reason sends a cashier looking for a way around it. No codes, no
 * provider names: the only useful instruction is to wait for the
 * payment to be confirmed.
 */
export const UNCONFIRMED_MPESA_MESSAGE =
  'This M-Pesa payment has not been confirmed yet. Wait for the payment to come through, then complete the sale.'

/**
 * Shown when the payment a sale is trying to use was already spent on
 * another sale between the check and the claim.
 *
 * Rare, and the whole reason the claim is a conditional write rather
 * than bookkeeping: two tills, or two rapid checkouts, can both see the
 * same payment as available before either takes it.
 */
export const MPESA_PAYMENT_ALREADY_USED_MESSAGE =
  'That M-Pesa payment was just used for another sale. Find the customer’s own payment and try again.'

/**
 * The shape of a Safaricom confirmation code: ten uppercase
 * alphanumerics.
 *
 * An allowlist, not a denylist, and checked here in the main process as
 * well as in `checkoutRequestSchema` — the renderer's copy is a courtesy
 * to the cashier, this one is the control. It stops a blank, a single
 * letter, or keyboard mashing from becoming a recorded payment. It
 * proves nothing about whether money moved, and is not asked to.
 */
export const MPESA_MANUAL_CODE_PATTERN = /^[A-Z0-9]{10}$/

/** Shown when a manual code is not shaped like an M-Pesa code at all. */
export const MPESA_MANUAL_CODE_INVALID_MESSAGE =
  'That is not an M-Pesa code. Enter the 10-character code from the customer’s confirmation message.'

/** Shown when manual entry is attempted on a till that has not been allowed it. */
export const MPESA_MANUAL_NOT_ENABLED_MESSAGE =
  'Recording a manually verified M-Pesa payment is not switched on for this till. Ask an administrator to enable it in Admin > Integrations.'

/** Shown when the cashier's attestation is missing (docs/phase-150.md step 3 — a positive statement, not a warning acknowledgement). */
export const MPESA_MANUAL_NOT_ACKNOWLEDGED_MESSAGE =
  'Confirm that you have seen the M-Pesa confirmation message on the customer’s phone before completing the sale.'

/** Shown when a manual code has already been recorded against another sale. */
export const MPESA_MANUAL_CODE_ALREADY_USED_MESSAGE =
  'That M-Pesa code has already been recorded against another sale. Check the customer’s message and try again.'

/**
 * Shown when a card sale arrives with no PDQ reference at all — either
 * `cardApproval` is missing entirely, or its `reference` is blank.
 */
export const CARD_REFERENCE_MISSING_MESSAGE =
  'Enter the reference from the PDQ slip before completing this sale.'

/**
 * The shape of a PDQ slip reference this till accepts: 1 to 12
 * uppercase letters/digits.
 *
 * The 12-character ceiling is a working assumption (docs/phase-176.md
 * Part 2 §1) until Rubis Finance confirms which PDQ slip number this
 * till is meant to reconcile against — not a limit any specific PDQ
 * terminal model is known to produce. Checked here in the main process
 * as well as in `checkoutRequestSchema` — the renderer's copy is a
 * courtesy to the cashier, this one is the control (same reasoning as
 * {@link MPESA_MANUAL_CODE_PATTERN}).
 */
export const CARD_REFERENCE_PATTERN = /^[A-Z0-9]{1,12}$/

/** Shown when a card reference is not shaped like a PDQ slip reference at all. */
export const CARD_REFERENCE_INVALID_MESSAGE =
  'That doesn’t look like a PDQ slip reference. Enter 1-12 letters/numbers from the slip.'

/** Shown when the cashier's attestation that the PDQ slip shows Approved is missing. */
export const CARD_NOT_ACKNOWLEDGED_MESSAGE =
  'Confirm that the PDQ slip shows Approved for this amount before completing the sale.'

/**
 * The `app_configurations` key of the split-payments setting (docs/phase-252, S9): `'true'` turns split payments on;
 * anything else, or no row, is off. Written only through `config:set`, which re-verifies an admin PIN.
 */
export const SPLIT_PAYMENTS_SETTING_KEY = 'split_payments_enabled'

/** The most payments one sale may be split into (docs/phase-252, S1). */
export const MAX_SPLIT_PAYMENTS = 4

/** Shown when a split sale reaches a till whose split setting is off (docs/phase-252, S9); nothing is written. */
export const SPLIT_PAYMENTS_OFF_MESSAGE =
  'Split payments are switched off on this till. Take the whole payment one way, or ask an administrator.'

/** Shown when a request says `split` without its payments, or carries payments without saying `split`. */
export const SPLIT_REQUEST_INVALID_MESSAGE = 'This split payment could not be read, so nothing was recorded. Start the payment again.'

/** Shown when a split sale has fewer than two payments. */
export const SPLIT_TOO_FEW_MESSAGE = 'A split payment needs two or more payments.'

/** Shown when a split sale has more than {@link MAX_SPLIT_PAYMENTS} payments. */
export const SPLIT_TOO_MANY_MESSAGE = `A sale can be split into at most ${MAX_SPLIT_PAYMENTS} payments.`

/** Shown when a split sale has a payment of zero, a negative amount or no amount. */
export const SPLIT_AMOUNT_INVALID_MESSAGE = 'Every payment must be more than 0.'

/** Shown when a split sale has two cash payments. */
export const SPLIT_TWO_CASH_MESSAGE = 'Take cash once only, as the last payment.'

/** Shown when a split sale's cash payment is not the last one. */
export const SPLIT_CASH_NOT_LAST_MESSAGE = 'Cash must be the last payment, because only cash gives change.'

/** Shown when an M-Pesa or card payment is more than what was still due when it was taken. */
export const SPLIT_ABOVE_DUE_MESSAGE =
  'An M-Pesa or card payment cannot be more than the amount still due. Only cash gives change.'

/** Shown when the cash handed over is less than the cash payment. */
export const SPLIT_CASH_SHORT_MESSAGE = 'The cash handed over is less than the cash still due.'

/** Shown when the payments do not add up to the sale's total, to the cent. */
export const SPLIT_NOT_ADDING_UP_MESSAGE = 'The payments do not add up to the total. Check each payment and try again.'

/** Shown when one M-Pesa code is on two payments of one sale. */
export const SPLIT_SAME_CODE_MESSAGE = 'The same M-Pesa code is on two payments. Each payment needs its own code.'

/** Shown when the write found one of the split sale's M-Pesa payments already used; nothing was written. */
export const SPLIT_MPESA_ALREADY_USED_MESSAGE =
  'One of these M-Pesa payments was already used for another sale, so nothing was recorded. Check the codes and try again.'

/** One M-Pesa payment of a split sale, as the sale's write records it (docs/phase-252). */
export interface SplitMpesaWrite {
  payment: RecordMpesaPaymentInput
  /** Set on a message-based till: the stored message the payment spends. */
  claim?: { transactionCode: string; staffId: number }
}

/** @returns {number} the amount in whole cents, the unit every split comparison is made in */
function cents(amount: number): number {
  return Math.round(amount * 100)
}

/**
 * Checks a split sale's payments against its total (docs/phase-252, S1), before any payment gate or write. In whole
 * cents: at most {@link MAX_SPLIT_PAYMENTS} payments and at least two; every amount above 0; cash at most once and
 * last; no M-Pesa or card payment above what is still due when it is taken; the cash handed over at least the cash
 * due; the payments adding up to the total exactly; no M-Pesa code on two payments.
 *
 * @param {number} total the sale's total
 * @param {readonly CheckoutPaymentLeg[]} legs in the order recorded
 * @returns {{ change: number } | { error: string }} the change, given on the cash payment only, or why the payments are refused
 */
export function checkSplitPayments(total: number, legs: readonly CheckoutPaymentLeg[]): { change: number } | { error: string } {
  if (legs.length < 2) return { error: SPLIT_TOO_FEW_MESSAGE }
  if (legs.length > MAX_SPLIT_PAYMENTS) return { error: SPLIT_TOO_MANY_MESSAGE }
  const cashAt = legs.flatMap((leg, index) => (leg.method === 'cash' ? [index] : []))
  if (cashAt.length > 1) return { error: SPLIT_TWO_CASH_MESSAGE }
  if (cashAt.length === 1 && cashAt[0] !== legs.length - 1) return { error: SPLIT_CASH_NOT_LAST_MESSAGE }
  const codes = legs
    .filter((leg) => leg.method === 'mpesa')
    .map((leg) => (leg.referenceNumber ?? '').trim().toUpperCase())
    .filter((code) => code.length > 0)
  if (new Set(codes).size !== codes.length) return { error: SPLIT_SAME_CODE_MESSAGE }

  let due = cents(total)
  let change = 0
  for (const leg of legs) {
    if (!Number.isFinite(leg.amount) || cents(leg.amount) <= 0) return { error: SPLIT_AMOUNT_INVALID_MESSAGE }
    const amount = cents(leg.amount)
    if (amount > due) return { error: leg.method === 'cash' ? SPLIT_NOT_ADDING_UP_MESSAGE : SPLIT_ABOVE_DUE_MESSAGE }
    if (leg.method === 'cash') {
      const tendered = Number.isFinite(leg.tendered) ? cents(leg.tendered as number) : 0
      if (tendered < amount) return { error: SPLIT_CASH_SHORT_MESSAGE }
      change = (tendered - amount) / 100
    }
    due -= amount
  }
  if (due !== 0) return { error: SPLIT_NOT_ADDING_UP_MESSAGE }
  return { change }
}

/**
 * Shown when a checkout's key was already used by a sale of a different total (docs/phase-249). The screen keeps one
 * key per cart until the cart is cleared, so this means the earlier submit did make a sale and the cart changed after.
 *
 * @param {OrderRow} earlier
 * @returns {string}
 */
export function checkoutKeyReusedMessage(earlier: OrderRow): string {
  return `This checkout was already completed as sale #${earlier.local_id} for ${earlier.total.toFixed(2)}, and the cart has changed since. Clear the cart and start a new sale.`
}

/**
 * The receipt of the order a checkout already made (docs/phase-249), read back from the order row exactly as the first
 * submit's receipt reads it back: a repeat of the same checkout is told about that sale, and nothing else happens.
 *
 * @param {OrderRow} order
 * @returns {CheckoutReceipt}
 */
function receiptOfEarlierOrder(order: OrderRow): CheckoutReceipt {
  return {
    localId: order.local_id,
    mode: order.status === 'synced' ? 'synced' : 'queued-offline',
    shopifyOrderId: order.status === 'synced' ? (order.shopify_order_id ?? undefined) : undefined,
    fiscal:
      order.fiscal_status === 'fiscalized' && order.fiscal_invoice_number
        ? { invoiceNumber: order.fiscal_invoice_number, qrCode: order.fiscal_qr_code ?? '' }
        : undefined,
    fiscalStatus: order.fiscal_status ?? null,
    fiscalErrorReason: order.fiscal_error_reason ?? null,
    fiscalErrorKind: order.fiscal_error_kind ?? null,
    fiscalDataIssue: order.fiscal_data_issue ?? null
  }
}

/**
 * What a repeat of a checkout gets (docs/phase-249): the earlier order's receipt when the totals agree to the cent, or a
 * refusal when they do not. Either way nothing is written, filed, queued or paid.
 *
 * @param {OrderRow} earlier
 * @param {number} total the total this submit carries
 * @returns {ServiceResult<CheckoutReceipt>}
 */
function repeatOfCheckout(earlier: OrderRow, total: number): ServiceResult<CheckoutReceipt> {
  if (Math.round(earlier.total * 100) !== Math.round(total * 100)) {
    return { success: false, error: checkoutKeyReusedMessage(earlier) }
  }
  return { success: true, data: receiptOfEarlierOrder(earlier) }
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
  claim(localId: number): void
  release(localId: number): void
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
  /**
   * Whether this till's M-Pesa provider can settle, by itself, whether a
   * reference number corresponds to a payment that really happened.
   *
   * A capability, not a mode. `true` for the SMS reader and the
   * development mock; `false` for Daraja, which has no receipt-lookup
   * endpoint and is checked against this till's own STK records instead.
   * Supplied by `resolveMpesaProvider`, never derived here — reading it
   * as "is this the mock" is what let an unverified M-Pesa sale through
   * on a Daraja till.
   */
  verifyReferenceNumbers: boolean
  /**
   * Whether the confirmation a sale uses is a stored record that must be
   * **spent**, so the next sale cannot use it too.
   *
   * `true` only on a message-based till, where received payments sit in
   * a list a cashier picks from. Supplied by `resolveMpesaProvider`
   * alongside {@link verifyReferenceNumbers}: the two answer different
   * questions, and conflating them would either leave a real payment
   * re-spendable or try to consume a Daraja STK record that has no such
   * notion.
   */
  claimsStoredPayments: boolean
  /**
   * Whether this till may complete a sale on a manually entered code
   * that nobody has confirmed.
   *
   * A **fallback permitted alongside** whichever confirming mode the
   * till runs, never a mode of its own — see `docs/phase-120.md` §7.3.
   * Manual entry is the only route that works with no credentials, no
   * modem and no internet; made selectable as *the* mode it would become
   * the path of least resistance for any shop with a flaky setup, and
   * phase-102's hole would reopen by configuration rather than by code.
   *
   * Optional, defaulting to off. An omitted flag must mean "not
   * allowed", so no caller can enable the exception by forgetting about
   * it.
   */
  manualEntryEnabled?: boolean
  /**
   * Whether this till takes split payments (docs/phase-252, S9): the `split_payments_enabled` setting, changed only in
   * Admin behind the admin PIN and read for each checkout. Optional, defaulting to off, so a caller that forgets it
   * cannot let a split sale through.
   */
  splitPaymentsEnabled?: boolean
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

/**
 * Builds a payment record for one of the two confirming modes.
 *
 * Both take the same fields; the mode and status differ, and they are
 * derived from **which gate branch ran**, never from anything the
 * renderer sent. That is the whole guarantee: a compromised renderer
 * cannot make a manual payment read as `confirmed`, because it has no
 * say in either value.
 *
 * The development mock (`verifyReferenceNumbers` true, no stored payment
 * to claim) records as `sms`/`matched`. It cannot reach a packaged
 * build, so that inaccuracy stays in development.
 *
 * @param {MpesaPaymentMode} mode
 * @param {MpesaVerificationStatus} verificationStatus
 * @param {string} reference
 * @param {number} amount
 * @param {number} enteredByStaffId
 * @returns {RecordMpesaPaymentInput}
 */
function settledBy(
  mode: MpesaPaymentMode,
  verificationStatus: MpesaVerificationStatus,
  reference: string,
  amount: number,
  enteredByStaffId: number
): RecordMpesaPaymentInput {
  return { mode, verificationStatus, reference, amount, enteredByStaffId, approvedByStaffId: null }
}

/**
 * The payment gate. No M-Pesa sale reaches the ledger without a real
 * confirmation, by any route — including a request that never came
 * from a checkout screen, since the main process must not trust a
 * value merely because a screen validated it.
 *
 * Payment inverts the fiscal rule this file follows everywhere else.
 * An unfiled sale is recoverable and so fiscalization never blocks;
 * goods released for a payment that never arrived are not, so every
 * ambiguous case here resolves to NOT PAID and the sale stops.
 *
 * Which confirmation counts depends on what the till's provider can
 * actually prove:
 *
 *   - `verifyReferenceNumbers` (the SMS reader, and the development
 *     mock): the provider itself settles it, by matching the code
 *     against a confirmation this till received.
 *   - otherwise (Daraja): the provider has no receipt-lookup
 *     endpoint, so the reference is matched against this till's own
 *     record of Daraja's STK status responses instead. Which means
 *     Daraja's STK path continues to work exactly as before, and a
 *     typed reference that never went through it does not.
 *
 * A third outcome was added in phase-121: a **manually entered code,
 * recorded as confirmed by nobody.** It bends this rule's letter —
 * the gate no longer only confirms or refuses — while keeping its
 * purpose exactly: the point was never that every sale is proven, it
 * was that nobody is ever misled about whether a sale was proven. A
 * manual payment is an exception an operator opens deliberately, by
 * name, that the record describes as open for ever.
 *
 * As of docs/phase-150.md step 3 (the client's POC decision,
 * consciously reversing phase-120 §7.3's "fallback flag" framing —
 * manual is now this till's default, exclusive method, not an
 * exception bolted onto another one), this is reached with **no
 * manager PIN at sale time**: only the cashier's own positive
 * attestation that they saw the confirmation message on the
 * customer's phone. `approvedByStaffId` is always written `null`
 * here — a manager's approval is deferred to the end-of-day report
 * (Step 4), covering every manual entry in it at once, not
 * re-verified per sale.
 *
 * `verifyTransactionCode` is **never** called on this branch. Routing
 * manual through the provider would make an unverified payment
 * indistinguishable from a verified one right here, which is the
 * precise regression phase-102 exists to prevent.
 *
 * A function since docs/phase-252, so a split sale runs exactly this gate once for each M-Pesa payment, with that
 * payment's amount where a sale paid one way uses its total. It answers at once, not as a promise, on every branch
 * but the provider's check, as the inline gate did: a manual or Daraja payment is then written with no `await`
 * between its gate and its write, so no other checkout on this till can run in between.
 *
 * @param {GateDeps} deps
 * @param {number} staffId the cashier, established from the request's staff id
 * @param {string | undefined} rawReference
 * @param {ManualMpesaApproval | undefined} manualApproval
 * @param {number} amount the sale's total, or the payment's amount in a split sale
 * @returns {MpesaGate | Promise<MpesaGate>} a promise only when the provider is asked
 */
function gateMpesaPayment(
  deps: GateDeps,
  staffId: number,
  rawReference: string | undefined,
  manualApproval: ManualMpesaApproval | undefined,
  amount: number
): MpesaGate | Promise<MpesaGate> {
  const { db, mpesaProvider, verifyReferenceNumbers, manualEntryEnabled } = deps
  const reference = rawReference?.trim() ?? ''
  if (!reference) {
    return { error: UNCONFIRMED_MPESA_MESSAGE }
  }

  if (manualApproval) {
    if (!manualEntryEnabled) {
      return { error: MPESA_MANUAL_NOT_ENABLED_MESSAGE }
    }
    if (!MPESA_MANUAL_CODE_PATTERN.test(reference)) {
      return { error: MPESA_MANUAL_CODE_INVALID_MESSAGE }
    }
    if (!manualApproval.acknowledgedUnverified) {
      return { error: MPESA_MANUAL_NOT_ACKNOWLEDGED_MESSAGE }
    }
    // Across every mode, not just previous manual entries: the same
    // M-Pesa code confirmed by Daraja or matched from a message is
    // the same payment, and must not settle a second sale because
    // somebody typed it in by hand.
    if (db.hasRecordedMpesaPayment(reference)) {
      return { error: MPESA_MANUAL_CODE_ALREADY_USED_MESSAGE }
    }
    return {
      settlement: {
        mode: 'manual',
        verificationStatus: 'manual_unverified',
        reference,
        amount,
        enteredByStaffId: staffId,
        // No per-sale approval any more (docs/phase-150.md step 3) — a
        // manager's end-of-day approval (Step 4) is what sets this.
        approvedByStaffId: null
      }
    }
  }
  if (verifyReferenceNumbers) {
    return verifyWithProvider(mpesaProvider, staffId, reference, amount)
  }
  if (!db.hasConfirmedStkPayment(reference)) {
    return { error: UNCONFIRMED_MPESA_MESSAGE }
  }
  return { settlement: settledBy('daraja', 'confirmed', reference, amount, staffId) }
}

/** What the M-Pesa gate decides: the payment record to write, or why the payment is refused. */
type MpesaGate = { settlement: RecordMpesaPaymentInput } | { error: string }

/**
 * The M-Pesa gate's provider branch (the SMS reader, and the development mock): the provider settles whether this
 * code is a payment of `amount` this till received.
 *
 * @param {CheckoutMpesaProvider} mpesaProvider
 * @param {number} staffId
 * @param {string} reference trimmed
 * @param {number} amount
 * @returns {Promise<MpesaGate>}
 */
async function verifyWithProvider(
  mpesaProvider: CheckoutMpesaProvider,
  staffId: number,
  reference: string,
  amount: number
): Promise<MpesaGate> {
  const verification = await mpesaProvider.verifyTransactionCode({
    transactionCode: reference,
    amount
  })
  if (!verification.success) {
    return { error: verification.error ?? UNCONFIRMED_MPESA_MESSAGE }
  }
  if (!verification.data?.verified) {
    return { error: verification.data?.reason ?? UNCONFIRMED_MPESA_MESSAGE }
  }
  return { settlement: settledBy('sms', 'matched', reference, amount, staffId) }
}

/**
 * The card (PDQ) gate. Rubis takes cards on a separate PDQ machine
 * the till has no link to (docs/phase-176.md §4.7, VIL G03 manual
 * Step 7: `CloseReceipt` has no payment argument at all) — there is
 * no confirming provider to check a card reference against, the way
 * M-Pesa's Daraja/SMS/manual routes above can. The whole record is
 * the cashier's reference plus their attestation that the slip
 * printed Approved, same shape as manual M-Pesa's exception (docs/
 * phase-150.md step 3): no manager PIN at sale time, cashier
 * attribution from `staffId` alone.
 *
 * `cardApproval` — never `input.referenceNumber` — is the only
 * source for the reference, so a renderer cannot bypass this gate by
 * setting the top-level field directly. Unlike M-Pesa there is no
 * settlement/ledger row (Option A, docs/phase-176.md Part 2 §5):
 * the `orders` row below is the entire record, and nothing here
 * needs claiming or spending.
 *
 * A function since docs/phase-252, so each card payment of a split sale runs exactly this gate.
 *
 * @param {CardApproval | undefined} cardApproval
 * @returns {{ reference: string } | { error: string }} the reference to record, or why the payment is refused
 */
function gateCardPayment(cardApproval: CardApproval | undefined): { reference: string } | { error: string } {
  const reference = cardApproval?.reference.trim() ?? ''
  if (!reference) {
    return { error: CARD_REFERENCE_MISSING_MESSAGE }
  }
  if (!CARD_REFERENCE_PATTERN.test(reference)) {
    return { error: CARD_REFERENCE_INVALID_MESSAGE }
  }
  if (!cardApproval?.confirmRecorded) {
    return { error: CARD_NOT_ACKNOWLEDGED_MESSAGE }
  }
  return { reference }
}

/** What the payment gates read from {@link RunCheckoutDeps}. */
type GateDeps = Pick<RunCheckoutDeps, 'db' | 'mpesaProvider' | 'verifyReferenceNumbers' | 'manualEntryEnabled'>

/** A split sale that passed every check and gate (docs/phase-252), ready to write. */
interface SplitDecision {
  payments: SalePayment[]
  mpesa: SplitMpesaWrite[]
  /** Everything handed over: the M-Pesa and card payments plus the cash handed over. */
  tendered: number
  change: number
}

/** What deciding a split sale gives: the sale ready to write, or why it is refused. */
type SplitOutcome = SplitDecision | { error: string }

/** What deciding a split sale reads from {@link RunCheckoutDeps}. */
type SplitDeps = GateDeps & { splitPaymentsEnabled?: boolean; claimsStoredPayments: boolean }

/**
 * Decides a split sale (docs/phase-252): refused while the setting is off, then the payments checked against the total
 * ({@link checkSplitPayments}), then each payment through today's own gate, in the order recorded. Nothing is written
 * here; the first refusal stops the sale. Answers at once unless a payment needs the provider's check, for the reason
 * {@link gateMpesaPayment} gives.
 *
 * @param {SplitDeps} deps
 * @param {CheckoutRequest} input
 * @param {number} staffId
 * @returns {SplitOutcome | Promise<SplitOutcome>}
 */
function decideSplit(deps: SplitDeps, input: CheckoutRequest, staffId: number): SplitOutcome | Promise<SplitOutcome> {
  if (deps.splitPaymentsEnabled !== true) return { error: SPLIT_PAYMENTS_OFF_MESSAGE }
  if (input.paymentMethod !== 'split' || !input.payments) return { error: SPLIT_REQUEST_INVALID_MESSAGE }
  const checked = checkSplitPayments(input.total, input.payments)
  if ('error' in checked) return checked
  return gateSplitPayments(deps, staffId, input.payments, 0, { payments: [], mpesa: [], tendered: 0, change: checked.change })
}

/**
 * Runs the payments of a split sale from `from` on through their gates, in order, adding each to `decision`. Waits only
 * where a payment needs the provider's check, then carries on from the next payment.
 *
 * @param {SplitDeps} deps
 * @param {number} staffId
 * @param {readonly CheckoutPaymentLeg[]} legs
 * @param {number} from
 * @param {SplitDecision} decision filled in as the payments pass
 * @returns {SplitOutcome | Promise<SplitOutcome>}
 */
function gateSplitPayments(
  deps: SplitDeps,
  staffId: number,
  legs: readonly CheckoutPaymentLeg[],
  from: number,
  decision: SplitDecision
): SplitOutcome | Promise<SplitOutcome> {
  for (let index = from; index < legs.length; index++) {
    const leg = legs[index]
    const amount = cents(leg.amount) / 100
    if (leg.method === 'cash') {
      decision.payments.push({ method: 'cash', amount, tendered: cents(leg.tendered as number) / 100, changeDue: decision.change })
      continue
    }
    if (leg.method === 'card') {
      const gate = gateCardPayment(leg.cardApproval)
      if ('error' in gate) return gate
      decision.payments.push({ method: 'card', amount, reference: gate.reference })
      continue
    }
    const gate = gateMpesaPayment(deps, staffId, leg.referenceNumber, leg.manualApproval, amount)
    if (gate instanceof Promise) {
      return gate.then((checked) => {
        if ('error' in checked) return checked
        addMpesaPayment(deps, staffId, decision, checked.settlement)
        return gateSplitPayments(deps, staffId, legs, index + 1, decision)
      })
    }
    if ('error' in gate) return gate
    addMpesaPayment(deps, staffId, decision, gate.settlement)
  }
  // Everything handed over: each M-Pesa and card payment, and the cash handed over, added in whole cents.
  const handedOver = decision.payments.reduce((sum, payment) => sum + cents(payment.tendered ?? payment.amount), 0)
  return { ...decision, tendered: handedOver / 100 }
}

/**
 * Adds an M-Pesa payment that passed its gate to a split sale. As for a sale paid one way, on a message-based till a
 * confirmed payment spends its stored message; a manual code has none.
 *
 * @param {SplitDeps} deps
 * @param {number} staffId
 * @param {SplitDecision} decision
 * @param {RecordMpesaPaymentInput} settlement
 */
function addMpesaPayment(deps: SplitDeps, staffId: number, decision: SplitDecision, settlement: RecordMpesaPaymentInput): void {
  decision.payments.push({ method: 'mpesa', amount: settlement.amount, reference: settlement.reference, mpesaMode: settlement.mode })
  const claim = deps.claimsStoredPayments && settlement.mode !== 'manual' ? { transactionCode: settlement.reference, staffId } : undefined
  decision.mpesa.push({ payment: settlement, ...(claim ? { claim } : {}) })
}

/**
 * The one payment of a sale paid one way (docs/phase-252), written to `order_payments` with the sale: its whole total,
 * the cash handed over and the change for cash, the reference for card and M-Pesa, and for M-Pesa the mode from the gate
 * branch that accepted it.
 *
 * @param {CheckoutRequest} input
 * @param {number} total
 * @param {RecordMpesaPaymentInput | null} mpesaSettlement
 * @param {string | null} cardReference
 * @returns {SalePayment}
 */
function singlePayment(
  input: CheckoutRequest,
  total: number,
  mpesaSettlement: RecordMpesaPaymentInput | null,
  cardReference: string | null
): SalePayment {
  if (input.paymentMethod === 'mpesa' && mpesaSettlement) {
    return { method: 'mpesa', amount: total, reference: mpesaSettlement.reference, mpesaMode: mpesaSettlement.mode }
  }
  if (input.paymentMethod === 'card' && cardReference !== null) {
    return { method: 'card', amount: total, reference: cardReference }
  }
  return { method: 'cash', amount: total, tendered: input.tenderedAmount, changeDue: input.changeDue }
}

/** Builds the fiscal invoice request from a checkout, identically on the happy path and the exception-fallback rebuild. */
function buildFiscalRequest(
  input: CheckoutRequest,
  clientOrderUuid: string,
  localId: number,
  taxRate: number,
  traderInvNum?: string
): FiscalInvoiceRequest {
  return {
    clientOrderUuid,
    localId,
    ...(traderInvNum ? { traderInvNum } : {}),
    items: input.items.map((item) => {
      // A class the till does not know keeps its raw value, so the
      // provider's validator refuses it; it is never filed as class A.
      const vatClass = resolveVatClass(item.vatClass)
      return {
        description: item.title,
        quantity: item.quantity,
        unitPrice: item.price,
        // Only class A carries the store's rate; the other classes are
        // not taxed at it (docs/phase-194).
        taxRate: vatClass === DEFAULT_VAT_CLASS ? taxRate : 0,
        pluCode: item.id,
        // VAT class / HS classification come from the Shopify product's
        // `rubis` metafields (`vat_class`, `hs_code`, `hs_name`) when the
        // cart carried them through; otherwise this defaults to the
        // standard 16% VAT class with no HS classification.
        vatClass: vatClass ?? String(item.vatClass),
        hsCode: item.hsCode || '',
        hsName: item.hsName || ''
      }
    }),
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
    fiscalizationProvider,
    fiscalEngine,
    monitor,
    engineTick,
    idGen,
    taxRate,
    claimsStoredPayments,
    logger,
    debugLogging
  } = deps

  // Hoisted so the outer catch (below) can still say which sale failed
  // when the throw happens after the order was queued — logging only,
  // never read for control flow.
  let localId: number | undefined

  /**
   * The unified payment record this sale will write, decided by the gate
   * below and written in the same transaction as the order. `null` for a
   * cash or card sale, which settle no M-Pesa payment.
   */
  let mpesaSettlement: RecordMpesaPaymentInput | null = null

  /**
   * Set only by the card gate below, once a card sale passes it — the
   * derived reference `orderInput` (below) must use instead of whatever
   * `input.referenceNumber` holds, since a card sale has no confirming
   * provider to have already set that field correctly.
   */
  let cardReference: string | null = null

  try {
    const { items, total } = input

    // docs/phase-249: a checkout already made into an order is answered with that order, before anything else: before the
    // payment gates (a manual code would read as "already used" by the sale it made), the order write and the fiscal call.
    // The same lookup is made again inside the order's write transaction, which is what settles two submits that pass
    // this point together.
    if (input.checkoutKey) {
      const earlier = db.getOrderByCheckoutKey(input.checkoutKey)
      if (earlier) return repeatOfCheckout(earlier, total)
    }

    // Before the staff check, the payment gates and the order write: a cart
    // the fiscal device could only reject after payment is refused here,
    // so nothing is saved or paid (docs/phase-194, D2 and D4).
    const vatClassRefusal = findVatClassRefusal(items)
    if (vatClassRefusal) {
      return { success: false, error: vatClassRefusal }
    }

    const staff = db.getStaffById(input.staffId)
    if (!staff) {
      return { success: false, error: 'No staff member is logged in' }
    }

    /**
     * docs/phase-252: a split sale is decided first, whole: the setting, the payments against the total, then each
     * payment through the same gate a sale paid one way uses. A request that carries payments without saying `split`
     * is refused the same way.
     */
    let split: SplitDecision | null = null
    if (input.paymentMethod === 'split' || input.payments !== undefined) {
      const pending = decideSplit(deps, input, staff.id)
      const decided = pending instanceof Promise ? await pending : pending
      if ('error' in decided) {
        return { success: false, error: decided.error }
      }
      split = decided
    }

    // The payment gates: see gateMpesaPayment and gateCardPayment.
    if (input.paymentMethod === 'mpesa') {
      // Awaited only when the provider is asked: see gateMpesaPayment.
      const pending = gateMpesaPayment(deps, staff.id, input.referenceNumber, input.manualApproval, total)
      const gate = pending instanceof Promise ? await pending : pending
      if ('error' in gate) {
        return { success: false, error: gate.error }
      }
      mpesaSettlement = gate.settlement
    }

    if (input.paymentMethod === 'card') {
      const gate = gateCardPayment(input.cardApproval)
      if ('error' in gate) {
        return { success: false, error: gate.error }
      }
      cardReference = gate.reference
    }

    const openShift = db.getOpenShift()
    const clientOrderUuid = idGen()
    // docs/phase-252: a split sale's tendered and change are worked out here from its payments, never the screen's.
    const fiscalSource: CheckoutRequest = split ? { ...input, tenderedAmount: split.tendered, changeDue: split.change } : input
    const orderInput: QueueOrderInput = {
      items,
      total,
      clientOrderUuid,
      staffId: staff.id,
      staffName: staff.name,
      paymentMethod: input.paymentMethod,
      // Derived, never trusted, for a card sale (docs/phase-176.md Part
      // 2 §2): the PDQ terminal already took the full amount, so the
      // renderer's tenderedAmount/changeDue are not evidence of
      // anything and are ignored in favour of the cart total/zero.
      tenderedAmount: cardReference !== null ? total : fiscalSource.tenderedAmount,
      changeDue: cardReference !== null ? 0 : fiscalSource.changeDue,
      referenceNumber: split ? undefined : (cardReference ?? input.referenceNumber),
      payments: split ? split.payments : [singlePayment(input, total, mpesaSettlement, cardReference)],
      shiftId: openShift?.id,
      customerPin: input.customerPin,
      cartDiscount: input.cartDiscount,
      cartToken: input.cartToken,
      locationId: input.locationId,
      locationName: input.locationName,
      checkoutKey: input.checkoutKey,
      // Rule 3 (docs/phase-185.md §4.1): the sale is `waiting`, queued and
      // carries this exact request from the moment it exists.
      buildFiscalRequest: (id: number, traderInvNum?: string) =>
        buildFiscalRequest(fiscalSource, clientOrderUuid, id, taxRate, traderInvNum)
    }

    /**
     * On a message-based till the confirmation is a stored record, and
     * the sale has to spend it: the same received payment sits in the
     * list a cashier picks from, so leaving it unspent would let the next
     * sale pick it again — a double credit through ordinary use, not
     * abuse.
     *
     * Queueing and claiming happen in one transaction, so the sale and
     * the spent payment are one fact. Splitting them either way has a
     * failure that costs money: queue-then-claim can leave a completed
     * sale whose payment still reads as available, and claim-then-queue
     * can consume a real payment for a sale that never existed.
     *
     * The claim is also the gate, not a note taken after one. The check
     * above ran before an `await`, and two checkouts can interleave
     * there; the conditional write inside is what actually settles who
     * gets the payment.
     */
    const smsClaim =
      claimsStoredPayments && input.paymentMethod === 'mpesa' && input.referenceNumber?.trim()
        ? { transactionCode: input.referenceNumber.trim(), staffId: staff.id }
        : null

    /**
     * The sale and its payment record are written together, whichever
     * route got here. Either both rows exist or neither does — an
     * unverified sale whose payment record failed to write would be
     * indistinguishable from a confirmed one, and a confirmed sale with
     * no payment row is the untraceable state this table exists to end.
     */
    let queued: QueuedOrder | null
    if (split) {
      queued = db.queueOrderRecordingPayments(orderInput, split.mpesa)
      if (!queued) {
        return { success: false, error: SPLIT_MPESA_ALREADY_USED_MESSAGE }
      }
    } else if (mpesaSettlement?.mode === 'manual') {
      queued = db.queueOrderRecordingManualPayment(orderInput, mpesaSettlement)
      if (!queued) {
        return { success: false, error: MPESA_MANUAL_CODE_ALREADY_USED_MESSAGE }
      }
    } else if (smsClaim) {
      queued = db.queueOrderClaimingSmsPayment(orderInput, smsClaim, mpesaSettlement ?? undefined)
      if (!queued) {
        return { success: false, error: MPESA_PAYMENT_ALREADY_USED_MESSAGE }
      }
    } else if (mpesaSettlement) {
      queued = db.queueOrderRecordingMpesaPayment(orderInput, mpesaSettlement)
    } else {
      queued = db.queueOrder(orderInput)
    }
    localId = queued.localId
    // docs/phase-249: another submit of this checkout made the order while this one waited (the SMS check is the only
    // wait before the write). Nothing was written; this submit reports that order and files nothing.
    if (queued.existing) {
      const earlier = db.getOrder(queued.localId)
      return earlier ? repeatOfCheckout(earlier, total) : { success: false, error: 'Failed to record checkout' }
    }
    // Always set: `orderInput` carries `buildFiscalRequest`.
    const fiscalQueueId = queued.fiscalQueueId as number

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
     * the transaction is already committed. The insert above already
     * left the sale `waiting` with a due `sync_queue` row carrying this
     * exact request, so every outcome below only settles that row:
     * success deletes it, a retryable failure (or an unexpected throw)
     * leaves it for `fiscalEngine`, and a non-retryable one deletes it.
     *
     * The claim is taken before the first `await`, so nothing else can
     * run between the insert and it; until released, the engine and a
     * manual resend leave this sale alone (Rule 1, docs/phase-185.md §5).
     */
    let fiscal: CheckoutReceipt['fiscal']
    let fiscalDataIssue: CheckoutReceipt['fiscalDataIssue'] = null
    let retryInBackground = false
    fiscalEngine.claim(localId)
    try {
      const fiscalRequest = buildFiscalRequest(fiscalSource, clientOrderUuid, localId, taxRate, queued.traderInvNum)
      const invoice = await fiscalizationProvider.submitInvoice(fiscalRequest)

      if (invoice.ok) {
        fiscal = { invoiceNumber: invoice.data.invoiceNumber, qrCode: invoice.data.qrCode }
        if (db.settleCheckoutFiscalSuccess(localId, fiscalQueueId, invoice.data) === false) {
          // docs/phase-208: the device's number is already another sale's here, so it is not this
          // sale's. The sale is now needs_fixing, and the receipt must not claim a number.
          fiscal = undefined
          logger.error(
            `[rubis-pos] Sale ${localId}: the CU invoice number ${invoice.data.invoiceNumber} is already held by another sale; ` +
              'it was NOT recorded and the sale is flagged for a person'
          )
        }
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
        db.settleCheckoutFiscalFailure(
          localId,
          fiscalQueueId,
          status,
          invoice.reason,
          invoice.kind,
          invoice.dataIssue ?? null
        )
        fiscalDataIssue = invoice.dataIssue ?? null
        retryInBackground = enqueue
      }
    } catch (fiscalError) {
      logger.error(`[rubis-pos] Sale ${localId}: fiscalization threw an unhandled exception:`, fiscalError)

      // An unclassified exception (a bug, not a device-reported
      // rejection) is treated the same as a transient/technical
      // failure — keep retrying, don't flag it as a data problem the
      // sale can't fix. The existing ABANDONED-after-10-attempts
      // backoff (`recordFiscalQueueFailure`) is the backstop against
      // an endless loop if it's genuinely unrecoverable. If even this
      // write fails, the sale is still `waiting` and queued from the
      // insert, so nothing is lost.
      const { reason, kind } = classifyThrownFiscalError(fiscalError)
      try {
        db.settleCheckoutFiscalFailure(localId, fiscalQueueId, 'waiting', reason, kind)
      } catch (queueError) {
        logger.error(`[rubis-pos] Sale ${localId}: fallback fiscal failure write also failed:`, queueError)
      }
      retryInBackground = true
    } finally {
      fiscalEngine.release(localId)
    }
    // After the release: the tick this starts must not find the sale
    // still claimed.
    if (retryInBackground) {
      fiscalEngine.onCheckoutMade()
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
