/**
 * Receipt fiscal block — the "details received from control unit (to be
 * printed on invoice)" the VIL G03 manual lists: CU invoice number, date
 * and time stamp, CU serial number (the QR code is handled separately,
 * since only the thermal path can render it as an image; the PDF fallback
 * has never carried one). Shared by `printer.ts`'s `renderReceipt` and
 * `pdf-receipt.ts`'s `generatePdfReceipt` (docs/phase-164), the same way
 * `receiptTotals.ts` is shared (docs/phase-160/161).
 *
 * Before docs/phase-164, `submitInvoice` already returned the control
 * unit's own date/time and serial number, but every caller discarded them
 * before they reached storage (docs/phase-163-2's audit) — this module
 * only formats whatever `fiscal_fiscalized_at`/`fiscal_fiscalized_at_source`/
 * `fiscal_cu_serial` a fiscalized order now has stored (docs/phase-164
 * Commit 1); it never talks to the device.
 *
 * docs/phase-165 adds the not-yet-filed slip wording, for the automatic
 * end-of-sale print (docs/phase-164-1 Part A item 4) of a sale that
 * hasn't fiscalized yet: a plain-language line in place of the CU block,
 * so the receipt is never mistaken for a tax invoice while KRA filing is
 * still pending.
 */

/** Printed at the top of a not-yet-filed slip (docs/phase-165), above the store name. */
export const FISCAL_PENDING_HEADER = 'SALE RECORD - TAX INVOICE TO FOLLOW'

/** Centred on a filed fiscal slip, after the header block and before the "FISCAL RECEIPT" label (docs/phase-198-2). */
export const FISCAL_RECEIPT_START_MARKER = '- START OF FISCAL RECEIPT -'

/** Centred on a filed fiscal slip, after the control unit block and before the footer (docs/phase-198-2). */
export const FISCAL_RECEIPT_END_MARKER = '- END OF FISCAL RECEIPT -'

/** Printed where the CU block would be, on a not-yet-filed slip (docs/phase-165). */
export const NOT_A_TAX_INVOICE_LINE = 'Not a tax invoice'

/** The order fields {@link buildFiscalBlockLines} needs. */
export interface ReceiptFiscalBlockOrder {
  /** KRA/eTIMS invoice number. Gates the whole block — absent means "not fiscalised", so no CU block prints at all. */
  fiscalInvoiceNumber?: string
  /** The control unit's own date/time stamp, stored verbatim — never reformatted or reparsed here. */
  fiscalizedAt?: string
  /** Where {@link fiscalizedAt} came from — see `FiscalInvoiceResult.fiscalizedAtSource`. */
  fiscalizedAtSource?: 'device' | 'local-fallback'
  /** The control unit's own serial number, from `ReadCUnumbers`. */
  cuSerial?: string
  /**
   * Set only for the automatic end-of-sale print, on the real provider,
   * of a sale that hasn't fiscalized yet (docs/phase-165) — see
   * `main/index.ts`'s `receipt:print` handler for the exact condition.
   * Ignored once `fiscalInvoiceNumber` is present (a fiscalised order
   * always gets the real CU block, never the slip wording).
   */
  fiscalPending?: boolean
}

/**
 * Builds the fiscal block's printed lines.
 *
 * For a fiscalized order (`fiscalInvoiceNumber` present), the CU block —
 * unaffected by `fiscalPending`, which never applies to a filed sale.
 *
 * For a not-yet-filed order: `[NOT_A_TAX_INVOICE_LINE]` when
 * `fiscalPending` is set (docs/phase-165 — the automatic print on the
 * real provider), or an empty array otherwise (docs/phase-164 rule 3 —
 * a manual print, the mock provider, or a sale that will never fiscalise
 * gets no block and no slip wording at all).
 *
 * The CU date/time line is worded from `fiscalizedAtSource`: `'device'`
 * reads as an actual control-unit timestamp; anything else (the local
 * fallback, or an older order fiscalized before this phase, where the
 * source is unknown) is labelled plainly as the till's own clock, so it
 * can never be mistaken for a device-attested time on a tax-relevant
 * document. Omitted entirely when there is no `fiscalizedAt` to print at
 * all (a fiscalized order somehow missing the column — should not happen,
 * since `setOrderFiscalInfo` always sets it alongside the invoice number,
 * but the line is skipped rather than printed with a blank value).
 *
 * The serial line is omitted entirely when absent, rather than printed
 * blank — same convention as the invoice number gate above.
 *
 * @param {ReceiptFiscalBlockOrder} order
 * @returns {string[]}
 */
export function buildFiscalBlockLines(order: ReceiptFiscalBlockOrder): string[] {
  if (!order.fiscalInvoiceNumber) {
    return order.fiscalPending ? [NOT_A_TAX_INVOICE_LINE] : []
  }

  const lines = [`CU Invoice No: ${order.fiscalInvoiceNumber}`]

  if (order.fiscalizedAt) {
    lines.push(
      order.fiscalizedAtSource === 'device'
        ? `CU Date/Time: ${order.fiscalizedAt}`
        : `Till time (device time unavailable): ${order.fiscalizedAt}`
    )
  }

  if (order.cuSerial) {
    lines.push(`CU Serial No: ${order.cuSerial}`)
  }

  return lines
}
