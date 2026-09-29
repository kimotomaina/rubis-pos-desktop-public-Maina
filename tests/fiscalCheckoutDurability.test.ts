/**
 * A sale is never lost if the app stops mid-filing (docs/phase-185.md,
 * Rule 3), and the queue never files a sale checkout is filing (Rule 1).
 *
 * Drives the real `runCheckout`, a real in-memory `RubisDatabase` and,
 * where the race matters, the real `fiscal-engine.ts`. A "stop" is a
 * `submitInvoice` that never settles: whatever the database holds at
 * that moment is what a crash would leave behind.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  INTERRUPTED_FILING_REASON,
  INTERRUPTED_UNSENT_REASON,
  RubisDatabase
} from '../src/main/services/database.js'
import type { CheckoutRequest } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { createFiscalEngine } from '../src/main/services/fiscal-engine.js'
import { runCheckout } from '../src/main/services/checkout.js'
import type { CheckoutLogger, RunCheckoutDeps } from '../src/main/services/checkout.js'
import { correctPinAndResend, resendFiscalization, SALE_STILL_FILING_REASON } from '../src/main/services/fiscal-retry.js'
import type { FiscalInvoiceRequest, FiscalSubmitOutcome } from '../src/main/services/integrations/etims.js'
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

function makeDeps(db: RubisDatabase, overrides: Partial<RunCheckoutDeps> = {}): RunCheckoutDeps {
  let uuidCounter = 0
  return {
    db,
    mpesaProvider: { verifyTransactionCode: vi.fn() },
    fiscalizationProvider: { submitInvoice: vi.fn() },
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

/** A promise the test settles by hand, standing in for a filing still in progress. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Lets already-queued promise callbacks (a `void tick()`) run to completion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Every fiscal row, due or not (an abandoned row is due at MAX_SAFE_INTEGER). */
function fiscalRows(db: RubisDatabase): ReturnType<RubisDatabase['getPendingFiscalQueue']> {
  return db.getPendingFiscalQueue(Number.MAX_SAFE_INTEGER)
}

const FILED: FiscalSubmitOutcome = {
  ok: true,
  data: { invoiceNumber: 'KRA-0185', qrCode: 'qr', fiscalizedAt: '2026-09-29T12:00:00.000Z' }
}
const UNREACHABLE: FiscalSubmitOutcome = {
  ok: false,
  reason: 'ZFPLabServer cannot reach the fiscal device',
  kind: 'technical',
  retryable: true
}
const REFUSED: FiscalSubmitOutcome = { ok: false, reason: 'Wrong client PIN', kind: 'data', retryable: false }

