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
  defaultPrinterFactory,
  PRINTER_CONNECT_TIMEOUT_MS
} from '../src/main/services/printer.js'
import type {
  PrinterSettings,
  ReceiptLineItem,
  ReceiptOrder,
  ThermalPrinterLike
} from '../src/main/services/printer.js'
import { formatCurrency } from '../src/main/services/currency.js'

vi.mock('node-thermal-printer', () => ({
  ThermalPrinter: vi.fn(),
  PrinterTypes: { EPSON: 'epson' }
}))

/**
 * Builds a recording fake implementing the narrow ThermalPrinterLike
 * surface, capturing the exact ESC/POS call sequence for assertions.
 */
function createFakePrinter(options?: { connected?: boolean; executeError?: unknown }) {
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
    })
  }
  return { client, calls }
}

const order: ReceiptOrder = {
  localId: 7,
  createdAt: '2026-08-24T10:00:00.000Z',
  cashierName: 'Alex',
  paymentMethod: 'cash',
  tenderedAmount: 50,
  changeDue: 1.41
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
  it('issues the ESC/POS call sequence: header, items, totals, footer', () => {
    const { client, calls } = createFakePrinter()

    renderReceipt(client, order, items, settings)

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

    // subtotal = 25 + 19.99 = 44.99; tax = 44.99 * 0.08 = 3.5992 -> 3.60; total = 48.59
    expect(lineTexts).toContain(`Subtotal: ${formatCurrency(44.99)}`)
    expect(lineTexts).toContain(`Tax: ${formatCurrency(3.5992)}`)
    expect(lineTexts).toContain(`Total: ${formatCurrency(48.59)}`)
    expect(lineTexts).toContain('Payment: cash')
    expect(lineTexts).toContain(`Tendered: ${formatCurrency(50)}`)
    expect(lineTexts).toContain(`Change: ${formatCurrency(1.41)}`)
    expect(lineTexts).toContain('Thank you!')

    expect(calls[calls.length - 1]).toEqual({ method: 'cut', args: [] })
  })

  it('prints a reference number instead of tendered/change for non-cash payments', () => {
    const { client, calls } = createFakePrinter()
    const cardOrder: ReceiptOrder = {
      ...order,
      paymentMethod: 'card',
      tenderedAmount: 48.59,
      changeDue: 0,
      referenceNumber: 'TXN-9001'
    }

    renderReceipt(client, cardOrder, items, settings)

    const lineTexts = calls.filter((c) => c.method === 'println').map((c) => c.args[0])
    expect(lineTexts).toContain('Payment: card')
    expect(lineTexts).toContain('Ref: TXN-9001')
    expect(lineTexts.some((t) => typeof t === 'string' && t.startsWith('Tendered:'))).toBe(false)
  })

  it('bolds only the store name and the total, not the item lines', () => {
    const { client, calls } = createFakePrinter()
    renderReceipt(client, order, items, settings)

    const boldCalls = calls.filter((c) => c.method === 'bold')
    expect(boldCalls).toEqual([
      { method: 'bold', args: [true] },
      { method: 'bold', args: [false] },
      { method: 'bold', args: [true] },
      { method: 'bold', args: [false] }
    ])
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

  it('fails gracefully when the printer is offline', async () => {
    const { client } = createFakePrinter({ connected: false })
    const factory = vi.fn(() => client)

    const result = await printReceipt(order, items, settings, factory)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/offline|unreachable/i)
    expect(client.execute).not.toHaveBeenCalled()
  })

  it('translates a connection-refused error from execute()', async () => {
    const err = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })
    const { client } = createFakePrinter({ connected: true, executeError: err })
    const factory = vi.fn(() => client)

    const result = await printReceipt(order, items, settings, factory)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unreachable/i)
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
    expect(logged).toContain(`Total: ${formatCurrency(48.59)}`)

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
