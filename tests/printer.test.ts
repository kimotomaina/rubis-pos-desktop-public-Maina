/**
 * Thermal printer service tests.
 *
 * `node-thermal-printer` is never touched — a recording fake
 * implementing {@link ThermalPrinterLike} is injected via the
 * `PrinterFactory` parameter, the same dependency-injection pattern
 * used for the Shopify axios client and the SQLite connection
 * elsewhere in this codebase.
 */

import { describe, it, expect, vi } from 'vitest'
import { ThermalPrinter } from 'node-thermal-printer'
import {
  printReceipt,
  renderReceipt,
  renderZReport,
  defaultPrinterFactory,
  PRINTER_CONNECT_TIMEOUT_MS
} from '../src/main/services/printer.js'
import type {
  PrinterSettings,
  ReceiptLineItem,
  ReceiptOrder,
  ThermalPrinterLike
} from '../src/main/services/printer.js'
import type { ZReport } from '../src/main/services/reports.js'
import { formatCurrency } from '../src/main/services/currency.js'

vi.mock('node-thermal-printer', () => ({
  ThermalPrinter: vi.fn(),
  PrinterTypes: { EPSON: 'epson' }
}))

/**
 * Builds a recording fake implementing the narrow ThermalPrinterLike
 * surface, capturing the exact ESC/POS call sequence for assertions.
 */
function createFakePrinter(options?: {
  connected?: boolean
  executeError?: unknown
  printImageBuffer?: ReturnType<typeof vi.fn>
}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const client: ThermalPrinterLike = {
    isPrinterConnected: vi.fn(async () => options?.connected ?? true),
    alignCenter: vi.fn(() => calls.push({ method: 'alignCenter', args: [] })),
    alignLeft: vi.fn(() => calls.push({ method: 'alignLeft', args: [] })),
    bold: vi.fn((enabled: boolean) => calls.push({ method: 'bold', args: [enabled] })),
    println: vi.fn((text: string) => calls.push({ method: 'println', args: [text] })),
    drawLine: vi.fn(() => calls.push({ method: 'drawLine', args: [] })),
    cut: vi.fn(() => calls.push({ method: 'cut', args: [] })),
    execute: vi.fn(async () => {
      if (options?.executeError) throw options.executeError
      return undefined
    }),
    ...(options?.printImageBuffer ? { printImageBuffer: options.printImageBuffer } : {})
  }
  return { client, calls }
}

const order: ReceiptOrder = {
  localId: 7,
  createdAt: '2026-08-24T10:00:00.000Z',
  cashierName: 'Alex',
  paymentMethod: 'cash',
  tenderedAmount: 50,
  changeDue: 1.41,
  // The amount actually charged (docs/phase-161) — no discount here, and
  // shelf prices already include VAT, so it equals the raw subtotal.
  total: 44.99
}

const items: ReceiptLineItem[] = [
  { title: 'RUBIS Mug', variantTitle: 'Small', quantity: 2, unitPrice: 12.5 },
  { title: 'RUBIS T-Shirt', variantTitle: '', quantity: 1, unitPrice: 19.99 }
]

const settings: PrinterSettings = {
  interfaceName: 'tcp://192.168.0.50:9100',
  storeName: 'RUBIS',
  taxRate: 0.08
}

