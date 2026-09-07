/**
 * `runCheckout` tests (phase-73).
 *
 * Drives the REAL extracted checkout orchestration function — see
 * `docs/phase-72.md`'s audit and `docs/phase-73.md`'s extraction — with
 * a real in-memory `RubisDatabase` and a real `fiscal-engine.ts`
 * (imported where a test exercises a background retry), and a
 * controllable mock `FiscalizationProvider`. `mpesaProvider`/`monitor`/
 * `idGen`/`logger` are stubbed, per the task brief, since this suite is
 * about `runCheckout`'s own branching, not those integrations'
 * internals (each has its own dedicated test file already).
 *
 * No logic is re-encoded here — every assertion is made by calling
 * `runCheckout` itself and inspecting its return value and the real
 * database it wrote to.
 */

import { describe, it, expect, vi } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'
import type { CheckoutRequest } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { createFiscalEngine } from '../src/main/services/fiscal-engine.js'
import { runCheckout } from '../src/main/services/checkout.js'
import type { CheckoutDb, CheckoutLogger, RunCheckoutDeps } from '../src/main/services/checkout.js'
import type { FiscalSubmitOutcome } from '../src/main/services/integrations/etims.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

/** Seeds a staff account, matching a real till's checkout precondition. */
function seedStaff(db: RubisDatabase): number {
  const { staffId } = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' })
  return staffId
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

/** A well-formed checkout input; override per test. */
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

/**
 * Full dependency set with sensible, inert defaults — every test
 * overrides only what it's exercising. `idGen` returns a fresh,
 * incrementing uuid per call by default so "duplicate submission"
 * tests can instead force the SAME uuid across two calls deliberately.
 */
function makeDeps(db: CheckoutDb, overrides: Partial<RunCheckoutDeps> = {}): RunCheckoutDeps {
  let uuidCounter = 0
  return {
    db,
    mpesaProvider: { verifyTransactionCode: vi.fn() },
    fiscalizationProvider: { submitInvoice: vi.fn() },
    fiscalEngine: { onCheckoutMade: vi.fn() },
    monitor: { isOnline: () => false },
    engineTick: vi.fn().mockResolvedValue(undefined),
    idGen: () => `uuid-${++uuidCounter}`,
    taxRate: 0.16,
    mockMpesaEnabled: false,
    logger: silentLogger,
    debugLogging: false,
    ...overrides
  }
}

describe('runCheckout — success (device accepts)', () => {
  it('creates the order, saves the invoice/QR, marks fiscalized, and returns the receipt shape', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: 'KRA-0001', qrCode: 'base64qr', fiscalizedAt: '2026-01-01T00:00:00.000Z' }
    } satisfies FiscalSubmitOutcome)
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice } })

    const result = await runCheckout(deps, makeInput(staffId))

    expect(result).toEqual({
      success: true,
      data: {
        localId: expect.any(Number),
        mode: 'queued-offline',
        shopifyOrderId: undefined,
        fiscal: { invoiceNumber: 'KRA-0001', qrCode: 'base64qr' },
        fiscalStatus: 'fiscalized',
        fiscalErrorReason: null,
        fiscalErrorKind: null,
        fiscalDataIssue: null
      }
    })
    expect(submitInvoice).toHaveBeenCalledWith(expect.objectContaining({ clientOrderUuid: 'uuid-1' }))

    const localId = result.data!.localId
    const order = db.getOrder(localId)
    expect(order?.fiscal_invoice_number).toBe('KRA-0001')
    expect(order?.fiscal_qr_code).toBe('base64qr')
    expect(order?.fiscal_status).toBe('fiscalized')
    expect(order?.fiscal_error_reason).toBeNull()
    expect(order?.fiscal_error_kind).toBeNull()
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(0)
  })

  it('kicks engineTick when the monitor reports online, and skips it when offline', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: 'KRA-0002', qrCode: '', fiscalizedAt: '2026-01-01T00:00:00.000Z' }
    })

    const onlineDeps = makeDeps(db, {
      fiscalizationProvider: { submitInvoice },
      monitor: { isOnline: () => true }
    })
    await runCheckout(onlineDeps, makeInput(staffId))
    expect(onlineDeps.engineTick).toHaveBeenCalledTimes(1)

    const offlineDeps = makeDeps(db, {
      fiscalizationProvider: { submitInvoice },
      monitor: { isOnline: () => false }
    })
    await runCheckout(offlineDeps, makeInput(staffId))
    expect(offlineDeps.engineTick).not.toHaveBeenCalled()
  })

  /**
   * `mode`/`shopifyOrderId` are a direct mapping off `db.getOrder(localId)`'s
   * read-back status — but in the real flow that read-back happens
   * synchronously, immediately after firing `engineTick()` (never
   * awaited), so a freshly `queueOrder`-d row is always still
   * `'pending_sync'` at that point, even when online (see the test
   * above and `docs/phase-73.md`'s note on this). A fake `CheckoutDb`
   * is used here — everything else delegating to the real one — purely
   * to exercise the `'synced'` branch of that mapping, since the real
   * timing never reaches it for a brand-new order.
   */
  it('maps a synced read-back order onto mode "synced" and the stored shopifyOrderId', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: 'KRA-0003', qrCode: '', fiscalizedAt: '2026-01-01T00:00:00.000Z' }
    })
    const syncedDb: CheckoutDb = {
      getStaffById: db.getStaffById.bind(db),
      getOpenShift: db.getOpenShift.bind(db),
      queueOrder: db.queueOrder.bind(db),
      getOrder: (localId) => ({ ...db.getOrder(localId)!, status: 'synced', shopify_order_id: 'gid://shopify/Order/9' }),
      setOrderFiscalInfo: db.setOrderFiscalInfo.bind(db),
      setOrderFiscalFailure: db.setOrderFiscalFailure.bind(db),
      queueFiscalInvoice: db.queueFiscalInvoice.bind(db),
      setOrderFiscalRequest: db.setOrderFiscalRequest.bind(db)
    }
    const deps = makeDeps(syncedDb, { fiscalizationProvider: { submitInvoice } })

    const result = await runCheckout(deps, makeInput(staffId))

    expect(result.success).toBe(true)
    expect(result.data?.mode).toBe('synced')
    expect(result.data?.shopifyOrderId).toBe('gid://shopify/Order/9')
  })
})

