/**
 * Void removal and the defensive filing refusal (phase-131).
 *
 * Runs against a real in-memory `better-sqlite3` database: the two
 * count queries' `status != 'voided'` filters and the "no queue row
 * added" assertions are SQL behaviour a recording fake cannot exercise.
 * Voided rows are produced with `db.voidOrder`, which stays in place for
 * historical data even though the till can no longer reach it.
 */

import { describe, it, expect, vi } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { VOID_DISABLED_MESSAGE } from '../src/main/services/voids.js'
import {
  VOIDED_ORDER_NOT_FILED_REASON,
  attemptFiscalRetry,
  correctPinAndResend,
  resendFiscalization
} from '../src/main/services/fiscal-retry.js'
import type { FiscalInvoiceRequest, FiscalSubmitOutcome } from '../src/main/services/integrations/etims.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const item: CartItem = {
  id: 'variant-1',
  productId: 'product-1',
  title: 'RUBIS Mug',
  variantTitle: 'Small',
  price: 1,
  quantity: 1,
  image: null
}

/** Far enough ahead that every order counts as stuck-waiting. */
const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000
const STUCK_THRESHOLD_MS = 15 * 60 * 1000

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

/** Queues a 1-KSh cash sale and stores its fiscal request, as checkout does. */
function sale(db: RubisDatabase, uuid: string): { localId: number; request: FiscalInvoiceRequest } {
  const { staffId } = db.createStaff({ name: `Cashier ${uuid}`, pinHash: hashPin('1234'), role: 'cashier' })
  const { localId } = db.queueOrder({
    items: [item],
    total: 1,
    clientOrderUuid: uuid,
    staffId,
    staffName: `Cashier ${uuid}`,
    paymentMethod: 'cash',
    tenderedAmount: 1,
    changeDue: 0
  })
  const request: FiscalInvoiceRequest = {
    clientOrderUuid: uuid,
    localId,
    items: [{ description: 'RUBIS Mug', quantity: 1, unitPrice: 1, taxRate: 0.16, vatClass: 'A' }],
    total: 1,
    taxAmount: 0.16,
    paymentMethod: 'cash'
  }
  db.setOrderFiscalRequest(localId, request)
  return { localId, request }
}

function waitingSale(db: RubisDatabase, uuid: string): { localId: number; request: FiscalInvoiceRequest } {
  const created = sale(db, uuid)
  db.setOrderFiscalFailure(created.localId, 'waiting', 'device unreachable', 'technical')
  return created
}

function needsFixingSale(db: RubisDatabase, uuid: string): { localId: number; request: FiscalInvoiceRequest } {
  const created = sale(db, uuid)
  db.setOrderFiscalFailure(created.localId, 'needs_fixing', 'rejected', 'data')
  return created
}

function okProvider(invoiceNumber = '0000000000000000001') {
  return {
    submitInvoice: vi.fn(
      async (_request: FiscalInvoiceRequest): Promise<FiscalSubmitOutcome> => ({
        ok: true,
        data: { invoiceNumber, qrCode: 'QR', fiscalizedAt: new Date().toISOString() }
      })
    )
  }
}

function queuedCount(db: RubisDatabase): number {
  return db.getPendingFiscalQueue(FAR_FUTURE).length
}

function attentionIds(db: RubisDatabase): number[] {
  return db.getOrdersNeedingAttention(FAR_FUTURE, STUCK_THRESHOLD_MS).map((row) => row.local_id)
}

describe('orders:void refusal', () => {
  it('names the credit note as the only way to reverse a filed sale', () => {
    expect(VOID_DISABLED_MESSAGE).toBe(
      'Sales cannot be voided on this till. A filed sale needs a credit note.'
    )
  })
})