describe('renderReceipt', () => {
  it('issues the ESC/POS call sequence: header, items, totals, footer', async () => {
    const { client, calls } = createFakePrinter()

    await renderReceipt(client, order, items, settings)

    expect(calls[0]).toEqual({ method: 'alignCenter', args: [] })
    expect(calls[1]).toEqual({ method: 'bold', args: [true] })
    expect(calls[2]).toEqual({ method: 'println', args: ['RUBIS'] })
    expect(calls[3]).toEqual({ method: 'bold', args: [false] })
    expect(calls[4]).toEqual({ method: 'println', args: ['Order #7'] })
    expect(calls.some((c) => c.method === 'println' && c.args[0] === 'Cashier: Alex')).toBe(true)

    const lineTexts = calls.filter((c) => c.method === 'println').map((c) => c.args[0])
    expect(lineTexts).toContain('RUBIS Mug (Small) x2')
    expect(lineTexts).toContain(`  ${formatCurrency(25)}`)
    expect(lineTexts).toContain('RUBIS T-Shirt x1')
    expect(lineTexts).toContain(`  ${formatCurrency(19.99)}`)

    /**
     * DELIBERATE TEST CHANGE (docs/phase-161 Commit 2, docs/phase-160 Part A):
     * this order carries no discount, and shelf prices already include VAT
     * (docs/phase-158), so the correct total is the order's own stored
     * total (44.99, unchanged from the raw subtotal) — not the old
     * added-on-top figure.
     *   Old assertions: `Tax: 3.60` (44.99 * 0.08, added on top),
     *     `Total: 48.59` (subtotal + that tax).
     *   New assertions: no "Discount:" line (nothing was discounted),
     *     `Total: 44.99` (the stored total, never recomputed), and
     *     `VAT included (calculated at 8%): 3.33` (44.99 * 0.08 / 1.08,
     *     the VAT already inside 44.99, extracted rather than added).
     */
    expect(lineTexts).toContain(`Subtotal: ${formatCurrency(44.99)}`)
    expect(lineTexts.some((t) => typeof t === 'string' && t.startsWith('Discount:'))).toBe(false)
    expect(lineTexts).toContain(`Total: ${formatCurrency(44.99)}`)
    expect(lineTexts).toContain(`VAT included (calculated at 8%): ${formatCurrency(3.33)}`)
    expect(lineTexts).toContain('Payment: cash')
    expect(lineTexts).toContain(`Tendered: ${formatCurrency(50)}`)
    expect(lineTexts).toContain(`Change: ${formatCurrency(1.41)}`)
    expect(lineTexts).toContain('Thank you!')

    expect(calls[calls.length - 1]).toEqual({ method: 'cut', args: [] })
  })

  it('prints a reference number instead of tendered/change for non-cash payments', async () => {
    const { client, calls } = createFakePrinter()
    const cardOrder: ReceiptOrder = {
      ...order,
      paymentMethod: 'card',
      tenderedAmount: 48.59,
      changeDue: 0,
      referenceNumber: 'TXN-9001'
    }

    await renderReceipt(client, cardOrder, items, settings)

    const lineTexts = calls.filter((c) => c.method === 'println').map((c) => c.args[0])
    expect(lineTexts).toContain('Payment: card')
    expect(lineTexts).toContain('Ref: TXN-9001')
    expect(lineTexts.some((t) => typeof t === 'string' && t.startsWith('Tendered:'))).toBe(false)
  })

  it('bolds only the store name and the total, not the item lines', async () => {
    const { client, calls } = createFakePrinter()
    await renderReceipt(client, order, items, settings)

    const boldCalls = calls.filter((c) => c.method === 'bold')
    expect(boldCalls).toEqual([
      { method: 'bold', args: [true] },
      { method: 'bold', args: [false] },
      { method: 'bold', args: [true] },
      { method: 'bold', args: [false] }
    ])
  })

  it('omits the fiscal footer entirely when the order was not fiscalized', async () => {
    const { client, calls } = createFakePrinter()
    await renderReceipt(client, order, items, settings)

    const lineTexts = calls.filter((c) => c.method === 'println').map((c) => c.args[0])
    expect(lineTexts.some((t) => typeof t === 'string' && t.startsWith('Fiscal Inv:'))).toBe(false)
  })

  it('prints the fiscal invoice number and the QR code as an image when supported', async () => {
    const printImageBuffer = vi.fn().mockResolvedValue(undefined)
    const { client, calls } = createFakePrinter({ printImageBuffer })
    const fiscalOrder: ReceiptOrder = {
      ...order,
      fiscalInvoiceNumber: 'KRA-0001',
      fiscalQrCode: Buffer.from('fake-png-bytes').toString('base64')
    }

    await renderReceipt(client, fiscalOrder, items, settings)

    const lineTexts = calls.filter((c) => c.method === 'println').map((c) => c.args[0])
    expect(lineTexts).toContain('Fiscal Inv: KRA-0001')
    expect(printImageBuffer).toHaveBeenCalledTimes(1)
    expect(printImageBuffer).toHaveBeenCalledWith(Buffer.from('fake-png-bytes'))
    expect(lineTexts.some((t) => typeof t === 'string' && t.startsWith('[QR CODE:'))).toBe(false)
  })

  it('falls back to a text placeholder when the client has no image support', async () => {
    const { client, calls } = createFakePrinter()
    const fiscalOrder: ReceiptOrder = {
      ...order,
      fiscalInvoiceNumber: 'KRA-0002',
      fiscalQrCode: Buffer.from('fake-png-bytes').toString('base64')
    }

    await renderReceipt(client, fiscalOrder, items, settings)

    const lineTexts = calls.filter((c) => c.method === 'println').map((c) => c.args[0])
    expect(lineTexts).toContain('[QR CODE: KRA-0002]')
  })

  it('falls back to a text placeholder when image printing throws', async () => {
    const printImageBuffer = vi.fn().mockRejectedValue(new Error('unsupported image format'))
    const { client, calls } = createFakePrinter({ printImageBuffer })
    const fiscalOrder: ReceiptOrder = {
      ...order,
      fiscalInvoiceNumber: 'KRA-0003',
      fiscalQrCode: 'not-a-real-png'
    }

    await renderReceipt(client, fiscalOrder, items, settings)

    const lineTexts = calls.filter((c) => c.method === 'println').map((c) => c.args[0])
    expect(lineTexts).toContain('[QR CODE: KRA-0003]')
  })

  it('prints only the invoice number line when no QR code is present', async () => {
    const { client, calls } = createFakePrinter()
    const fiscalOrder: ReceiptOrder = { ...order, fiscalInvoiceNumber: 'KRA-0004' }

    await renderReceipt(client, fiscalOrder, items, settings)

    const lineTexts = calls.filter((c) => c.method === 'println').map((c) => c.args[0])
    expect(lineTexts).toContain('Fiscal Inv: KRA-0004')
    expect(lineTexts.some((t) => typeof t === 'string' && t.startsWith('[QR CODE:'))).toBe(false)
  })

  it('prints the discount line and the stored total, not a recomputed one (docs/phase-160/161)', async () => {
    const { client, calls } = createFakePrinter()
    const discountedItems: ReceiptLineItem[] = [
      { title: 'RUBIS Mug', variantTitle: 'Small', quantity: 2, unitPrice: 100, discount: { type: 'fixed', value: 10 } }
    ]
    const discountedOrder: ReceiptOrder = { ...order, total: 190 }

    await renderReceipt(client, discountedOrder, discountedItems, settings)

    const lineTexts = calls.filter((c) => c.method === 'println').map((c) => c.args[0])
    expect(lineTexts).toContain(`Subtotal: ${formatCurrency(200)}`)
    expect(lineTexts).toContain(`Discount: -${formatCurrency(10)}`)
    expect(lineTexts).toContain(`Total: ${formatCurrency(190)}`)
  })

  it('omits the discount line entirely when nothing was discounted', async () => {
    const { client, calls } = createFakePrinter()
    await renderReceipt(client, order, items, settings)

    const lineTexts = calls.filter((c) => c.method === 'println').map((c) => c.args[0])
    expect(lineTexts.some((t) => typeof t === 'string' && t.startsWith('Discount:'))).toBe(false)
  })
})