describe('runCheckout — fiscal failure classes', () => {
  it('technical/retryable → waiting, enqueued, onCheckoutMade fired', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'ZFPLabServer cannot reach the fiscal device',
      kind: 'technical',
      retryable: true
    } satisfies FiscalSubmitOutcome)
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice } })

    const result = await runCheckout(deps, makeInput(staffId))

    expect(result).toEqual({
      success: true,
      data: {
        localId: expect.any(Number),
        mode: 'queued-offline',
        shopifyOrderId: undefined,
        fiscal: undefined,
        fiscalStatus: 'waiting',
        fiscalErrorReason: 'ZFPLabServer cannot reach the fiscal device',
        fiscalErrorKind: 'technical',
        fiscalDataIssue: null
      }
    })
    const order = db.getOrder(result.data!.localId)
    expect(order?.fiscal_status).toBe('waiting')
    expect(order?.fiscal_error_kind).toBe('technical')
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(1)
    expect(deps.fiscalEngine.onCheckoutMade).toHaveBeenCalledTimes(1)
  })

  it('data rejection → needs_fixing, NOT enqueued, onCheckoutMade NOT fired', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'Wrong client PIN',
      kind: 'data',
      retryable: false
    } satisfies FiscalSubmitOutcome)
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice } })

    const result = await runCheckout(deps, makeInput(staffId, { customerPin: 'P051234567Z' }))

    expect(result.success).toBe(true)
    expect(result.data?.fiscal).toBeUndefined()
    expect(result.data?.fiscalStatus).toBe('needs_fixing')
    expect(result.data?.fiscalErrorReason).toBe('Wrong client PIN')
    expect(result.data?.fiscalErrorKind).toBe('data')
    expect(result.data?.fiscalDataIssue).toBeNull()
    const order = db.getOrder(result.data!.localId)
    expect(order?.fiscal_status).toBe('needs_fixing')
    expect(order?.fiscal_error_kind).toBe('data')
    expect(order?.fiscal_error_reason).toBe('Wrong client PIN')
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(0)
    expect(deps.fiscalEngine.onCheckoutMade).not.toHaveBeenCalled()
  })

  it('a wrong-PIN data rejection surfaces fiscalDataIssue:"wrong-pin" on the receipt', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'Wrong client PIN',
      kind: 'data',
      retryable: false,
      dataIssue: 'wrong-pin'
    } satisfies FiscalSubmitOutcome)
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice } })

    const result = await runCheckout(deps, makeInput(staffId, { customerPin: 'P059999999Z' }))

    expect(result.data?.fiscalStatus).toBe('needs_fixing')
    expect(result.data?.fiscalDataIssue).toBe('wrong-pin')
  })

  it('a non-wrong-PIN data rejection leaves fiscalDataIssue null', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'HS code is not valid',
      kind: 'data',
      retryable: false
    } satisfies FiscalSubmitOutcome)
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice } })

    const result = await runCheckout(deps, makeInput(staffId))

    expect(result.data?.fiscalStatus).toBe('needs_fixing')
    expect(result.data?.fiscalDataIssue).toBeNull()
  })

  it('system failure (e.g. Code 63) → needs_fixing, NOT enqueued, onCheckoutMade NOT fired', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'ZFPLabServer rejected the request format',
      kind: 'system',
      retryable: false
    } satisfies FiscalSubmitOutcome)
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice } })

    const result = await runCheckout(deps, makeInput(staffId))

    expect(result.success).toBe(true)
    expect(result.data?.fiscalStatus).toBe('needs_fixing')
    expect(result.data?.fiscalErrorKind).toBe('system')
    expect(result.data?.fiscalDataIssue).toBeNull()
    const order = db.getOrder(result.data!.localId)
    expect(order?.fiscal_status).toBe('needs_fixing')
    expect(order?.fiscal_error_kind).toBe('system')
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(0)
    expect(deps.fiscalEngine.onCheckoutMade).not.toHaveBeenCalled()
  })

  it('a thrown exception → waiting, enqueued, identity preserved, fiscal undefined, success:true', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const deps = makeDeps(db, {
      fiscalizationProvider: { submitInvoice },
      idGen: () => 'uuid-thrown-exception'
    })

    const result = await runCheckout(deps, makeInput(staffId))

    expect(result.success).toBe(true)
    expect(result.data?.fiscal).toBeUndefined()
    expect(result.data?.fiscalStatus).toBe('waiting')
    expect(result.data?.fiscalErrorKind).toBe('technical')
    expect(result.data?.fiscalErrorReason).toMatch(/ECONNREFUSED/)
    expect(result.data?.fiscalDataIssue).toBeNull()
    const localId = result.data!.localId
    const order = db.getOrder(localId)
    expect(order?.fiscal_status).toBe('waiting')
    expect(order?.fiscal_error_kind).toBe('technical')
    expect(order?.fiscal_error_reason).toMatch(/ECONNREFUSED/)

    const queued = db.getPendingFiscalQueue(Date.now())
    expect(queued).toHaveLength(1)
    expect(queued[0].entity_id).toBe(localId)
    expect(queued[0].payload.clientOrderUuid).toBe('uuid-thrown-exception')
    expect(queued[0].payload.localId).toBe(localId)
    expect(deps.fiscalEngine.onCheckoutMade).toHaveBeenCalledTimes(1)
  })

  it('a queued technical failure is later drained to success by the real fiscal engine', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'device unreachable', kind: 'technical', retryable: true })
      .mockResolvedValueOnce({
        ok: true,
        data: { invoiceNumber: 'KRA-0099', qrCode: 'base64qr', fiscalizedAt: '2026-01-01T00:05:00.000Z' }
      })
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice } })

    const result = await runCheckout(deps, makeInput(staffId))
    const localId = result.data!.localId
    expect(db.getOrder(localId)?.fiscal_status).toBe('waiting')

    const fiscalEngine = createFiscalEngine({ db, submitInvoice })
    await fiscalEngine.tick()

    expect(submitInvoice).toHaveBeenCalledTimes(2)
    expect(db.getOrder(localId)?.fiscal_status).toBe('fiscalized')
    expect(db.getOrder(localId)?.fiscal_invoice_number).toBe('KRA-0099')
  })
})

