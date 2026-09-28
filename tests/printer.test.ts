/**
 * Thermal printer service tests.
 *
 * `node-thermal-printer` is never touched — a recording fake
 * implementing {@link ThermalPrinterLike} is injected via the
 * `PrinterFactory` parameter, the same dependency-injection pattern
 * used by the Shopify axios client and the SQLite connection
 * elsewhere in this codebase.
 *
 * `renderReceipt` (docs/phase-171) no longer owns any receipt content —
 * it only translates `buildReceiptLayout`'s array into ESC/POS calls, so
 * this file tests that translation (the wiring), not the content, which
 * `tests/receiptLayout.test.ts` covers exhaustively.
 */

import { describe, it, expect, vi } from 'vitest'
import { ThermalPrinter } from 'node-thermal-printer'
import {
  printReceipt,
  printReceiptToType,
  printWindowsTestPage,
  renderReceipt,
  renderZReport,
  defaultPrinterFactory,
  buildPrinterRegistry,
  PRINTER_CONNECT_TIMEOUT_MS,
  shouldMarkReceiptPrinted,
  shouldShowFiscalPendingSlip,
  shouldOpenPdfFallbackViewer
} from '../src/main/services/printer.js'
import type {
  PrinterSettings,
  ReceiptLineItem,
  ReceiptOrder,
  ThermalPrinterLike
} from '../src/main/services/printer.js'
import type { ZReport } from '../src/main/services/reports.js'
import type { PrinterConfig } from '../src/main/services/database.js'
import { formatCurrency } from '../src/main/services/currency.js'
import { buildReceiptLayout, isReceiptLayoutQr } from '../src/main/lib/receiptLayout.js'
import type { ReceiptLayoutOrder } from '../src/main/lib/receiptLayout.js'

/**
 * `createBufferClient` (docs/phase-174, the Windows route) constructs a
 * real `ThermalPrinter` with no `interface` — this fake gives it just
 * enough behaviour (formatting no-ops + `getBuffer()`) to render
 * through `renderReceipt`/the test-slip renderer without touching real
 * ESC/POS encoding. `ThermalPrinter` stays a `vi.fn()` spy so the
 * existing `defaultPrinterFactory` constructor-args test still holds.
 */
class FakeBufferPrinter {
  private lines: string[] = []
  alignCenter(): void {}
  alignLeft(): void {}
  alignRight(): void {}
  bold(): void {}
  setTextNormal(): void {}
  setTextQuadArea(): void {}
  println(text: string): void {
    this.lines.push(text)
  }
  drawLine(): void {}
  cut(): void {}
  printQR(text: string): void {
    this.lines.push(`[QR: ${text}]`)
  }
  async execute(): Promise<undefined> {
    return undefined
  }
  async isPrinterConnected(): Promise<boolean> {
    return true
  }
  getBuffer(): Buffer {
    return Buffer.from(this.lines.join('\n'))
  }
}

vi.mock('node-thermal-printer', () => ({
  ThermalPrinter: vi.fn(() => new FakeBufferPrinter()),
  PrinterTypes: { EPSON: 'epson' }
}))

/**
 * Builds a recording fake implementing the narrow ThermalPrinterLike
 * surface, capturing the exact ESC/POS call sequence for assertions.
 */
function createFakePrinter(options?: {
  connected?: boolean
  executeError?: unknown
  /** Defaults to true — real hardware always has this command (docs/phase-171's audit). */
  supportsPrintQR?: boolean
  printImageBuffer?: ReturnType<typeof vi.fn>
}) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const printQR = vi.fn((text: string) => calls.push({ method: 'printQR', args: [text] }))
  const client: ThermalPrinterLike = {
    isPrinterConnected: vi.fn(async () => options?.connected ?? true),
    alignCenter: vi.fn(() => calls.push({ method: 'alignCenter', args: [] })),
    alignLeft: vi.fn(() => calls.push({ method: 'alignLeft', args: [] })),
    alignRight: vi.fn(() => calls.push({ method: 'alignRight', args: [] })),
    bold: vi.fn((enabled: boolean) => calls.push({ method: 'bold', args: [enabled] })),
    setTextNormal: vi.fn(() => calls.push({ method: 'setTextNormal', args: [] })),
    setTextQuadArea: vi.fn(() => calls.push({ method: 'setTextQuadArea', args: [] })),
    println: vi.fn((text: string) => calls.push({ method: 'println', args: [text] })),
    drawLine: vi.fn(() => calls.push({ method: 'drawLine', args: [] })),
    cut: vi.fn(() => calls.push({ method: 'cut', args: [] })),
    execute: vi.fn(async () => {
      if (options?.executeError) throw options.executeError
      return undefined
    }),
    ...(options?.supportsPrintQR === false ? {} : { printQR }),
    ...(options?.printImageBuffer ? { printImageBuffer: options.printImageBuffer } : {})
  }
  return { client, calls, printQR }
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

