/**
 * The M-Pesa payment gate, at the sale path.
 *
 * The rule: **no M-Pesa sale reaches the ledger without a real
 * confirmation, by any route.** Payment inverts the fiscal rule the rest
 * of `runCheckout` follows. An unfiled sale is recoverable, so
 * fiscalization never blocks; goods handed over for a payment that never
 * arrived are not, so every ambiguous case here stops the sale.
 *
 * These tests exist because of a live hole (phase-102): a till installed
 * with no `.env` ran the mock, whose `verifyTransactionCode` approves
 * almost any string, and a Daraja till verified nothing at all in the
 * main process. Each test below covers one of the routes an M-Pesa sale
 * can take to completion.
 */

import { describe, it, expect, vi } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'
import type { CheckoutRequest } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { runCheckout, UNCONFIRMED_MPESA_MESSAGE } from '../src/main/services/checkout.js'
import type { CheckoutDb, CheckoutLogger, RunCheckoutDeps } from '../src/main/services/checkout.js'
import { SmsMpesaProvider } from '../src/main/services/integrations/sms-mpesa-provider.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

function seedStaff(db: RubisDatabase): number {
  return db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' }).staffId
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

/** A fiscalization provider that always succeeds — nothing here tests filing. */
function fiscalOk(): { submitInvoice: ReturnType<typeof vi.fn> } {
  return {
    submitInvoice: vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: 'KRA-0001', qrCode: 'qr', fiscalizedAt: '2026-01-01T00:00:00.000Z' }
    })
  }
}

function makeInput(staffId: number, overrides: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    items: [cartItem],
    total: 139.2,
    staffId,
    paymentMethod: 'cash',
    tenderedAmount: 150,
    changeDue: 10.8,
    ...overrides
  }
}

function makeDeps(db: CheckoutDb, overrides: Partial<RunCheckoutDeps> = {}): RunCheckoutDeps {
  let uuidCounter = 0
  return {
    db,
    mpesaProvider: { verifyTransactionCode: vi.fn() },
    fiscalizationProvider: fiscalOk(),
    fiscalEngine: { onCheckoutMade: vi.fn(), claim: vi.fn(), release: vi.fn() },
    monitor: { isOnline: () => false },
    engineTick: vi.fn().mockResolvedValue(undefined),
    idGen: () => `uuid-${++uuidCounter}`,
    taxRate: 0.16,
    verifyReferenceNumbers: false,
    claimsStoredPayments: false,
    logger: silentLogger,
    debugLogging: false,
    ...overrides
  }
}

/** An M-Pesa checkout carrying whatever reference the caller claims. */
function mpesaSale(staffId: number, referenceNumber?: string): CheckoutRequest {
  return makeInput(staffId, {
    paymentMethod: 'mpesa',
    tenderedAmount: 139.2,
    changeDue: 0,
    referenceNumber
  })
}

describe('the payment gate blocks every unconfirmed M-Pesa sale', () => {
  it('refuses an M-Pesa sale with no reference at all', async () => {
    const db = freshDb()
    const deps = makeDeps(db)

    const result = await runCheckout(deps, mpesaSale(seedStaff(db)))

    expect(result).toEqual({ success: false, error: UNCONFIRMED_MPESA_MESSAGE })
    expect(db.getOrders()).toHaveLength(0)
  })

  it('refuses an M-Pesa sale whose reference is only whitespace', async () => {
    const db = freshDb()
    const deps = makeDeps(db)

    const result = await runCheckout(deps, mpesaSale(seedStaff(db), '   '))

    expect(result.success).toBe(false)
    expect(db.getOrders()).toHaveLength(0)
  })

  it('refuses a typed reference on a till whose provider cannot verify one', async () => {
    // The loophole itself: on a Daraja till this used to complete.
    const db = freshDb()
    const deps = makeDeps(db, { verifyReferenceNumbers: false })

    const result = await runCheckout(deps, mpesaSale(seedStaff(db), 'X'))

    expect(result).toEqual({ success: false, error: UNCONFIRMED_MPESA_MESSAGE })
    expect(db.getOrders()).toHaveLength(0)
  })

  it('refuses a plausible-looking code that never went through a payment', async () => {
    // A well-formed string is not evidence. Nothing about the shape of a
    // reference tells you money moved.
    const db = freshDb()
    const deps = makeDeps(db, { verifyReferenceNumbers: false })

    const result = await runCheckout(deps, mpesaSale(seedStaff(db), 'QGH7XJ2K1L'))

    expect(result.success).toBe(false)
    expect(db.getOrders()).toHaveLength(0)
  })

  it('does not fiscalize or touch the ledger for a blocked sale', async () => {
    const db = freshDb()
    const fiscal = fiscalOk()
    const deps = makeDeps(db, { fiscalizationProvider: fiscal })

    await runCheckout(deps, mpesaSale(seedStaff(db), 'X'))

    expect(fiscal.submitInvoice).not.toHaveBeenCalled()
    expect(db.getOrders()).toHaveLength(0)
  })
})

