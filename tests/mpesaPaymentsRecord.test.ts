/**
 * The unified payment record, across all three modes.
 *
 * Before this table, a Daraja payment had no link to the sale it paid
 * for: `mpesa_transactions.order_local_id` was optional and never once
 * supplied, because both callers ran before the order existed. These
 * tests hold the closure of that gap — every mode, one row, always
 * naming its sale.
 */

import { describe, it, expect, vi } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'
import type { CheckoutRequest } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { runCheckout } from '../src/main/services/checkout.js'
import type { CheckoutLogger, RunCheckoutDeps } from '../src/main/services/checkout.js'
import { SmsMpesaProvider } from '../src/main/services/integrations/sms-mpesa-provider.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const TOTAL = 139.2

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

function seedStaff(db: RubisDatabase): { cashierId: number; managerId: number } {
  return {
    cashierId: db.createStaff({ name: 'Ann', pinHash: hashPin('1111'), role: 'cashier' }).staffId,
    managerId: db.createStaff({ name: 'Bob', pinHash: hashPin('2222'), role: 'admin' }).staffId
  }
}

const cartItem: CartItem = {
  id: 'gid://shopify/ProductVariant/201',
  productId: 'gid://shopify/Product/101',
  title: 'RUBIS Mug',
  variantTitle: 'Small',
  price: 60,
  quantity: 2,
  image: null
}

const silentLogger: CheckoutLogger = { log: () => {}, warn: () => {}, error: () => {} }

function makeDeps(db: RubisDatabase, overrides: Partial<RunCheckoutDeps> = {}): RunCheckoutDeps {
  let uuid = 0
  return {
    db,
    mpesaProvider: { verifyTransactionCode: vi.fn() },
    fiscalizationProvider: {
      submitInvoice: vi.fn().mockResolvedValue({
        ok: true,
        data: { invoiceNumber: 'KRA-1', qrCode: 'qr', fiscalizedAt: '2026-01-01T00:00:00.000Z' }
      })
    },
    fiscalEngine: { onCheckoutMade: vi.fn() },
    monitor: { isOnline: () => false },
    engineTick: vi.fn().mockResolvedValue(undefined),
    idGen: () => `uuid-${++uuid}`,
    taxRate: 0.16,
    verifyReferenceNumbers: false,
    claimsStoredPayments: false,
    logger: silentLogger,
    debugLogging: false,
    ...overrides
  }
}

function sale(staffId: number, overrides: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    items: [cartItem],
    total: TOTAL,
    staffId,
    paymentMethod: 'mpesa',
    tenderedAmount: TOTAL,
    changeDue: 0,
    ...overrides
  }
}

