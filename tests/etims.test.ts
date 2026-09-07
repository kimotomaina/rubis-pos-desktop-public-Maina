/**
 * eTIMS fiscalization placeholder tests.
 *
 * Exercises {@link MockFiscalizationProvider} directly — no real KRA
 * middleware exists yet; these tests pin down the
 * {@link FiscalizationProvider} contract and the idempotent
 * invoice-numbering behaviour the mock uses to stand in for a
 * store-and-forward queue.
 */

import { describe, it, expect } from 'vitest'
import { MockFiscalizationProvider } from '../src/main/services/integrations/mock-etims-provider.js'

const SAMPLE_REQUEST = {
  clientOrderUuid: '11111111-2222-3333-4444-555555555555',
  items: [{ description: 'Bread', quantity: 2, unitPrice: 60, taxRate: 0.16 }],
  total: 139.2,
  taxAmount: 19.2
}

describe('MockFiscalizationProvider.submitInvoice', () => {
  it('returns a dummy invoice number and a base64 placeholder QR code', async () => {
    const provider = new MockFiscalizationProvider(5)
    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(true)
    expect(result.ok && result.data.invoiceNumber).toMatch(/^KRA-MOCK-/)
    expect(() => Buffer.from(result.ok ? result.data.qrCode : '', 'base64')).not.toThrow()
    expect(
      Buffer.from(result.ok ? result.data.qrCode : '', 'base64').toString('utf8')
    ).toContain('[QR CODE]')
  })

  it('rejects a request with no line items', async () => {
    const provider = new MockFiscalizationProvider(5)
    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, items: [] })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/no line items/i)
  })

  it('rejects a request missing a clientOrderUuid', async () => {
    const provider = new MockFiscalizationProvider(5)
    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, clientOrderUuid: '' })

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/clientOrderUuid/i)
  })
})

describe('MockFiscalizationProvider.getInvoiceDetails / cancelInvoice', () => {
  it('reads back a submitted invoice by number', async () => {
    const provider = new MockFiscalizationProvider(5)
    const submitted = await provider.submitInvoice(SAMPLE_REQUEST)
    const invoiceNumber = submitted.ok ? submitted.data.invoiceNumber : ''

    const details = await provider.getInvoiceDetails(invoiceNumber)

    expect(details.success).toBe(true)
    expect(details.data?.invoiceNumber).toBe(invoiceNumber)
  })

  it('errors when reading an unknown invoice number', async () => {
    const provider = new MockFiscalizationProvider(5)
    const details = await provider.getInvoiceDetails('KRA-MOCK-UNKNOWN')

    expect(details.success).toBe(false)
  })

  it('cancels a submitted invoice so it can no longer be read back', async () => {
    const provider = new MockFiscalizationProvider(5)
    const submitted = await provider.submitInvoice(SAMPLE_REQUEST)
    const invoiceNumber = submitted.ok ? submitted.data.invoiceNumber : ''

    const cancelled = await provider.cancelInvoice(invoiceNumber)
    expect(cancelled.success).toBe(true)

    const details = await provider.getInvoiceDetails(invoiceNumber)
    expect(details.success).toBe(false)
  })

  it('errors when cancelling an unknown invoice number', async () => {
    const provider = new MockFiscalizationProvider(5)
    const cancelled = await provider.cancelInvoice('KRA-MOCK-UNKNOWN')
    expect(cancelled.success).toBe(false)
  })
})
