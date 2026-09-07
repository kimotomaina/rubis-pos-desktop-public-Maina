/**
 * `attemptFiscalRetry` tests (phase-75, Part B).
 *
 * The shared "is this attempt safe to make?" gate both `fiscal-
 * engine.ts`'s queue-draining `tick()` and the future manual resend
 * entry point (phase-76, Part C) go through — see `fiscal-retry.ts`'s
 * file doc.
 */

import { describe, it, expect, vi } from 'vitest'
import { attemptFiscalRetry } from '../src/main/services/fiscal-retry.js'
import type { FiscalRetryDb, FiscalRetryOrder } from '../src/main/services/fiscal-retry.js'
import type { FiscalInvoiceRequest, FiscalSubmitOutcome } from '../src/main/services/integrations/etims.js'

const REQUEST: FiscalInvoiceRequest = {
  clientOrderUuid: 'uuid-1',
  localId: 1,
  items: [{ description: 'Bread', quantity: 1, unitPrice: 60, taxRate: 0.16 }],
  total: 69.6,
  taxAmount: 9.6
}

function makeDb(order: FiscalRetryOrder | undefined): FiscalRetryDb {
  return { getOrder: vi.fn(() => order) }
}

describe('attemptFiscalRetry', () => {
  it('makes NO device call and returns the stored result when the order is already fiscalized', async () => {
    const db = makeDb({
      fiscal_status: 'fiscalized',
      fiscal_invoice_number: 'KRA-ALREADY',
      fiscal_qr_code: 'base64qr',
      fiscal_fiscalized_at: '2026-01-01T00:00:00.000Z'
    })
    const submitInvoice = vi.fn()

    const result = await attemptFiscalRetry({ db, fiscalizationProvider: { submitInvoice } }, 1, REQUEST)

    expect(submitInvoice).not.toHaveBeenCalled()
    expect(result).toEqual({
      ok: true,
      data: {
        invoiceNumber: 'KRA-ALREADY',
        qrCode: 'base64qr',
        fiscalizedAt: '2026-01-01T00:00:00.000Z'
      }
    })
  })

  it('resubmits with isRetry:true when the order is waiting (not yet fiscalized)', async () => {
    const db = makeDb({
      fiscal_status: 'waiting',
      fiscal_invoice_number: null,
      fiscal_qr_code: null,
      fiscal_fiscalized_at: null
    })
    const outcome: FiscalSubmitOutcome = {
      ok: true,
      data: { invoiceNumber: 'KRA-0002', qrCode: '', fiscalizedAt: '2026-01-01T00:05:00.000Z' }
    }
    const submitInvoice = vi.fn().mockResolvedValue(outcome)

    const result = await attemptFiscalRetry({ db, fiscalizationProvider: { submitInvoice } }, 1, REQUEST)

    expect(submitInvoice).toHaveBeenCalledWith({ ...REQUEST, isRetry: true })
    expect(result).toEqual(outcome)
  })

  it('resubmits with isRetry:true when the order is needs_fixing (a resend)', async () => {
    const db = makeDb({
      fiscal_status: 'needs_fixing',
      fiscal_invoice_number: null,
      fiscal_qr_code: null,
      fiscal_fiscalized_at: null
    })
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'still wrong',
      kind: 'data',
      retryable: false
    })

    await attemptFiscalRetry({ db, fiscalizationProvider: { submitInvoice } }, 1, REQUEST)

    expect(submitInvoice).toHaveBeenCalledWith(expect.objectContaining({ isRetry: true }))
  })

  it('resubmits when the order row does not exist yet (treated as not-fiscalized)', async () => {
    const db = makeDb(undefined)
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'device unreachable',
      kind: 'technical',
      retryable: true
    })

    const result = await attemptFiscalRetry({ db, fiscalizationProvider: { submitInvoice } }, 1, REQUEST)

    expect(submitInvoice).toHaveBeenCalledWith({ ...REQUEST, isRetry: true })
    expect(result.ok).toBe(false)
  })

  it('two rapid retries of the same sale file at most ONE invoice', async () => {
    // A stateful fake: the first successful submitInvoice "writes" the
    // order fiscalized, exactly like a real caller would after seeing
    // an ok:true outcome — modeling the second retry landing after the
    // first one's result reached the database.
    let order: FiscalRetryOrder | undefined
    const db: FiscalRetryDb = { getOrder: vi.fn(() => order) }
    const submitInvoice = vi.fn().mockImplementation(async () => {
      order = {
        fiscal_status: 'fiscalized',
        fiscal_invoice_number: 'KRA-ONLY-ONCE',
        fiscal_qr_code: 'base64qr',
        fiscal_fiscalized_at: '2026-01-01T00:00:00.000Z'
      }
      return { ok: true, data: { invoiceNumber: 'KRA-ONLY-ONCE', qrCode: 'base64qr', fiscalizedAt: '2026-01-01T00:00:00.000Z' } }
    })

    const first = await attemptFiscalRetry({ db, fiscalizationProvider: { submitInvoice } }, 1, REQUEST)
    const second = await attemptFiscalRetry({ db, fiscalizationProvider: { submitInvoice } }, 1, REQUEST)

    expect(submitInvoice).toHaveBeenCalledTimes(1)
    expect(first.ok && first.data.invoiceNumber).toBe('KRA-ONLY-ONCE')
    expect(second.ok && second.data.invoiceNumber).toBe('KRA-ONLY-ONCE')
  })

  it('never mutates the caller-supplied request object', async () => {
    const db = makeDb({ fiscal_status: 'waiting', fiscal_invoice_number: null, fiscal_qr_code: null, fiscal_fiscalized_at: null })
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: 'KRA-0003', qrCode: '', fiscalizedAt: '2026-01-01T00:00:00.000Z' }
    })
    const original = { ...REQUEST }

    await attemptFiscalRetry({ db, fiscalizationProvider: { submitInvoice } }, 1, REQUEST)

    expect(REQUEST).toEqual(original)
  })
})
