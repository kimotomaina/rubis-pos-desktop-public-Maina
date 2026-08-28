/**
 * eTIMS fiscalization pipeline integration tests.
 *
 * Runs against a **real** in-memory `better-sqlite3` connection
 * (`:memory:`), matching `reconciliation.test.ts`'s precedent: the
 * `entity_type` filtering this suite verifies is a `WHERE`-clause
 * behavior the recording fake used in `database.test.ts` cannot
 * exercise faithfully, since that fake ignores SQL text and just
 * replays pre-registered rows.
 *
 * Only the network-facing `RealFiscalizationProvider` is mocked (its
 * own HTTP behavior is covered by `realEtimsProvider.test.ts`) —
 * `RubisDatabase` and `createFiscalEngine` are the real modules, so
 * this suite exercises the actual interaction between them: the
 * `checkout → queueFiscalInvoice → fiscalEngine.tick → provider →
 * setOrderFiscalInfo` pipeline `main/index.ts`'s `orders:checkout`
 * handler drives.
 *
 * `attemptFiscalization` below is a test-local mirror of that
 * handler's fiscalization block (queue on failure, save on success) —
 * not exported production code — so this suite can drive the exact
 * same sequence deterministically without booting Electron.
 */

import { describe, it, expect, vi } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { createFiscalEngine } from '../src/main/services/fiscal-engine.js'
import type { FiscalizationProvider, FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

/** Sets up a staff account and an open shift, matching a real till's checkout preconditions. */
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

/**
 * Builds the same `FiscalInvoiceRequest` shape `orders:checkout`
 * constructs from a cart, mapping `checkout.customerPin` onto
 * `buyerPin` exactly as the handler does.
 */
function buildFiscalRequest(clientOrderUuid: string, customerPin?: string): FiscalInvoiceRequest {
  return {
    clientOrderUuid,
    items: [
      {
        description: cartItem.title,
        quantity: cartItem.quantity,
        unitPrice: cartItem.price,
        taxRate: 0.16,
        pluCode: cartItem.id
      }
    ],
    total: 139.2,
    taxAmount: 19.2,
    paymentMethod: 'cash',
    amountTendered: 150,
    buyerPin: customerPin
  }
}

/**
 * Mirrors `orders:checkout`'s fiscalization block: submit immediately;
 * on any failure (rejected result or thrown error), queue the same
 * request for the background engine to retry rather than blocking
 * the sale.
 */
async function attemptFiscalization(params: {
  db: RubisDatabase
  provider: FiscalizationProvider
  localId: number
  fiscalRequest: FiscalInvoiceRequest
}): Promise<{ invoiceNumber: string; qrCode: string } | undefined> {
  try {
    const invoice = await params.provider.submitInvoice(params.fiscalRequest)
    if (invoice.success && invoice.data) {
      params.db.setOrderFiscalInfo(params.localId, invoice.data.invoiceNumber, invoice.data.qrCode)
      return { invoiceNumber: invoice.data.invoiceNumber, qrCode: invoice.data.qrCode }
    }
    params.db.queueFiscalInvoice(params.localId, params.fiscalRequest)
    return undefined
  } catch {
    params.db.queueFiscalInvoice(params.localId, params.fiscalRequest)
    return undefined
  }
}

/** Builds a minimal mock {@link FiscalizationProvider}; only `submitInvoice` is exercised here. */
function makeProvider(submitInvoice: FiscalizationProvider['submitInvoice']): FiscalizationProvider {
  return {
    submitInvoice,
    getInvoiceDetails: vi.fn(),
    cancelInvoice: vi.fn()
  }
}

describe('Scenario A — happy path: submitInvoice succeeds at checkout', () => {
  it('calls submitInvoice with the clientOrderUuid and saves the invoice number/QR code onto the order', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-happy-path'
    const { localId } = db.queueOrder({
      items: [cartItem],
      total: 139.2,
      clientOrderUuid,
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 150,
      changeDue: 10.8
    })
    const fiscalRequest = buildFiscalRequest(clientOrderUuid)

    const submitInvoice = vi.fn().mockResolvedValue({
      success: true,
      data: { invoiceNumber: 'KRA-0001', qrCode: 'base64qr', fiscalizedAt: '2026-08-27T10:00:00.000Z' }
    })
    const provider = makeProvider(submitInvoice)

    const fiscal = await attemptFiscalization({ db, provider, localId, fiscalRequest })

    expect(submitInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ clientOrderUuid })
    )
    expect(fiscal).toEqual({ invoiceNumber: 'KRA-0001', qrCode: 'base64qr' })

    const order = db.getOrder(localId)
    expect(order?.fiscal_invoice_number).toBe('KRA-0001')
    expect(order?.fiscal_qr_code).toBe('base64qr')
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(0)
  })
})

