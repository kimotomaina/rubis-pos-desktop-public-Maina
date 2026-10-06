/**
 * Card (PDQ) tender: the manually recorded, no-confirming-provider
 * tender (docs/phase-176.md Part 2).
 *
 * Rubis takes cards on a separate PDQ machine the till has no link to
 * (docs/phase-176.md §4.7, VIL G03 manual Step 7) — unlike M-Pesa there
 * is no Daraja/SMS route to confirm against, so the whole record is the
 * cashier's reference plus their attestation that the slip printed
 * Approved. These tests are mostly about what must remain impossible:
 *
 *   - completing a card sale with no reference, a malformed reference,
 *     or no attestation;
 *   - a renderer's tenderedAmount/changeDue/referenceNumber overriding
 *     what `runCheckout` derives (the PDQ terminal already took the
 *     full amount, so those fields carry no information for a card
 *     sale);
 *   - reaching the queue twice, or the fiscal queue twice, for one sale.
 *
 * As with manual M-Pesa (docs/phase-150.md step 3), there is no manager
 * involved at sale time — cashier attribution comes from `staffId`
 * alone.
 */

import { describe, it, expect, vi } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'
import type { CheckoutRequest } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import {
  CARD_REFERENCE_INVALID_MESSAGE,
  CARD_REFERENCE_MISSING_MESSAGE,
  CARD_NOT_ACKNOWLEDGED_MESSAGE,
  runCheckout
} from '../src/main/services/checkout.js'
import type { CheckoutLogger, RunCheckoutDeps } from '../src/main/services/checkout.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const REFERENCE = 'TXN9001'

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

function seedStaff(db: RubisDatabase): number {
  return db.createStaff({ name: 'Ann', pinHash: hashPin('1111'), role: 'cashier' }).staffId
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
    fiscalEngine: { onCheckoutMade: vi.fn(), claim: vi.fn(), release: vi.fn() },
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

/** A card sale, as `index.ts` builds it — no manager involved, matching manual M-Pesa. */
function cardSale(staffId: number, overrides: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    items: [cartItem],
    total: 139.2,
    staffId,
    paymentMethod: 'card',
    // Deliberately wrong, on every test that doesn't override them — the
    // "renderer-sent values are overridden" tests below assert these
    // never reach the order row.
    tenderedAmount: 0,
    changeDue: 99,
    cardApproval: { reference: REFERENCE, confirmRecorded: true },
    ...overrides
  }
}

describe('the four guard rails', () => {
  it('refuses a card sale with no cardApproval at all', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)

    const result = await runCheckout(makeDeps(db), cardSale(staffId, { cardApproval: undefined }))

    expect(result).toEqual({ success: false, error: CARD_REFERENCE_MISSING_MESSAGE })
    expect(db.getOrders()).toHaveLength(0)
  })

  it.each([
    ['blank', ''],
    ['whitespace', '   ']
  ])('refuses a %s reference as missing, not malformed', async (_label, reference) => {
    const db = freshDb()
    const staffId = seedStaff(db)

    const result = await runCheckout(
      makeDeps(db),
      cardSale(staffId, { cardApproval: { reference, confirmRecorded: true } })
    )

    expect(result).toEqual({ success: false, error: CARD_REFERENCE_MISSING_MESSAGE })
    expect(db.getOrders()).toHaveLength(0)
  })

  it.each([
    ['13 characters', 'TXN90011234AB'],
    ['lowercase', 'txn9001'],
    ['punctuation', 'TXN-9001']
  ])('refuses a reference that is %s', async (_label, reference) => {
    const db = freshDb()
    const staffId = seedStaff(db)

    const result = await runCheckout(
      makeDeps(db),
      cardSale(staffId, { cardApproval: { reference, confirmRecorded: true } })
    )

    expect(result).toEqual({ success: false, error: CARD_REFERENCE_INVALID_MESSAGE })
    expect(db.getOrders()).toHaveLength(0)
  })

  it('refuses without the cashier’s attestation', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)

    const result = await runCheckout(
      makeDeps(db),
      cardSale(staffId, { cardApproval: { reference: REFERENCE, confirmRecorded: false } })
    )

    expect(result).toEqual({ success: false, error: CARD_NOT_ACKNOWLEDGED_MESSAGE })
    expect(db.getOrders()).toHaveLength(0)
  })
})