describe('renderZReport (docs/phase-158-1)', () => {
  const baseReport: ZReport = {
    shiftId: 7,
    staffName: 'Ann',
    openedAt: '2026-09-01T08:00:00.000Z',
    closedAt: '2026-09-01T16:00:00.000Z',
    status: 'closed',
    startingCash: 100,
    totalsByMethod: { cash: 200, mpesa: 80, card: 0 },
    mpesaByMode: { manual: 30, daraja: 50 },
    orderCount: 5,
    totalRevenue: 280,
    vatIncluded: 38.62,
    vatRate: 0.16,
    expectedCash: 300,
    endingCash: 300,
    discrepancy: 0
  }

  it('labels the VAT line from the report\'s own rate, not a hardcoded 16%', () => {
    const { client, calls } = createFakePrinter()

    renderZReport(client, baseReport, settings)

    const lineTexts = calls.filter((c) => c.method === 'println').map((c) => c.args[0])
    expect(lineTexts).toContain(`VAT included (calculated at 16%): ${formatCurrency(38.62)}`)
  })

  it('relabels correctly at an 8% rate', () => {
    const { client, calls } = createFakePrinter()
    const report: ZReport = { ...baseReport, vatRate: 0.08, vatIncluded: 20.74 }

    renderZReport(client, report, settings)

    const lineTexts = calls.filter((c) => c.method === 'println').map((c) => c.args[0])
    expect(lineTexts).toContain(`VAT included (calculated at 8%): ${formatCurrency(20.74)}`)
    expect(lineTexts.some((t) => typeof t === 'string' && t.includes('16%'))).toBe(false)
  })
})

