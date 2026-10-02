/**
 * `canPrintDuplicate` (docs/phase-196-2): every branch of the guard that
 * decides whether an order's receipt may be reprinted at the fiscal device.
 */

import { describe, it, expect } from 'vitest'
import { canPrintDuplicate, type DuplicatePrintGuardInput } from '../src/main/lib/duplicatePrintGuard.js'

const OK: DuplicatePrintGuardInput = {
  orderCuInvoiceNumber: '0110605040001000810',
  deviceLastCuInvoiceNumber: '0110605040001000810',
  fiscalStatus: 'fiscalized',
  queueHasInFlight: false,
  receiptOpen: false
}

const refused = (overrides: Partial<DuplicatePrintGuardInput>): { allowed: boolean; reason: string } =>
  canPrintDuplicate({ ...OK, ...overrides })

describe('canPrintDuplicate', () => {
  it('allows only a filed order whose number is the device last, with nothing in flight and no receipt open', () => {
    expect(canPrintDuplicate(OK)).toEqual({
      allowed: true,
      reason: "This is the fiscal device's most recent receipt."
    })
  })

  it.each(['waiting', 'needs_fixing', null] as const)('refuses an order that is %s, not filed', (fiscalStatus) => {
    const result = refused({ fiscalStatus })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('This sale has not been filed with KRA, so there is no receipt to copy.')
  })

  it('refuses while the till is still sending a sale to the device', () => {
    const result = refused({ queueHasInFlight: true })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('The till is still sending a sale to the fiscal device. Try again in a moment.')
  })

  it('refuses while the device has a receipt open', () => {
    const result = refused({ receiptOpen: true })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('The fiscal device has a receipt open right now. Try again in a moment.')
  })

  it.each([null, undefined, '', '   '])('refuses an order with no fiscal invoice number (%j)', (orderCuInvoiceNumber) => {
    const result = refused({ orderCuInvoiceNumber })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe(
      'This sale has no fiscal invoice number on record, so there is no receipt to copy.'
    )
  })

  it.each([null, undefined, '', '   '])('refuses when the device reports no last number (%j)', (deviceLastCuInvoiceNumber) => {
    const result = refused({ deviceLastCuInvoiceNumber })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('The fiscal device did not report its last receipt number, so nothing was sent.')
  })

  it('refuses when the device has issued a later receipt', () => {
    const result = refused({ deviceLastCuInvoiceNumber: '0110605040001000811' })
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe(
      "The fiscal device's most recent receipt is a different one. Only the most recent receipt can be reprinted."
    )
  })

  it('ignores surrounding whitespace when comparing the two numbers', () => {
    expect(refused({ orderCuInvoiceNumber: ' 0110605040001000810 ', deviceLastCuInvoiceNumber: '0110605040001000810\n' }).allowed).toBe(true)
  })

  it('does not ignore case: the numbers are digits, so a letter difference is a different number', () => {
    expect(refused({ orderCuInvoiceNumber: 'abc123', deviceLastCuInvoiceNumber: 'ABC123' }).allowed).toBe(false)
  })

  it('checks the order is filed before anything about the device', () => {
    const result = refused({ fiscalStatus: 'waiting', queueHasInFlight: true, receiptOpen: true })
    expect(result.reason).toBe('This sale has not been filed with KRA, so there is no receipt to copy.')
  })
})