describe('a provider that can verify decides for itself', () => {
  it('completes the sale when the provider confirms the payment', async () => {
    const db = freshDb()
    const verifyTransactionCode = vi
      .fn()
      .mockResolvedValue({ success: true, data: { verified: true, transactionCode: 'QDF73H', amount: 139.2 } })
    const deps = makeDeps(db, { verifyReferenceNumbers: true, mpesaProvider: { verifyTransactionCode } })

    const result = await runCheckout(deps, mpesaSale(seedStaff(db), 'QDF73H'))

    expect(result.success).toBe(true)
    expect(db.getOrders()).toHaveLength(1)
    expect(verifyTransactionCode).toHaveBeenCalledWith({ transactionCode: 'QDF73H', amount: 139.2 })
  })

  it('blocks the sale when the provider says the code is not a payment', async () => {
    const db = freshDb()
    const verifyTransactionCode = vi
      .fn()
      .mockResolvedValue({ success: true, data: { verified: false, reason: 'That payment has not arrived yet.' } })
    const deps = makeDeps(db, { verifyReferenceNumbers: true, mpesaProvider: { verifyTransactionCode } })

    const result = await runCheckout(deps, mpesaSale(seedStaff(db), 'NOPE'))

    expect(result).toEqual({ success: false, error: 'That payment has not arrived yet.' })
    expect(db.getOrders()).toHaveLength(0)
  })

  it('blocks the sale when the check itself could not be made', async () => {
    // An unanswered question is not a yes.
    const db = freshDb()
    const verifyTransactionCode = vi.fn().mockResolvedValue({ success: false, error: 'Could not reach M-Pesa' })
    const deps = makeDeps(db, { verifyReferenceNumbers: true, mpesaProvider: { verifyTransactionCode } })

    const result = await runCheckout(deps, mpesaSale(seedStaff(db), 'QDF73H'))

    expect(result).toEqual({ success: false, error: 'Could not reach M-Pesa' })
    expect(db.getOrders()).toHaveLength(0)
  })

  it('passes the trimmed reference to the provider', async () => {
    const db = freshDb()
    const verifyTransactionCode = vi
      .fn()
      .mockResolvedValue({ success: true, data: { verified: true, transactionCode: 'QDF73H', amount: 139.2 } })
    const deps = makeDeps(db, { verifyReferenceNumbers: true, mpesaProvider: { verifyTransactionCode } })

    await runCheckout(deps, mpesaSale(seedStaff(db), '  QDF73H  '))

    expect(verifyTransactionCode).toHaveBeenCalledWith({ transactionCode: 'QDF73H', amount: 139.2 })
  })
})