describe('the sale is waiting, queued and carries its request from the moment it exists (option A)', () => {
  it('a stop while the device is being called leaves the sale waiting, counted, and queued with its exact request', () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockReturnValue(new Promise<FiscalSubmitOutcome>(() => {}))

    void runCheckout(makeDeps(db, { fiscalizationProvider: { submitInvoice } }), makeInput(staffId))

    expect(submitInvoice).toHaveBeenCalledTimes(1)
    const sent = submitInvoice.mock.calls[0][0] as FiscalInvoiceRequest
    const order = db.getOrder(sent.localId!)!
    expect(order.fiscal_status).toBe('waiting')
    expect(JSON.parse(order.fiscal_request_json!)).toEqual(JSON.parse(JSON.stringify(sent)))
    expect(db.getUnfiledOrderCount()).toBe(1)
    const rows = fiscalRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].entity_id).toBe(sent.localId)
    expect(rows[0].next_attempt_at).toBe(0)
    expect(rows[0].payload).toEqual(JSON.parse(JSON.stringify(sent)))
  })

  it('after that stop, the next start files the sale once, as a retry (isRetry, so verifyAlreadyFiled applies)', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const stalled = vi.fn().mockReturnValue(new Promise<FiscalSubmitOutcome>(() => {}))
    void runCheckout(makeDeps(db, { fiscalizationProvider: { submitInvoice: stalled } }), makeInput(staffId))
    const localId = (stalled.mock.calls[0][0] as FiscalInvoiceRequest).localId!

    // A fresh engine is a restart: its claims are empty.
    const submitInvoice = vi.fn().mockResolvedValue(FILED)
    await createFiscalEngine({ db, submitInvoice, logger: silentLogger }).tick()

    expect(submitInvoice).toHaveBeenCalledTimes(1)
    expect(submitInvoice.mock.calls[0][0]).toMatchObject({ localId, isRetry: true })
    expect(db.getOrder(localId)?.fiscal_status).toBe('fiscalized')
    expect(fiscalRows(db)).toHaveLength(0)
  })

  it('a manual M-Pesa sale is queued in the same transaction too (the wrappers pass the builder through)', () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockReturnValue(new Promise<FiscalSubmitOutcome>(() => {}))

    void runCheckout(
      makeDeps(db, { fiscalizationProvider: { submitInvoice }, manualEntryEnabled: true }),
      makeInput(staffId, {
        paymentMethod: 'mpesa',
        referenceNumber: 'QWE1234567',
        manualApproval: { acknowledgedUnverified: true }
      })
    )

    expect(submitInvoice).toHaveBeenCalledTimes(1)
    const localId = (submitInvoice.mock.calls[0][0] as FiscalInvoiceRequest).localId!
    expect(db.getOrder(localId)?.fiscal_status).toBe('waiting')
    expect(fiscalRows(db).map((row) => row.entity_id)).toEqual([localId])
  })
})

describe("checkout's outcome settles the queue row it created", () => {
  it('success: fiscalized, and no fiscal row is left', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice: vi.fn().mockResolvedValue(FILED) } })

    const result = await runCheckout(deps, makeInput(staffId))

    expect(result.data?.fiscalStatus).toBe('fiscalized')
    expect(db.getOrder(result.data!.localId)?.fiscal_invoice_number).toBe('KRA-0185')
    expect(fiscalRows(db)).toHaveLength(0)
  })

  it('a retryable failure: waiting, with exactly one due row that has no attempt counted', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice: vi.fn().mockResolvedValue(UNREACHABLE) } })

    const result = await runCheckout(deps, makeInput(staffId))

    expect(result.data?.fiscalStatus).toBe('waiting')
    const rows = db.getPendingFiscalQueue(Date.now())
    expect(rows).toHaveLength(1)
    expect(rows[0].attempts).toBe(0)
    expect(fiscalRows(db)).toHaveLength(1)
    expect(deps.fiscalEngine.onCheckoutMade).toHaveBeenCalledTimes(1)
  })

  it('a non-retryable failure: needs_fixing, and no fiscal row is left', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const deps = makeDeps(db, { fiscalizationProvider: { submitInvoice: vi.fn().mockResolvedValue(REFUSED) } })

    const result = await runCheckout(deps, makeInput(staffId))

    expect(result.data?.fiscalStatus).toBe('needs_fixing')
    expect(fiscalRows(db)).toHaveLength(0)
    expect(deps.fiscalEngine.onCheckoutMade).not.toHaveBeenCalled()
  })

  it('a thrown exception: waiting, with exactly one row', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockRejectedValue(new Error('provider bug'))

    const result = await runCheckout(makeDeps(db, { fiscalizationProvider: { submitInvoice } }), makeInput(staffId))

    expect(result.success).toBe(true)
    expect(result.data?.fiscalStatus).toBe('waiting')
    expect(fiscalRows(db)).toHaveLength(1)
  })

  it('a void while the device is filing still records the filing, so it is never lost', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const filing = deferred<FiscalSubmitOutcome>()
    const submitInvoice = vi.fn().mockReturnValue(filing.promise)

    const pending = runCheckout(makeDeps(db, { fiscalizationProvider: { submitInvoice } }), makeInput(staffId))
    const localId = (submitInvoice.mock.calls[0][0] as FiscalInvoiceRequest).localId!
    db.voidOrder(localId)
    filing.resolve(FILED)
    await pending

    expect(db.getOrder(localId)?.fiscal_invoice_number).toBe('KRA-0185')
    expect(db.getOrder(localId)?.fiscal_status).toBe('fiscalized')
  })
})

