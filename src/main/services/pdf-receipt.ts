/**
 * PDF fallback receipt generator.
 *
 * When the configured thermal printer is offline or unreachable,
 * `printReceipt` in `printer.ts` falls back to this generator instead
 * of failing the print outright, saving a readable receipt to the
 * cashier's desktop so the sale still has a physical record.
 */

import PDFDocument from 'pdfkit'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ReceiptOrder, ReceiptLineItem, PrinterSettings } from './printer.js'
import { formatCurrency } from './currency.js'
import { formatVatRateLabel } from './reports.js'
import { computeReceiptTotals } from '../lib/receiptTotals.js'
import type { ReceiptTotalsLineItem } from '../lib/receiptTotals.js'
import { buildFiscalBlockLines, FISCAL_PENDING_HEADER } from '../lib/receiptFiscalBlock.js'

/** Narrow receipt-page width (points) approximating an 80mm thermal roll. */
const PAGE_WIDTH = 280
const PAGE_HEIGHT = 800
const DASHED_LINE = '-'.repeat(40)

/**
 * Renders `order`/`items` as a simple text receipt PDF and saves it to
 * the user's desktop as `RUBIS_Receipt_Order_<localId>.pdf`.
 *
 * @param {ReceiptOrder} order
 * @param {ReceiptLineItem[]} items
 * @param {PrinterSettings} settings
 * @returns {Promise<string>} the absolute path of the saved PDF
 */
export async function generatePdfReceipt(
  order: ReceiptOrder,
  items: ReceiptLineItem[],
  settings: PrinterSettings
): Promise<string> {
  const lineItems: ReceiptTotalsLineItem[] = items.map((item) => ({
    unitPrice: item.unitPrice,
    quantity: item.quantity,
    discount: item.discount
  }))
  const totals = computeReceiptTotals(
    { localId: order.localId, lineItems, cartDiscount: order.cartDiscount, total: order.total },
    settings.taxRate
  )

  const filePath = join(app.getPath('desktop'), `RUBIS_Receipt_Order_${order.localId}.pdf`)

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: [PAGE_WIDTH, PAGE_HEIGHT], margin: 12 })
    const stream = createWriteStream(filePath)
    stream.on('finish', () => resolve())
    stream.on('error', reject)
    doc.on('error', reject)
    doc.pipe(stream)

    // docs/phase-164, post-implementation checklist item 11: any print
    // past the first successful one for this sale is stamped a duplicate,
    // top and bottom, so it can never be mistaken for the original
    // receipt — same rule as the thermal path in `printer.ts`.
    if (order.isDuplicate) {
      doc.font('Helvetica-Bold').text('*** DUPLICATE ***', { align: 'center' })
      doc.font('Helvetica')
    }
    // docs/phase-165: same not-yet-filed heading as the thermal path.
    if (order.fiscalPending && !order.fiscalInvoiceNumber) {
      doc.font('Helvetica-Bold').text(FISCAL_PENDING_HEADER, { align: 'center' })
      doc.font('Helvetica')
    }
    doc.font('Helvetica-Bold').fontSize(14).text(settings.storeName, { align: 'center' })
    doc.font('Helvetica').fontSize(9)
    doc.text(`Order #${order.localId}`, { align: 'center' })
    doc.text(`Sale time: ${new Date(order.createdAt).toLocaleString()}`, { align: 'center' })
    doc.text(`Cashier: ${order.cashierName}`)
    if (order.customerPin) {
      doc.text(`Customer PIN: ${order.customerPin}`)
    }
    doc.text(DASHED_LINE)

    for (const item of items) {
      const label = item.variantTitle ? `${item.title} (${item.variantTitle})` : item.title
      doc.text(`${item.quantity} x ${label} - ${formatCurrency(item.unitPrice * item.quantity)}`)
    }

    doc.text(DASHED_LINE)
    doc.text(`Subtotal: ${formatCurrency(totals.rawSubtotal)}`)
    if (totals.discountTotal > 0) {
      doc.text(`Discount: -${formatCurrency(totals.discountTotal)}`)
    }
    doc.font('Helvetica-Bold').text(`Total: ${formatCurrency(totals.total)}`)
    doc.font('Helvetica')
    doc.text(`${formatVatRateLabel(settings.taxRate)}: ${formatCurrency(totals.vatIncluded)}`)
    doc.text(`Payment: ${order.paymentMethod}`)
    if (order.paymentMethod === 'cash') {
      doc.text(`Tendered: ${formatCurrency(order.tenderedAmount)}`)
      doc.text(`Change: ${formatCurrency(order.changeDue)}`)
    } else if (order.referenceNumber) {
      doc.text(`Ref: ${order.referenceNumber}`)
    }
    doc.text(DASHED_LINE)
    doc.text('Thank you!', { align: 'center' })

    // docs/phase-164: CU invoice number, date/time and serial — the same
    // shared helper `printer.ts`'s thermal path uses, so both surfaces
    // agree on content and wording. Empty for a non-fiscalized order, so
    // nothing prints here at all in that case. No QR image in the PDF
    // fallback — it never carried one before this phase either.
    const fiscalLines = buildFiscalBlockLines(order)
    if (fiscalLines.length > 0) {
      doc.text(DASHED_LINE)
      for (const line of fiscalLines) {
        doc.text(line)
      }
    }

    if (order.isDuplicate) {
      doc.font('Helvetica-Bold').text('*** DUPLICATE ***', { align: 'center' })
      doc.font('Helvetica')
    }

    doc.end()
  })

  return filePath
}