describe('Scenario B — device offline at checkout', () => {
  it('does not block the sale, queues the invoice, then the engine retries it to success', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-offline-checkout'
    const { localId } = db.queueOrder({
      items: [cartItem],
      total: 139.2,
      clientOrderUuid,
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 150,
      changeDue: 10.8
    })
    const fiscalRequest = buildFiscalRequest(clientOrderUuid)

    const submitInvoice = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        success: true,
        data: { invoiceNumber: 'KRA-0002', qrCode: 'base64qr', fiscalizedAt: '2026-08-27T10:05:00.000Z' }
      })
    const provider = makeProvider(submitInvoice)

    const checkoutResult = await attemptFiscalization({ db, provider, localId, fiscalRequest })

    // The sale itself was never at risk — checkout already committed
    // via queueOrder above; this just confirms fiscalization failing
    // doesn't surface as a checkout-blocking error.
    expect(checkoutResult).toBeUndefined()
    expect(db.getOrder(localId)?.fiscal_invoice_number).toBeNull()
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(1)

    const fiscalEngine = createFiscalEngine({ db, submitInvoice })
    await fiscalEngine.tick()

    expect(submitInvoice).toHaveBeenCalledTimes(2)
    expect(submitInvoice).toHaveBeenNthCalledWith(2, expect.objectContaining({ clientOrderUuid }))
    expect(db.getOrder(localId)?.fiscal_invoice_number).toBe('KRA-0002')
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(0)
  })
})

describe('Scenario C — B2B invoice: customer KRA PIN flows from checkout to the provider', () => {
  it('passes the PIN through to submitInvoice as buyerPin', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-b2b'
    const { localId } = db.queueOrder({
      items: [cartItem],
      total: 139.2,
      clientOrderUuid,
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 150,
      changeDue: 10.8,
      customerPin: 'P051234567Z'
    })
    const fiscalRequest = buildFiscalRequest(clientOrderUuid, 'P051234567Z')

    const submitInvoice = vi.fn().mockResolvedValue({
      success: true,
      data: { invoiceNumber: 'KRA-B2B-0001', qrCode: '', fiscalizedAt: '2026-08-27T10:20:00.000Z' }
    })
    const provider = makeProvider(submitInvoice)

    await attemptFiscalization({ db, provider, localId, fiscalRequest })

    expect(submitInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ buyerPin: 'P051234567Z', clientOrderUuid })
    )
    expect(db.getOrder(localId)?.fiscal_invoice_number).toBe('KRA-B2B-0001')
  })

  it('leaves buyerPin undefined for a walk-in B2C sale', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-b2c'
    const { localId } = db.queueOrder({
      items: [cartItem],
      total: 139.2,
      clientOrderUuid,
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 150,
      changeDue: 10.8
    })
    const fiscalRequest = buildFiscalRequest(clientOrderUuid)

    const submitInvoice = vi.fn().mockResolvedValue({
      success: true,
      data: { invoiceNumber: 'KRA-B2C-0001', qrCode: '', fiscalizedAt: '2026-08-27T10:20:00.000Z' }
    })
    const provider = makeProvider(submitInvoice)

    await attemptFiscalization({ db, provider, localId, fiscalRequest })

    expect(submitInvoice).toHaveBeenCalledWith(expect.objectContaining({ buyerPin: undefined }))
  })
})

describe('Idempotent retry — device processed the request despite a timeout', () => {
  it('accepts the original invoice number on retry without creating a duplicate queue row', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-idempotent'
    const { localId } = db.queueOrder({
      items: [cartItem],
      total: 139.2,
      clientOrderUuid,
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 150,
      changeDue: 10.8
    })
    const fiscalRequest = buildFiscalRequest(clientOrderUuid)

    /** The "device" already fiscalized the request under this uuid before timing out on the response. */
    const deviceLedger = new Map<string, string>()
    deviceLedger.set(clientOrderUuid, 'KRA-ORIGINAL')

    const submitInvoice = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('ETIMEDOUT')
      })
      .mockImplementationOnce(async (request: FiscalInvoiceRequest) => ({
        success: true,
        data: {
          invoiceNumber: deviceLedger.get(request.clientOrderUuid)!,
          qrCode: 'base64qr',
          fiscalizedAt: '2026-08-27T10:10:00.000Z'
        }
      }))
    const provider = makeProvider(submitInvoice)

    await attemptFiscalization({ db, provider, localId, fiscalRequest })
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(1)

    const fiscalEngine = createFiscalEngine({ db, submitInvoice })
    await fiscalEngine.tick()

    expect(submitInvoice).toHaveBeenCalledTimes(2)
    expect(submitInvoice.mock.calls[0][0].clientOrderUuid).toBe(clientOrderUuid)
    expect(submitInvoice.mock.calls[1][0].clientOrderUuid).toBe(clientOrderUuid)
    expect(db.getOrder(localId)?.fiscal_invoice_number).toBe('KRA-ORIGINAL')
    // Exactly one queue entry ever existed for this order, and it's gone now — no duplicate row.
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(0)
  })
})

