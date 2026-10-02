/**
 * Decides whether an order's receipt may be reprinted at the fiscal
 * device (docs/phase-196-2).
 *
 * `InfoLastReceiptDuplicate` takes no arguments and acts on whatever the
 * device issued last, so the only safe moment to send it is when that
 * last receipt is provably this order's. Pure, so every branch is
 * directly testable.
 */

import type { FiscalStatus } from '../services/database.js'

/** Inputs to {@link canPrintDuplicate}. */
export interface DuplicatePrintGuardInput {
  /** The order's stored `fiscal_invoice_number`. */
  orderCuInvoiceNumber: string | null | undefined
  /** `LastCUInvoiceNum` read from the device just before the send. */
  deviceLastCuInvoiceNumber: string | null | undefined
  /** The order's stored `fiscal_status`. */
  fiscalStatus: FiscalStatus | null
  /** Another call is already using the fiscal device on this till. */
  queueHasInFlight: boolean
  /** The device's `Opened_Fiscal_Receipt` status bit. */
  receiptOpen: boolean
}

/** Outcome of {@link canPrintDuplicate}; `reason` is a sentence a cashier can read. */
export interface DuplicatePrintGuardResult {
  allowed: boolean
  reason: string
}

const reasons = {
  notFiled: 'This sale has not been filed with KRA, so there is no receipt to copy.',
  busy: 'The till is still sending a sale to the fiscal device. Try again in a moment.',
  receiptOpen: 'The fiscal device has a receipt open right now. Try again in a moment.',
  noOrderNumber: 'This sale has no fiscal invoice number on record, so there is no receipt to copy.',
  noDeviceNumber: 'The fiscal device did not report its last receipt number, so nothing was sent.',
  notLatest:
    "The fiscal device's most recent receipt is a different one. Only the most recent receipt can be reprinted.",
  allowed: "This is the fiscal device's most recent receipt."
} as const

/**
 * @param {string | null | undefined} value
 * @returns {string} the value trimmed, or `''` when absent
 */
const clean = (value: string | null | undefined): string => (value ?? '').trim()

/**
 * Allowed only when the order is filed, nothing else is using the device,
 * no receipt is open, and both invoice numbers are non-empty and equal
 * after trimming. The comparison is exact otherwise: the numbers are
 * digits, so case never differs.
 *
 * @param {DuplicatePrintGuardInput} input
 * @returns {DuplicatePrintGuardResult}
 */
export function canPrintDuplicate(input: DuplicatePrintGuardInput): DuplicatePrintGuardResult {
  if (input.fiscalStatus !== 'fiscalized') return { allowed: false, reason: reasons.notFiled }
  if (input.queueHasInFlight) return { allowed: false, reason: reasons.busy }
  if (input.receiptOpen) return { allowed: false, reason: reasons.receiptOpen }

  const orderNumber = clean(input.orderCuInvoiceNumber)
  if (!orderNumber) return { allowed: false, reason: reasons.noOrderNumber }
  const deviceNumber = clean(input.deviceLastCuInvoiceNumber)
  if (!deviceNumber) return { allowed: false, reason: reasons.noDeviceNumber }
  if (orderNumber !== deviceNumber) return { allowed: false, reason: reasons.notLatest }

  return { allowed: true, reason: reasons.allowed }
}