describe('a Daraja till proves payment from its own STK records', () => {
  /** Records an STK push and its confirmed outcome, exactly as the IPC handlers do. */
  function recordConfirmedStkPush(
    db: RubisDatabase,
    checkoutRequestId: string,
    receiptNumber?: string
  ): void {
    db.logMpesaTransaction({
      checkoutRequestId,
      merchantRequestId: 'merchant-1',
      phoneNumber: '254712345678',
      amount: 139.2
    })
    db.updateMpesaTransactionStatus(checkoutRequestId, 'success', receiptNumber)
  }

  it('completes a sale for a receipt number Daraja confirmed', async () => {
    // The regression that matters most: a real Daraja STK sale must
    // still go through, end to end, after all of this.
    const db = freshDb()
    const staffId = seedStaff(db)
    recordConfirmedStkPush(db, 'ws_CO_123', 'QGH7XJ2K1L')
    const deps = makeDeps(db, { verifyReferenceNumbers: false })

    const result = await runCheckout(deps, mpesaSale(staffId, 'QGH7XJ2K1L'))

    expect(result.success).toBe(true)
    expect(db.getOrders()).toHaveLength(1)
  })

  it('completes a sale for the checkout request id, which PaymentModal falls back to', async () => {
    // Daraja can confirm a payment without returning a receipt number,
    // and the modal then hands back the request id instead.
    const db = freshDb()
    const staffId = seedStaff(db)
    recordConfirmedStkPush(db, 'ws_CO_456', undefined)
    const deps = makeDeps(db, { verifyReferenceNumbers: false })

    const result = await runCheckout(deps, mpesaSale(staffId, 'ws_CO_456'))

    expect(result.success).toBe(true)
    expect(db.getOrders()).toHaveLength(1)
  })

  it('blocks a push that was logged but never confirmed', async () => {
    // Logged as pending is not paid. This is the "cashier gave up
    // waiting and typed the reference in anyway" case.
    const db = freshDb()
    const staffId = seedStaff(db)
    db.logMpesaTransaction({
      checkoutRequestId: 'ws_CO_789',
      merchantRequestId: 'merchant-1',
      phoneNumber: '254712345678',
      amount: 139.2
    })
    const deps = makeDeps(db, { verifyReferenceNumbers: false })

    const result = await runCheckout(deps, mpesaSale(staffId, 'ws_CO_789'))

    expect(result).toEqual({ success: false, error: UNCONFIRMED_MPESA_MESSAGE })
    expect(db.getOrders()).toHaveLength(0)
  })

  it('blocks a push Daraja reported as failed', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    db.logMpesaTransaction({
      checkoutRequestId: 'ws_CO_999',
      merchantRequestId: 'merchant-1',
      phoneNumber: '254712345678',
      amount: 139.2
    })
    db.updateMpesaTransactionStatus('ws_CO_999', 'failed')
    const deps = makeDeps(db, { verifyReferenceNumbers: false })

    const result = await runCheckout(deps, mpesaSale(staffId, 'ws_CO_999'))

    expect(result.success).toBe(false)
    expect(db.getOrders()).toHaveLength(0)
  })

  it('never asks the Daraja provider to verify a code, since it cannot', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    recordConfirmedStkPush(db, 'ws_CO_123', 'QGH7XJ2K1L')
    const verifyTransactionCode = vi.fn()
    const deps = makeDeps(db, { verifyReferenceNumbers: false, mpesaProvider: { verifyTransactionCode } })

    await runCheckout(deps, mpesaSale(staffId, 'QGH7XJ2K1L'))

    expect(verifyTransactionCode).not.toHaveBeenCalled()
  })
})

describe('hasConfirmedStkPayment', () => {
  it('matches a confirmed receipt number case-insensitively', () => {
    const db = freshDb()
    db.logMpesaTransaction({
      checkoutRequestId: 'ws_CO_1',
      merchantRequestId: 'm',
      phoneNumber: '254712345678',
      amount: 100
    })
    db.updateMpesaTransactionStatus('ws_CO_1', 'success', 'QGH7XJ2K1L')

    expect(db.hasConfirmedStkPayment('qgh7xj2k1l')).toBe(true)
    expect(db.hasConfirmedStkPayment('  QGH7XJ2K1L  ')).toBe(true)
  })

  it('is false for a blank reference and for one it has never seen', () => {
    const db = freshDb()

    expect(db.hasConfirmedStkPayment('')).toBe(false)
    expect(db.hasConfirmedStkPayment('   ')).toBe(false)
    expect(db.hasConfirmedStkPayment('NEVERSEEN')).toBe(false)
  })
})

