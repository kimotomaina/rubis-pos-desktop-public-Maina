/**
 * An outage never abandons a sale (docs/phase-186.md §5).
 *
 * Provider level: which failures are "the device was not reached"
 * (`unreachable`) and which are real refusals. Engine level: a 72-hour
 * outage through the real provider (mocked transport), real engine and
 * real in-memory database, then every sale files once, in order.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import { RubisDatabase } from '../src/main/services/database.js'
import type { CheckoutRequest } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { createFiscalEngine } from '../src/main/services/fiscal-engine.js'
import { runCheckout } from '../src/main/services/checkout.js'
import type { CheckoutLogger } from '../src/main/services/checkout.js'
import {
  DAILY_CLOSURE_BLOCK_REASON,
  RealFiscalizationProvider
} from '../src/main/services/integrations/real-etims-provider.js'
import type { FiscalInvoiceRequest, FiscalSubmitOutcome } from '../src/main/services/integrations/etims.js'

const TEST_DEVICE = { deviceIp: '192.168.1.50', devicePort: '8000', password: 'test-device-password' } as const

const silentLogger: CheckoutLogger = { log: () => {}, warn: () => {}, error: () => {} }

// The HTTP client and the Code-40 decoder log every failure to the console;
// a 72-hour run would print thousands of lines.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

const SAMPLE_REQUEST: FiscalInvoiceRequest = {
  clientOrderUuid: '11111111-2222-3333-4444-555555555555',
  items: [{ description: 'Bread', quantity: 2, unitPrice: 60, taxRate: 0.16 }],
  total: 120,
  taxAmount: 16.55,
  paymentMethod: 'cash',
  amountTendered: 150
}

function commandNameOf(body: unknown): string {
  return /<Command Name="([^"]+)"/.exec(String(body))?.[1] ?? ''
}

function xmlResponse(fields: Record<string, string> = {}): string {
  return `<Res Code="0">${Object.entries(fields)
    .map(([key, value]) => `<${key}>${value}</${key}>`)
    .join('')}</Res>`
}

function xmlServerError(code: string): string {
  return `<Res Code="${code}"><Err Source="Server" Type="ServSockConnectionFailed"><Message>no device</Message></Err></Res>`
}

function xmlCommandError(ste1Decimal: number, ste2Decimal: number): string {
  return `<Res Code="40"><Err Source="Device" Type="FPException" STE1="${ste1Decimal.toString(16)}" STE2="${ste2Decimal.toString(16)}" FPLibErrorCode="00"><Message>refused</Message></Err></Res>`
}

/**
 * A device that answers every command normally, except `failing`, which
 * gets `failure`: a response body, or an Error to reject the transport.
 * CloseReceipt returns a distinct invoice number per call.
 */
function makeDevice(failing?: string, failure?: string | Error): ReturnType<typeof vi.fn> {
  let invoice = 0
  return vi.fn().mockImplementation((_path: string, body: string) => {
    const name = commandNameOf(body)
    if (name === failing) {
      return failure instanceof Error ? Promise.reject(failure) : Promise.resolve({ data: failure })
    }
    switch (name) {
      case 'ReadStatus':
        return Promise.resolve({ data: xmlResponse({ CU_fiscalized: '1', Paired_with_TIMS: '1' }) })
      case 'ReadCurrentReceiptInfo':
        return Promise.resolve({ data: xmlResponse({ OptionIsReceiptOpened: '1', SubtotalAmountVATGA: '120.00' }) })
      case 'CloseReceipt':
        invoice++
        return Promise.resolve({ data: xmlResponse({ InvoiceNum: `KRA-${invoice}`, QRcode: 'qr' }) })
      case 'ReadDateTime':
        return Promise.resolve({ data: xmlResponse({ DateTime: '29-09-2026 12:00' }) })
      default:
        return Promise.resolve({ data: xmlResponse() })
    }
  })
}

function makeProvider(post: ReturnType<typeof vi.fn>): RealFiscalizationProvider {
  const get = vi.fn().mockResolvedValue({ data: '<Res Code="0"><settings><defVer></defVer></settings></Res>' })
  const httpClient = { post, get, defaults: { baseURL: 'http://localhost:4444/' } } as unknown as AxiosInstance
  return new RealFiscalizationProvider({ ...TEST_DEVICE, httpClient, logger: silentLogger })
}

