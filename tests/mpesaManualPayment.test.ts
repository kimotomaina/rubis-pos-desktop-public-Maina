/**
 * Manual M-Pesa entry: the deliberate, authorized, recorded exception.
 *
 * Phase-102 left the payment gate with two outcomes — confirmed, or
 * refused. This adds a third: a sale completed on a code nobody checked.
 * Its whole justification is that it is *recorded as such*, so these
 * tests are mostly about what must remain impossible:
 *
 *   - a manual payment reading as `confirmed`;
 *   - the renderer deciding the verification status, the cashier, or the
 *     approver (there is no approver at sale time at all — see below);
 *   - reaching the route without the switch, the format, or the
 *     attestation;
 *   - a sale existing without its payment record, or the reverse.
 *
 * As of docs/phase-150.md step 3 (the client's POC decision, reversing
 * phase-121's manager-PIN-per-sale design), there is no manager
 * involved at sale time at all: `approved_by_staff_id` is always
 * written `null` here, set later only by a manager's end-of-day
 * approval (Step 4) — not by anything this file exercises.
 *
 * Run against a real in-memory SQLite database: the `UNIQUE` constraint
 * and the order-and-payment transaction are part of the argument, so
 * they have to actually execute.
 */

import { describe, it, expect, vi } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'
import type { CheckoutRequest } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import {
  MPESA_MANUAL_CODE_ALREADY_USED_MESSAGE,
  MPESA_MANUAL_CODE_INVALID_MESSAGE,
  MPESA_MANUAL_NOT_ACKNOWLEDGED_MESSAGE,
  MPESA_MANUAL_NOT_ENABLED_MESSAGE,
  runCheckout
} from '../src/main/services/checkout.js'
import type { CheckoutLogger, RunCheckoutDeps } from '../src/main/services/checkout.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const CODE = 'QDF73HK9LM'

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

/** A cashier and a manager — manual entry always involves both. */
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
    fiscalEngine: { onCheckoutMade: vi.fn(), claim: vi.fn(), release: vi.fn() },
    monitor: { isOnline: () => false },
    engineTick: vi.fn().mockResolvedValue(undefined),
    idGen: () => `uuid-${++uuid}`,
    taxRate: 0.16,
    verifyReferenceNumbers: false,
    claimsStoredPayments: false,
    manualEntryEnabled: true,
    logger: silentLogger,
    debugLogging: false,
    ...overrides
  }
}

/** A manual M-Pesa sale, as `index.ts` builds it — no manager involved (docs/phase-150.md step 3). */
function manualSale(cashierId: number, overrides: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    items: [cartItem],
    total: 139.2,
    staffId: cashierId,
    paymentMethod: 'mpesa',
    tenderedAmount: 139.2,
    changeDue: 0,
    referenceNumber: CODE,
    manualApproval: { acknowledgedUnverified: true },
    ...overrides
  }
}

