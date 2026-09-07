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
 * `attemptFiscalization` below calls the REAL extracted `runCheckout`
 * (phase-73, `checkout.ts`) — not a test-local re-encoding of its
 * logic — so this suite can't silently drift from what the actual
 * checkout handler does. It only fixes `paymentMethod: 'cash'` and a
 * few other checkout fields that this suite doesn't vary; `runCheckout`
 * itself is exhaustively branch-tested against every other input in
 * `tests/runCheckout.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import { RubisDatabase } from '../src/main/services/database.js'
import { RealFiscalizationProvider } from '../src/main/services/integrations/real-etims-provider.js'
import { hashPin } from '../src/main/services/auth.js'
import { createFiscalEngine } from '../src/main/services/fiscal-engine.js'
import { runCheckout } from '../src/main/services/checkout.js'
import type { FiscalizationProvider, FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

/**
 * Device details every construction here supplies.
 *
 * `RealFiscalizationProvider` has no defaults for ip/port/password by
 * design (a guessed password reads as a device fault on the wire — see
 * `docs/phase-89.md` section 5), and without them `submitInvoice`
 * short-circuits with "not set up yet" before sending anything. Tests
 * that want the not-configured path assert it explicitly in
 * `tests/fiscalNotConfigured.test.ts`.
 */
const TEST_DEVICE = {
  deviceIp: '192.168.1.50',
  devicePort: '8000',
  password: 'test-device-password'
} as const

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
 * Runs a checkout through the REAL `runCheckout` (phase-73), fixing
 * every field this suite doesn't vary (`items`/`total`/`paymentMethod`/
 * `tenderedAmount`/`changeDue`) to the same literals the old
 * `db.queueOrder` calls here used, so every existing assertion below
 * still applies to the same order shape. `mpesaProvider`/`monitor`/
 * `fiscalEngine`/`logger` are inert stubs — this suite never exercises
 * those branches — and `idGen` is pinned to the caller's
 * `clientOrderUuid` so tests can assert on it deterministically.
 */
async function attemptFiscalization(params: {
  db: RubisDatabase
  provider: FiscalizationProvider
  staffId: number
  clientOrderUuid: string
  customerPin?: string
}): Promise<{ localId: number; fiscal?: { invoiceNumber: string; qrCode: string } }> {
  const result = await runCheckout(
    {
      db: params.db,
      mpesaProvider: { verifyTransactionCode: vi.fn() },
      fiscalizationProvider: params.provider,
      fiscalEngine: { onCheckoutMade: vi.fn() },
      monitor: { isOnline: () => false },
      engineTick: vi.fn().mockResolvedValue(undefined),
      idGen: () => params.clientOrderUuid,
      taxRate: 0.16,
      mockMpesaEnabled: false,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      debugLogging: false
    },
    {
      items: [cartItem],
      total: 139.2,
      staffId: params.staffId,
      paymentMethod: 'cash',
      tenderedAmount: 150,
      changeDue: 10.8,
      customerPin: params.customerPin
    }
  )
  if (!result.success || !result.data) {
    throw new Error(`runCheckout failed unexpectedly in test setup: ${JSON.stringify(result)}`)
  }
  return { localId: result.data.localId, fiscal: result.data.fiscal }
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

    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: 'KRA-0001', qrCode: 'base64qr', fiscalizedAt: '2026-08-27T10:00:00.000Z' }
    })
    const provider = makeProvider(submitInvoice)

    const { localId, fiscal } = await attemptFiscalization({ db, provider, staffId, clientOrderUuid })

    expect(submitInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ clientOrderUuid })
    )
    expect(fiscal).toEqual({ invoiceNumber: 'KRA-0001', qrCode: 'base64qr' })

    const order = db.getOrder(localId)
    expect(order?.fiscal_invoice_number).toBe('KRA-0001')
    expect(order?.fiscal_qr_code).toBe('base64qr')
    expect(order?.fiscal_status).toBe('fiscalized')
    expect(order?.fiscal_error_reason).toBeNull()
    expect(order?.fiscal_error_kind).toBeNull()
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(0)
  })
})

describe('Scenario B — device offline at checkout', () => {
  it('does not block the sale, queues the invoice, then the engine retries it to success', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-offline-checkout'

    const submitInvoice = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({
        ok: true,
        data: { invoiceNumber: 'KRA-0002', qrCode: 'base64qr', fiscalizedAt: '2026-08-27T10:05:00.000Z' }
      })
    const provider = makeProvider(submitInvoice)

    const { localId, fiscal: checkoutFiscal } = await attemptFiscalization({
      db,
      provider,
      staffId,
      clientOrderUuid
    })

    // The sale itself was never at risk — checkout already committed;
    // this just confirms fiscalization failing doesn't surface as a
    // checkout-blocking error.
    expect(checkoutFiscal).toBeUndefined()
    expect(db.getOrder(localId)?.fiscal_invoice_number).toBeNull()
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(1)
    // A thrown exception (`classifyThrownFiscalError`) is treated as
    // waiting/technical — never `needs_fixing` — so it keeps retrying.
    expect(db.getOrder(localId)?.fiscal_status).toBe('waiting')
    expect(db.getOrder(localId)?.fiscal_error_kind).toBe('technical')
    expect(db.getOrder(localId)?.fiscal_error_reason).toMatch(/ECONNREFUSED/)

    const fiscalEngine = createFiscalEngine({ db, submitInvoice })
    await fiscalEngine.tick()

    expect(submitInvoice).toHaveBeenCalledTimes(2)
    expect(submitInvoice).toHaveBeenNthCalledWith(2, expect.objectContaining({ clientOrderUuid }))
    expect(db.getOrder(localId)?.fiscal_invoice_number).toBe('KRA-0002')
    expect(db.getOrder(localId)?.fiscal_status).toBe('fiscalized')
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(0)
  })
})

describe('Scenario F — a business rejection of the sale\'s own data (e.g. wrong PIN) is NOT queued', () => {
  it('flags the order needs_fixing/data and never enqueues a retry', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-wrong-pin'

    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'Wrong client PIN',
      kind: 'data',
      retryable: false
    })
    const provider = makeProvider(submitInvoice)

    const { localId, fiscal } = await attemptFiscalization({
      db,
      provider,
      staffId,
      clientOrderUuid,
      customerPin: 'P051234567Z'
    })

    // Rule 4: the sale is never blocked — checkout never throws, and
    // the order row (created by runCheckout) stands.
    expect(fiscal).toBeUndefined()
    const order = db.getOrder(localId)
    expect(order).toBeDefined()
    expect(order?.fiscal_status).toBe('needs_fixing')
    expect(order?.fiscal_error_kind).toBe('data')
    expect(order?.fiscal_error_reason).toBe('Wrong client PIN')
    expect(order?.fiscal_invoice_number).toBeNull()
    // The whole point of `needs_fixing`: never placed on the retry queue.
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(0)

    // Confirms the retry queue really was skipped, not just empty by
    // coincidence — the background engine has nothing to do here at all.
    const fiscalEngine = createFiscalEngine({ db, submitInvoice })
    await fiscalEngine.tick()
    expect(submitInvoice).toHaveBeenCalledTimes(1)
  })
})

describe('Scenario G — a malformed-request/system failure (e.g. Code 63) is NOT queued', () => {
  it('flags the order needs_fixing/system and never enqueues a retry', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-malformed-request'

    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'ZFPLabServer rejected the request format',
      kind: 'system',
      retryable: false
    })
    const provider = makeProvider(submitInvoice)

    const { localId, fiscal } = await attemptFiscalization({ db, provider, staffId, clientOrderUuid })

    expect(fiscal).toBeUndefined()
    const order = db.getOrder(localId)
    expect(order?.fiscal_status).toBe('needs_fixing')
    expect(order?.fiscal_error_kind).toBe('system')
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(0)
  })
})

describe('Rule 4 — the sale always completes, whatever the fiscalization outcome', () => {
  it.each([
    ['success', { ok: true, data: { invoiceNumber: 'KRA-R4', qrCode: '', fiscalizedAt: '2026-01-01T00:00:00.000Z' } }],
    ['technical failure', { ok: false, reason: 'device unreachable', kind: 'technical', retryable: true }],
    ['data rejection', { ok: false, reason: 'wrong PIN', kind: 'data', retryable: false }],
    ['system failure', { ok: false, reason: 'malformed request', kind: 'system', retryable: false }]
  ] as const)(
    'never throws and the order row survives — %s',
    async (_label, outcome) => {
      const db = freshDb()
      const staffId = seedStaff(db)
      const clientOrderUuid = `uuid-rule4-${_label.replace(/\s+/g, '-')}`
      const provider = makeProvider(vi.fn().mockResolvedValue(outcome))

      // If attemptFiscalization (the real runCheckout) threw, this
      // `await` would reject and fail the test — that rejection never
      // happening is the Rule-4 proof.
      const { localId } = await attemptFiscalization({ db, provider, staffId, clientOrderUuid })

      const order = db.getOrder(localId)
      expect(order).toBeDefined()
      expect(order?.local_id).toBe(localId)
    }
  )

  it('never throws even when submitInvoice itself throws', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-rule4-thrown'
    const provider = makeProvider(vi.fn().mockRejectedValue(new Error('boom')))

    const { localId } = await attemptFiscalization({ db, provider, staffId, clientOrderUuid })

    expect(db.getOrder(localId)).toBeDefined()
  })
})

describe('Scenario C — B2B invoice: customer KRA PIN flows from checkout to the provider', () => {
  it('passes the PIN through to submitInvoice as buyerPin', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-b2b'

    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: 'KRA-B2B-0001', qrCode: '', fiscalizedAt: '2026-08-27T10:20:00.000Z' }
    })
    const provider = makeProvider(submitInvoice)

    const { localId } = await attemptFiscalization({
      db,
      provider,
      staffId,
      clientOrderUuid,
      customerPin: 'P051234567Z'
    })

    expect(submitInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ buyerPin: 'P051234567Z', clientOrderUuid })
    )
    expect(db.getOrder(localId)?.fiscal_invoice_number).toBe('KRA-B2B-0001')
  })

  it('leaves buyerPin undefined for a walk-in B2C sale', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-b2c'

    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: 'KRA-B2C-0001', qrCode: '', fiscalizedAt: '2026-08-27T10:20:00.000Z' }
    })
    const provider = makeProvider(submitInvoice)

    await attemptFiscalization({ db, provider, staffId, clientOrderUuid })

    expect(submitInvoice).toHaveBeenCalledWith(expect.objectContaining({ buyerPin: undefined }))
  })
})

describe('Idempotent retry — device processed the request despite a timeout', () => {
  it('accepts the original invoice number on retry without creating a duplicate queue row', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-idempotent'

    /** The "device" already fiscalized the request under this uuid before timing out on the response. */
    const deviceLedger = new Map<string, string>()
    deviceLedger.set(clientOrderUuid, 'KRA-ORIGINAL')

    const submitInvoice = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('ETIMEDOUT')
      })
      .mockImplementationOnce(async (request: FiscalInvoiceRequest) => ({
        ok: true,
        data: {
          invoiceNumber: deviceLedger.get(request.clientOrderUuid)!,
          qrCode: 'base64qr',
          fiscalizedAt: '2026-08-27T10:10:00.000Z'
        }
      }))
    const provider = makeProvider(submitInvoice)

    const { localId } = await attemptFiscalization({ db, provider, staffId, clientOrderUuid })
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
                  ok: true,
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

      const submitInvoice = vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'device unreachable', kind: 'technical', retryable: true })
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

describe('Scenario H — a queued retry reveals a genuine data problem (phase-76, Part C)', () => {
  /**
   * The scenario the brief calls out explicitly: with the device
   * password wrong, EVERY sale first fails on connectivity (`waiting`)
   * — so a real data problem (e.g. a bad PIN the cashier mistyped) only
   * surfaces once the device is actually reachable, on a LATER retry.
   * Before this step, `fiscal-engine.ts` treated every retry failure as
   * "keep backing off," so a sale like this would retry forever without
   * ever being flagged for a person. This is the real `RubisDatabase` +
   * real `createFiscalEngine`, proving the row is actually gone from
   * the queue — not just that a mock method was called.
   */
  it('a waiting item whose retry comes back a data failure becomes needs_fixing and leaves the retry queue for good', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-reveals-data-problem'
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
    // Queued exactly as a first-attempt connectivity failure would have
    // queued it (`fiscal_status: 'waiting'`), mirroring the checkout
    // handler's own write on a technical failure.
    db.setOrderFiscalFailure(localId, 'waiting', 'device unreachable', 'technical')
    db.queueFiscalInvoice(localId, buildFiscalRequest(clientOrderUuid))
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(1)

    // The device is reachable now, but rejects the sale's own data.
    const submitInvoice = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'Wrong client PIN', kind: 'data', retryable: false })
    const fiscalEngine = createFiscalEngine({ db, submitInvoice })

    await fiscalEngine.tick()

    const order = db.getOrder(localId)
    expect(order?.fiscal_status).toBe('needs_fixing')
    expect(order?.fiscal_error_kind).toBe('data')
    expect(order?.fiscal_error_reason).toBe('Wrong client PIN')
    // Gone from the queue for real — not backing off, not coming back.
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(0)

    // A later tick has nothing left to do — proves it isn't quietly
    // still queued under a future next_attempt_at.
    await fiscalEngine.tick()
    expect(submitInvoice).toHaveBeenCalledTimes(1)
  })

  it('a waiting item whose retry stays technical keeps backing off in the queue, as before this step', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-stays-technical'
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
    db.setOrderFiscalFailure(localId, 'waiting', 'device unreachable', 'technical')
    db.queueFiscalInvoice(localId, buildFiscalRequest(clientOrderUuid))

    const submitInvoice = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'still unreachable', kind: 'technical', retryable: true })
    const fiscalEngine = createFiscalEngine({ db, submitInvoice })

    await fiscalEngine.tick()

    expect(db.getOrder(localId)?.fiscal_status).toBe('waiting')
    // Still there, backed off — not removed, not needs_fixing.
    expect(db.getPendingFiscalQueue(Number.MAX_SAFE_INTEGER)).toHaveLength(1)
  })
})

describe('Scenario E — device TCP password rejected (Code 31)', () => {
  /**
   * The POC's live blocker: ZFPLabServer reaches the device but the
   * device rejects the TCP password handshake. The till must stay
   * usable — the sale completes, the invoice lands in the fiscal queue,
   * and nothing propagates to the UI as a throw. Once the password is
   * corrected, the background engine drains the queue with no cashier
   * action, which the second half of this test exercises.
   *
   * Uses the real {@link RealFiscalizationProvider} over a mocked
   * transport (rather than a stub provider) so the real Code-31 →
   * `ServiceResult` translation is what's being asserted.
   */
  it('completes the sale, queues the invoice as pending, and heals once the password is fixed', async () => {
    const db = freshDb()
    const staffId = seedStaff(db)
    const clientOrderUuid = 'uuid-tcp-auth-rejected'

    let passwordFixed = false
    const post = vi.fn().mockImplementation((_path: string, body: string) => {
      const command = /<Command Name="([^"]+)"/.exec(String(body))?.[1] ?? ''
      if (!passwordFixed) {
        return Promise.resolve({
          data: '<Res Code="31"><Err Source="Server" Type="ServTCPAuth"><Message>ServTCPAuth</Message></Err></Res>'
        })
      }
      switch (command) {
        case 'ReadStatus':
          return Promise.resolve({
            data: '<Res Code="0"><CU_fiscalized>1</CU_fiscalized><Paired_with_TIMS>1</Paired_with_TIMS></Res>'
          })
        case 'ReadCurrentReceiptInfo':
          return Promise.resolve({
            data: '<Res Code="0"><OptionIsReceiptOpened>1</OptionIsReceiptOpened><SubtotalAmountVATGA>139.20</SubtotalAmountVATGA></Res>'
          })
        case 'CloseReceipt':
          return Promise.resolve({
            data: '<Res Code="0"><InvoiceNum>KRA-0031</InvoiceNum><QRcode>base64qr</QRcode></Res>'
          })
        case 'ReadDateTime':
          return Promise.resolve({ data: '<Res Code="0"><DateTime>01-01-2026 09:30</DateTime></Res>' })
        default:
          return Promise.resolve({ data: '<Res Code="0"/>' })
      }
    })
    const httpClient = {
      post,
      get: vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' }),
      defaults: { baseURL: 'http://localhost:4444/' }
    } as unknown as AxiosInstance
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient })

    const { localId, fiscal } = await attemptFiscalization({ db, provider, staffId, clientOrderUuid })

    // The sale itself is unaffected: no throw, and the order stands.
    expect(fiscal).toBeUndefined()
    expect(db.getOrder(localId)?.fiscal_invoice_number).toBeFalsy()
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(1)

    // Password corrected on the device → the background engine drains it.
    passwordFixed = true
    const engine = createFiscalEngine({
      db,
      submitInvoice: (request) => provider.submitInvoice(request)
    })
    await engine.tick()

    expect(db.getOrder(localId)?.fiscal_invoice_number).toBe('KRA-0031')
    expect(db.getPendingFiscalQueue(Date.now())).toHaveLength(0)
  })

  it('surfaces Code 31 as an actionable device-password message, not a raw code', async () => {
    const post = vi.fn().mockResolvedValue({
      data: '<Res Code="31"><Err Source="Server" Type="ServTCPAuth"><Message>ServTCPAuth</Message></Err></Res>'
    })
    const provider = new RealFiscalizationProvider({ ...TEST_DEVICE,
      httpClient: {
        post,
        get: vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' }),
        defaults: { baseURL: 'http://localhost:4444/' }
      } as unknown as AxiosInstance
    })

    const result = await provider.submitInvoice(buildFiscalRequest('uuid-code-31-message'))

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toMatch(/TCP password/i)
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