/** A logger whose calls can be inspected, unlike `silentLogger`. */
function makeSpyLogger(): CheckoutLogger {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('runCheckout — logging (phase-80)', () => {
  it('a normal successful sale is quiet — no warn or error logs, and (debugLogging off) no log line either', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const logger = makeSpyLogger()
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: 'KRA-QUIET', qrCode: 'base64qr', fiscalizedAt: '2026-01-01T00:00:00.000Z' }
    } satisfies FiscalSubmitOutcome)
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice }, logger })

    await runCheckout(deps, makeInput(staffId))

    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.log).not.toHaveBeenCalled()
  })

  it('a data rejection (needs_fixing) logs a warn including the sale\'s localId', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const logger = makeSpyLogger()
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'Wrong client PIN',
      kind: 'data',
      retryable: false
    } satisfies FiscalSubmitOutcome)
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice }, logger })

    const result = await runCheckout(deps, makeInput(staffId))

    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`Sale ${result.data!.localId}`)
    )
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Wrong client PIN'))
  })

  it('a system-kind failure logs an error including the sale\'s localId', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const logger = makeSpyLogger()
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'ZFPLabServer rejected the request format',
      kind: 'system',
      retryable: false
    } satisfies FiscalSubmitOutcome)
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice }, logger })

    const result = await runCheckout(deps, makeInput(staffId))

    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Sale ${result.data!.localId}`)
    )
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ZFPLabServer rejected the request format'))
  })

  it('a retryable/technical failure logs at info level (log), not warn or error', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const logger = makeSpyLogger()
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'ZFPLabServer cannot reach the fiscal device',
      kind: 'technical',
      retryable: true
    } satisfies FiscalSubmitOutcome)
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice }, logger })

    const result = await runCheckout(deps, makeInput(staffId))

    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining(`Sale ${result.data!.localId}`)
    )
  })

  it('an unhandled exception logs an error including the sale\'s localId', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const logger = makeSpyLogger()
    const submitInvoice = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice }, logger })

    const result = await runCheckout(deps, makeInput(staffId))

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Sale ${result.data!.localId}`),
      expect.any(Error)
    )
  })
})