describe('printReceipt', () => {
  it('sends the receipt when the printer reports connected', async () => {
    const { client, calls } = createFakePrinter({ connected: true })
    const factory = vi.fn(() => client)

    const result = await printReceipt(order, items, settings, factory)

    expect(factory).toHaveBeenCalledWith(settings.interfaceName)
    expect(result).toEqual({ success: true, data: { printed: true, mock: false } })
    expect(calls.some((c) => c.method === 'cut')).toBe(true)
    expect(client.execute).toHaveBeenCalledTimes(1)
  })

  it('falls back to a PDF receipt when the printer reports offline', async () => {
    const { client } = createFakePrinter({ connected: false })
    const factory = vi.fn(() => client)
    const pdfGenerator = vi.fn(async () => 'C:\\Users\\cashier\\Desktop\\RUBIS_Receipt_Order_7.pdf')

    const result = await printReceipt(order, items, settings, factory, pdfGenerator)

    expect(client.execute).not.toHaveBeenCalled()
    expect(pdfGenerator).toHaveBeenCalledWith(order, items, settings)
    expect(result).toEqual({
      success: true,
      data: {
        printed: false,
        mock: false,
        mode: 'pdf',
        filePath: 'C:\\Users\\cashier\\Desktop\\RUBIS_Receipt_Order_7.pdf'
      }
    })
  })

  it('falls back to a PDF receipt when execute() throws a connection-refused error', async () => {
    const err = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })
    const { client } = createFakePrinter({ connected: true, executeError: err })
    const factory = vi.fn(() => client)
    const pdfGenerator = vi.fn(async () => 'C:\\Users\\cashier\\Desktop\\RUBIS_Receipt_Order_7.pdf')

    const result = await printReceipt(order, items, settings, factory, pdfGenerator)

    expect(pdfGenerator).toHaveBeenCalledWith(order, items, settings)
    expect(result.success).toBe(true)
    expect(result.data?.mode).toBe('pdf')
  })

  it('reports a failure if the printer is offline and PDF generation itself throws', async () => {
    const { client } = createFakePrinter({ connected: false })
    const factory = vi.fn(() => client)
    const pdfGenerator = vi.fn(async () => {
      throw new Error('disk full')
    })

    const result = await printReceipt(order, items, settings, factory, pdfGenerator)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/disk full/i)
  })

  it('translates an out-of-paper style error message', async () => {
    const err = new Error('Printer out of paper')
    const { client } = createFakePrinter({ connected: true, executeError: err })
    const factory = vi.fn(() => client)

    const result = await printReceipt(order, items, settings, factory)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/paper/i)
  })

  it('never calls the factory or isPrinterConnected in mock mode', async () => {
    const factory = vi.fn()
    const mockSettings: PrinterSettings = { ...settings, mock: true }

    const result = await printReceipt(order, items, mockSettings, factory)

    expect(factory).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true, data: { printed: true, mock: true } })
  })

  it('logs the formatted receipt to the console in mock mode', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const mockSettings: PrinterSettings = { ...settings, mock: true }

    await printReceipt(order, items, mockSettings)

    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = logSpy.mock.calls[0][0] as string
    expect(logged).toContain('Order #7')
    // DELIBERATE TEST CHANGE (docs/phase-161 Commit 2, same reasoning as
    // the "issues the ESC/POS call sequence" test above): old assertion
    // `Total: 48.59` (the old added-on-top figure); new assertion
    // `Total: 44.99` (the order's own stored total, unchanged since
    // there is no discount here).
    expect(logged).toContain(`Total: ${formatCurrency(44.99)}`)

    logSpy.mockRestore()
  })

  it('translates a socket timeout error from execute() into a friendly message', async () => {
    const err = new Error('Socket timeout')
    const { client } = createFakePrinter({ connected: true, executeError: err })
    const factory = vi.fn(() => client)

    const result = await printReceipt(order, items, settings, factory)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/timed out/i)
  })
})

describe('defaultPrinterFactory', () => {
  it('constructs the ThermalPrinter client with a strict 3-second connect/socket timeout', () => {
    defaultPrinterFactory('tcp://192.168.0.50:9100')

    expect(PRINTER_CONNECT_TIMEOUT_MS).toBe(3000)
    expect(ThermalPrinter).toHaveBeenCalledWith(
      expect.objectContaining({
        interface: 'tcp://192.168.0.50:9100',
        options: { timeout: PRINTER_CONNECT_TIMEOUT_MS }
      })
    )
  })
})
