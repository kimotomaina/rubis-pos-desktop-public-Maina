/**
 * Confirms M-Pesa payments from the confirmation messages this till read
 * off its own modem.
 *
 * Daraja's mirror image. Daraja can prompt for a payment but cannot look
 * a receipt up; this can look a receipt up but cannot prompt for
 * anything. It is receive-only, so `initiateStkPush` and
 * `queryStkPushStatus` refuse in the same way
 * `DarajaMpesaProvider.verifyTransactionCode` refuses — a clear result,
 * never a thrown error.
 *
 * Unlike the development mock, which approves nearly anything, this one
 * confirms for real: the evidence is a message Safaricom sent to the
 * till's notification SIM, stored verbatim in `mpesa_sms_messages`.
 *
 * **Every ambiguous answer is a refusal.** Not found, wrong amount,
 * already spent — each returns `verified: false` with a reason the
 * cashier can act on. There is no maybe on a payment gate.
 */

import type { ServiceResult } from '../shopify-types.js'
import type { MpesaSmsMessageRow } from '../database.js'
import type {
  ManualCodeVerification,
  ManualCodeVerificationResult,
  MpesaProvider,
  StkPushRequest,
  StkPushResult,
  StkPushStatusResult
} from './mpesa.js'

/** Returned by the two things a receive-only method cannot do. */
export const SMS_RECEIVE_ONLY_MESSAGE =
  'This till confirms M-Pesa payments from the message the customer receives. Ask the customer to pay, then find their payment here.'

/** How far back the cashier's list of recent payments reaches. */
export const UNMATCHED_WINDOW_MS = 30 * 60_000

/** Most recent payments offered to the cashier at once. */
export const UNMATCHED_LIMIT = 20

/** The database surface this provider reads. */
export interface SmsMpesaProviderDb {
  getMpesaSmsMessageByCode(transactionCode: string): MpesaSmsMessageRow | undefined
  listUnmatchedMpesaSmsMessages(since: string, limit?: number): MpesaSmsMessageRow[]
}

/**
 * The cashier's "pick the matching payment from a list" flow.
 *
 * Deliberately **not** part of {@link MpesaProvider}: listing received
 * messages is meaningless for Daraja and for the mock, and widening the
 * shared contract with a method two of three implementations would have
 * to stub is the wrong trade. Only the message-based till implements it.
 */
export interface MpesaSmsInboxReader {
  /** Recent payments not yet spent on a sale, newest first. */
  listRecentUnmatched(): MpesaSmsMessageRow[]
}

/** One payment offered to the cashier, with the amount check already applied. */
export interface UnmatchedMpesaPayment {
  transactionCode: string
  amount: number
  /** The payer's name, their privacy alias, or `null` when the message carried neither. */
  payerLabel: string | null
  /** ISO-8601, as the message stated it. */
  occurredAt: string
}

/** Options accepted by {@link SmsMpesaProvider}. */
export interface SmsMpesaProviderOptions {
  db: SmsMpesaProviderDb
  /** Defaults to {@link UNMATCHED_WINDOW_MS}. */
  windowMs?: number
  /** Defaults to {@link UNMATCHED_LIMIT}. */
  limit?: number
  /** Injectable clock, defaulting to `Date.now`. */
  now?: () => number
}

/**
 * Compares two money amounts as whole cents.
 *
 * The client's rule is an exact match, and floating point would break it
 * in the wrong direction: a payment of exactly the right amount can
 * compare unequal to the cart total through nothing but binary
 * representation, and the customer who really did pay gets turned away.
 * Rounding to cents is the same treatment `checkoutMath.ts` already
 * gives every other currency comparison.
 *
 * @param {number} left
 * @param {number} right
 * @returns {boolean}
 */
export function amountsMatchExactly(left: number, right: number): boolean {
  return Math.round(left * 100) === Math.round(right * 100)
}

/** The payer's name, falling back to a privacy alias, then to nothing. */
function payerLabel(row: MpesaSmsMessageRow): string | null {
  return row.payer_name ?? row.payer_alias ?? null
}