describe('runCheckout — Rule 4: the sale always completes, whatever the fiscalization outcome', () => {
  it.each([
    ['success', { ok: true, data: { invoiceNumber: 'KRA-R4', qrCode: '', fiscalizedAt: '2026-01-01T00:00:00.000Z' } }],
    ['technical failure', { ok: false, reason: 'device unreachable', kind: 'technical', retryable: true }],
    ['data rejection', { ok: false, reason: 'wrong PIN', kind: 'data', retryable: false }],
    ['system failure', { ok: false, reason: 'malformed request', kind: 'system', retryable: false }]
  ] as const)('returns success:true and the order row exists — %s', async (_label, outcome) => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockResolvedValue(outcome)
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice } })

    const result = await runCheckout(deps, makeInput(staffId))

    expect(result.success).toBe(true)
    expect(db.getOrder(result.data!.localId)).toBeDefined()
  })

  it('returns success:true and the order row exists even when submitInvoice throws', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockRejectedValue(new Error('boom'))
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice } })

    const result = await runCheckout(deps, makeInput(staffId))

    expect(result.success).toBe(true)
    expect(db.getOrder(result.data!.localId)).toBeDefined()
  })
})

describe('runCheckout — pre-order rejections create no order and attempt no fiscalization', () => {
  it('no logged-in staff → rejected, no order created', async () => {
    const db = freshDb()
    const submitInvoice = vi.fn()
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice } })

    const result = await runCheckout(deps, makeInput(999999))

    expect(result).toEqual({ success: false, error: 'No staff member is logged in' })
    expect(db.getOrders()).toHaveLength(0)
    expect(submitInvoice).not.toHaveBeenCalled()
  })

  it('mock-mode M-Pesa manual code check fails (verification error) → rejected, no order created', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn()
    const verifyTransactionCode = vi.fn().mockResolvedValue({ success: false, error: 'Daraja timeout' })
    const deps = makeDeps(db, {
      fiscalizationProvider: { submitInvoice },
      mpesaProvider: { verifyTransactionCode },
      mockMpesaEnabled: true
    })

    const result = await runCheckout(
      deps,
      makeInput(staffId, { paymentMethod: 'mpesa', referenceNumber: 'QDF73H' })
    )

    expect(result).toEqual({ success: false, error: 'Daraja timeout' })
    expect(db.getOrders()).toHaveLength(0)
    expect(submitInvoice).not.toHaveBeenCalled()
  })

  it('mock-mode M-Pesa manual code check fails (code not verified) → rejected, no order created', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn()
    const verifyTransactionCode = vi
      .fn()
      .mockResolvedValue({ success: true, data: { verified: false, reason: 'Code does not match any transaction' } })
    const deps = makeDeps(db, {
      fiscalizationProvider: { submitInvoice },
      mpesaProvider: { verifyTransactionCode },
      mockMpesaEnabled: true
    })

    const result = await runCheckout(
      deps,
      makeInput(staffId, { paymentMethod: 'mpesa', referenceNumber: 'INVALID' })
    )

    expect(result).toEqual({ success: false, error: 'Code does not match any transaction' })
    expect(db.getOrders()).toHaveLength(0)
    expect(submitInvoice).not.toHaveBeenCalled()
  })

  it('the M-Pesa manual code check is skipped (and checkout proceeds) when mockMpesaEnabled is false', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: 'KRA-MPESA', qrCode: '', fiscalizedAt: '2026-01-01T00:00:00.000Z' }
    })
    const verifyTransactionCode = vi.fn()
    const deps = makeDeps(db, {
      fiscalizationProvider: { submitInvoice },
      mpesaProvider: { verifyTransactionCode },
      mockMpesaEnabled: false
    })

    const result = await runCheckout(
      deps,
      makeInput(staffId, { paymentMethod: 'mpesa', referenceNumber: 'QDF73H' })
    )

    expect(result.success).toBe(true)
    expect(verifyTransactionCode).not.toHaveBeenCalled()
    expect(db.getOrders()).toHaveLength(1)
  })
})

