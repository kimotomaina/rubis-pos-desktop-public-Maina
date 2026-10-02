/**
 * A manual resend that files a sale prints its fiscal slip (docs/phase-198-1),
 * by the same decision the fiscal engine's `onFiled` uses, once, guarded by
 * `receipt_printed_at`. `tests/fiscalResend.test.ts` is unchanged.
 */

import { describe, it, expect, vi } from 'vitest'
import { correctPinAndResend, resendFiscalization } from '../src/main/services/fiscal-retry.js'
import { printLateFiledSlip } from '../src/main/services/late-filed-slip.js'
import type { RubisDatabase } from '../src/main/services/database.js'
import type { FiscalInvoiceRequest, FiscalSubmitOutcome } from '../src/main/services/integrations/etims.js'
import type { ReceiptPrintResult } from '../src/main/services/printer.js'
import type { ServiceResult } from '../src/main/services/shopify-types.js'
import { freshDb, seedSale } from './helpers/slipOrders.js'

const silent = { log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never

const FILED: FiscalSubmitOutcome = {
  ok: true,
  data: { invoiceNumber: '0123456789012345678', qrCode: 'https://example.invalid/q', fiscalizedAt: '2026-10-02T10:00:00.000Z' }
}
const REJECTED: FiscalSubmitOutcome = { ok: false, reason: 'Device busy', kind: 'technical', retryable: true }
const onPaper: ServiceResult<ReceiptPrintResult> = { success: true, data: { printed: true, mock: false } }
const viaPdf: ServiceResult<ReceiptPrintResult> = { success: true, data: { printed: false, mock: false, mode: 'pdf' } }

/** A waiting sale with its stored fiscal request, ready to be resent. */
function waitingSale(db: RubisDatabase): number {
  const { localId } = seedSale(db)
  const request: FiscalInvoiceRequest = {
    clientOrderUuid: `uuid-${localId}`,
    localId,
    items: [{ description: 'RUBIS Mug', quantity: 1, unitPrice: 60, taxRate: 0.16 }],
    total: 60,
    taxAmount: 8.28,
    paymentMethod: 'cash',
    amountTendered: 100
  }
  db.setOrderFiscalRequest(localId, request)
  db.setOrderFiscalFailure(localId, 'waiting', 'Device unreachable', 'technical')
  return localId
}

/** Deps wired the way index.ts wires them: the resend's `onFiled` runs the shared late-filed decision. */
function wired(db: RubisDatabase, outcome: FiscalSubmitOutcome, printFiscalSlip: ReturnType<typeof vi.fn>) {
  const submitInvoice = vi.fn().mockResolvedValue(outcome)
  const onFiled = vi.fn((id: number) => void printLateFiledSlip({ db, printFiscalSlip, logger: silent }, id))
  return { deps: { db, fiscalizationProvider: { submitInvoice }, logger: silent, onFiled }, submitInvoice, onFiled }
}

/** Lets the unawaited print (started by `onFiled`) finish. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('a resend that files the sale', () => {
  it('prints the fiscal slip once, as the original, and marks it', async () => {
    const db = freshDb()
    const localId = waitingSale(db)
    const printFiscalSlip = vi.fn(async () => onPaper)
    const { deps, onFiled } = wired(db, FILED, printFiscalSlip)

    const outcome = await resendFiscalization(deps, localId)
    await settle()

    expect(outcome.ok).toBe(true)
    expect(onFiled).toHaveBeenCalledWith(localId)
    expect(printFiscalSlip).toHaveBeenCalledTimes(1)
    expect((printFiscalSlip.mock.calls[0] as unknown[])[0]).toMatchObject({ local_id: localId, fiscal_status: 'fiscalized', fiscal_invoice_number: '0123456789012345678' })
    expect(db.hasReceiptPrinted(localId)).toBe(true)
  })

  it('a second resend of the same sale prints nothing', async () => {
    const db = freshDb()
    const localId = waitingSale(db)
    const printFiscalSlip = vi.fn(async () => onPaper)
    const { deps, submitInvoice, onFiled } = wired(db, FILED, printFiscalSlip)
    await resendFiscalization(deps, localId)
    await settle()

    const second = await resendFiscalization(deps, localId)
    await settle()

    expect(second.ok).toBe(true)
    expect(submitInvoice).toHaveBeenCalledTimes(1)
    expect(onFiled).toHaveBeenCalledTimes(1)
    expect(printFiscalSlip).toHaveBeenCalledTimes(1)
  })

  it('is held to one print by receipt_printed_at even if the callback ran again', async () => {
    const db = freshDb()
    const localId = waitingSale(db)
    const printFiscalSlip = vi.fn(async () => onPaper)
    const { deps } = wired(db, FILED, printFiscalSlip)
    await resendFiscalization(deps, localId)
    await settle()

    await printLateFiledSlip({ db, printFiscalSlip, logger: silent }, localId)

    expect(printFiscalSlip).toHaveBeenCalledTimes(1)
  })

  it('does not print a slip that already went out', async () => {
    const db = freshDb()
    const localId = waitingSale(db)
    db.markReceiptPrinted(localId)
    const printFiscalSlip = vi.fn(async () => onPaper)
    const { deps } = wired(db, FILED, printFiscalSlip)

    await resendFiscalization(deps, localId)
    await settle()

    expect(printFiscalSlip).not.toHaveBeenCalled()
    expect(db.getUnprintedFiscalSlips()).toEqual([])
  })

  it('flags the sale for Needs Attention when the printer is unavailable, as the engine path does, and does not retry', async () => {
    const db = freshDb()
    const localId = waitingSale(db)
    const printFiscalSlip = vi.fn(async () => viaPdf)
    const { deps } = wired(db, FILED, printFiscalSlip)

    await resendFiscalization(deps, localId)
    await settle()

    expect(printFiscalSlip).toHaveBeenCalledTimes(1)
    expect(db.hasReceiptPrinted(localId)).toBe(false)
    expect(db.getOrder(localId)?.fiscal_slip_unprinted_at).toBeTruthy()
    expect(db.getUnprintedFiscalSlips().map((row) => row.local_id)).toEqual([localId])
  })

  it('flags it the same way when printing throws', async () => {
    const db = freshDb()
    const localId = waitingSale(db)
    const printFiscalSlip = vi.fn(async (): Promise<ServiceResult<ReceiptPrintResult>> => {
      throw new Error('spooler is down')
    })
    const { deps } = wired(db, FILED, printFiscalSlip)

    const outcome = await resendFiscalization(deps, localId)
    await settle()

    expect(outcome.ok).toBe(true)
    expect(db.getUnprintedFiscalSlips().map((row) => row.local_id)).toEqual([localId])
  })
})

describe('a resend that does not file the sale', () => {
  it('prints nothing and flags nothing new', async () => {
    const db = freshDb()
    const localId = waitingSale(db)
    const printFiscalSlip = vi.fn(async () => onPaper)
    const { deps, onFiled } = wired(db, REJECTED, printFiscalSlip)

    const outcome = await resendFiscalization(deps, localId)
    await settle()

    expect(outcome.ok).toBe(false)
    expect(onFiled).not.toHaveBeenCalled()
    expect(printFiscalSlip).not.toHaveBeenCalled()
    expect(db.getOrder(localId)?.fiscal_slip_unprinted_at ?? null).toBeNull()
    expect(db.getUnprintedFiscalSlips()).toEqual([])
  })
})

describe('the resend paths', () => {
  it('a callback that throws does not fail the resend', async () => {
    const db = freshDb()
    const localId = waitingSale(db)
    const submitInvoice = vi.fn().mockResolvedValue(FILED)
    const onFiled = vi.fn(() => {
      throw new Error('printer exploded')
    })

    const outcome = await resendFiscalization({ db, fiscalizationProvider: { submitInvoice }, logger: silent, onFiled }, localId)

    expect(outcome.ok).toBe(true)
    expect(db.getOrder(localId)?.fiscal_status).toBe('fiscalized')
  })

  it('"Correct PIN and resend" prints through the same decision', async () => {
    const db = freshDb()
    const localId = waitingSale(db)
    const printFiscalSlip = vi.fn(async () => onPaper)
    const { deps } = wired(db, FILED, printFiscalSlip)

    await correctPinAndResend(deps, localId, 'P051234567Z')
    await settle()

    expect(printFiscalSlip).toHaveBeenCalledTimes(1)
    expect(db.hasReceiptPrinted(localId)).toBe(true)
  })

  it('works with no callback at all', async () => {
    const db = freshDb()
    const localId = waitingSale(db)
    const submitInvoice = vi.fn().mockResolvedValue(FILED)

    const outcome = await resendFiscalization({ db, fiscalizationProvider: { submitInvoice }, logger: silent }, localId)

    expect(outcome.ok).toBe(true)
  })
})
