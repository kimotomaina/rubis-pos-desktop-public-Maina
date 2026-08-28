/**
 * XML serialization/parsing utility tests, covering the object/array/
 * escaping rules `serializeToXml` follows and the casing/nesting
 * variants `parseXmlResponse` and its extraction helpers tolerate.
 */

import { describe, it, expect } from 'vitest'
import {
  serializeToXml,
  parseXmlResponse,
  extractInvoiceNumberFromXml,
  extractQrCodeFromXml,
  escapeXml
} from '../src/main/services/integrations/xml-utils.js'

describe('serializeToXml', () => {
  it('wraps a flat object in a <Request name="commandName"> envelope', () => {
    const xml = serializeToXml({ taxpayerPin: 'P051234567Z', currency: 'KES' }, 'OpenInvoice')

    expect(xml).toBe(
      '<Request name="OpenInvoice"><taxpayerPin>P051234567Z</taxpayerPin><currency>KES</currency></Request>'
    )
  })

  it('serializes nested objects as nested elements inside the envelope', () => {
    const xml = serializeToXml({ data: { item: 'value' } }, 'OpenInvoice')

    expect(xml).toBe('<Request name="OpenInvoice"><data><item>value</item></data></Request>')
  })

  it('serializes arrays as one repeated singular element per entry', () => {
    const xml = serializeToXml({ items: [{ name: 'A' }, { name: 'B' }] }, 'OpenInvoice')

    expect(xml).toBe(
      '<Request name="OpenInvoice"><items><item><name>A</name></item><item><name>B</name></item></items></Request>'
    )
  })

  it('serializes numbers and booleans as text content', () => {
    const xml = serializeToXml({ quantity: 2, unitPrice: 12.5, taxable: true }, 'SellPLU')

    expect(xml).toBe(
      '<Request name="SellPLU"><quantity>2</quantity><unitPrice>12.5</unitPrice><taxable>true</taxable></Request>'
    )
  })

  it('omits properties whose value is undefined', () => {
    const xml = serializeToXml({ a: 'x', b: undefined }, 'CloseReceipt')

    expect(xml).toBe('<Request name="CloseReceipt"><a>x</a></Request>')
  })

  it('escapes XML special characters in text content', () => {
    const xml = serializeToXml({ description: `Fish & Chips <Large> "Combo" 'Deal'` }, 'SellPLU')

    expect(xml).toBe(
      '<Request name="SellPLU"><description>Fish &amp; Chips &lt;Large&gt; &quot;Combo&quot; &apos;Deal&apos;</description></Request>'
    )
  })

  it('escapes special characters in the command name itself', () => {
    const xml = serializeToXml({}, 'Open&Close')

    expect(xml).toBe('<Request name="Open&amp;Close"></Request>')
  })
})

describe('escapeXml', () => {
  it('escapes each special character independently', () => {
    expect(escapeXml('&')).toBe('&amp;')
    expect(escapeXml('<')).toBe('&lt;')
    expect(escapeXml('>')).toBe('&gt;')
    expect(escapeXml('"')).toBe('&quot;')
    expect(escapeXml("'")).toBe('&apos;')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeXml('P051234567Z')).toBe('P051234567Z')
  })
})

describe('parseXmlResponse', () => {
  it('flattens top-level elements into a field lookup', () => {
    const parsed = parseXmlResponse('<Response><invoiceNumber>KRA-0001</invoiceNumber><qrCode>base64qr</qrCode></Response>')

    expect(parsed.invoiceNumber).toBe('KRA-0001')
    expect(parsed.qrCode).toBe('base64qr')
  })

  it('flattens elements nested one level deep under a container', () => {
    const parsed = parseXmlResponse('<Response><data><invoiceNumber>KRA-0002</invoiceNumber></data></Response>')

    expect(parsed.invoiceNumber).toBe('KRA-0002')
  })

  it('extracts the Code attribute and nested Message from an error response', () => {
    const parsed = parseXmlResponse(
      '<Res Code="63"><Err code="1"><Message>Data at the root level is invalid</Message></Err></Res>'
    )

    expect(parsed.code).toBe('63')
    expect(parsed.Message).toBe('Data at the root level is invalid')
  })

  it('unescapes XML entities back to their literal characters', () => {
    const parsed = parseXmlResponse('<Response><description>Fish &amp; Chips</description></Response>')

    expect(parsed.description).toBe('Fish & Chips')
  })

  it('returns an empty object for a response with no matching elements', () => {
    const parsed = parseXmlResponse('<Response></Response>')

    expect(parsed.invoiceNumber).toBeUndefined()
  })
})

describe('extractInvoiceNumberFromXml', () => {
  it('finds invoiceNumber directly', () => {
    expect(extractInvoiceNumberFromXml({ invoiceNumber: 'KRA-0001' })).toBe('KRA-0001')
  })

  it('finds a capitalized InvoiceNumber', () => {
    expect(extractInvoiceNumberFromXml({ InvoiceNumber: 'INV-999' })).toBe('INV-999')
  })

  it('finds receiptNumber and ReceiptNumber as fallbacks', () => {
    expect(extractInvoiceNumberFromXml({ receiptNumber: 'INV-1' })).toBe('INV-1')
    expect(extractInvoiceNumberFromXml({ ReceiptNumber: 'INV-2' })).toBe('INV-2')
  })

  it('returns undefined when no known key is present', () => {
    expect(extractInvoiceNumberFromXml({ success: 'true' })).toBeUndefined()
  })
})

describe('extractQrCodeFromXml', () => {
  it('finds qrCode, QrCode, and qr_code variants', () => {
    expect(extractQrCodeFromXml({ qrCode: 'a' })).toBe('a')
    expect(extractQrCodeFromXml({ QrCode: 'b' })).toBe('b')
    expect(extractQrCodeFromXml({ qr_code: 'c' })).toBe('c')
  })

  it('returns undefined when no known key is present', () => {
    expect(extractQrCodeFromXml({ invoiceNumber: 'KRA-0001' })).toBeUndefined()
  })
})
