/**
 * Maps a checkout's fiscal outcome to the small notice shown at the
 * till (phase-78). Pure and dependency-free, tested directly without
 * mounting `FiscalNotice`, matching how `checkoutMath.ts` is tested
 * independently of `CheckoutModal`.
 *
 * Copy rules: plain language only, no device codes, no jargon. The
 * customer's sale is already complete in every case below; wording
 * must stay calm and never imply otherwise. A system-kind rejection is
 * this build's own problem, not the cashier's, so it reads as "tell
 * support," never "fix your data."
 */

import type { CheckoutReceipt } from '../../../main/services/database.js'

/** Which of the three non-silent outcomes this notice is for. */
export type FiscalNoticeKind = 'waiting' | 'data' | 'system'

export interface FiscalNotice {
  kind: FiscalNoticeKind
  message: string
  /**
   * Set only when the till can offer an on-the-spot fix for this exact
   * rejection (phase-78, Part C). Currently the only recognized value
   * is `'wrong-pin'`; `undefined` for every other notice, including
   * every other `'data'`-kind rejection — never guessed from `message`.
   */
  fixableAs?: 'wrong-pin'
}

type FiscalOutcome = Pick<
  CheckoutReceipt,
  'fiscalStatus' | 'fiscalErrorReason' | 'fiscalErrorKind' | 'fiscalDataIssue'
>

/**
 * Returns the notice for `receipt`'s fiscal outcome, or `null` when
 * none is needed: `fiscalStatus` is `'fiscalized'` (no notice — a
 * fiscalized sale needs nothing extra), or `null` (fiscalization was
 * never attempted, e.g. a non-eTIMS deployment).
 *
 * @param {FiscalOutcome} receipt
 * @returns {FiscalNotice | null}
 */
export function getFiscalNotice(receipt: FiscalOutcome): FiscalNotice | null {
  if (receipt.fiscalStatus === 'waiting') {
    return {
      kind: 'waiting',
      message: "Tax device unavailable. This sale will be sent automatically when it's back."
    }
  }

  if (receipt.fiscalStatus === 'needs_fixing') {
    if (receipt.fiscalErrorKind === 'system') {
      return {
        kind: 'system',
        message:
          "Sale complete, but it couldn't be sent to the tax device due to a system error. It's been flagged. Please tell support."
      }
    }
    const reason = receipt.fiscalErrorReason ?? 'the tax device rejected it'
    return {
      kind: 'data',
      message: `Sale complete, but the tax device rejected it: ${reason}. It's been flagged for correction.`,
      fixableAs: receipt.fiscalDataIssue === 'wrong-pin' ? 'wrong-pin' : undefined
    }
  }

  return null
}
