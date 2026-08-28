/**
 * Real eTIMS provider tests.
 *
 * Injects a mock `AxiosInstance` (matching the pattern already used in
 * `shopifyService.test.ts`) so the stateful OpenInvoice → SellPLU →
 * CloseReceipt flow — its configurable endpoint paths, XML payload
 * shapes, and CancelReceipt rollback on failure — can be asserted
 * without a real ZFPLabServer running. The device speaks XML, not
 * JSON, so every mocked response here is an XML string and every
 * payload assertion checks the serialized XML body.
 */

import { describe, it, expect, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import {
  RealFiscalizationProvider,
  DEFAULT_FISCAL_ENDPOINTS
} from '../src/main/services/integrations/real-etims-provider.js'
import type { FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'

function makeMockClient(postImpl: ReturnType<typeof vi.fn>): AxiosInstance {
  return { post: postImpl } as unknown as AxiosInstance
}

/** Builds a successful XML response body from flat field values. */
function xmlResponse(fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join('')
  return `<Response>${body}</Response>`
}

/** Builds a ZFP-style XML error response, e.g. `<Res Code="63">...`. */
function xmlError(code: string, message: string): string {
  return `<Res Code="${code}"><Err><Message>${message}</Message></Err></Res>`
}

const SAMPLE_REQUEST: FiscalInvoiceRequest = {
  clientOrderUuid: '11111111-2222-3333-4444-555555555555',
  items: [
    { description: 'Bread', quantity: 2, unitPrice: 60, taxRate: 0.16, pluCode: 'variant-1' },
    { description: 'Milk', quantity: 1, unitPrice: 80, taxRate: 0.16, pluCode: 'variant-2' }
  ],
  total: 219.2,
  taxAmount: 30.2,
  paymentMethod: 'cash',
  amountTendered: 250
}

describe('RealFiscalizationProvider.submitInvoice', () => {
  it('drives OpenInvoice, one SellPLU per line item, then CloseReceipt using the default endpoint paths', async () => {
    const post = vi.fn().mockImplementation((path: string) => {
      if (path === DEFAULT_FISCAL_ENDPOINTS.closeReceipt) {
        return Promise.resolve({ data: xmlResponse({ invoiceNumber: 'KRA-0001', qrCode: 'base64qr' }) })
      }
      return Promise.resolve({ data: xmlResponse({}) })
    })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.success).toBe(true)
    expect(result.data?.invoiceNumber).toBe('KRA-0001')
    expect(result.data?.qrCode).toBe('base64qr')

    const calledPaths = post.mock.calls.map((call) => call[0])
    expect(calledPaths).toEqual([
      DEFAULT_FISCAL_ENDPOINTS.openInvoice,
      DEFAULT_FISCAL_ENDPOINTS.sellPLU,
      DEFAULT_FISCAL_ENDPOINTS.sellPLU,
      DEFAULT_FISCAL_ENDPOINTS.closeReceipt
    ])
  })

  it('posts every device call as an XML <Request> envelope with a text/xml content type', async () => {
    const post = vi.fn().mockResolvedValue({ data: xmlResponse({ invoiceNumber: 'KRA-0001' }) })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    await provider.submitInvoice(SAMPLE_REQUEST)

    for (const call of post.mock.calls) {
      expect(typeof call[1]).toBe('string')
      expect(call[1]).toMatch(/^<Request name="\w+">[\s\S]*<\/Request>$/)
      expect(call[2]).toEqual({ headers: { 'Content-Type': 'text/xml' } })
    }
  })

  it('serializes the OpenInvoice payload as a <Request name="OpenInvoice"> envelope', async () => {
    const post = vi.fn().mockResolvedValue({ data: xmlResponse({ invoiceNumber: 'KRA-0001' }) })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    await provider.submitInvoice(SAMPLE_REQUEST)

    const openCall = post.mock.calls.find((call) => call[0] === DEFAULT_FISCAL_ENDPOINTS.openInvoice)
    expect(openCall?.[1]).toContain('<Request name="OpenInvoice">')
    expect(openCall?.[1]).toContain(
      `<clientOrderUuid>${SAMPLE_REQUEST.clientOrderUuid}</clientOrderUuid>`
    )
  })

  it('serializes each SellPLU call as a <Request name="SellPLU"> envelope', async () => {
    const post = vi.fn().mockResolvedValue({ data: xmlResponse({ invoiceNumber: 'KRA-0001' }) })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    await provider.submitInvoice(SAMPLE_REQUEST)

    const sellCalls = post.mock.calls.filter((call) => call[0] === DEFAULT_FISCAL_ENDPOINTS.sellPLU)
    expect(sellCalls[0][1]).toBe(
      '<Request name="SellPLU"><pluCode>variant-1</pluCode><description>Bread</description><quantity>2</quantity><unitPrice>60</unitPrice><vatClass>A</vatClass></Request>'
    )
    expect(sellCalls[1][1]).toBe(
      '<Request name="SellPLU"><pluCode>variant-2</pluCode><description>Milk</description><quantity>1</quantity><unitPrice>80</unitPrice><vatClass>A</vatClass></Request>'
    )
  })

  it('sends clientOrderUuid in the OpenInvoice XML payload for device-side idempotency on a retried request', async () => {
    const post = vi.fn().mockImplementation((path: string) => {
      if (path === DEFAULT_FISCAL_ENDPOINTS.closeReceipt) {
        return Promise.resolve({ data: xmlResponse({ invoiceNumber: 'KRA-0001', qrCode: '' }) })
      }
      return Promise.resolve({ data: xmlResponse({}) })
    })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    await provider.submitInvoice(SAMPLE_REQUEST)

    const openCall = post.mock.calls.find((call) => call[0] === DEFAULT_FISCAL_ENDPOINTS.openInvoice)
    expect(openCall?.[1]).toContain(
      `<clientOrderUuid>${SAMPLE_REQUEST.clientOrderUuid}</clientOrderUuid>`
    )
  })

  it('submits a B2B invoice with the customer PIN via openInvoiceWithPin', async () => {
    const post = vi.fn().mockImplementation((path: string) => {
      if (path === DEFAULT_FISCAL_ENDPOINTS.closeReceipt) {
        return Promise.resolve({ data: xmlResponse({ invoiceNumber: 'KRA-B2B-0001', qrCode: '' }) })
      }
      return Promise.resolve({ data: xmlResponse({}) })
    })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, buyerPin: 'p051234567z' })

    expect(result.success).toBe(true)
    const calledPaths = post.mock.calls.map((call) => call[0])
    expect(calledPaths[0]).toBe(DEFAULT_FISCAL_ENDPOINTS.openInvoiceWithPin)
    expect(calledPaths).not.toContain(DEFAULT_FISCAL_ENDPOINTS.openInvoice)

    const openCall = post.mock.calls.find(
      (call) => call[0] === DEFAULT_FISCAL_ENDPOINTS.openInvoiceWithPin
    )
    expect(openCall?.[1]).toContain('<Request name="OpenInvoiceWithCustomerData">')
    expect(openCall?.[1]).toContain('<taxpayerPin>p051234567z</taxpayerPin>')
    expect(openCall?.[1]).toContain(
      `<clientOrderUuid>${SAMPLE_REQUEST.clientOrderUuid}</clientOrderUuid>`
    )
    expect(openCall?.[1]).not.toContain('<buyerPin>')
  })

  it('submits a B2C invoice via the free-customer endpoint when the PIN is blank', async () => {
    const post = vi.fn().mockImplementation((path: string) => {
      if (path === DEFAULT_FISCAL_ENDPOINTS.closeReceipt) {
        return Promise.resolve({ data: xmlResponse({ invoiceNumber: 'KRA-B2C-0001', qrCode: '' }) })
      }
      return Promise.resolve({ data: xmlResponse({}) })
    })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    await provider.submitInvoice({ ...SAMPLE_REQUEST, buyerPin: '   ' })

    const calledPaths = post.mock.calls.map((call) => call[0])
    expect(calledPaths[0]).toBe(DEFAULT_FISCAL_ENDPOINTS.openInvoice)
    expect(calledPaths).not.toContain(DEFAULT_FISCAL_ENDPOINTS.openInvoiceWithPin)

    const openCall = post.mock.calls.find((call) => call[0] === DEFAULT_FISCAL_ENDPOINTS.openInvoice)
    expect(openCall?.[1]).toContain('<Request name="OpenInvoice">')
    expect(openCall?.[1]).toContain('<buyerPin></buyerPin>')
    expect(openCall?.[1]).not.toContain('<taxpayerPin>')
  })

  it('uses configured endpoint overrides instead of the defaults', async () => {
    const post = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/v1/receipt/close') {
        return Promise.resolve({ data: xmlResponse({ invoiceNumber: 'KRA-0002', qrCode: '' }) })
      }
      return Promise.resolve({ data: xmlResponse({}) })
    })
    const provider = new RealFiscalizationProvider({
      httpClient: makeMockClient(post),
      endpoints: {
        openInvoice: '/api/v1/receipt/open',
        sellPLU: '/api/v1/receipt/sell',
        closeReceipt: '/api/v1/receipt/close',
        cancelReceipt: '/api/v1/receipt/cancel'
      }
    })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.success).toBe(true)
    const calledPaths = post.mock.calls.map((call) => call[0])
    expect(calledPaths).toEqual([
      '/api/v1/receipt/open',
      '/api/v1/receipt/sell',
      '/api/v1/receipt/sell',
      '/api/v1/receipt/close'
    ])
    // openCreditNote wasn't overridden, so it should retain its default.
    expect(DEFAULT_FISCAL_ENDPOINTS.openCreditNote).toBe('/OpenCreditNoteWithFreeCustomerData')
  })

  it('sends CloseReceipt with the mapped payment method and amount tendered', async () => {
    const post = vi.fn().mockImplementation((path: string) => {
      if (path === DEFAULT_FISCAL_ENDPOINTS.closeReceipt) {
        return Promise.resolve({ data: xmlResponse({ invoiceNumber: 'KRA-0004', qrCode: '' }) })
      }
      return Promise.resolve({ data: xmlResponse({}) })
    })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    await provider.submitInvoice({ ...SAMPLE_REQUEST, paymentMethod: 'mpesa', amountTendered: 219.2 })

    const closeCall = post.mock.calls.find((call) => call[0] === DEFAULT_FISCAL_ENDPOINTS.closeReceipt)
    expect(closeCall?.[1]).toBe(
      '<Request name="CloseReceipt"><paymentMethod>MPESA</paymentMethod><amountTendered>219.2</amountTendered></Request>'
    )
  })

  it('rejects a request with no line items without calling the device', async () => {
    const post = vi.fn()
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice({ ...SAMPLE_REQUEST, items: [] })

    expect(result.success).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })

  it('calls CancelReceipt when a SellPLU call fails, then surfaces the original error', async () => {
    const post = vi.fn().mockImplementation((path: string) => {
      if (path === DEFAULT_FISCAL_ENDPOINTS.sellPLU) {
        return Promise.reject(new Error('device rejected line item'))
      }
      return Promise.resolve({ data: xmlResponse({}) })
    })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.success).toBe(false)
    const calledPaths = post.mock.calls.map((call) => call[0])
    expect(calledPaths).toEqual([
      DEFAULT_FISCAL_ENDPOINTS.openInvoice,
      DEFAULT_FISCAL_ENDPOINTS.sellPLU,
      DEFAULT_FISCAL_ENDPOINTS.cancelReceipt
    ])
  })

  it('calls CancelReceipt when CloseReceipt fails', async () => {
    const post = vi.fn().mockImplementation((path: string) => {
      if (path === DEFAULT_FISCAL_ENDPOINTS.closeReceipt) {
        return Promise.reject(new Error('device offline'))
      }
      return Promise.resolve({ data: xmlResponse({}) })
    })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.success).toBe(false)
    const calledPaths = post.mock.calls.map((call) => call[0])
    expect(calledPaths).toEqual([
      DEFAULT_FISCAL_ENDPOINTS.openInvoice,
      DEFAULT_FISCAL_ENDPOINTS.sellPLU,
      DEFAULT_FISCAL_ENDPOINTS.sellPLU,
      DEFAULT_FISCAL_ENDPOINTS.closeReceipt,
      DEFAULT_FISCAL_ENDPOINTS.cancelReceipt
    ])
  })

  it('fails and rolls back if CloseReceipt succeeds but omits an invoice number', async () => {
    const post = vi.fn().mockResolvedValue({ data: xmlResponse({}) })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.success).toBe(false)
    expect(post.mock.calls.at(-1)?.[0]).toBe(DEFAULT_FISCAL_ENDPOINTS.cancelReceipt)
  })

  it('extracts the invoice number from a capitalized InvoiceNumber field', async () => {
    const post = vi.fn().mockImplementation((path: string) => {
      if (path === DEFAULT_FISCAL_ENDPOINTS.closeReceipt) {
        return Promise.resolve({ data: xmlResponse({ InvoiceNumber: 'INV-999' }) })
      }
      return Promise.resolve({ data: xmlResponse({}) })
    })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.success).toBe(true)
    expect(result.data?.invoiceNumber).toBe('INV-999')
  })

  it('extracts the invoice number and QR code from a ReceiptNumber/QrCode response', async () => {
    const post = vi.fn().mockImplementation((path: string) => {
      if (path === DEFAULT_FISCAL_ENDPOINTS.closeReceipt) {
        return Promise.resolve({ data: xmlResponse({ ReceiptNumber: 'INV-888', QrCode: 'qr-payload' }) })
      }
      return Promise.resolve({ data: xmlResponse({}) })
    })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.success).toBe(true)
    expect(result.data?.invoiceNumber).toBe('INV-888')
    expect(result.data?.qrCode).toBe('qr-payload')
  })

  it('logs the raw response and fails when no known invoice-number field is present', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const post = vi.fn().mockImplementation((path: string) => {
      if (path === DEFAULT_FISCAL_ENDPOINTS.closeReceipt) {
        return Promise.resolve({ data: xmlResponse({ success: 'true' }) })
      }
      return Promise.resolve({ data: xmlResponse({}) })
    })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/without returning an invoice number/i)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ZFP CloseReceipt response missing expected invoiceNumber'),
      expect.stringContaining('success')
    )

    warnSpy.mockRestore()
  })

  it('translates an XML device-level error response into a descriptive failure', async () => {
    const post = vi.fn().mockImplementation((path: string) => {
      if (path === DEFAULT_FISCAL_ENDPOINTS.openInvoice) {
        return Promise.resolve({
          data: xmlError('63', 'Data at the root level is invalid')
        })
      }
      return Promise.resolve({ data: xmlResponse({}) })
    })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    const result = await provider.submitInvoice(SAMPLE_REQUEST)

    expect(result.success).toBe(false)
    expect(result.error).toBe('Fiscal device error (Code 63): Data at the root level is invalid')
    expect(post).toHaveBeenCalledTimes(1)
  })
})

