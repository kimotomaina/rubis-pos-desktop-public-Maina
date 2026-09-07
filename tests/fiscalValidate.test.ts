/**
 * Pre-send validation tests (Step 1, `docs/phase-66.md`) — per the VIL
 * G03 manual's setup step 3 + checklist item 14: required item fields,
 * HS code/name for non-16%/exempt items, and PIN digit count.
 */

import { describe, it, expect } from 'vitest'
import { validateFiscalInvoiceRequest } from '../src/main/services/integrations/fiscal-validate.js'
import type { FiscalInvoiceLine, FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'

function baseLine(overrides: Partial<FiscalInvoiceLine> = {}): FiscalInvoiceLine {
  return {
    description: 'Bread',
    quantity: 1,
    unitPrice: 60,
    taxRate: 0.16,
    ...overrides
  }
}

function baseRequest(overrides: Partial<FiscalInvoiceRequest> = {}): FiscalInvoiceRequest {
  return {
    clientOrderUuid: 'uuid-1',
    items: [baseLine()],
    total: 60,
    taxAmount: 8.28,
    ...overrides
  }
}

describe('validateFiscalInvoiceRequest — happy paths', () => {
  it('accepts a well-formed class-A request with no vatClass/hsCode set', () => {
    expect(validateFiscalInvoiceRequest(baseRequest())).toBeUndefined()
  })

  it('accepts a well-formed non-A request carrying HS code + name', () => {
    const request = baseRequest({
      items: [baseLine({ vatClass: 'C', hsCode: '1102.20.00', hsName: 'Maize Flour' })]
    })
    expect(validateFiscalInvoiceRequest(request)).toBeUndefined()
  })

  it('accepts a valid buyer PIN', () => {
    const request = baseRequest({ buyerPin: 'P051234567Z' })
    expect(validateFiscalInvoiceRequest(request)).toBeUndefined()
  })

  it('accepts a missing/blank buyer PIN (optional field)', () => {
    expect(validateFiscalInvoiceRequest(baseRequest({ buyerPin: undefined }))).toBeUndefined()
    expect(validateFiscalInvoiceRequest(baseRequest({ buyerPin: '  ' }))).toBeUndefined()
  })
})

describe('validateFiscalInvoiceRequest — required item fields', () => {
  it('rejects a blank description', () => {
    const error = validateFiscalInvoiceRequest(baseRequest({ items: [baseLine({ description: '' })] }))
    expect(error).toMatch(/Item 1: description is required/)
  })

  it('rejects a whitespace-only description', () => {
    const error = validateFiscalInvoiceRequest(baseRequest({ items: [baseLine({ description: '   ' })] }))
    expect(error).toMatch(/description is required/)
  })

  it('rejects a zero quantity', () => {
    const error = validateFiscalInvoiceRequest(baseRequest({ items: [baseLine({ quantity: 0 })] }))
    expect(error).toMatch(/Item 1: quantity must be greater than zero/)
  })

  it('rejects a negative quantity', () => {
    const error = validateFiscalInvoiceRequest(baseRequest({ items: [baseLine({ quantity: -1 })] }))
    expect(error).toMatch(/quantity must be greater than zero/)
  })

  it('rejects a NaN quantity', () => {
    const error = validateFiscalInvoiceRequest(baseRequest({ items: [baseLine({ quantity: NaN })] }))
    expect(error).toMatch(/quantity must be greater than zero/)
  })

  it('rejects a missing/NaN unit price', () => {
    const error = validateFiscalInvoiceRequest(
      baseRequest({ items: [baseLine({ unitPrice: NaN })] })
    )
    expect(error).toMatch(/Item 1: unit price is required/)
  })

  it('rejects a negative unit price', () => {
    const error = validateFiscalInvoiceRequest(baseRequest({ items: [baseLine({ unitPrice: -5 })] }))
    expect(error).toMatch(/unit price is required and cannot be negative/)
  })

  it('accepts a zero unit price (e.g. a promotional giveaway line)', () => {
    expect(
      validateFiscalInvoiceRequest(baseRequest({ items: [baseLine({ unitPrice: 0 })] }))
    ).toBeUndefined()
  })

  it('reports the correct 1-based item index for the second line', () => {
    const error = validateFiscalInvoiceRequest(
      baseRequest({ items: [baseLine(), baseLine({ description: '' })] })
    )
    expect(error).toMatch(/^Item 2:/)
  })
})

describe('validateFiscalInvoiceRequest — VAT class', () => {
  it('rejects an unrecognized VAT class', () => {
    const error = validateFiscalInvoiceRequest(baseRequest({ items: [baseLine({ vatClass: 'X' })] }))
    expect(error).toMatch(/VAT class "X" is not one of A\/B\/C\/D\/E/)
  })

  it.each(['B', 'C', 'D', 'E'])(
    'requires HS code + name for VAT class %s when either is missing',
    (vatClass) => {
      const missingHsCode = validateFiscalInvoiceRequest(
        baseRequest({ items: [baseLine({ vatClass, hsName: 'Something' })] })
      )
      expect(missingHsCode).toMatch(/HS code is required/)

      const missingHsName = validateFiscalInvoiceRequest(
        baseRequest({ items: [baseLine({ vatClass, hsCode: '1102.20.00' })] })
      )
      expect(missingHsName).toMatch(/HS name is required/)
    }
  )

  it('does not require HS code/name for class A', () => {
    expect(
      validateFiscalInvoiceRequest(baseRequest({ items: [baseLine({ vatClass: 'A' })] }))
    ).toBeUndefined()
  })
})

describe('validateFiscalInvoiceRequest — buyer PIN digit count', () => {
  it('rejects a PIN with too few digits', () => {
    const error = validateFiscalInvoiceRequest(baseRequest({ buyerPin: 'P0512345Z' }))
    expect(error).toMatch(/must be 11 characters/)
  })

  it('rejects a PIN with too many digits', () => {
    const error = validateFiscalInvoiceRequest(baseRequest({ buyerPin: 'P05123456789Z' }))
    expect(error).toMatch(/must be 11 characters/)
  })

  it('rejects a PIN missing the trailing letter', () => {
    const error = validateFiscalInvoiceRequest(baseRequest({ buyerPin: 'P0512345678' }))
    expect(error).toMatch(/must be 11 characters/)
  })
})
