/**
 * XML serialization/parsing utility tests, covering the
 * `<Command Name="…"><Args><Arg Name Value/></Args></Command>` envelope
 * `serializeToXml` emits (the shape the vendor's own
 * `fillXmlWithParamVals` builds) and the response variants
 * `parseXmlResponse` and its extraction helpers tolerate.
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
  it('emits a self-closing <Command Name> with no <Args> for a no-argument command', () => {
    expect(serializeToXml({}, 'ReadStatus')).toBe('<Command Name="ReadStatus"/>')
    expect(serializeToXml({}, 'CloseReceipt')).toBe('<Command Name="CloseReceipt"/>')
  })

  it('wraps arguments in <Args> as <Arg Name Value/> elements, in insertion order', () => {
    const xml = serializeToXml(
      { CompanyName: 'Acme Ltd', ClientPINnum: 'P051234567Z' },
      'OpenInvoiceWithFreeCustomerData'
    )

    expect(xml).toBe(
      '<Command Name="OpenInvoiceWithFreeCustomerData"><Args>' +
        '<Arg Name="CompanyName" Value="Acme Ltd"/>' +
        '<Arg Name="ClientPINnum" Value="P051234567Z"/>' +
        '</Args></Command>'
    )
  })

  it('keeps an <Arg> with an empty value for a deliberately blank argument', () => {
    expect(serializeToXml({ HSCode: '' }, 'SellPLUfromExtDB')).toBe(
      '<Command Name="SellPLUfromExtDB"><Args><Arg Name="HSCode" Value=""/></Args></Command>'
    )
  })

  it('omits an argument entirely when its value is undefined', () => {
    expect(serializeToXml({ Quantity: '2', DiscAddP: undefined }, 'SellPLUfromExtDB')).toBe(
      '<Command Name="SellPLUfromExtDB"><Args><Arg Name="Quantity" Value="2"/></Args></Command>'
    )
  })

  it('drops <Args> altogether when every argument was undefined', () => {
    expect(serializeToXml({ DiscAddP: undefined }, 'ReadDateTime')).toBe(
      '<Command Name="ReadDateTime"/>'
    )
  })

  it('serializes numbers as attribute values', () => {
    expect(serializeToXml({ Price: 12.5, Quantity: 2 }, 'SellPLUfromExtDB')).toBe(
      '<Command Name="SellPLUfromExtDB"><Args>' +
        '<Arg Name="Price" Value="12.5"/><Arg Name="Quantity" Value="2"/>' +
        '</Args></Command>'
    )
  })

  it('escapes XML special characters in argument values', () => {
    const xml = serializeToXml({ NamePLU: `Fish & Chips <Large> "Combo" 'Deal'` }, 'SellPLUfromExtDB')

    expect(xml).toBe(
      '<Command Name="SellPLUfromExtDB"><Args>' +
        '<Arg Name="NamePLU" Value="Fish &amp; Chips &lt;Large&gt; &quot;Combo&quot; &apos;Deal&apos;"/>' +
        '</Args></Command>'
    )
  })

  it('escapes special characters in the command name itself', () => {
    expect(serializeToXml({}, 'Open&Close')).toBe('<Command Name="Open&amp;Close"/>')
  })

  it('emits no XML declaration, matching the vendor client omit-xml-declaration setting', () => {
    expect(serializeToXml({ A: 'b' }, 'ReadStatus').startsWith('<Command')).toBe(true)
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