describe('a valid card sale', () => {
  it('writes payment_method, reference_number, derived tendered/change, and cashier attribution', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)

    const result = await runCheckout(makeDeps(db), cardSale(staffId))

    expect(result.success).toBe(true)
    const order = db.getOrder(result.data!.localId)
    expect(order?.payment_method).toBe('card')
    expect(order?.reference_number).toBe(REFERENCE)
    expect(order?.tendered_amount).toBe(139.2)
    expect(order?.change_due).toBe(0)
    expect(order?.staff_id).toBe(staffId)
  })

  it.each([
    ['a renderer-sent tenderedAmount of 0', { tenderedAmount: 0 }],
    ['a renderer-sent changeDue of 99', { changeDue: 99 }],
    ['both wrong at once', { tenderedAmount: 0, changeDue: 99 }]
  ])('overrides %s with the derived total/zero', async (_label, overrides) => {
    const db = freshDb()
    const staffId = seedStaff(db)

    const result = await runCheckout(makeDeps(db), cardSale(staffId, overrides))

    const order = db.getOrder(result.data!.localId)
    expect(order?.tendered_amount).toBe(139.2)
    expect(order?.change_due).toBe(0)
  })

  /**
   * A hostile top-level `referenceNumber` must not leak into the order
   * either — `cardApproval.reference` is the only source, mirroring
   * manual M-Pesa's own "ignores a verification status the caller tries
   * to supply" test.
   */
  it('ignores a top-level referenceNumber the caller tries to supply, using cardApproval.reference instead', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)

    const result = await runCheckout(
      makeDeps(db),
      cardSale(staffId, { referenceNumber: 'FORGED-REF' })
    )

    const order = db.getOrder(result.data!.localId)
    expect(order?.reference_number).toBe(REFERENCE)
  })

  it('is queued exactly once and reaches the fiscal queue exactly once', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'device unreachable',
      kind: 'technical',
      retryable: true
    })
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice } })

    const result = await runCheckout(deps, cardSale(staffId))

    expect(result.success).toBe(true)
    expect(db.getOrders()).toHaveLength(1)
    expect(submitInvoice).toHaveBeenCalledTimes(1)
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(1)
  })

  it('follows the same unconditional queueOrder path as cash — no settlement/ledger row', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)

    await runCheckout(makeDeps(db), cardSale(staffId))

    // Option A (docs/phase-176.md Part 2 §5): nothing card-specific is
    // ever written to mpesa_payments.
    expect(db.listMpesaPayments()).toHaveLength(0)
  })
})

// CHANGED (docs/phase-249): every checkout payload now carries the screen's checkout key, which the schema requires.
describe('the wire contract gives a renderer nothing to forge', () => {
  it('has no cardApproval field on the checkout payload, but does have cardManual', async () => {
    const { checkoutRequestSchema } = await import('../src/main/lib/ipcValidator.js')
    const keys = Object.keys(checkoutRequestSchema.shape)

    expect(keys).not.toContain('cardApproval')
    expect(keys).toContain('cardManual')
  })

  it('accepts a well-formed cardManual', async () => {
    const { checkoutRequestSchema, validate } = await import('../src/main/lib/ipcValidator.js')
    const base = {
      items: [cartItem],
      total: 139.2,
      staffId: 1,
      paymentMethod: 'card',
      tenderedAmount: 139.2,
      changeDue: 0,
      checkoutKey: '0b7d9c2e-4f1a-4c3b-9e8d-1a2b3c4d5e6f'
    }

    expect(
      validate(checkoutRequestSchema, {
        ...base,
        cardManual: { reference: REFERENCE, confirmRecorded: true }
      }).success
    ).toBe(true)
  })

  it.each([
    ['blank', ''],
    ['13 characters', 'TXN90011234AB'],
    ['lowercase', 'txn9001'],
    ['punctuation', 'TXN-9001']
  ])('rejects a reference that is %s', async (_label, reference) => {
    const { checkoutRequestSchema, validate } = await import('../src/main/lib/ipcValidator.js')
    const result = validate(checkoutRequestSchema, {
      items: [cartItem],
      total: 139.2,
      staffId: 1,
      paymentMethod: 'card',
      tenderedAmount: 139.2,
      changeDue: 0,
      checkoutKey: '0b7d9c2e-4f1a-4c3b-9e8d-1a2b3c4d5e6f',
      cardManual: { reference, confirmRecorded: true }
    })

    expect(result.success).toBe(false)
  })

  it('rejects a cardManual that is not explicitly confirmed', async () => {
    const { checkoutRequestSchema, validate } = await import('../src/main/lib/ipcValidator.js')

    expect(
      validate(checkoutRequestSchema, {
        items: [cartItem],
        total: 139.2,
        staffId: 1,
        paymentMethod: 'card',
        tenderedAmount: 139.2,
        changeDue: 0,
        checkoutKey: '0b7d9c2e-4f1a-4c3b-9e8d-1a2b3c4d5e6f',
        cardManual: { reference: REFERENCE, confirmRecorded: false }
      }).success
    ).toBe(false)
  })
})