describe('runCheckout — outer-catch path (a dependency throws outside the fiscalization block)', () => {
  it('queueOrder throws → success:false, no order created', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const throwingDb: CheckoutDb = {
      getStaffById: db.getStaffById.bind(db),
      getOpenShift: db.getOpenShift.bind(db),
      queueOrder: () => {
        throw new Error('disk full')
      },
      getOrder: db.getOrder.bind(db),
      setOrderFiscalInfo: db.setOrderFiscalInfo.bind(db),
      setOrderFiscalFailure: db.setOrderFiscalFailure.bind(db),
      queueFiscalInvoice: db.queueFiscalInvoice.bind(db),
      setOrderFiscalRequest: db.setOrderFiscalRequest.bind(db)
    }
    const deps = makeDeps(throwingDb)

    const result = await runCheckout(deps, makeInput(staffId))

    expect(result).toEqual({ success: false, error: 'disk full' })
    expect(db.getOrders()).toHaveLength(0)
  })

  /**
   * KNOWN, PRE-EXISTING EDGE (not introduced or fixed by this
   * extraction — see `docs/phase-73.md`): if something throws
   * AFTER `queueOrder` already committed the order row, the handler
   * still reports `success: false` to the till even though the sale
   * exists in `orders`. `getOrder`'s post-queueOrder read-back is one
   * such call. This test locks in TODAY's behavior; it is not a
   * statement that this is correct or safe, and it is explicitly out
   * of scope to fix here per this task's behavior-preserving rule.
   */
  it('a throw after queueOrder succeeds (e.g. getOrder) still reports failure, even though the order row exists', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const throwingDb: CheckoutDb = {
      getStaffById: db.getStaffById.bind(db),
      getOpenShift: db.getOpenShift.bind(db),
      queueOrder: db.queueOrder.bind(db),
      getOrder: () => {
        throw new Error('read-back exploded')
      },
      setOrderFiscalInfo: db.setOrderFiscalInfo.bind(db),
      setOrderFiscalFailure: db.setOrderFiscalFailure.bind(db),
      queueFiscalInvoice: db.queueFiscalInvoice.bind(db),
      setOrderFiscalRequest: db.setOrderFiscalRequest.bind(db)
    }
    const deps = makeDeps(throwingDb)

    const result = await runCheckout(deps, makeInput(staffId))

    expect(result).toEqual({ success: false, error: 'read-back exploded' })
    // The real db (bypassing the throwing wrapper) shows the order was
    // in fact committed — the till was told it failed regardless.
    expect(db.getOrders()).toHaveLength(1)
  })
})

describe('runCheckout — duplicate submission (documents TODAY\'s behavior; Step 2 will change this)', () => {
  /**
   * `runCheckout` has no idempotency guard yet — that is exactly what
   * the next step ("never-file-twice") adds. Submitting the identical
   * input twice today creates two separate orders and calls
   * `submitInvoice` twice. This test locks in that current behavior as
   * a baseline; it is NOT an assertion that duplicate submission is
   * safe.
   */
  it('submitting the same input twice creates two orders and calls submitInvoice twice', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: 'KRA-DUP', qrCode: '', fiscalizedAt: '2026-01-01T00:00:00.000Z' }
    })
    // Same idGen output both times, simulating a true duplicate resubmit.
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice }, idGen: () => 'uuid-duplicate' })
    const input = makeInput(staffId)

    const first = await runCheckout(deps, input)
    const second = await runCheckout(deps, input)

    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    expect(first.data!.localId).not.toBe(second.data!.localId)
    expect(db.getOrders()).toHaveLength(2)
    expect(submitInvoice).toHaveBeenCalledTimes(2)
  })
})

// Payment initiation and receipt printing are NOT covered here: the
// phase-72 audit confirmed `orders:checkout` owns neither. STK Push
// initiation is the standalone `mpesa:initiate-stk-push` channel, and
// printing happens in the renderer after this call resolves — there is
// no branch of `runCheckout` to drive for either. See docs/phase-73.md.
