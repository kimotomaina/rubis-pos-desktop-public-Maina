/**
 * Admin screen eTIMS config-form helper tests.
 *
 * `parseEtimsEndpointsInput` is the pure logic backing the
 * Integrations tab's endpoints JSON textarea — kept framework-free so
 * it's testable without mounting `AdminScreen` (whose renderer-only
 * import graph isn't `NodeNext`-extension-safe, the module resolution
 * `tests/**` is type-checked under).
 */

import { describe, it, expect } from 'vitest'
import {
  parseEtimsEndpointsInput,
  DEFAULT_ETIMS_ENDPOINTS,
  DEFAULT_ETIMS_BASE_URL,
  DEFAULT_ETIMS_VAT_CLASS
} from '../src/renderer/src/lib/etimsConfig.js'

describe('parseEtimsEndpointsInput', () => {
  it('returns no endpoints and no error for blank input', () => {
    expect(parseEtimsEndpointsInput('')).toEqual({})
    expect(parseEtimsEndpointsInput('   ')).toEqual({})
  })

  it('parses a valid JSON object into endpoints', () => {
    const result = parseEtimsEndpointsInput('{"closeReceipt": "/api/v1/receipt/close"}')
    expect(result.error).toBeUndefined()
    expect(result.endpoints).toEqual({ closeReceipt: '/api/v1/receipt/close' })
  })

  it('round-trips the default endpoints object', () => {
    const text = JSON.stringify(DEFAULT_ETIMS_ENDPOINTS, null, 2)
    const result = parseEtimsEndpointsInput(text)
    expect(result.error).toBeUndefined()
    expect(result.endpoints).toEqual(DEFAULT_ETIMS_ENDPOINTS)
  })

  it('reports an error for malformed JSON', () => {
    const result = parseEtimsEndpointsInput('{ not valid json')
    expect(result.endpoints).toBeUndefined()
    expect(result.error).toMatch(/valid JSON/i)
  })

  it('reports an error when the JSON parses to an array', () => {
    const result = parseEtimsEndpointsInput('["/OpenInvoiceWithFreeCustomerData"]')
    expect(result.endpoints).toBeUndefined()
    expect(result.error).toMatch(/JSON object/i)
  })

  it('reports an error when the JSON parses to a primitive', () => {
    const result = parseEtimsEndpointsInput('"just a string"')
    expect(result.endpoints).toBeUndefined()
    expect(result.error).toMatch(/JSON object/i)
  })

  it('reports an error when the JSON parses to null', () => {
    const result = parseEtimsEndpointsInput('null')
    expect(result.endpoints).toBeUndefined()
    expect(result.error).toMatch(/JSON object/i)
  })
})

describe('eTIMS config defaults', () => {
  it('exposes the documented default base URL and VAT class', () => {
    expect(DEFAULT_ETIMS_BASE_URL).toBe('http://localhost:4444')
    expect(DEFAULT_ETIMS_VAT_CLASS).toBe('A')
  })

  it('exposes all six default endpoint paths', () => {
    expect(DEFAULT_ETIMS_ENDPOINTS).toEqual({
      openInvoice: '/OpenInvoiceWithFreeCustomerData',
      openInvoiceWithPin: '/OpenInvoiceWithCustomerData',
      sellPLU: '/SellPLUfromExtDB',
      closeReceipt: '/CloseReceipt',
      cancelReceipt: '/CancelReceipt',
      openCreditNote: '/OpenCreditNoteWithFreeCustomerData'
    })
  })
})