describe('every mode writes exactly one payment row, naming its sale', () => {
  it('records a Daraja sale as confirmed', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    db.logMpesaTransaction({
      checkoutRequestId: 'ws_CO_1',
      merchantRequestId: 'm',
      phoneNumber: '254712345678',
      amount: TOTAL
    })
    db.updateMpesaTransactionStatus('ws_CO_1', 'success', 'QGH7XJ2K1L')

    const result = await runCheckout(
      makeDeps(db),
      sale(cashierId, { referenceNumber: 'QGH7XJ2K1L' })
    )

    const payments = db.listMpesaPayments()
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({
      mode: 'daraja',
      verification_status: 'confirmed',
      reference: 'QGH7XJ2K1L',
      order_local_id: result.data?.localId,
      entered_by_staff_id: cashierId,
      approved_by_staff_id: null
    })
  })

  it('records a message-confirmed sale as matched, alongside the claim', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    db.insertMpesaSmsMessage({
      transactionCode: 'UI7N55IAAT',
      amount: TOTAL,
      payerName: 'Nelson Onyango',
      payerAlias: null,
      maskedPhone: '254719350972',
      accountReference: null,
      occurredAt: '2026-09-07T13:44:00.000Z',
      sourceFile: 'IN20260907.txt',
      rawText: 'UI7N55IAAT Confirmed. Ksh139.20 received.',
      createdAt: '2026-09-07T13:44:05.000Z'
    })

    const result = await runCheckout(
      makeDeps(db, {
        verifyReferenceNumbers: true,
        claimsStoredPayments: true,
        mpesaProvider: new SmsMpesaProvider({ db })
      }),
      sale(cashierId, { referenceNumber: 'UI7N55IAAT' })
    )

    const payments = db.listMpesaPayments()
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({
      mode: 'sms',
      verification_status: 'matched',
      reference: 'UI7N55IAAT',
      order_local_id: result.data?.localId
    })
    // The existing claim still happens; the payment row is additional.
    expect(db.getMpesaSmsMessageByCode('UI7N55IAAT')?.matched_order_local_id).toBe(
      result.data?.localId
    )
  })

  /**
   * DELIBERATE TEST CHANGE (docs/phase-150.md step 3): a manual sale no
   * longer has an approver at sale time — `ManualMpesaApproval` dropped
   * `approvedByStaffId` entirely, since per-sale manager approval was
   * removed (a manager's later end-of-day approval, Step 4, is what
   * eventually sets it).
   *   Old assertion: `approved_by_staff_id` equals the seeded manager's id.
   *   New assertion: `approved_by_staff_id` is `null`.
   */
  it('records a manual sale as manual_unverified with no approver yet', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)

    const result = await runCheckout(
      makeDeps(db, { manualEntryEnabled: true }),
      sale(cashierId, {
        referenceNumber: 'QDF73HK9LM',
        manualApproval: { acknowledgedUnverified: true }
      })
    )

    expect(db.listMpesaPayments()[0]).toMatchObject({
      mode: 'manual',
      verification_status: 'manual_unverified',
      order_local_id: result.data?.localId,
      entered_by_staff_id: cashierId,
      approved_by_staff_id: null
    })
  })

  it('writes nothing for a cash sale, which settles no M-Pesa payment', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)

    await runCheckout(
      makeDeps(db),
      sale(cashierId, { paymentMethod: 'cash', tenderedAmount: 150, changeDue: 10.8 })
    )

    expect(db.listMpesaPayments()).toHaveLength(0)
  })

  /**
   * DELIBERATE TEST CHANGE (docs/phase-176.md Part 2): a card sale now
   * needs `cardApproval` (see `tests/cardManualPayment.test.ts` for its
   * gate's full coverage) — this uses a valid one so the assertion below
   * still exercises a *successful* card sale, not an incidentally
   * refused one.
   */
  it('writes nothing for a card sale either', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)

    const result = await runCheckout(
      makeDeps(db),
      sale(cashierId, {
        paymentMethod: 'card',
        cardApproval: { reference: 'TXN9001', confirmRecorded: true }
      })
    )

    expect(result.success).toBe(true)
    expect(db.listMpesaPayments()).toHaveLength(0)
  })

  it('writes no payment row for a refused sale', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)

    const result = await runCheckout(makeDeps(db), sale(cashierId, { referenceNumber: 'NEVERPAID' }))

    expect(result.success).toBe(false)
    expect(db.listMpesaPayments()).toHaveLength(0)
  })
})

describe('the pre-existing Daraja re-use residual is recorded, not fixed', () => {
  /**
   * `hasConfirmedStkPayment` is a read-only check with no claim, so one
   * confirmed STK payment can still settle two sales — phase-120 §10.2,
   * deliberately out of scope here. What must be true is that this
   * change neither fixes nor worsens it: the second sale still
   * completes, exactly as before.
   */
  it('lets a second Daraja sale on one reference complete, as it did before', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    db.logMpesaTransaction({
      checkoutRequestId: 'ws_CO_1',
      merchantRequestId: 'm',
      phoneNumber: '254712345678',
      amount: TOTAL
    })
    db.updateMpesaTransactionStatus('ws_CO_1', 'success', 'QGH7XJ2K1L')

    const first = await runCheckout(
      makeDeps(db),
      sale(cashierId, { referenceNumber: 'QGH7XJ2K1L' })
    )
    const second = await runCheckout(
      makeDeps(db),
      sale(cashierId, { referenceNumber: 'QGH7XJ2K1L' })
    )

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(db.getOrders()).toHaveLength(2)

    // One payment row for two sales — the residual, now visible rather
    // than invisible. Detectable after the fact; still not prevented.
    expect(db.listMpesaPayments()).toHaveLength(1)
  })
})
