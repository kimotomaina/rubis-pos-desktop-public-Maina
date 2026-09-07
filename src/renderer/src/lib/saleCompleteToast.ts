/**
 * The sale-complete confirmation toast's message (phase-84, Task 2).
 * Mirrors `fiscalNotice.ts`'s shape and reuses `getFiscalNotice` as the
 * single source of truth for whether the banner already owns this
 * sale's story — the two can never show a contradictory pair of
 * messages for one sale, since both read the same derivation off the
 * same receipt.
 */

import type { CheckoutReceipt } from '../../../main/services/database.js'
import { getFiscalNotice } from './fiscalNotice.js'

type FiscalOutcome = Pick<
  CheckoutReceipt,
  'fiscalStatus' | 'fiscalErrorReason' | 'fiscalErrorKind' | 'fiscalDataIssue'
>

/**
 * Returns the sale-complete toast's message, or `null` when the fiscal
 * notice already has something to say about this sale (`waiting` or
 * `needs_fixing`) — showing both would be redundant at best and
 * contradictory at worst.
 */
export function getSaleCompleteMessage(receipt: FiscalOutcome): string | null {
  if (getFiscalNotice(receipt)) return null
  return receipt.fiscalStatus === 'fiscalized' ? 'Sale complete - tax receipt issued.' : 'Sale complete.'
}