describe('provider: "not reached" is told apart from a refusal', () => {
  it.each([
    ['connection refused at ReadStatus', 'ReadStatus', new Error('connect ECONNREFUSED 127.0.0.1:4444')],
    ['our own timeout at OpenInvoice', 'OpenInvoiceWithFreeCustomerData', new Error('timeout of 5000ms exceeded')],
    ['Code 30 (server cannot reach the device) at OpenInvoice', 'OpenInvoiceWithFreeCustomerData', xmlServerError('30')],
    ['Code 30 at CloseReceipt (the server never reached the device)', 'CloseReceipt', xmlServerError('30')],
    ['Code 19 (socket busy) at a sell command', 'SellPLUfromExtDB', xmlServerError('19')]
  ])('%s → unreachable, retryable, technical', async (_label, failing, failure) => {
    const result = await makeProvider(makeDevice(failing, failure)).submitInvoice(SAMPLE_REQUEST)

    expect(result).toMatchObject({ ok: false, unreachable: true, retryable: true, kind: 'technical' })
  })

  it('the missing daily closure (STE1=59) → unreachable, with its cashier reason unchanged', async () => {
    const post = makeDevice('OpenInvoiceWithFreeCustomerData', xmlCommandError(59, 0))

    const result = await makeProvider(post).submitInvoice(SAMPLE_REQUEST)

    expect(result).toMatchObject({ ok: false, unreachable: true, retryable: true, reason: DAILY_CLOSURE_BLOCK_REASON })
  })

  it('a lost CloseReceipt reply is NOT unreachable and NOT retried: the device may already have filed', async () => {
    const post = makeDevice('CloseReceipt', new Error('timeout of 5000ms exceeded'))

    const result = await makeProvider(post).submitInvoice(SAMPLE_REQUEST)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.retryable).toBe(false)
    expect(result.unreachable).toBeUndefined()
  })

  it('STE2 0x32 "Illegal command" stays a retryable refusal, not unreachable, so it still counts', async () => {
    const post = makeDevice('OpenInvoiceWithFreeCustomerData', xmlCommandError(0, 0x32))

    const result = await makeProvider(post).submitInvoice(SAMPLE_REQUEST)

    expect(result).toMatchObject({ ok: false, retryable: true, kind: 'technical' })
    expect(result.ok === false && result.unreachable).toBeFalsy()
  })

  it('a data refusal (wrong client PIN) is neither retryable nor unreachable', async () => {
    const post = makeDevice('OpenInvoiceWithFreeCustomerData', xmlCommandError(0, 0x3b))

    const result = await makeProvider(post).submitInvoice({ ...SAMPLE_REQUEST, buyerPin: 'P051234567A' })

    expect(result).toMatchObject({ ok: false, retryable: false, kind: 'data', dataIssue: 'wrong-pin' })
    expect(result.ok === false && result.unreachable).toBeFalsy()
  })

  it('a device that answers "not fiscalized" is a device answer, not unreachable', async () => {
    const post = makeDevice('ReadStatus', xmlResponse({ CU_fiscalized: '0', Paired_with_TIMS: '1' }))

    const result = await makeProvider(post).submitInvoice(SAMPLE_REQUEST)

    expect(result).toMatchObject({ ok: false, retryable: false, kind: 'system' })
    expect(result.ok === false && result.unreachable).toBeFalsy()
  })
})

function freshDb(): RubisDatabase {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  return db
}

function makeInput(staffId: number, price: number): CheckoutRequest {
  return {
    items: [
      {
        id: 'gid://shopify/ProductVariant/201',
        productId: 'gid://shopify/Product/101',
        title: 'Bread',
        variantTitle: 'Loaf',
        price,
        quantity: 1,
        image: null
      }
    ],
    total: price,
    staffId,
    paymentMethod: 'cash',
    tenderedAmount: price,
    changeDue: 0
  }
}

const THIRTY_SECONDS = 30_000
const SEVENTY_TWO_HOURS = 72 * 60 * 60 * 1000