/**
 * Confirms payments from stored confirmation messages.
 */
export class SmsMpesaProvider implements MpesaProvider, MpesaSmsInboxReader {
  private readonly db: SmsMpesaProviderDb
  private readonly windowMs: number
  private readonly limit: number
  private readonly now: () => number

  constructor(options: SmsMpesaProviderOptions) {
    this.db = options.db
    this.windowMs = options.windowMs ?? UNMATCHED_WINDOW_MS
    this.limit = options.limit ?? UNMATCHED_LIMIT
    this.now = options.now ?? Date.now
  }

  /**
   * Cannot prompt for a payment: there is no outbound channel here, only
   * messages arriving.
   */
  async initiateStkPush(_request: StkPushRequest): Promise<ServiceResult<StkPushResult>> {
    return { success: false, error: SMS_RECEIVE_ONLY_MESSAGE }
  }

  /**
   * Confirms a transaction code against the messages this till received.
   *
   * Three separate things must all hold, and each failure gets its own
   * sentence because they need different actions from the cashier:
   * a code nobody has paid means wait, a wrong amount means the customer
   * paid something else, and an already-spent code means look again.
   *
   * @param {ManualCodeVerification} input
   * @returns {Promise<ServiceResult<ManualCodeVerificationResult>>}
   */
  async verifyTransactionCode(
    input: ManualCodeVerification
  ): Promise<ServiceResult<ManualCodeVerificationResult>> {
    const transactionCode = input.transactionCode.trim()
    const refuse = (reason: string): ServiceResult<ManualCodeVerificationResult> => ({
      success: true,
      data: { verified: false, transactionCode, amount: input.amount, reason }
    })

    if (!transactionCode) {
      return refuse('Enter the M-Pesa code from the customer’s message.')
    }

    const row = this.db.getMpesaSmsMessageByCode(transactionCode)
    if (!row) {
      // Not "wrong code": the usual cause is a message that has not
      // arrived yet, and telling the cashier it is wrong sends them to
      // re-type a code that was right.
      return refuse('That payment has not come through yet. Wait a moment and try again.')
    }

    if (row.matched_order_local_id !== null) {
      return refuse('That payment was already used for another sale. Find the customer’s own payment in the list.')
    }

    if (!amountsMatchExactly(row.amount, input.amount)) {
      return refuse(
        `That payment is for a different amount. It is for ${row.amount.toFixed(2)} and this sale is ${input.amount.toFixed(2)}.`
      )
    }

    return {
      success: true,
      data: { verified: true, transactionCode: row.transaction_code, amount: row.amount }
    }
  }

  /**
   * Cannot ask Safaricom about anything: nothing was pushed from here.
   */
  async queryStkPushStatus(_checkoutRequestId: string): Promise<ServiceResult<StkPushStatusResult>> {
    return { success: false, error: SMS_RECEIVE_ONLY_MESSAGE }
  }

  /**
   * Recent payments not yet spent on a sale, newest first — what the
   * cashier picks from.
   *
   * Already-spent payments are excluded by the query rather than shown
   * greyed out: a payment that has paid for another sale is not a
   * candidate for this one, and offering it invites the double credit
   * this whole path exists to prevent.
   *
   * @returns {MpesaSmsMessageRow[]}
   */
  listRecentUnmatched(): MpesaSmsMessageRow[] {
    const since = new Date(this.now() - this.windowMs).toISOString()
    return this.db.listUnmatchedMpesaSmsMessages(since, this.limit)
  }
}

/**
 * Reduces stored rows to what a payment screen needs, dropping the raw
 * message text and the file it came from — neither belongs on a till
 * screen, and both would travel over IPC for nothing.
 *
 * @param {MpesaSmsMessageRow[]} rows
 * @returns {UnmatchedMpesaPayment[]}
 */
export function toUnmatchedPayments(rows: MpesaSmsMessageRow[]): UnmatchedMpesaPayment[] {
  return rows.map((row) => ({
    transactionCode: row.transaction_code,
    amount: row.amount,
    payerLabel: payerLabel(row),
    occurredAt: row.occurred_at
  }))
}
