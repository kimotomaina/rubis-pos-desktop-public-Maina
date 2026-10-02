/**
 * The automatic end-of-sale print's toasts (docs/phase-165, docs/
 * phase-166 Commit 0). Pure and dependency-free, tested directly without
 * mounting anything — same convention as `saleCompleteToast.ts`/
 * `fiscalNotice.ts`.
 *
 * The automatic print (`cartStore.ts`'s `checkout` success branch) never
 * force-opens a PDF viewer window the way a manual Order History print
 * does — see `main/index.ts`'s `receipt:print` handler. These toasts are
 * the cashier's only signal that something needs attention after that
 * automatic attempt: either a receipt exists as a saved PDF (printer
 * offline), or nothing printed at all (an outright failure, whether the
 * IPC call rejected or threw synchronously — see `cartStore.ts`'s
 * `triggerAutomaticPrint`).
 */

import type { ServiceResult } from '../../../main/services/shopify-types.js'
import type { ReceiptPrintResult } from '../../../main/services/printer.js'

/** Shown when the automatic print's IPC call rejected or threw outright — nothing was saved anywhere. */
export const AUTO_PRINT_FAILURE_MESSAGE = 'Receipt did not print. Print it from Order History.'

/** Shown when the automatic print fell back to a saved PDF because the printer was offline. */
export const AUTO_PRINT_OFFLINE_MESSAGE =
  'Printer offline. Receipt saved; print it from Order History when the printer is back.'

/** Shown when the fiscal slip printed but the separate Enjoy customer slip did not (docs/phase-198). */
export const CUSTOMER_SLIP_FAILURE_MESSAGE = 'Customer slip did not print. Reprint it from Order History.'

/**
 * Returns the toast message for an automatic print's result, or `null`
 * when no toast is needed — a genuine print (physical or mock) needs no
 * extra notice. An outright failure (docs/phase-166 Commit 0) now gets
 * its own message rather than being silently ignored, since a cashier
 * otherwise has no way to know the receipt never printed at all.
 *
 * @param {ServiceResult<ReceiptPrintResult>} result
 * @returns {string | null}
 */
export function getAutoPrintOfflineMessage(result: ServiceResult<ReceiptPrintResult>): string | null {
  if (!result.success) return AUTO_PRINT_FAILURE_MESSAGE
  if (result.data?.mode === 'pdf') return AUTO_PRINT_OFFLINE_MESSAGE
  if (result.data?.customerSlip === 'failed') return CUSTOMER_SLIP_FAILURE_MESSAGE
  return null
}