describe('a manual payment is recorded as unverified, never as confirmed', () => {
  it('completes the sale and records manual_unverified', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)

    const result = await runCheckout(makeDeps(db), manualSale(cashierId))

    expect(result.success).toBe(true)
    const [payment] = db.listMpesaPayments()
    expect(payment.mode).toBe('manual')
    expect(payment.verification_status).toBe('manual_unverified')
    expect(payment.reference).toBe(CODE)
    expect(payment.amount).toBe(139.2)
  })

  /**
   * The status is derived from which gate branch ran. There is no field
   * on the payload that could carry it, and this proves that a value
   * smuggled onto the object anyway changes nothing.
   */
  it('ignores a verification status the caller tries to supply', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    const hostile = {
      ...manualSale(cashierId),
      verificationStatus: 'confirmed',
      mode: 'daraja'
    } as unknown as CheckoutRequest

    await runCheckout(makeDeps(db), hostile)

    const [payment] = db.listMpesaPayments()
    expect(payment.verification_status).toBe('manual_unverified')
    expect(payment.mode).toBe('manual')
  })

  /**
   * DELIBERATE TEST CHANGE (docs/phase-150.md step 3): `approved_by_staff_id`
   * can no longer equal a manager's id at sale time — there is no
   * manager involved in a manual sale at all any more.
   *   Old assertion: `approved_by_staff_id` equals the seeded manager's
   *     id (from a PIN re-verified during checkout).
   *   New assertion: `approved_by_staff_id` is `null`, always — a
   *     hostile payload naming one changes nothing, and neither does a
   *     real one, since nothing populates it until Step 4's end-of-day
   *     approval.
   */
  it('ignores a cashier or approver the caller tries to name, and records no approver at all', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    const hostile = {
      ...manualSale(cashierId),
      enteredByStaffId: 999,
      approvedByStaffId: 999
    } as unknown as CheckoutRequest

    await runCheckout(makeDeps(db), hostile)

    const [payment] = db.listMpesaPayments()
    expect(payment.entered_by_staff_id).toBe(cashierId)
    expect(payment.approved_by_staff_id).toBeNull()
  })

  it('never asks the provider to verify a manual code', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    const verifyTransactionCode = vi.fn()

    await runCheckout(
      makeDeps(db, { verifyReferenceNumbers: true, mpesaProvider: { verifyTransactionCode } }),
      manualSale(cashierId)
    )

    expect(verifyTransactionCode).not.toHaveBeenCalled()
  })

  /**
   * Manual entry makes no request to Safaricom, no manager PIN
   * round-trip, and no other network-dependent call — `makeDeps`'
   * `monitor.isOnline: () => false` above already covers every test in
   * this file, but this one says so explicitly and checks the provider
   * was never touched, which is what "offline" actually depends on here.
   */
  it('completes fully offline — no network call of any kind', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    const verifyTransactionCode = vi.fn()

    const result = await runCheckout(
      makeDeps(db, { monitor: { isOnline: () => false }, mpesaProvider: { verifyTransactionCode } }),
      manualSale(cashierId)
    )

    expect(result.success).toBe(true)
    expect(verifyTransactionCode).not.toHaveBeenCalled()
    expect(db.listMpesaPayments()).toHaveLength(1)
  })
})

describe('the four guard rails', () => {
  it('refuses when the till was never allowed manual entry', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)

    const result = await runCheckout(
      makeDeps(db, { manualEntryEnabled: false }),
      manualSale(cashierId)
    )

    expect(result).toEqual({ success: false, error: MPESA_MANUAL_NOT_ENABLED_MESSAGE })
    expect(db.getOrders()).toHaveLength(0)
    expect(db.listMpesaPayments()).toHaveLength(0)
  })

  it('refuses when the flag is simply absent, rather than defaulting to allowed', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    const deps = makeDeps(db)
    delete (deps as { manualEntryEnabled?: boolean }).manualEntryEnabled

    const result = await runCheckout(deps, manualSale(cashierId))

    expect(result.success).toBe(false)
    expect(db.getOrders()).toHaveLength(0)
  })

  it.each([
    ['blank', ''],
    ['whitespace', '   '],
    ['too short', 'QDF73HK9L'],
    ['too long', 'QDF73HK9LMN'],
    ['lowercase', 'qdf73hk9lm'],
    ['mashing', 'AAA'],
    ['punctuation', 'QDF-73HK9L']
  ])('refuses a code that is %s', async (_label, code) => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)

    const result = await runCheckout(
      makeDeps(db),
      manualSale(cashierId, { referenceNumber: code })
    )

    expect(result.success).toBe(false)
    expect(db.getOrders()).toHaveLength(0)
    expect(db.listMpesaPayments()).toHaveLength(0)
  })

  it('names the format problem rather than the generic refusal', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)

    const result = await runCheckout(
      makeDeps(db),
      manualSale(cashierId, { referenceNumber: 'AAA' })
    )

    expect(result.error).toBe(MPESA_MANUAL_CODE_INVALID_MESSAGE)
  })

  it('refuses without the cashier’s attestation', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)

    const result = await runCheckout(
      makeDeps(db),
      manualSale(cashierId, {
        manualApproval: { acknowledgedUnverified: false }
      })
    )

    expect(result).toEqual({ success: false, error: MPESA_MANUAL_NOT_ACKNOWLEDGED_MESSAGE })
    expect(db.getOrders()).toHaveLength(0)
    expect(db.listMpesaPayments()).toHaveLength(0)
  })

  /**
   * Without `manualApproval` the request is not a manual sale at all —
   * it falls through to the confirming branches, which refuse a typed
   * code exactly as they did before this feature existed. That is the
   * phase-102 behaviour, unchanged.
   */
  it('refuses a bare typed code with no approval at all, as it always did', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)

    const result = await runCheckout(
      makeDeps(db),
      manualSale(cashierId, { manualApproval: undefined })
    )

    expect(result.success).toBe(false)
    expect(db.getOrders()).toHaveLength(0)
    expect(db.listMpesaPayments()).toHaveLength(0)
  })
})

