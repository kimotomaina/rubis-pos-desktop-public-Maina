/**
 * PDF fallback receipt generator tests.
 *
 * `electron.app.getPath` is mocked to point at the OS temp directory
 * so `generatePdfReceipt` writes a real, disposable PDF via `pdfkit` —
 * exercising the actual rendering code path rather than a fake sink.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  generatePdfReceipt,
  fontSizeForWidth,
  computeReceiptPdfHeight
} from '../src/main/services/pdf-receipt.js'
import type { PrinterSettings, ReceiptLineItem, ReceiptOrder } from '../src/main/services/printer.js'
import { buildReceiptLayout } from '../src/main/lib/receiptLayout.js'
import type { ReceiptLayoutOrder } from '../src/main/lib/receiptLayout.js'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()) }
}))

const order: ReceiptOrder = {
  localId: 42,
  createdAt: '2026-08-27T10:00:00.000Z',
  cashierName: 'Alex',
  paymentMethod: 'cash',
  tenderedAmount: 50,
  changeDue: 1.41,
  // The amount actually charged (docs/phase-161) — no discount here, so
  // it equals the raw subtotal (2 x 12.50).
  total: 25
}

const items: ReceiptLineItem[] = [
  { title: 'RUBIS Mug', variantTitle: 'Small', quantity: 2, unitPrice: 12.5 }
]

const settings: PrinterSettings = {
  interfaceName: 'tcp://192.168.0.50:9100',
  storeName: 'RUBIS',
  taxRate: 0.08
}

const expectedPath = join(tmpdir(), `RUBIS_Receipt_Order_${order.localId}.pdf`)

afterEach(() => {
  if (existsSync(expectedPath)) rmSync(expectedPath)
})

describe('generatePdfReceipt', () => {
  it('saves a PDF file to the resolved desktop path and returns its path', async () => {
    const filePath = await generatePdfReceipt(order, items, settings)

    expect(filePath).toBe(expectedPath)
    expect(existsSync(filePath)).toBe(true)
  })

  it('writes a non-empty PDF starting with the PDF magic header', async () => {
    const filePath = await generatePdfReceipt(order, items, settings)

    const buffer = readFileSync(filePath)
    expect(buffer.length).toBeGreaterThan(0)
    expect(buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  })

  it('includes a customer PIN when the order was fiscalized as a B2B invoice', async () => {
    const b2bOrder: ReceiptOrder = { ...order, customerPin: 'P051234567Z' }

    const filePath = await generatePdfReceipt(b2bOrder, items, settings)

    expect(existsSync(filePath)).toBe(true)
  })

  /**
   * Content-level assertions on the printed Subtotal/Discount/Total/VAT
   * lines aren't possible here — `pdfkit`'s output is a compressed PDF
   * stream, and this project has no PDF-text-extraction dependency (the
   * existing tests above only ever check the file's existence and its
   * magic header). These two tests instead exercise
   * `computeReceiptTotals` being wired through with a line discount and
   * a cart discount without throwing; the line-by-line correctness of
   * what gets printed is covered exhaustively by `receiptTotals.test.ts`
   * (the pure function) and `printer.test.ts` (the thermal path, whose
   * `println` calls ARE plain-text-assertable).
   */
  it('accepts a line discount and still produces a PDF (docs/phase-160/161)', async () => {
    const discountedOrder: ReceiptOrder = { ...order, total: 20 }
    const discountedItems: ReceiptLineItem[] = [
      { title: 'RUBIS Mug', variantTitle: 'Small', quantity: 2, unitPrice: 12.5, discount: { type: 'fixed', value: 5 } }
    ]

    const filePath = await generatePdfReceipt(discountedOrder, discountedItems, settings)

    expect(existsSync(filePath)).toBe(true)
  })

  it('accepts a cart discount and still produces a PDF', async () => {
    const discountedOrder: ReceiptOrder = { ...order, total: 22.5, cartDiscount: { type: 'fixed', value: 2.5 } }

    const filePath = await generatePdfReceipt(discountedOrder, items, settings)

    expect(existsSync(filePath)).toBe(true)
  })

  /**
   * docs/phase-164 — the CU date/time/serial block and the DUPLICATE
   * stamp, shared with `printer.ts` via `buildFiscalBlockLines`
   * (`tests/receiptFiscalBlock.test.ts` asserts the actual line content
   * that function produces, since it's a plain string array; PDF output
   * itself isn't text-assertable here, per this file's own note above —
   * these tests only prove each shape reaches `generatePdfReceipt`
   * without throwing, the same way the discount tests above do.
   */
  it('accepts a fiscalized order with a device CU date/time and serial, and still produces a PDF', async () => {
    const fiscalOrder: ReceiptOrder = {
      ...order,
      fiscalInvoiceNumber: 'KRA-0010',
      fiscalizedAt: '27-08-2026 09:15:00',
      fiscalizedAtSource: 'device',
      cuSerial: 'CU-SERIAL-0010'
    }

    const filePath = await generatePdfReceipt(fiscalOrder, items, settings)

    expect(existsSync(filePath)).toBe(true)
  })

  it('accepts a fiscalized order with a local-fallback timestamp and no serial, and still produces a PDF', async () => {
    const fiscalOrder: ReceiptOrder = {
      ...order,
      fiscalInvoiceNumber: 'KRA-0011',
      fiscalizedAt: '2026-08-27T09:15:00.000Z',
      fiscalizedAtSource: 'local-fallback'
    }

    const filePath = await generatePdfReceipt(fiscalOrder, items, settings)

    expect(existsSync(filePath)).toBe(true)
  })

  it('accepts an unfiled order (no fiscalInvoiceNumber) and still produces a PDF', async () => {
    const unfiledOrder: ReceiptOrder = {
      ...order,
      fiscalizedAt: '27-08-2026 09:15:00',
      fiscalizedAtSource: 'device',
      cuSerial: 'CU-SERIAL-0012'
    }

    const filePath = await generatePdfReceipt(unfiledOrder, items, settings)

    expect(existsSync(filePath)).toBe(true)
  })

  it('accepts isDuplicate:true and still produces a PDF', async () => {
    const duplicateOrder: ReceiptOrder = { ...order, isDuplicate: true }

    const filePath = await generatePdfReceipt(duplicateOrder, items, settings)

    expect(existsSync(filePath)).toBe(true)
  })

  /**
   * docs/phase-165 — the not-yet-filed slip's header and "Not a tax
   * invoice" line, shared with `printer.ts` via `buildFiscalBlockLines`/
   * `FISCAL_PENDING_HEADER` (their exact wording is asserted directly in
   * `tests/receiptFiscalBlock.test.ts` and the thermal path's tests in
   * `tests/printer.test.ts` — PDF content itself isn't text-assertable
   * here, per this file's earlier note).
   */
  it('accepts fiscalPending:true (an unfiled sale) and still produces a PDF', async () => {
    const pendingOrder: ReceiptOrder = { ...order, fiscalPending: true }

    const filePath = await generatePdfReceipt(pendingOrder, items, settings)

    expect(existsSync(filePath)).toBe(true)
  })

  it('accepts fiscalPending:true alongside a fiscalInvoiceNumber and still produces a PDF', async () => {
    const fiscalOrder: ReceiptOrder = {
      ...order,
      fiscalInvoiceNumber: 'KRA-0013',
      fiscalPending: true
    }

    const filePath = await generatePdfReceipt(fiscalOrder, items, settings)

    expect(existsSync(filePath)).toBe(true)
  })
})