describe('Re-entrancy guard under fake timers', () => {
  it('ignores a tick() triggered mid-flight, calling the provider only once', async () => {
    vi.useFakeTimers()
    try {
      const db = freshDb()
      const staffId = seedStaff(db)
      const clientOrderUuid = 'uuid-reentrancy'
      const { localId } = db.queueOrder({
        items: [cartItem],
        total: 139.2,
        clientOrderUuid,
        staffId,
        staffName: 'Alex',
        paymentMethod: 'cash',
        tenderedAmount: 150,
        changeDue: 10.8
      })
      db.queueFiscalInvoice(localId, buildFiscalRequest(clientOrderUuid))

      const submitInvoice = vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  success: true,
                  data: { invoiceNumber: 'KRA-0003', qrCode: '', fiscalizedAt: '2026-08-27T10:15:00.000Z' }
                }),
              5000
            )
          })
      )
      const fiscalEngine = createFiscalEngine({ db, submitInvoice: submitInvoice as never })

      const firstTick = fiscalEngine.tick()
      await vi.advanceTimersByTimeAsync(1000)

      const secondTick = fiscalEngine.tick()
      await vi.advanceTimersByTimeAsync(4000)
      await Promise.all([firstTick, secondTick])

      expect(submitInvoice).toHaveBeenCalledTimes(1)
      expect(db.getOrder(localId)?.fiscal_invoice_number).toBe('KRA-0003')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Abandonment after the max attempts', () => {
  it('marks the row ABANDONED with next_attempt_at pushed to never, and stops calling the provider', async () => {
    vi.useFakeTimers()
    try {
      const db = freshDb()
      const staffId = seedStaff(db)
      const clientOrderUuid = 'uuid-abandoned'
      const { localId } = db.queueOrder({
        items: [cartItem],
        total: 139.2,
        clientOrderUuid,
        staffId,
        staffName: 'Alex',
        paymentMethod: 'cash',
        tenderedAmount: 150,
        changeDue: 10.8
      })
      db.queueFiscalInvoice(localId, buildFiscalRequest(clientOrderUuid))

      const submitInvoice = vi.fn().mockResolvedValue({ success: false, error: 'device unreachable' })
      const fiscalEngine = createFiscalEngine({ db, submitInvoice })

      const MAX_ATTEMPTS = 10
      const PAST_ANY_BACKOFF_MS = 31 * 60 * 1000
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await fiscalEngine.tick()
        await vi.advanceTimersByTimeAsync(PAST_ANY_BACKOFF_MS)
      }

      expect(submitInvoice).toHaveBeenCalledTimes(MAX_ATTEMPTS)

      // Passing MAX_SAFE_INTEGER as `now` is the only way to read an
      // abandoned row back through the public API — its
      // `next_attempt_at` was pushed there specifically so a normal
      // tick() never selects it again (see the assertion below).
      const abandoned = db.getPendingFiscalQueue(Number.MAX_SAFE_INTEGER)
      expect(abandoned).toHaveLength(1)
      expect(abandoned[0].attempts).toBe(MAX_ATTEMPTS)
      expect(abandoned[0].last_error).toMatch(/^ABANDONED/)
      expect(abandoned[0].next_attempt_at).toBe(Number.MAX_SAFE_INTEGER)

      await fiscalEngine.tick()
      expect(submitInvoice).toHaveBeenCalledTimes(MAX_ATTEMPTS)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Regression: Shopify sync queue never picks up an etims_invoice row', () => {
  it('getPendingSyncQueue returns empty when the only queued row is an etims_invoice retry', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-regression'
    const { localId, queueId } = db.queueOrder({
      items: [cartItem],
      total: 139.2,
      clientOrderUuid,
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 150,
      changeDue: 10.8
    })
    // Clears the 'order' queue row queueOrder created, isolating the
    // 'etims_invoice' row queueFiscalInvoice inserts next.
    db.markQueueItemSynced(queueId, 'gid://shopify/Order/1')
    db.queueFiscalInvoice(localId, buildFiscalRequest(clientOrderUuid))

    expect(db.getPendingSyncQueue(Date.now())).toEqual([])
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(1)
  })
})