describe('attemptFiscalRetry refuses a voided order', () => {
  it('returns a non-retryable system failure without calling the device', async () => {
    const db = freshDb()
    const { localId, request } = waitingSale(db, 'uuid-voided-waiting')
    db.voidOrder(localId)
    const provider = okProvider()

    const outcome = await attemptFiscalRetry({ db, fiscalizationProvider: provider }, localId, request)

    expect(outcome).toEqual({
      ok: false,
      reason: VOIDED_ORDER_NOT_FILED_REASON,
      kind: 'system',
      retryable: false
    })
    expect(provider.submitInvoice).not.toHaveBeenCalled()
  })

  it('refuses a filed-then-voided order as voided, proving the guard runs before the fiscalized short-circuit', async () => {
    const db = freshDb()
    const { localId, request } = sale(db, 'uuid-filed-then-voided')
    db.setOrderFiscalInfo(localId, '0000000000000000099', 'QR-99')
    db.voidOrder(localId)
    const provider = okProvider()

    const outcome = await attemptFiscalRetry({ db, fiscalizationProvider: provider }, localId, request)

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.reason).toBe(VOIDED_ORDER_NOT_FILED_REASON)
    expect(provider.submitInvoice).not.toHaveBeenCalled()
    expect(db.getUnfiledOrderCount()).toBe(0)
    expect(attentionIds(db)).not.toContain(localId)
  })
})

describe('resend routes never file a voided order', () => {
  it('resendFiscalization makes no device call and adds no queue row', async () => {
    const db = freshDb()
    const { localId } = waitingSale(db, 'uuid-resend-voided')
    db.voidOrder(localId)
    const provider = okProvider()

    const outcome = await resendFiscalization({ db, fiscalizationProvider: provider, logger: silentLogger() }, localId)

    expect(outcome.ok).toBe(false)
    expect(provider.submitInvoice).not.toHaveBeenCalled()
    expect(queuedCount(db)).toBe(0)
    expect(db.getOrder(localId)?.fiscal_invoice_number).toBeNull()
  })

  it('correctPinAndResend makes no device call and adds no queue row', async () => {
    const db = freshDb()
    const { localId } = needsFixingSale(db, 'uuid-pin-voided')
    db.voidOrder(localId)
    const provider = okProvider()

    const outcome = await correctPinAndResend(
      { db, fiscalizationProvider: provider, logger: silentLogger() },
      localId,
      'P051234567A'
    )

    expect(outcome.ok).toBe(false)
    expect(provider.submitInvoice).not.toHaveBeenCalled()
    expect(queuedCount(db)).toBe(0)
    expect(db.getOrder(localId)?.fiscal_invoice_number).toBeNull()
  })

  it('a non-voided waiting order still resubmits and files as before', async () => {
    const db = freshDb()
    const { localId } = waitingSale(db, 'uuid-regression')
    const provider = okProvider('0000000000000000007')

    const outcome = await resendFiscalization({ db, fiscalizationProvider: provider, logger: silentLogger() }, localId)

    expect(outcome.ok).toBe(true)
    expect(provider.submitInvoice).toHaveBeenCalledTimes(1)
    expect(provider.submitInvoice.mock.calls[0][0]).toMatchObject({ isRetry: true, localId })
    expect(db.getOrder(localId)?.fiscal_status).toBe('fiscalized')
    expect(db.getOrder(localId)?.fiscal_invoice_number).toBe('0000000000000000007')
  })
})

describe('voided orders are excluded from the unfiled count and Needs Attention', () => {
  it('excludes voided waiting and needs_fixing orders but still counts live ones', () => {
    const db = freshDb()
    const voidedWaiting = waitingSale(db, 'uuid-vw').localId
    const voidedFixing = needsFixingSale(db, 'uuid-vf').localId
    const liveWaiting = waitingSale(db, 'uuid-lw').localId
    const liveFixing = needsFixingSale(db, 'uuid-lf').localId
    db.voidOrder(voidedWaiting)
    db.voidOrder(voidedFixing)

    expect(db.getUnfiledOrderCount()).toBe(2)
    const ids = attentionIds(db)
    expect(ids).toEqual(expect.arrayContaining([liveWaiting, liveFixing]))
    expect(ids).not.toContain(voidedWaiting)
    expect(ids).not.toContain(voidedFixing)
  })
})

/** Keeps expected-failure log lines out of the test output. */
function silentLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
}