describe('a message-based till spends the payment it used', () => {
  /** A stored confirmation message, as the inbox reader would have written it. */
  function storePayment(db: RubisDatabase, transactionCode = 'UI7N55IAAT'): void {
    db.insertMpesaSmsMessage({
      transactionCode,
      amount: 139.2,
      payerName: 'Nelson Elijah Onyango',
      payerAlias: null,
      maskedPhone: '254719350972',
      accountReference: null,
      occurredAt: '2026-09-07T13:44:00.000Z',
      sourceFile: 'IN20260907_134401_00_MPESA_00.txt',
      rawText: 'UI7N55IAAT Confirmed. Ksh139.20 received.',
      createdAt: '2026-09-07T13:44:05.000Z'
    })
  }

  /** Deps for a till that confirms from messages and consumes what it uses. */
  function smsDeps(db: RubisDatabase): RunCheckoutDeps {
    return makeDeps(db, {
      verifyReferenceNumbers: true,
      claimsStoredPayments: true,
      mpesaProvider: new SmsMpesaProvider({ db })
    })
  }

  it('completes the sale and marks the payment as spent', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    storePayment(db)

    const result = await runCheckout(smsDeps(db), mpesaSale(staffId, 'UI7N55IAAT'))

    expect(result.success).toBe(true)
    const row = db.getMpesaSmsMessageByCode('UI7N55IAAT')
    expect(row?.matched_order_local_id).toBe(result.data?.localId)
    expect(row?.approved_by_staff_id).toBe(staffId)
  })

  it('refuses a second sale using the same payment', async () => {
    // The ordinary-use double credit: a payment left on the list after
    // paying for one sale gets picked again for the next.
    const db = freshDb()
    const staffId = seedStaff(db)
    storePayment(db)

    const first = await runCheckout(smsDeps(db), mpesaSale(staffId, 'UI7N55IAAT'))
    const second = await runCheckout(smsDeps(db), mpesaSale(staffId, 'UI7N55IAAT'))

    expect(first.success).toBe(true)
    expect(second.success).toBe(false)
    expect(db.getOrders()).toHaveLength(1)
  })

  it('tells the cashier the payment was already used, in plain words', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    storePayment(db)
    await runCheckout(smsDeps(db), mpesaSale(staffId, 'UI7N55IAAT'))

    const second = await runCheckout(smsDeps(db), mpesaSale(staffId, 'UI7N55IAAT'))

    expect(second.error).toMatch(/already used for another sale/)
    expect(second.error).not.toMatch(/transaction_code|SQL|null/i)
  })

  it('enforces the exact amount before anything is spent', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    storePayment(db)

    // The sale is for 139.20; this payment is not.
    const result = await runCheckout(
      smsDeps(db),
      makeInput(staffId, {
        paymentMethod: 'mpesa',
        total: 200,
        tenderedAmount: 200,
        changeDue: 0,
        referenceNumber: 'UI7N55IAAT'
      })
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/different amount/)
    expect(db.getOrders()).toHaveLength(0)
    // Refused, so still available for the sale it actually paid for.
    expect(db.getMpesaSmsMessageByCode('UI7N55IAAT')?.matched_order_local_id).toBeNull()
  })

  it('leaves other payments untouched when one sale completes', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    storePayment(db, 'UI7N55IAAT')
    storePayment(db, 'BBB2222222')

    await runCheckout(smsDeps(db), mpesaSale(staffId, 'UI7N55IAAT'))

    expect(db.getMpesaSmsMessageByCode('BBB2222222')?.matched_order_local_id).toBeNull()
  })

  it('spends nothing on a till that does not claim stored payments', async () => {
    // Daraja and the mock have no stored confirmation to consume, and
    // attempting to would either fail their sales or mark a row that is
    // not theirs.
    const db = freshDb()
    const staffId = seedStaff(db)
    storePayment(db)
    const deps = makeDeps(db, {
      verifyReferenceNumbers: true,
      claimsStoredPayments: false,
      mpesaProvider: new SmsMpesaProvider({ db })
    })

    const result = await runCheckout(deps, mpesaSale(staffId, 'UI7N55IAAT'))

    expect(result.success).toBe(true)
    expect(db.getMpesaSmsMessageByCode('UI7N55IAAT')?.matched_order_local_id).toBeNull()
  })
})

describe('cash and card are untouched by the M-Pesa gate', () => {
  it('a cash sale completes exactly as before', async () => {
    const db = freshDb()
    const deps = makeDeps(db)

    const result = await runCheckout(deps, makeInput(seedStaff(db)))

    expect(result.success).toBe(true)
    expect(db.getOrders()).toHaveLength(1)
  })

  /**
   * DELIBERATE TEST CHANGE (docs/phase-176.md Part 2): card now has its
   * own gate (`checkout.ts`'s `if (input.paymentMethod === 'card')`
   * block, see `tests/cardManualPayment.test.ts` for its full coverage)
   * — Part 1's audit found it had none at all, which is exactly what
   * that gate closes. What survives from this test's original premise
   * is still true and still asserted here: a card sale is never routed
   * through the M-Pesa confirmation gate, since there is no confirming
   * provider for a PDQ payment to check against.
   */
  it('a card sale completes on cardApproval, with no M-Pesa-style confirmation required', async () => {
    const db = freshDb()
    const verifyTransactionCode = vi.fn()
    const deps = makeDeps(db, { verifyReferenceNumbers: true, mpesaProvider: { verifyTransactionCode } })

    const result = await runCheckout(
      deps,
      makeInput(seedStaff(db), {
        paymentMethod: 'card',
        cardApproval: { reference: 'TXN9001', confirmRecorded: true }
      })
    )

    expect(result.success).toBe(true)
    expect(db.getOrders()).toHaveLength(1)
    expect(verifyTransactionCode).not.toHaveBeenCalled()
  })
})
