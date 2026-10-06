/**
 * PDF fallback receipt generator (docs/phase-171).
 *
 * When the configured thermal printer is offline or unreachable,
 * `printReceipt` in `printer.ts` falls back to this generator instead
 * of failing the print outright, saving a readable receipt to the
 * cashier's desktop so the sale still has a physical record.
 *
 * Renders the exact same {@link buildReceiptLayout} array the thermal
 * path renders — this module owns no receipt content or wording of its
 * own. Courier (a standard PDF base font, needing no embedded font file)
 * keeps every line's monospaced width identical to the thermal printer's
 * own fixed-pitch font, so the two-column rows the layout already
 * pre-pads (Details, Totals, Payment, VAT table, CU block) line up here
 * too. A `{ qr }` entry has no image — no QR-image library is a
 * dependency of this project (docs/phase-171's audit) — so it prints as
 * plain small text instead; see the report for the dependency this
 * would need to become a real code, proposed and stopped rather than
 * added without asking.
 */

import PDFDocument from 'pdfkit'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ReceiptOrder, ReceiptLineItem, PrinterSettings } from './printer.js'
import { buildReceiptLayout, isReceiptLayoutQr } from '../lib/receiptLayout.js'
import type { ReceiptLayoutOrder, ReceiptLayoutLineItem, ReceiptLayoutEntry } from '../lib/receiptLayout.js'

const MM_TO_PT = 2.83465
/** 80mm roll width — fixed regardless of the configured character width (docs/phase-171 item 4). */
const PAGE_WIDTH_PT = 80 * MM_TO_PT
const MARGIN_PT = 4 * MM_TO_PT
/** Courier's advance width is 0.6em at any size — a PDF base-14 font metric, not a guess. */
const COURIER_CHAR_WIDTH_FACTOR = 0.6
const LINE_HEIGHT_FACTOR = 1.5
/** Vertical space reserved for the QR entry's placeholder text block (no image — see module doc). */
const QR_BLOCK_LINES = 5

/**
 * The font size that fits `width` Courier characters into the fixed
 * 80mm page, less its margins — ~7.1pt at the default 48 characters,
 * matching docs/phase-171's own "about 7.2pt" estimate. A narrower
 * character width (a 58mm printer's 42 or 32) computes a larger font
 * for the same physical PDF page, rather than a narrower one.
 *
 * @param {number} width
 * @returns {number}
 */
export function fontSizeForWidth(width: number): number {
  const usable = PAGE_WIDTH_PT - 2 * MARGIN_PT
  return usable / (width * COURIER_CHAR_WIDTH_FACTOR)
}

/**
 * Computes the page height needed for `entries` at `fontSize` — grown
 * from the content, never a fixed guess. A `'double'` line takes two
 * rows' worth of height; a QR entry reserves a small fixed block for its
 * placeholder text (never an image — see module doc).
 *
 * @param {ReceiptLayoutEntry[]} entries
 * @param {number} fontSize
 * @returns {number}
 */
export function computeReceiptPdfHeight(entries: ReceiptLayoutEntry[], fontSize: number): number {
  let rows = 0
  for (const entry of entries) {
    if (isReceiptLayoutQr(entry)) {
      rows += QR_BLOCK_LINES
      continue
    }
    rows += entry.style === 'double' ? 2 : 1
  }
  const contentHeight = rows * fontSize * LINE_HEIGHT_FACTOR
  return Math.ceil(contentHeight + 2 * MARGIN_PT)
}

/**
 * Renders `order`/`items` as a PDF receipt and saves it to the user's
 * desktop as `RUBIS_Receipt_Order_<localId>.pdf`.
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
  const layoutOrder: ReceiptLayoutOrder = {
    ...order,
    items: items.map(
      (item): ReceiptLayoutLineItem => ({
        title: item.title,
        variantTitle: item.variantTitle,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount,
        vatClass: item.vatClass,
        ...(item.autoDiscount ? { autoDiscount: item.autoDiscount } : {})
      })
    )
  }
  const width = settings.width ?? 48
  const entries = buildReceiptLayout(
    layoutOrder,
    {
      taxRate: settings.taxRate,
      tradingName: settings.storeName,
      legalName: settings.legalName,
      address: settings.address,
      phone: settings.phone,
      sellerPin: settings.storeKraPin,
      footerMessage: settings.footerMessage,
      decorate: settings.decorateFiscalSlip
    },
    { width }
  )
  const fontSize = fontSizeForWidth(width)
  const pageHeight = computeReceiptPdfHeight(entries, fontSize)

  const filePath = join(app.getPath('desktop'), `RUBIS_Receipt_Order_${order.localId}.pdf`)

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: [PAGE_WIDTH_PT, pageHeight], margin: MARGIN_PT })
    const stream = createWriteStream(filePath)
    stream.on('finish', () => resolve())
    stream.on('error', reject)
    doc.on('error', reject)
    doc.pipe(stream)

    doc.font('Courier').fontSize(fontSize)

    for (const entry of entries) {
      if (isReceiptLayoutQr(entry)) {
        doc.fontSize(fontSize * 0.8)
        doc.text(entry.qr, { align: 'center' })
        doc.fontSize(fontSize)
        continue
      }

      const align = entry.align === 'centre' ? 'center' : entry.align
      if (entry.style === 'double') {
        doc.font('Courier-Bold').fontSize(fontSize * 2)
        doc.text(entry.text, { align })
        doc.font('Courier').fontSize(fontSize)
      } else if (entry.style === 'bold') {
        doc.font('Courier-Bold')
        doc.text(entry.text, { align })
        doc.font('Courier')
      } else {
        doc.text(entry.text, { align })
      }
    }

    doc.end()
  })

  return filePath
}