describe('RealFiscalizationProvider.cancelInvoice', () => {
  it('issues a credit note referencing the original invoice number', async () => {
    const post = vi.fn().mockResolvedValue({ data: xmlResponse({}) })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    const result = await provider.cancelInvoice('KRA-0001')

    expect(result.success).toBe(true)
    expect(post).toHaveBeenCalledWith(
      DEFAULT_FISCAL_ENDPOINTS.openCreditNote,
      '<Request name="OpenCreditNote"><referenceInvoiceNumber>KRA-0001</referenceInvoiceNumber></Request>',
      { headers: { 'Content-Type': 'text/xml' } }
    )
  })

  it('reports a manual-credit-note fallback when the device call fails', async () => {
    const post = vi.fn().mockRejectedValue(new Error('device offline'))
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    const result = await provider.cancelInvoice('KRA-0001')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/manual credit note/i)
  })

  it('reports a manual-credit-note fallback when the device returns an XML error code', async () => {
    const post = vi.fn().mockResolvedValue({ data: xmlError('63', 'Invalid reference') })
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(post) })

    const result = await provider.cancelInvoice('KRA-0001')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/manual credit note/i)
    expect(result.error).toMatch(/Code 63/)
  })
})

describe('RealFiscalizationProvider.getInvoiceDetails', () => {
  it('reports not configured when no local lookup function is supplied', async () => {
    const provider = new RealFiscalizationProvider({ httpClient: makeMockClient(vi.fn()) })

    const result = await provider.getInvoiceDetails('KRA-0001')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no local invoice lookup/i)
  })

  it('queries the injected local DB lookup and returns its result on a hit', async () => {
    const lookupInvoice = vi.fn().mockReturnValue({
      invoiceNumber: 'KRA-0001',
      qrCode: 'stored-qr',
      fiscalizedAt: '2026-01-01T00:00:00.000Z'
    })
    const provider = new RealFiscalizationProvider({
      httpClient: makeMockClient(vi.fn()),
      lookupInvoice
    })

    const result = await provider.getInvoiceDetails('KRA-0001')

    expect(lookupInvoice).toHaveBeenCalledWith('KRA-0001')
    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      invoiceNumber: 'KRA-0001',
      qrCode: 'stored-qr',
      fiscalizedAt: '2026-01-01T00:00:00.000Z'
    })
  })

  it('reports not found when the local DB lookup misses', async () => {
    const lookupInvoice = vi.fn().mockReturnValue(undefined)
    const provider = new RealFiscalizationProvider({
      httpClient: makeMockClient(vi.fn()),
      lookupInvoice
    })

    const result = await provider.getInvoiceDetails('KRA-UNKNOWN')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/i)
  })
})
