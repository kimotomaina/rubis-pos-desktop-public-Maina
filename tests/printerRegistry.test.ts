/**
 * Multi-printer registry tests — multi-peripheral support.
 *
 * `node-thermal-printer` is never touched — a recording fake
 * implementing `ThermalPrinterLike` is injected via the `PrinterFactory`
 * parameter, the same pattern `printer.test.ts` uses for the original
 * single-printer flow.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  buildPrinterRegistry,
  resolvePrinterSettings,
  printReceiptToType,
  printTestPage
} from '../src/main/services/printer.js'
import type {
  PrinterSettings,
  ReceiptLineItem,
  ReceiptOrder,
  ThermalPrinterLike
} from '../src/main/services/printer.js'
import type { PrinterConfig } from '../src/main/services/database.js'

/** Builds a recording fake implementing the narrow ThermalPrinterLike surface. */
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

const defaultSettings: PrinterSettings = {
  interfaceName: 'tcp://192.168.0.50:9100',
  storeName: 'RUBIS',
  taxRate: 0.08
}

const receiptPrinter: PrinterConfig = {
  id: 'till-1',
  type: 'receipt',
  interfaceName: 'tcp://192.168.0.51:9100',
  enabled: true
}

const kitchenPrinter: PrinterConfig = {
  id: 'kitchen-1',
  type: 'kitchen',
  interfaceName: 'tcp://192.168.0.52:9100',
  enabled: true
}

const disabledLabelPrinter: PrinterConfig = {
  id: 'label-1',
  type: 'label',
  interfaceName: 'tcp://192.168.0.53:9100',
  enabled: false
}

describe('buildPrinterRegistry', () => {
  it('builds a Map keyed by printer id', () => {
    const registry = buildPrinterRegistry([receiptPrinter, kitchenPrinter])

    expect(registry.size).toBe(2)
    expect(registry.get('till-1')).toEqual(receiptPrinter)
    expect(registry.get('kitchen-1')).toEqual(kitchenPrinter)
  })

  it('builds an empty registry from an empty config list', () => {
    expect(buildPrinterRegistry([]).size).toBe(0)
  })

  it('later entries win when two configs share an id', () => {
    const updated: PrinterConfig = { ...receiptPrinter, interfaceName: 'tcp://10.0.0.9:9100' }
    const registry = buildPrinterRegistry([receiptPrinter, updated])

    expect(registry.size).toBe(1)
    expect(registry.get('till-1')?.interfaceName).toBe('tcp://10.0.0.9:9100')
  })
})

describe('resolvePrinterSettings', () => {
  it('falls back to defaultSettings when the registry is empty', () => {
    const registry = buildPrinterRegistry([])

    expect(resolvePrinterSettings(registry, 'receipt', defaultSettings)).toEqual(defaultSettings)
  })

  it('falls back to defaultSettings when no entry matches the requested type', () => {
    const registry = buildPrinterRegistry([kitchenPrinter])

    expect(resolvePrinterSettings(registry, 'receipt', defaultSettings)).toEqual(defaultSettings)
  })

  it('resolves to a registered printer of the matching type', () => {
    const registry = buildPrinterRegistry([receiptPrinter, kitchenPrinter])

    const resolved = resolvePrinterSettings(registry, 'kitchen', defaultSettings)

    expect(resolved.interfaceName).toBe(kitchenPrinter.interfaceName)
    expect(resolved.storeName).toBe(defaultSettings.storeName)
    expect(resolved.taxRate).toBe(defaultSettings.taxRate)
  })

  it('skips a disabled printer and falls back to defaultSettings', () => {
    const registry = buildPrinterRegistry([disabledLabelPrinter])

    expect(resolvePrinterSettings(registry, 'label', defaultSettings)).toEqual(defaultSettings)
  })
})

const order: ReceiptOrder = {
  localId: 1,
  createdAt: '2026-08-24T10:00:00.000Z',
  cashierName: 'Alex',
  paymentMethod: 'cash',
  tenderedAmount: 10,
  changeDue: 0
}

const items: ReceiptLineItem[] = [
  { title: 'Item', variantTitle: '', quantity: 1, unitPrice: 10 }
]

describe('printReceiptToType', () => {
  it('prints to the registered printer for the requested type', async () => {
    const { client } = createFakePrinter()
    const factory = vi.fn(() => client)
    const registry = buildPrinterRegistry([kitchenPrinter])

    const result = await printReceiptToType(
      order,
      items,
      registry,
      defaultSettings,
      'kitchen',
      factory
    )

    expect(factory).toHaveBeenCalledWith(kitchenPrinter.interfaceName)
    expect(result).toEqual({ success: true, data: { printed: true, mock: false } })
  })

  it('defaults to printerType "receipt" when omitted', async () => {
    const { client } = createFakePrinter()
    const factory = vi.fn(() => client)
    const registry = buildPrinterRegistry([receiptPrinter])

    await printReceiptToType(order, items, registry, defaultSettings, undefined, factory)

    expect(factory).toHaveBeenCalledWith(receiptPrinter.interfaceName)
  })

  it('falls back to defaultSettings when the till has no printers registered (backward compatibility)', async () => {
    const { client } = createFakePrinter()
    const factory = vi.fn(() => client)
    const emptyRegistry = buildPrinterRegistry([])

    await printReceiptToType(order, items, emptyRegistry, defaultSettings, 'receipt', factory)

    expect(factory).toHaveBeenCalledWith(defaultSettings.interfaceName)
  })
})

describe('printTestPage', () => {
  it('sends a test page and reports success when the printer connects', async () => {
    const { client, calls } = createFakePrinter({ connected: true })
    const factory = vi.fn(() => client)

    const result = await printTestPage('tcp://192.168.0.60:9100', factory)

    expect(factory).toHaveBeenCalledWith('tcp://192.168.0.60:9100')
    expect(result).toEqual({ success: true, data: { printed: true, mock: false } })
    const lineTexts = calls.filter((c) => c.method === 'println').map((c) => c.args[0])
    expect(lineTexts).toContain('TEST PAGE')
  })

  it('reports a friendly error when the printer is offline', async () => {
    const { client } = createFakePrinter({ connected: false })
    const factory = vi.fn(() => client)

    const result = await printTestPage('tcp://192.168.0.60:9100', factory)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/offline|unreachable/i)
  })

  it('translates a connection-refused error into a friendly message', async () => {
    const err = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })
    const { client } = createFakePrinter({ connected: true, executeError: err })
    const factory = vi.fn(() => client)

    const result = await printTestPage('tcp://192.168.0.60:9100', factory)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/unreachable/i)
  })
})