describe('engine: a 72-hour outage leaves every sale waiting, then all file once, in order', () => {
  // 8,640 real provider passes; the default 5 s limit is tight when the whole suite runs in parallel.
  it('no sale is counted or abandoned during the outage, and each files exactly once afterwards', { timeout: 60_000 }, async () => {
    const db = freshDb()
    const staffId = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' }).staffId
    const outage = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:4444'))
    let post = outage
    const provider = makeProvider(vi.fn((path: string, body: string) => post(path, body)))
    let clock = Date.parse('2026-09-29T08:00:00.000Z')
    const engine = createFiscalEngine({
      db,
      submitInvoice: (request) => provider.submitInvoice(request),
      now: () => clock,
      logger: silentLogger
    })
    const deps = {
      db,
      mpesaProvider: { verifyTransactionCode: vi.fn() },
      fiscalizationProvider: provider,
      fiscalEngine: { onCheckoutMade: vi.fn(), claim: engine.claim, release: engine.release },
      monitor: { isOnline: () => false },
      engineTick: vi.fn().mockResolvedValue(undefined),
      idGen: (() => {
        let n = 0
        return () => `uuid-${++n}`
      })(),
      taxRate: 0.16,
      verifyReferenceNumbers: false,
      claimsStoredPayments: false,
      logger: silentLogger,
      debugLogging: false
    }

    const saleIds: number[] = []
    for (const price of [100, 200, 300, 400, 500]) {
      const result = await runCheckout(deps, makeInput(staffId, price))
      expect(result.data?.fiscalStatus).toBe('waiting')
      saleIds.push(result.data!.localId)
    }

    const ticks = SEVENTY_TWO_HOURS / THIRTY_SECONDS
    for (let i = 0; i < ticks; i++) {
      clock += THIRTY_SECONDS
      await engine.tick()
    }

    const rows = db.getPendingFiscalQueue(Number.MAX_SAFE_INTEGER)
    expect(rows.map((row) => row.entity_id)).toEqual(saleIds)
    expect(rows.every((row) => row.attempts === 0)).toBe(true)
    expect(rows.every((row) => row.next_attempt_at <= clock)).toBe(true)
    expect(rows.every((row) => row.last_error === null)).toBe(true)
    expect(saleIds.every((id) => db.getOrder(id)?.fiscal_status === 'waiting')).toBe(true)
    expect(db.getUnfiledOrderCount()).toBe(saleIds.length)

    // The device comes back.
    post = makeDevice()
    clock += THIRTY_SECONDS
    await engine.tick()

    const opened = post.mock.calls
      .filter(([, body]) => commandNameOf(body) === 'OpenInvoiceWithFreeCustomerData')
      .map(([, body]) => /Name="TraderSystemInvNum" Value="INV-0*(\d+)"/.exec(String(body))?.[1])
    expect(opened).toEqual(saleIds.map(String))
    const invoices = saleIds.map((id) => db.getOrder(id)?.fiscal_invoice_number)
    expect(invoices).toEqual(['KRA-1', 'KRA-2', 'KRA-3', 'KRA-4', 'KRA-5'])
    expect(new Set(invoices).size).toBe(saleIds.length)
    expect(db.getPendingFiscalQueue(Number.MAX_SAFE_INTEGER)).toHaveLength(0)
    expect(db.getUnfiledOrderCount()).toBe(0)
  })

  it('while unreachable, one pass tries only the oldest sale', async () => {
    const db = freshDb()
    const staffId = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' }).staffId
    const unreachable: FiscalSubmitOutcome = {
      ok: false,
      reason: 'not reached',
      kind: 'technical',
      retryable: true,
      unreachable: true
    }
    for (const price of [100, 200, 300]) {
      await runCheckout(
        {
          db,
          mpesaProvider: { verifyTransactionCode: vi.fn() },
          fiscalizationProvider: { submitInvoice: vi.fn().mockResolvedValue(unreachable) },
          fiscalEngine: { onCheckoutMade: vi.fn(), claim: vi.fn(), release: vi.fn() },
          monitor: { isOnline: () => false },
          engineTick: vi.fn().mockResolvedValue(undefined),
          idGen: () => `uuid-${price}`,
          taxRate: 0.16,
          verifyReferenceNumbers: false,
          claimsStoredPayments: false,
          logger: silentLogger,
          debugLogging: false
        },
        makeInput(staffId, price)
      )
    }
    const submitInvoice = vi.fn().mockResolvedValue(unreachable)

    await createFiscalEngine({ db, submitInvoice, logger: silentLogger }).tick()

    expect(submitInvoice).toHaveBeenCalledTimes(1)
    expect(submitInvoice.mock.calls[0][0]).toMatchObject({ localId: 1 })
  })
})

describe('engine: real refusals keep today\'s routing', () => {
  /** Queues one waiting sale directly, as checkout would after a retryable failure. */
  function queuedSale(db: RubisDatabase): number {
    const staffId = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' }).staffId
    const localId = db.queueOrder({
      items: makeInput(staffId, 100).items,
      total: 100,
      clientOrderUuid: 'uuid-q',
      staffId,
      staffName: 'Alex',
      paymentMethod: 'cash',
      tenderedAmount: 100,
      changeDue: 0,
      buildFiscalRequest: (id) => ({ ...SAMPLE_REQUEST, localId: id })
    }).localId
    db.setOrderFiscalFailure(localId, 'waiting', 'first attempt failed', 'technical')
    return localId
  }

  it('a data refusal on retry still ends in needs_fixing and leaves the queue', async () => {
    const db = freshDb()
    const localId = queuedSale(db)
    const submitInvoice = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'Wrong client PIN', kind: 'data', retryable: false } satisfies FiscalSubmitOutcome)

    await createFiscalEngine({ db, submitInvoice, logger: silentLogger }).tick()

    expect(db.getOrder(localId)?.fiscal_status).toBe('needs_fixing')
    expect(db.getPendingFiscalQueue(Number.MAX_SAFE_INTEGER)).toHaveLength(0)
  })

  it('a device-answered 0x32 still counts: ten of them abandon the row, as before', async () => {
    const db = freshDb()
    const localId = queuedSale(db)
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'Illegal command',
      kind: 'technical',
      retryable: true
    } satisfies FiscalSubmitOutcome)
    let clock = Date.now()
    const engine = createFiscalEngine({ db, submitInvoice, now: () => clock, logger: silentLogger })

    await engine.tick()
    expect(db.getPendingFiscalQueue(Number.MAX_SAFE_INTEGER)[0].attempts).toBe(1)

    for (let i = 0; i < 20; i++) {
      clock += 60 * 60 * 1000
      await engine.tick()
    }

    const [row] = db.getPendingFiscalQueue(Number.MAX_SAFE_INTEGER)
    expect(row.attempts).toBe(10)
    expect(row.last_error).toMatch(/^ABANDONED/)
    expect(submitInvoice).toHaveBeenCalledTimes(10)
    expect(db.getOrder(localId)?.fiscal_status).toBe('waiting')
  })
})