/** Rebuilds the same layout `renderReceipt` builds internally, for wiring assertions. */
function expectedLayout(o: ReceiptOrder, lines: ReceiptLineItem[], s: PrinterSettings) {
  const layoutOrder: ReceiptLayoutOrder = {
    ...o,
    items: lines.map((item) => ({
      title: item.title,
      variantTitle: item.variantTitle,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discount: item.discount,
      vatClass: item.vatClass
    }))
  }
  return buildReceiptLayout(
    layoutOrder,
    {
      taxRate: s.taxRate,
      tradingName: s.storeName,
      legalName: s.legalName,
      address: s.address,
      phone: s.phone,
      sellerPin: s.storeKraPin,
      footerMessage: s.footerMessage
    },
    { width: s.width }
  )
}

describe('renderReceipt — wiring (docs/phase-171)', () => {
  it('translates every layout entry into its matching ESC/POS calls, in order', async () => {
    const { client, calls } = createFakePrinter()
    const fiscalOrder: ReceiptOrder = {
      ...order,
      fiscalInvoiceNumber: 'KRA-0001',
      fiscalQrCode: 'https://itax.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=abc123'
    }

    await renderReceipt(client, fiscalOrder, items, settings)

    const entries = expectedLayout(fiscalOrder, items, settings)
    let i = 0
    for (const entry of entries) {
      if (isReceiptLayoutQr(entry)) {
        expect(calls[i]).toEqual({ method: 'printQR', args: [entry.qr] })
        i += 1
        continue
      }
      const alignMethod =
        entry.align === 'left' ? 'alignLeft' : entry.align === 'right' ? 'alignRight' : 'alignCenter'
      expect(calls[i]).toEqual({ method: alignMethod, args: [] })
      i += 1
      if (entry.style === 'double') {
        expect(calls[i]).toEqual({ method: 'setTextQuadArea', args: [] })
        expect(calls[i + 1]).toEqual({ method: 'bold', args: [true] })
        expect(calls[i + 2]).toEqual({ method: 'println', args: [entry.text] })
        expect(calls[i + 3]).toEqual({ method: 'bold', args: [false] })
        expect(calls[i + 4]).toEqual({ method: 'setTextNormal', args: [] })
        i += 5
      } else if (entry.style === 'bold') {
        expect(calls[i]).toEqual({ method: 'bold', args: [true] })
        expect(calls[i + 1]).toEqual({ method: 'println', args: [entry.text] })
        expect(calls[i + 2]).toEqual({ method: 'bold', args: [false] })
        i += 3
      } else {
        expect(calls[i]).toEqual({ method: 'println', args: [entry.text] })
        i += 1
      }
    }
    expect(calls[calls.length - 1]).toEqual({ method: 'cut', args: [] })
  })

  it('prints the QR entry with the native printQR command, receiving the exact stored text', async () => {
    const { client, calls, printQR } = createFakePrinter()
    const fiscalOrder: ReceiptOrder = {
      ...order,
      fiscalInvoiceNumber: 'KRA-0002',
      fiscalQrCode: 'https://itax.kra.go.ke/verify/xyz789'
    }

    await renderReceipt(client, fiscalOrder, items, settings)

    expect(printQR).toHaveBeenCalledTimes(1)
    expect(printQR).toHaveBeenCalledWith('https://itax.kra.go.ke/verify/xyz789')
    // Never falls back to the text placeholder when the native command exists.
    const lineTexts = calls.filter((c) => c.method === 'println').map((c) => c.args[0])
    expect(lineTexts.some((t) => typeof t === 'string' && t.startsWith('[QR:'))).toBe(false)
  })

  it('falls back to a text placeholder when the client has no printQR command', async () => {
    const { client, calls } = createFakePrinter({ supportsPrintQR: false })
    const fiscalOrder: ReceiptOrder = {
      ...order,
      fiscalInvoiceNumber: 'KRA-0003',
      fiscalQrCode: 'https://itax.kra.go.ke/verify/qr-text'
    }

    await renderReceipt(client, fiscalOrder, items, settings)

    const lineTexts = calls.filter((c) => c.method === 'println').map((c) => c.args[0])
    expect(lineTexts).toContain('[QR: https://itax.kra.go.ke/verify/qr-text]')
  })

  it('prints no QR entry, and calls printQR zero times, when no QR text is stored', async () => {
    const { client, printQR } = createFakePrinter()
    const fiscalOrder: ReceiptOrder = { ...order, fiscalInvoiceNumber: 'KRA-0004' }

    await renderReceipt(client, fiscalOrder, items, settings)

    expect(printQR).not.toHaveBeenCalled()
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
    expect(logged).toContain('RUBIS')
    // DELIBERATE TEST CHANGE (docs/phase-171): the receipt no longer
    // prints a "Total:" label — the new layout's headline total line
    // reads "TOTAL KSH <amount>" (see receiptLayout.ts section (e)).
    // Old assertion: `logged` contains `Total: Ksh 44.99`.
    expect(logged).toContain('TOTAL KSH')
    expect(logged).toContain('44.99')

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

describe('shouldMarkReceiptPrinted (docs/phase-164-1)', () => {
  it('is true for a physical print of a fiscalised order', () => {
    expect(
      shouldMarkReceiptPrinted({ success: true, data: { printed: true, mock: false } }, 'KRA-0001')
    ).toBe(true)
  })

  it('is true for a mock-mode print of a fiscalised order (mock stands in for the real printer, not the PDF fallback)', () => {
    expect(
      shouldMarkReceiptPrinted({ success: true, data: { printed: true, mock: true } }, 'KRA-0001')
    ).toBe(true)
  })

  it('is false for a PDF fallback print, even of a fiscalised order', () => {
    expect(
      shouldMarkReceiptPrinted(
        { success: true, data: { printed: false, mock: false, mode: 'pdf', filePath: 'C:\\Desktop\\r.pdf' } },
        'KRA-0001'
      )
    ).toBe(false)
  })

  it('is false for a physical print of an unfiled order (no fiscalInvoiceNumber)', () => {
    expect(
      shouldMarkReceiptPrinted({ success: true, data: { printed: true, mock: false } }, undefined)
    ).toBe(false)
    expect(
      shouldMarkReceiptPrinted({ success: true, data: { printed: true, mock: false } }, null)
    ).toBe(false)
  })

  it('is false for a failed print attempt, whatever the order', () => {
    expect(shouldMarkReceiptPrinted({ success: false, error: 'Printer offline' }, 'KRA-0001')).toBe(false)
  })
})

describe('shouldShowFiscalPendingSlip (docs/phase-165)', () => {
  it('is true on the real provider for a waiting sale', () => {
    expect(shouldShowFiscalPendingSlip(true, 'waiting')).toBe(true)
  })

  it('is true on the real provider for a needs_fixing sale', () => {
    expect(shouldShowFiscalPendingSlip(true, 'needs_fixing')).toBe(true)
  })

  it('is true on the real provider when fiscalization was never attempted (null)', () => {
    expect(shouldShowFiscalPendingSlip(true, null)).toBe(true)
  })

  it('is false on the real provider once fiscalised', () => {
    expect(shouldShowFiscalPendingSlip(true, 'fiscalized')).toBe(false)
  })

  it('is false on the mock/non-eTIMS provider, whatever the fiscal status', () => {
    expect(shouldShowFiscalPendingSlip(false, 'waiting')).toBe(false)
    expect(shouldShowFiscalPendingSlip(false, null)).toBe(false)
    expect(shouldShowFiscalPendingSlip(false, 'fiscalized')).toBe(false)
  })
})

describe('shouldOpenPdfFallbackViewer (docs/phase-165)', () => {
  it('is true for a manual print (auto omitted or false)', () => {
    expect(shouldOpenPdfFallbackViewer(undefined)).toBe(true)
    expect(shouldOpenPdfFallbackViewer(false)).toBe(true)
  })

  it('is false for the automatic end-of-sale print', () => {
    expect(shouldOpenPdfFallbackViewer(true)).toBe(false)
  })
})

describe('printReceipt — Windows route (docs/phase-174)', () => {
  const windowsSettings: PrinterSettings = {
    ...settings,
    interfaceName: 'EPSON-TM-T88',
    connectionType: 'windows'
  }

  it('sends the rendered ESC/POS buffer to the named Windows queue, never touching the network factory', async () => {
    const windowsSender = vi.fn(async () => undefined)
    const networkFactory = vi.fn()

    const result = await printReceipt(
      order,
      items,
      windowsSettings,
      networkFactory,
      undefined,
      windowsSender
    )

    expect(networkFactory).not.toHaveBeenCalled()
    expect(windowsSender).toHaveBeenCalledTimes(1)
    expect(windowsSender).toHaveBeenCalledWith('EPSON-TM-T88', expect.any(Buffer))
    expect(result).toEqual({ success: true, data: { printed: true, mock: false } })
  })

  it('falls back to a PDF receipt when the Windows queue is missing', async () => {
    const windowsSender = vi.fn(async () => {
      throw new Error("The printer name is invalid, or the specified printer is no longer installed")
    })
    const pdfGenerator = vi.fn(async () => 'C:\\Users\\cashier\\Desktop\\RUBIS_Receipt_Order_7.pdf')

    const result = await printReceipt(
      order,
      items,
      windowsSettings,
      defaultPrinterFactory,
      pdfGenerator,
      windowsSender
    )

    expect(pdfGenerator).toHaveBeenCalledWith(order, items, windowsSettings)
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

  it('falls back to a PDF receipt when the send times out', async () => {
    const windowsSender = vi.fn(async () => {
      throw Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' })
    })
    const pdfGenerator = vi.fn(async () => 'C:\\Users\\cashier\\Desktop\\RUBIS_Receipt_Order_7.pdf')

    const result = await printReceipt(
      order,
      items,
      windowsSettings,
      defaultPrinterFactory,
      pdfGenerator,
      windowsSender
    )

    expect(result.success).toBe(true)
    expect(result.data?.mode).toBe('pdf')
  })

  it('never blocks the sale: a PDF-generation failure alongside a missing queue still returns a clear error, not a throw', async () => {
    const windowsSender = vi.fn(async () => {
      throw new Error('missing queue')
    })
    const pdfGenerator = vi.fn(async () => {
      throw new Error('disk full')
    })

    const result = await printReceipt(
      order,
      items,
      windowsSettings,
      defaultPrinterFactory,
      pdfGenerator,
      windowsSender
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/disk full/i)
  })

  it('stays on the mock sink when mock: true, even with connectionType windows (mock always wins)', async () => {
    const windowsSender = vi.fn(async () => undefined)
    const mockWindowsSettings: PrinterSettings = { ...windowsSettings, mock: true }

    const result = await printReceipt(
      order,
      items,
      mockWindowsSettings,
      defaultPrinterFactory,
      undefined,
      windowsSender
    )

    expect(windowsSender).not.toHaveBeenCalled()
    expect(result).toEqual({ success: true, data: { printed: true, mock: true } })
  })
})

describe('printReceiptToType — Windows route (docs/phase-174)', () => {
  it('resolves a registered windows-connection printer and routes through the Windows sender', async () => {
    const windowsSender = vi.fn(async () => undefined)
    const networkFactory = vi.fn()
    const windowsConfig: PrinterConfig = {
      id: 'till-1',
      type: 'receipt',
      interfaceName: 'EPSON-TM-T88',
      enabled: true,
      connectionType: 'windows'
    }
    const registry = buildPrinterRegistry([windowsConfig])

    await printReceiptToType(
      order,
      items,
      registry,
      settings,
      'receipt',
      networkFactory,
      undefined,
      windowsSender
    )

    expect(networkFactory).not.toHaveBeenCalled()
    expect(windowsSender).toHaveBeenCalledWith('EPSON-TM-T88', expect.any(Buffer))
  })
})

describe('printWindowsTestPage (docs/phase-174)', () => {
  it('sends a slip with the store name, date, and "Test print" RAW to the named queue', async () => {
    const windowsSender = vi.fn<(printerName: string, buffer: Buffer) => Promise<void>>(
      async () => undefined
    )

    const result = await printWindowsTestPage('EPSON-TM-T88', 'RUBIS Westlands', windowsSender)

    expect(windowsSender).toHaveBeenCalledWith('EPSON-TM-T88', expect.any(Buffer))
    const sentText = (windowsSender.mock.calls[0][1] as Buffer).toString()
    expect(sentText).toContain('RUBIS Westlands')
    expect(sentText).toContain('Test print')
    expect(result).toEqual({ success: true, data: { printed: true, mock: false } })
  })

  it('reports a clear failure when the queue is missing — no PDF fallback for a bare test print', async () => {
    const windowsSender = vi.fn(async () => {
      throw new Error('printer not found')
    })

    const result = await printWindowsTestPage('EPSON-TM-T88', 'RUBIS Westlands', windowsSender)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/printer not found/i)
  })
})