describe('the queue and a resend never file a sale checkout is filing (in-flight claim, §5)', () => {
  it('a tick during checkout skips the sale: the device is called exactly once', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const filing = deferred<FiscalSubmitOutcome>()
    const submitInvoice = vi.fn().mockReturnValue(filing.promise)
    const engine = createFiscalEngine({ db, submitInvoice, logger: silentLogger })

    const pending = runCheckout(
      makeDeps(db, { fiscalizationProvider: { submitInvoice }, fiscalEngine: engine }),
      makeInput(staffId)
    )
    const localId = (submitInvoice.mock.calls[0][0] as FiscalInvoiceRequest).localId!
    expect(engine.isClaimed(localId)).toBe(true)

    await engine.tick()
    expect(submitInvoice).toHaveBeenCalledTimes(1)
    expect(fiscalRows(db)[0].attempts).toBe(0)

    filing.resolve(FILED)
    await pending
    expect(engine.isClaimed(localId)).toBe(false)

    await engine.tick()
    expect(submitInvoice).toHaveBeenCalledTimes(1)
    expect(db.getOrder(localId)?.fiscal_status).toBe('fiscalized')
    expect(fiscalRows(db)).toHaveLength(0)
  })

  it('a retryable failure hands the sale to the queue at once: the tick it starts is not blocked by the claim', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const submitInvoice = vi.fn().mockResolvedValueOnce(UNREACHABLE).mockResolvedValueOnce(FILED)
    const engine = createFiscalEngine({ db, submitInvoice, logger: silentLogger })

    const result = await runCheckout(
      makeDeps(db, { fiscalizationProvider: { submitInvoice }, fiscalEngine: engine }),
      makeInput(staffId)
    )
    await flush()

    expect(submitInvoice).toHaveBeenCalledTimes(2)
    expect(submitInvoice.mock.calls[1][0]).toMatchObject({ isRetry: true })
    expect(db.getOrder(result.data!.localId)?.fiscal_status).toBe('fiscalized')
    expect(fiscalRows(db)).toHaveLength(0)
  })

  it('a resend during checkout is refused with no device call and no write', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const filing = deferred<FiscalSubmitOutcome>()
    const submitInvoice = vi.fn().mockReturnValue(filing.promise)
    const engine = createFiscalEngine({ db, submitInvoice, logger: silentLogger })

    const pending = runCheckout(
      makeDeps(db, { fiscalizationProvider: { submitInvoice }, fiscalEngine: engine }),
      makeInput(staffId)
    )
    const localId = (submitInvoice.mock.calls[0][0] as FiscalInvoiceRequest).localId!
    const before = db.getOrder(localId)

    const outcome = await resendFiscalization(
      { db, fiscalizationProvider: { submitInvoice }, logger: silentLogger, isFiling: engine.isClaimed },
      localId
    )

    expect(outcome).toMatchObject({ ok: false, reason: SALE_STILL_FILING_REASON })
    expect(submitInvoice).toHaveBeenCalledTimes(1)
    expect(db.getOrder(localId)).toEqual(before)
    expect(fiscalRows(db)).toHaveLength(1)

    filing.resolve(FILED)
    await pending
  })

  it('a PIN correction during checkout is refused before the stored request is rewritten', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const filing = deferred<FiscalSubmitOutcome>()
    const submitInvoice = vi.fn().mockReturnValue(filing.promise)
    const engine = createFiscalEngine({ db, submitInvoice, logger: silentLogger })

    const pending = runCheckout(
      makeDeps(db, { fiscalizationProvider: { submitInvoice }, fiscalEngine: engine }),
      makeInput(staffId, { customerPin: 'P051234567A' })
    )
    const localId = (submitInvoice.mock.calls[0][0] as FiscalInvoiceRequest).localId!
    const storedBefore = db.getOrder(localId)?.fiscal_request_json

    const outcome = await correctPinAndResend(
      { db, fiscalizationProvider: { submitInvoice }, logger: silentLogger, isFiling: engine.isClaimed },
      localId,
      undefined
    )

    expect(outcome).toMatchObject({ ok: false, reason: SALE_STILL_FILING_REASON })
    expect(submitInvoice).toHaveBeenCalledTimes(1)
    expect(db.getOrder(localId)?.fiscal_request_json).toBe(storedBefore)

    filing.resolve(FILED)
    await pending
  })
})

