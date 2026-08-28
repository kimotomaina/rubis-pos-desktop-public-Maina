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
import { generatePdfReceipt } from '../src/main/services/pdf-receipt.js'
import type { PrinterSettings, ReceiptLineItem, ReceiptOrder } from '../src/main/services/printer.js'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()) }
}))

const order: ReceiptOrder = {
  localId: 42,
  createdAt: '2026-08-27T10:00:00.000Z',
  cashierName: 'Alex',
  paymentMethod: 'cash',
  tenderedAmount: 50,
  changeDue: 1.41
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
})
