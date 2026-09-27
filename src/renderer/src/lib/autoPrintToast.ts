/**
 * The automatic end-of-sale print's "printer offline" notice (docs/
 * phase-165). Pure and dependency-free, tested directly without mounting
 * anything — same convention as `saleCompleteToast.ts`/`fiscalNotice.ts`.
 *
 * The automatic print (`cartStore.ts`'s `checkout` success branch) never
 * force-opens a PDF viewer window the way a manual Order History print
 * does — see `main/index.ts`'s `receipt:print` handler. This toast is
 * the cashier's only signal that a receipt still exists (as a saved PDF)
 * when the printer was offline for that automatic attempt.
 */

import type { ServiceResult } from '../../../main/services/shopify-types.js'
import type { ReceiptPrintResult } from '../../../main/services/printer.js'

/**
 * Returns the "printer offline" toast message for an automatic print's
 * result, or `null` when no toast is needed — a genuine print (physical
 * or mock) needs no extra notice, and a print that failed outright is
 * silently ignored here (docs/phase-164-1 Part A item 4's own proposal:
 * a print failure must never block or intrude on the sale).
 *
 * @param {ServiceResult<ReceiptPrintResult>} result
 * @returns {string | null}
 */
export function getAutoPrintOfflineMessage(result: ServiceResult<ReceiptPrintResult>): string | null {
  if (!result.success || result.data?.mode !== 'pdf') return null
  return 'Printer offline. Receipt saved; print it from Order History when the printer is back.'
}
