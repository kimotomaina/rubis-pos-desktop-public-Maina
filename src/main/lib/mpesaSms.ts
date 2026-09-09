/**
 * Contract shared by the M-Pesa confirmation-SMS reader and the parser
 * that turns one message into a payment.
 *
 * The parser implementation lands in the next part, once the field
 * regexes have been settled against real captured messages. The types
 * live here now so the reader can depend on the shape rather than on a
 * regex nobody has verified yet, and so the reader's own tests can
 * inject a stand-in parser instead of asserting two things at once.
 */

/**
 * One confirmed **incoming** M-Pesa payment, parsed from a confirmation
 * SMS.
 *
 * `payerName` and `payerAlias` are mutually exclusive: a normal receipt
 * names the sender, a Split Notification (Jumbe) receipt carries a
 * privacy alias instead. Exactly one is set.
 *
 * `maskedPhone` is captured for the cashier to read and is **never**
 * matched on — Safaricom masks the number in merchant notifications, so
 * it cannot identify a payment.
 */
export interface MpesaSmsPayment {
  /** ~10-character alphanumeric code, uppercased. The dedup key. */
  transactionCode: string
  /** Amount in KES. */
  amount: number
  /** The payer's names, or `null` on a Jumbe receipt. */
  payerName: string | null
  /** Jumbe privacy alias, or `null` on a normal receipt. */
  payerAlias: string | null
  /** Partial number exactly as printed, or `null` when absent. Never matched on. */
  maskedPhone: string | null
  /** Paybill account reference, or `null` on a Till receipt. */
  accountReference: string | null
  /** The moment the message states, normalised to ISO-8601. */
  occurredAt: string
  /** The message exactly as received. */
  raw: string
}

/**
 * Turns one reassembled SMS into a payment.
 *
 * Returns `null` for anything that is not an incoming payment — noise,
 * an outgoing transfer, a balance alert, a partially-written file, or a
 * message whose shape is not recognised. Never a half-parsed guess:
 * this is money, and a wrong payment is worse than no payment.
 */
export type MpesaSmsParser = (raw: string) => MpesaSmsPayment | null

/**
 * Whether {@link parseMpesaPaymentSms} can actually recognise a message
 * yet.
 *
 * **Currently `false`.** The field patterns cannot be finalised until
 * real confirmation messages from the branch's own notification SIM are
 * in hand: Safaricom changed the merchant SMS format in March 2026, the
 * one real sample available shows a different field order from every
 * published example, and a Till receipt differs again from a Paybill
 * one. Guessing here would mean guessing about money.
 *
 * Read by the inbox reader so a till running without a working parser
 * says so on screen instead of showing a cashier an empty payment list.
 * Flip to `true` in the same change that fills in the parser.
 */
export const MPESA_SMS_PARSER_READY = false

/**
 * **Not implemented yet — recognises nothing, by design.**
 *
 * This is the injection point the reader and its tests are built
 * against, kept as a named export so finishing it is a change to this
 * function's body and to {@link MPESA_SMS_PARSER_READY}, with no
 * rewiring anywhere else.
 *
 * Returning `null` for everything is the safe direction: no message
 * reaches the payments table, so no M-Pesa sale can be confirmed on a
 * message-based till, so none completes. A till in this state reports
 * itself as not ready rather than as quiet.
 *
 * @param {string} _raw one reassembled SMS
 * @returns {MpesaSmsPayment | null} always `null` until the patterns are settled against real samples
 */
export function parseMpesaPaymentSms(_raw: string): MpesaSmsPayment | null {
  return null
}
