/**
 * docs/phase-208, guard E: a CU invoice number belongs to one sale. `setOrderFiscalInfo`, the one
 * write path for a fiscal number, refuses a number another order already holds, writes nothing,
 * and its callers route the sale to needs_fixing.
 *
 * Runs against a real in-memory `RubisDatabase`.
 */

import { describe, it, expect, vi } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { resendFiscalization } from '../src/main/services/fiscal-retry.js'
import { UNVERIFIABLE_RETRY_REASON } from '../src/main/services/integrations/real-etims-provider.js'
import type { FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const HELD = '0110605040001000809'
const OTHER = '0110605040001000810'

const cartItem: CartItem = {
  id: 'gid://shopify/ProductVariant/201',
  productId: 'gid://shopify/Product/101',
  title: 'test',
  variantTitle: '',
  price: 1,
  quantity: 1,
  image: null
}

interface Seeded {
  db: RubisDatabase
  /** The order that already holds `HELD`. */
  holderId: number
  /** A second order, not yet filed, with a fiscal queue row. */
  otherId: number
  otherQueueId: number
  otherRequest: FiscalInvoiceRequest
}

/** Two orders: the first filed with `HELD`, the second waiting with a queued fiscal row. */
function seed(): Seeded {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const { staffId } = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' })
  const queue = (uuid: string): number =>
    db.queueOrder({
      items: [cartItem],
      total: 1,
      clientOrderUuid: uuid,
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 1,
      changeDue: 0
    }).localId
  const holderId = queue('uuid-holder')
  db.setOrderFiscalInfo(holderId, HELD, 'qr-holder')
  const otherId = queue('uuid-other')
  const otherRequest: FiscalInvoiceRequest = {
    clientOrderUuid: 'uuid-other',
    localId: otherId,
    items: [{ description: 'test', quantity: 1, unitPrice: 1, taxRate: 0.16 }],
    total: 1,
    taxAmount: 0.14,
    paymentMethod: 'cash'
  }
  db.setOrderFiscalRequest(otherId, otherRequest)
  db.setOrderFiscalFailure(otherId, 'waiting', 'device unreachable', 'technical')
  const otherQueueId = db.queueFiscalInvoice(otherId, otherRequest).queueId
  return { db, holderId, otherId, otherQueueId, otherRequest }
}

describe('setOrderFiscalInfo (guard E)', () => {
  it('refuses a number another order holds: returns false and writes nothing', () => {
    const { db, otherId } = seed()

    const stored = db.setOrderFiscalInfo(otherId, HELD, 'qr-other')

    expect(stored).toBe(false)
    const order = db.getOrder(otherId)
    expect(order?.fiscal_invoice_number).toBeNull()
    expect(order?.fiscal_status).toBe('waiting')
  })

  it('leaves the holder untouched', () => {
    const { db, holderId, otherId } = seed()

    db.setOrderFiscalInfo(otherId, HELD, 'qr-other')

    const holder = db.getOrder(holderId)
    expect(holder?.fiscal_invoice_number).toBe(HELD)
    expect(holder?.fiscal_qr_code).toBe('qr-holder')
  })

  it('accepts a number no other order holds', () => {
    const { db, otherId } = seed()

    expect(db.setOrderFiscalInfo(otherId, OTHER, 'qr-other')).toBe(true)
    expect(db.getOrder(otherId)?.fiscal_invoice_number).toBe(OTHER)
    expect(db.getOrder(otherId)?.fiscal_status).toBe('fiscalized')
  })

  it('accepts the same number for the order that already holds it (a repeat write is not a clash)', () => {
    const { db, holderId } = seed()

    expect(db.setOrderFiscalInfo(holderId, HELD, 'qr-holder')).toBe(true)
  })
})

describe('the callers route a refused number to needs_fixing (guard E)', () => {
  it('settleCheckoutFiscalSuccess: returns false, flags the sale with the phase 111 message, deletes the fiscal row', () => {
    const { db, otherId, otherQueueId } = seed()

    const stored = db.settleCheckoutFiscalSuccess(otherId, otherQueueId, {
      invoiceNumber: HELD,
      qrCode: 'qr-other',
      fiscalizedAt: '2026-10-03T00:00:00.000Z'
    })

    expect(stored).toBe(false)
    const order = db.getOrder(otherId)
    expect(order?.fiscal_status).toBe('needs_fixing')
    expect(order?.fiscal_error_reason).toBe(UNVERIFIABLE_RETRY_REASON)
    expect(order?.fiscal_invoice_number).toBeNull()
    expect(db.getPendingFiscalQueue(Number.MAX_SAFE_INTEGER)).toHaveLength(0)
  })

  it('markFiscalQueueItemSynced: returns false, flags the sale, deletes the fiscal row', () => {
    const { db, otherId, otherQueueId } = seed()

    const stored = db.markFiscalQueueItemSynced(otherQueueId, HELD, 'qr-other')

    expect(stored).toBe(false)
    const order = db.getOrder(otherId)
    expect(order?.fiscal_status).toBe('needs_fixing')
    expect(order?.fiscal_error_reason).toBe(UNVERIFIABLE_RETRY_REASON)
    expect(order?.fiscal_invoice_number).toBeNull()
    expect(db.getPendingFiscalQueue(Number.MAX_SAFE_INTEGER)).toHaveLength(0)
  })

  it('markFiscalQueueItemSynced with a fresh number still fiscalizes and clears the row', () => {
    const { db, otherId, otherQueueId } = seed()

    expect(db.markFiscalQueueItemSynced(otherQueueId, OTHER, 'qr-other')).toBe(true)
    expect(db.getOrder(otherId)?.fiscal_status).toBe('fiscalized')
    expect(db.getPendingFiscalQueue(Number.MAX_SAFE_INTEGER)).toHaveLength(0)
  })

  it('resendFiscalization: a duplicate number is a failure, the sale is flagged and onFiled is not called', async () => {
    const { db, otherId } = seed()
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: HELD, qrCode: 'qr-other', fiscalizedAt: '2026-10-03T00:00:00.000Z' }
    })
    const onFiled = vi.fn()

    const outcome = await resendFiscalization(
      { db, fiscalizationProvider: { submitInvoice }, onFiled },
      otherId
    )

    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toBe(UNVERIFIABLE_RETRY_REASON)
    expect(onFiled).not.toHaveBeenCalled()
    const order = db.getOrder(otherId)
    expect(order?.fiscal_status).toBe('needs_fixing')
    expect(order?.fiscal_invoice_number).toBeNull()
  })
})
