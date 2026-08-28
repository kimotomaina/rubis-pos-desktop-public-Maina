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
  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0)
  const tax = subtotal * settings.taxRate
  const total = subtotal + tax

  const filePath = join(app.getPath('desktop'), `RUBIS_Receipt_Order_${order.localId}.pdf`)

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: [PAGE_WIDTH, PAGE_HEIGHT], margin: 12 })
    const stream = createWriteStream(filePath)
    stream.on('finish', () => resolve())
    stream.on('error', reject)
    doc.on('error', reject)
    doc.pipe(stream)

    doc.font('Helvetica-Bold').fontSize(14).text(settings.storeName, { align: 'center' })
    doc.font('Helvetica').fontSize(9)
    doc.text(`Order #${order.localId}`, { align: 'center' })
    doc.text(new Date(order.createdAt).toLocaleString(), { align: 'center' })
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
    doc.text(`Subtotal: ${formatCurrency(subtotal)}`)
    doc.text(`Tax: ${formatCurrency(tax)}`)
    doc.font('Helvetica-Bold').text(`Total: ${formatCurrency(total)}`)
    doc.font('Helvetica')
    doc.text(`Payment: ${order.paymentMethod}`)
    if (order.paymentMethod === 'cash') {
      doc.text(`Tendered: ${formatCurrency(order.tenderedAmount)}`)
      doc.text(`Change: ${formatCurrency(order.changeDue)}`)
    } else if (order.referenceNumber) {
      doc.text(`Ref: ${order.referenceNumber}`)
    }
    doc.text(DASHED_LINE)
    doc.text('Thank you!', { align: 'center' })

    doc.end()
  })

  return filePath
}