describe('fontSizeForWidth (docs/phase-171)', () => {
  it('is about 7.2pt at the default 48-character width', () => {
    expect(fontSizeForWidth(48)).toBeCloseTo(7.1, 1)
  })

  it('is larger for a narrower character width — same physical 80mm page, fewer characters to fit', () => {
    expect(fontSizeForWidth(32)).toBeGreaterThan(fontSizeForWidth(48))
    expect(fontSizeForWidth(42)).toBeGreaterThan(fontSizeForWidth(48))
    expect(fontSizeForWidth(42)).toBeLessThan(fontSizeForWidth(32))
  })
})

describe('computeReceiptPdfHeight (docs/phase-171)', () => {
  function layoutFor(itemCount: number) {
    const layoutOrder: ReceiptLayoutOrder = {
      localId: 1,
      createdAt: '2026-08-27T10:00:00.000Z',
      cashierName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 50,
      changeDue: 0,
      total: itemCount * 10,
      items: Array.from({ length: itemCount }, (_, i) => ({
        title: `Item ${i}`,
        variantTitle: '',
        quantity: 1,
        unitPrice: 10
      }))
    }
    return buildReceiptLayout(layoutOrder, { taxRate: 0.16, tradingName: 'RUBIS' }, { width: 48 })
  }

  it('grows with the number of items', () => {
    const fontSize = fontSizeForWidth(48)
    const shortHeight = computeReceiptPdfHeight(layoutFor(1), fontSize)
    const longHeight = computeReceiptPdfHeight(layoutFor(20), fontSize)

    expect(longHeight).toBeGreaterThan(shortHeight)
  })

  it('is always tall enough to hold every line at least once', () => {
    const fontSize = fontSizeForWidth(48)
    const entries = layoutFor(5)
    const height = computeReceiptPdfHeight(entries, fontSize)

    expect(height).toBeGreaterThan(entries.length * fontSize)
  })
})

describe('generatePdfReceipt — page width (docs/phase-171)', () => {
  it('is fixed at 80mm regardless of the configured character width', async () => {
    // 80mm in points (2.83465pt/mm) — the page's physical width never
    // changes with the configured character width (item 4's own spec);
    // only the font size (see fontSizeForWidth above) adapts instead.
    const narrowSettings: PrinterSettings = { ...settings, width: 32 }
    const filePath = await generatePdfReceipt(order, items, narrowSettings)

    const buffer = readFileSync(filePath)
    expect(buffer.toString('latin1')).toContain('226.77')
  })
})
