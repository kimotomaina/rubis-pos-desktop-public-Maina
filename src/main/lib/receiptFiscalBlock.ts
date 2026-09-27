/**
 * Receipt fiscal block — the "details received from control unit (to be
 * printed on invoice)" the VIL G03 manual lists: CU invoice number, date
 * and time stamp, CU serial number (the QR code is handled separately,
 * since only the thermal path can render it as an image; the PDF fallback
 * has never carried one). Shared by `printer.ts`'s `renderReceipt` and
 * `pdf-receipt.ts`'s `generatePdfReceipt` (docs/phase-164), the same way
 * `receiptTotals.ts` is shared (docs/phase-160/161).
 *
 * Before this phase, `submitInvoice` already returned the control unit's
 * own date/time and serial number, but every caller discarded them before
 * they reached storage (docs/phase-163-2's audit) — this module only
 * formats whatever `fiscal_fiscalized_at`/`fiscal_fiscalized_at_source`/
 * `fiscal_cu_serial` a fiscalized order now has stored (docs/phase-164
 * Commit 1); it never talks to the device.
 */

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
}

/**
 * Builds the fiscal block's printed lines for a fiscalized order.
 *
 * Returns an empty array when `fiscalInvoiceNumber` is absent — a sale
 * that was never fiscalized (still `waiting`/`needs_fixing`) never gets a
 * CU block, whatever else the order carries (docs/phase-164 rule 3).
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
  if (!order.fiscalInvoiceNumber) return []

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