describe('the order and its payment record are one fact', () => {
  it('writes both, linked, or neither', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)

    const result = await runCheckout(makeDeps(db), manualSale(cashierId))

    const [payment] = db.listMpesaPayments()
    expect(payment.order_local_id).toBe(result.data?.localId)
    expect(db.getOrders()).toHaveLength(1)
  })

  /**
   * The same M-Pesa code confirmed by Daraja and then typed in by hand
   * is one payment, not two. Without this guard `UNIQUE (mode,
   * reference)` would happily record it twice under different modes.
   */
  it('refuses a manual code that another mode already settled a sale with', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    db.logMpesaTransaction({
      checkoutRequestId: 'ws_CO_1',
      merchantRequestId: 'm',
      phoneNumber: '254712345678',
      amount: 139.2
    })
    db.updateMpesaTransactionStatus('ws_CO_1', 'success', CODE)
    const confirmed = await runCheckout(makeDeps(db), {
      ...manualSale(cashierId),
      manualApproval: undefined
    })
    expect(confirmed.success).toBe(true)

    const typedIn = await runCheckout(makeDeps(db), manualSale(cashierId))

    expect(typedIn).toEqual({ success: false, error: MPESA_MANUAL_CODE_ALREADY_USED_MESSAGE })
    expect(db.getOrders()).toHaveLength(1)
    expect(db.listMpesaPayments()).toHaveLength(1)
  })

  it('rolls the sale back when the payment record cannot be written', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    await runCheckout(makeDeps(db), manualSale(cashierId))

    // The same code again: the payment row conflicts, so the second sale
    // must not exist either.
    const second = await runCheckout(makeDeps(db), manualSale(cashierId))

    expect(second).toEqual({ success: false, error: MPESA_MANUAL_CODE_ALREADY_USED_MESSAGE })
    expect(db.getOrders()).toHaveLength(1)
    expect(db.listMpesaPayments()).toHaveLength(1)
  })
})

describe('the reconciliation queue', () => {
  it('lists a manual payment and takes it off only via reconciling', async () => {
    const db = freshDb()
    const { cashierId, managerId } = seedStaff(db)
    await runCheckout(makeDeps(db), manualSale(cashierId))

    const queued = db.listUnreconciledMpesaPayments()
    expect(queued).toHaveLength(1)

    expect(db.markMpesaPaymentReconciled(queued[0].id, managerId, 'on the 23 Sep statement')).toBe(
      true
    )
    expect(db.listUnreconciledMpesaPayments()).toHaveLength(0)
  })

  /**
   * Reconciling records that somebody later looked. It must not rewrite
   * the status, which would erase the only evidence that this sale took
   * the exception route.
   */
  it('leaves the payment recorded as unverified for ever', async () => {
    const db = freshDb()
    const { cashierId, managerId } = seedStaff(db)
    await runCheckout(makeDeps(db), manualSale(cashierId))
    const [queued] = db.listUnreconciledMpesaPayments()

    db.markMpesaPaymentReconciled(queued.id, managerId, null)

    const [payment] = db.listMpesaPayments()
    expect(payment.verification_status).toBe('manual_unverified')
    expect(payment.reconciled_by_staff_id).toBe(managerId)
    expect(payment.reconciled_at).toEqual(expect.any(String))
  })

  it('refuses to reconcile the same payment twice', async () => {
    const db = freshDb()
    const { cashierId, managerId } = seedStaff(db)
    await runCheckout(makeDeps(db), manualSale(cashierId))
    const [queued] = db.listUnreconciledMpesaPayments()

    expect(db.markMpesaPaymentReconciled(queued.id, managerId, null)).toBe(true)
    expect(db.markMpesaPaymentReconciled(queued.id, managerId, null)).toBe(false)
  })

  it('never lists a confirmed payment, which has nothing to reconcile', async () => {
    const db = freshDb()
    const { cashierId } = seedStaff(db)
    db.logMpesaTransaction({
      checkoutRequestId: 'ws_CO_1',
      merchantRequestId: 'm',
      phoneNumber: '254712345678',
      amount: 139.2
    })
    db.updateMpesaTransactionStatus('ws_CO_1', 'success', 'QGH7XJ2K1L')

    await runCheckout(makeDeps(db), {
      items: [cartItem],
      total: 139.2,
      staffId: cashierId,
      paymentMethod: 'mpesa',
      tenderedAmount: 139.2,
      changeDue: 0,
      referenceNumber: 'QGH7XJ2K1L'
    })

    expect(db.listMpesaPayments()).toHaveLength(1)
    expect(db.listUnreconciledMpesaPayments()).toHaveLength(0)
  })
})