describe('the start-up sweep for sales already stuck with no fiscal status (option B)', () => {
  /** An order as an older build left it: inserted, then stopped before any fiscal status was written. */
  function stuckOrder(db: RubisDatabase, staffId: number, uuid: string): number {
    return db.queueOrder({
      items: [cartItem],
      total: 139.2,
      clientOrderUuid: uuid,
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 150,
      changeDue: 10.8
    }).localId
  }

  it('re-queues a stuck sale that has its request, flags one that does not, and leaves the rest alone', () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const withRequest = stuckOrder(db, staffId, 'uuid-a')
    const request: FiscalInvoiceRequest = {
      clientOrderUuid: 'uuid-a',
      localId: withRequest,
      items: [{ description: 'RUBIS Mug', quantity: 2, unitPrice: 60, taxRate: 0.16, vatClass: 'B', hsCode: '0001.11.00', hsName: 'Mug' }],
      total: 139.2,
      taxAmount: 22.27,
      paymentMethod: 'cash',
      amountTendered: 150
    }
    db.setOrderFiscalRequest(withRequest, request)
    const withoutRequest = stuckOrder(db, staffId, 'uuid-b')
    const voided = stuckOrder(db, staffId, 'uuid-c')
    db.voidOrder(voided)
    const filed = stuckOrder(db, staffId, 'uuid-d')
    db.setOrderFiscalInfo(filed, 'KRA-OLD', 'qr')

    expect(db.sweepUnqueuedFiscalOrders()).toEqual({ queued: 1, flagged: 1 })

    expect(db.getOrder(withRequest)).toMatchObject({
      fiscal_status: 'waiting',
      fiscal_error_reason: INTERRUPTED_FILING_REASON,
      fiscal_error_kind: 'technical'
    })
    const rows = fiscalRows(db)
    expect(rows.map((row) => row.entity_id)).toEqual([withRequest])
    expect(rows[0].payload).toEqual(request)
    expect(rows[0].next_attempt_at).toBe(0)

    expect(db.getOrder(withoutRequest)).toMatchObject({
      fiscal_status: 'needs_fixing',
      fiscal_error_reason: INTERRUPTED_UNSENT_REASON,
      fiscal_error_kind: 'system'
    })
    expect(db.getOrder(voided)?.fiscal_status).toBeNull()
    expect(db.getOrder(filed)?.fiscal_status).toBe('fiscalized')
    expect(db.getUnfiledOrderCount()).toBe(2)
  })

  it('is a no-op the second time, and never touches a sale checkout queued', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    stuckOrder(db, staffId, 'uuid-a')
    await runCheckout(
      makeDeps(db, { fiscalizationProvider: { submitInvoice: vi.fn().mockResolvedValue(UNREACHABLE) } }),
      makeInput(staffId)
    )

    expect(db.sweepUnqueuedFiscalOrders()).toEqual({ queued: 0, flagged: 1 })
    const rowsAfterFirst = fiscalRows(db)
    expect(db.sweepUnqueuedFiscalOrders()).toEqual({ queued: 0, flagged: 0 })
    expect(fiscalRows(db)).toEqual(rowsAfterFirst)
    expect(rowsAfterFirst).toHaveLength(1)
  })
})