describe('the wire contract gives a renderer nothing to forge', () => {
  it('has no verification status, cashier or approver field on the checkout payload', async () => {
    const { checkoutRequestSchema } = await import('../src/main/lib/ipcValidator.js')
    const keys = Object.keys(checkoutRequestSchema.shape)

    expect(keys).not.toContain('verificationStatus')
    expect(keys).not.toContain('enteredByStaffId')
    expect(keys).not.toContain('approvedByStaffId')
    expect(keys).not.toContain('manualApproval')
    expect(keys).toContain('mpesaManual')
  })

  it('rejects a manual entry that is not explicitly confirmed', async () => {
    const { checkoutRequestSchema, validate } = await import('../src/main/lib/ipcValidator.js')
    const base = {
      items: [cartItem],
      total: 139.2,
      staffId: 1,
      paymentMethod: 'mpesa',
      tenderedAmount: 139.2,
      changeDue: 0
    }
    const manual = { code: CODE }

    expect(
      validate(checkoutRequestSchema, {
        ...base,
        mpesaManual: { ...manual, confirmUnverified: true }
      }).success
    ).toBe(true)
    expect(
      validate(checkoutRequestSchema, {
        ...base,
        mpesaManual: { ...manual, confirmUnverified: false }
      }).success
    ).toBe(false)
    expect(validate(checkoutRequestSchema, { ...base, mpesaManual: manual }).success).toBe(false)
  })

  it('rejects a malformed code at the wire before it reaches any logic', async () => {
    const { checkoutRequestSchema, validate } = await import('../src/main/lib/ipcValidator.js')
    const payload = (code: string) => ({
      items: [cartItem],
      total: 139.2,
      staffId: 1,
      paymentMethod: 'mpesa',
      tenderedAmount: 139.2,
      changeDue: 0,
      mpesaManual: { code, confirmUnverified: true }
    })

    expect(validate(checkoutRequestSchema, payload(CODE)).success).toBe(true)
    expect(validate(checkoutRequestSchema, payload('aaa')).success).toBe(false)
    expect(validate(checkoutRequestSchema, payload('')).success).toBe(false)
    expect(validate(checkoutRequestSchema, payload('QDF73HK9L')).success).toBe(false)
  })

  /**
   * DELIBERATE TEST CHANGE (docs/phase-150.md step 3, named explicitly
   * in the task): manual entry no longer needs a manager at all.
   *   Old title/assertion: `'requires a manager on every manual entry'`
   *     — a payload with just `code`/`confirmUnverified` and no
   *     `managerId`/`managerPin` was rejected.
   *   New title/assertion: `'needs no manager PIN — just the code and
   *     the cashier's attestation'` — the same minimal payload is now
   *     accepted, and the schema has no `managerId`/`managerPin` fields
   *     left to require.
   */
  it('needs no manager PIN — just the code and the cashier’s attestation', async () => {
    const { checkoutRequestSchema, validate } = await import('../src/main/lib/ipcValidator.js')

    const result = validate(checkoutRequestSchema, {
      items: [cartItem],
      total: 139.2,
      staffId: 1,
      paymentMethod: 'mpesa',
      tenderedAmount: 139.2,
      changeDue: 0,
      mpesaManual: { code: CODE, confirmUnverified: true }
    })

    expect(result.success).toBe(true)
    expect(Object.keys(checkoutRequestSchema.shape.mpesaManual.unwrap().shape)).toEqual([
      'code',
      'confirmUnverified'
    ])
  })
})
