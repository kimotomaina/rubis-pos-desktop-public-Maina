/**
 * One order per checkout (docs/phase-249). The screen makes one key for a checkout and sends it with every submit; the
 * main process looks it up before the payment gates, the order id, the trader invoice number, the Shopify queue row and
 * the fiscal call, and again inside the order's write transaction. A repeat gets the first order and nothing is written,
 * filed, queued or paid. Real `:memory:` SQLite (a real file for the migration), the real `runCheckout`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import type { CheckoutRequest } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { runCheckout, checkoutKeyReusedMessage } from '../src/main/services/checkout.js'
import type { CheckoutDb, RunCheckoutDeps } from '../src/main/services/checkout.js'
import type { FiscalSubmitOutcome } from '../src/main/services/integrations/etims.js'
import { checkoutRequestSchema, validate, CHECKOUT_KEY_MISSING_MESSAGE } from '../src/main/lib/ipcValidator.js'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const KEY = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const OTHER_KEY = '9e8d7c6b-5a49-4382-a716-f5e4d3c2b1a0'
const LOCATION = { locationId: 'gid://shopify/Location/77557989479', locationName: 'Rubis Kisumu' }

const item: CartItem = {
  id: 'gid://shopify/ProductVariant/201',
  productId: 'gid://shopify/Product/101',
  title: 'RUBIS Mug',
  variantTitle: 'Small',
  price: 60,
  quantity: 2,
  image: null
}

const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn
const count = (db: RubisDatabase, table: string): number => (conn(db).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

const filed: FiscalSubmitOutcome = { ok: true, data: { invoiceNumber: 'KRA-0001', qrCode: 'qr', fiscalizedAt: '2026-10-06T10:00:00.000Z' } }

function setup(): { db: RubisDatabase; staffId: number } {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const { staffId } = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' })
  return { db, staffId }
}

function deps(db: CheckoutDb, overrides: Partial<RunCheckoutDeps> = {}): RunCheckoutDeps {
  let n = 0
  return {
    db,
    mpesaProvider: { verifyTransactionCode: vi.fn() },
    fiscalizationProvider: { submitInvoice: vi.fn().mockResolvedValue(filed) },
    fiscalEngine: { onCheckoutMade: vi.fn(), claim: vi.fn(), release: vi.fn() },
    monitor: { isOnline: () => false },
    engineTick: vi.fn().mockResolvedValue(undefined),
    idGen: () => `uuid-${++n}`,
    taxRate: 0.16,
    verifyReferenceNumbers: false,
    claimsStoredPayments: false,
    manualEntryEnabled: true,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    debugLogging: false,
    ...overrides
  }
}

/** A Daraja STK payment this till has seen confirmed. */
function confirmStk(db: RubisDatabase, receipt: string): void {
  db.logMpesaTransaction({ checkoutRequestId: `ws_CO_${receipt}`, merchantRequestId: 'm', phoneNumber: '712345678', amount: 120, status: 'pending' })
  db.updateMpesaTransactionStatus(`ws_CO_${receipt}`, 'success', receipt)
}

const sale = (staffId: number, overrides: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
  items: [item],
  total: 120,
  staffId,
  paymentMethod: 'cash',
  tenderedAmount: 200,
  changeDue: 80,
  checkoutKey: KEY,
  ...LOCATION,
  ...overrides
})

const METHODS: Array<[string, (db: RubisDatabase, staffId: number) => CheckoutRequest]> = [
  ['cash', (_db, staffId) => sale(staffId)],
  ['card', (_db, staffId) => sale(staffId, { paymentMethod: 'card', tenderedAmount: 120, changeDue: 0, cardApproval: { reference: 'PDQ123', confirmRecorded: true } })],
  [
    'M-Pesa STK (Daraja)',
    (db, staffId) => {
      confirmStk(db, 'QDF73HK9LM')
      return sale(staffId, { paymentMethod: 'mpesa', tenderedAmount: 120, changeDue: 0, referenceNumber: 'QDF73HK9LM' })
    }
  ],
  [
    'M-Pesa manual code',
    (_db, staffId) =>
      sale(staffId, { paymentMethod: 'mpesa', tenderedAmount: 120, changeDue: 0, referenceNumber: 'QAB45GH6IJ', manualApproval: { acknowledgedUnverified: true } })
  ]
]

describe('two submits with one key', () => {
  it.each(METHODS)('give one order, one trader number, one Shopify row and one fiscal call: %s', async (_name, make) => {
    const { db, staffId } = setup()
    const request = make(db, staffId)
    const d = deps(db)

    const first = await runCheckout(d, request)
    const before = { orders: count(db, 'orders'), queue: count(db, 'sync_queue'), payments: count(db, 'mpesa_payments'), trader: db.getOrder(1)?.fiscal_trader_inv_num }
    const second = await runCheckout(d, request)

    expect(first.success).toBe(true)
    expect(second).toEqual(first)
    expect(before.orders).toBe(1)
    expect(before.trader).toBeTruthy()
    expect({ orders: count(db, 'orders'), queue: count(db, 'sync_queue'), payments: count(db, 'mpesa_payments'), trader: db.getOrder(1)?.fiscal_trader_inv_num }).toEqual(before)
    expect(d.fiscalizationProvider.submitInvoice).toHaveBeenCalledTimes(1)
    expect(d.engineTick).not.toHaveBeenCalled()
  })

  it('answers the repeat with the first order as it now stands, its CU invoice included', async () => {
    const { db, staffId } = setup()
    const d = deps(db)

    await runCheckout(d, sale(staffId))
    const second = await runCheckout(d, sale(staffId))

    expect(second).toEqual({
      success: true,
      data: { localId: 1, mode: 'queued-offline', shopifyOrderId: undefined, fiscal: { invoiceNumber: 'KRA-0001', qrCode: 'qr' }, fiscalStatus: 'fiscalized', fiscalErrorReason: null, fiscalErrorKind: null, fiscalDataIssue: null }
    })
  })

  it('refuses a repeat whose total differs from the order the key made, and writes nothing', async () => {
    const { db, staffId } = setup()
    const d = deps(db)
    await runCheckout(d, sale(staffId))

    const changed = await runCheckout(d, sale(staffId, { total: 180, items: [{ ...item, quantity: 3 }] }))

    expect(changed).toEqual({ success: false, error: checkoutKeyReusedMessage(db.getOrder(1)!) })
    expect(changed.success === false && changed.error).toContain('sale #1 for 120.00')
    expect(count(db, 'orders')).toBe(1)
    expect(d.fiscalizationProvider.submitInvoice).toHaveBeenCalledTimes(1)
  })
})

describe('two submits with different keys', () => {
  it('give two orders and two fiscal calls', async () => {
    const { db, staffId } = setup()
    const d = deps(db)

    const first = await runCheckout(d, sale(staffId))
    const second = await runCheckout(d, sale(staffId, { checkoutKey: OTHER_KEY }))

    expect(first.success && second.success).toBe(true)
    expect(first.data?.localId).not.toBe(second.data?.localId)
    expect(count(db, 'orders')).toBe(2)
    expect(d.fiscalizationProvider.submitInvoice).toHaveBeenCalledTimes(2)
  })
})

describe('a submit while the first is still filing', () => {
  it('does not file again, and reports the first order as waiting', async () => {
    const { db, staffId } = setup()
    let release: (outcome: FiscalSubmitOutcome) => void = () => {}
    const submitInvoice = vi.fn(() => new Promise<FiscalSubmitOutcome>((resolve) => (release = resolve)))
    const d = deps(db, { fiscalizationProvider: { submitInvoice } })

    const first = runCheckout(d, sale(staffId))
    await vi.waitFor(() => expect(submitInvoice).toHaveBeenCalledTimes(1))
    const second = await runCheckout(d, sale(staffId))

    expect(second).toMatchObject({ success: true, data: { localId: 1, fiscalStatus: 'waiting', fiscal: undefined } })
    expect(submitInvoice).toHaveBeenCalledTimes(1)
    release(filed)
    expect(await first).toMatchObject({ success: true, data: { localId: 1, fiscalStatus: 'fiscalized' } })
    expect(submitInvoice).toHaveBeenCalledTimes(1)
    expect(count(db, 'orders')).toBe(1)
  })

  it('is answered inside the write when it passed the first look-up before the order existed (the SMS wait)', async () => {
    const { db, staffId } = setup()
    const d = deps(db)
    await runCheckout(d, sale(staffId))
    // The look-up before the gates misses, as it would for a submit that passed it while the first one was being written.
    const raced: CheckoutDb = Object.assign(Object.create(db) as RubisDatabase, { getOrderByCheckoutKey: () => undefined })

    const second = await runCheckout({ ...d, db: raced }, sale(staffId))

    expect(second).toMatchObject({ success: true, data: { localId: 1 } })
    expect(count(db, 'orders')).toBe(1)
    expect(count(db, 'sync_queue')).toBe(1)
    expect(d.fiscalizationProvider.submitInvoice).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['the SMS claim', (db: RubisDatabase, input: Parameters<RubisDatabase['queueOrder']>[0]) => db.queueOrderClaimingSmsPayment(input, { transactionCode: 'QDF73HK9LM', staffId: 1 })],
    ['a confirmed payment', (db: RubisDatabase, input: Parameters<RubisDatabase['queueOrder']>[0]) => db.queueOrderRecordingMpesaPayment(input, { mode: 'daraja', verificationStatus: 'confirmed', reference: 'QDF73HK9LM', amount: 120, enteredByStaffId: 1, approvedByStaffId: null })],
    ['a manual code', (db: RubisDatabase, input: Parameters<RubisDatabase['queueOrder']>[0]) => db.queueOrderRecordingManualPayment(input, { mode: 'manual', verificationStatus: 'manual_unverified', reference: 'QAB45GH6IJ', amount: 120, enteredByStaffId: 1, approvedByStaffId: null })]
  ])('leaves %s unwritten for a key that already made its order', (_name, write) => {
    const { db } = setup()
    const input = { items: [item], total: 120, clientOrderUuid: 'u1', staffId: 1, staffName: 'Alex', paymentMethod: 'mpesa' as const, tenderedAmount: 120, changeDue: 0, checkoutKey: KEY }
    db.queueOrder(input)
    const before = { orders: count(db, 'orders'), queue: count(db, 'sync_queue'), payments: count(db, 'mpesa_payments') }

    const again = write(db, { ...input, clientOrderUuid: 'u2' })

    expect(again).toMatchObject({ localId: 1, queueId: 0, existing: true })
    expect({ orders: count(db, 'orders'), queue: count(db, 'sync_queue'), payments: count(db, 'mpesa_payments') }).toEqual(before)
  })
})

describe('a submit with no key', () => {
  const payload = { items: [item], total: 120, staffId: 1, paymentMethod: 'cash', tenderedAmount: 200, changeDue: 80 }

  it('is refused at the channel with a clear message, and a malformed key the same', () => {
    const missing = validate(checkoutRequestSchema, payload)
    const malformed = validate(checkoutRequestSchema, { ...payload, checkoutKey: 'abc' })

    expect(missing).toEqual({ success: false, error: `checkoutKey: ${CHECKOUT_KEY_MISSING_MESSAGE}` })
    expect(malformed).toEqual({ success: false, error: `checkoutKey: ${CHECKOUT_KEY_MISSING_MESSAGE}` })
    expect(validate(checkoutRequestSchema, { ...payload, checkoutKey: KEY }).success).toBe(true)
  })

  it('writes nothing: the handler returns the refusal before the location is read and before runCheckout', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')
    const handler = source.slice(source.indexOf("'orders:checkout'"), source.indexOf("ipcMain.handle('mpesa:list-payments'"))

    const refusal = handler.indexOf('if (!validation.success) {')
    expect(handler.indexOf('validate(checkoutRequestSchema, request)')).toBeGreaterThan(-1)
    expect(refusal).toBeLessThan(handler.indexOf('resolveCheckoutLocation('))
    expect(refusal).toBeLessThan(handler.indexOf('runCheckout('))
  })
})

describe('the column and its index', () => {
  it('are made on a new database, unique among the orders that have a key', () => {
    const { db } = setup()
    const insert = conn(db).prepare("INSERT INTO orders (total, created_at, checkout_key) VALUES (1, '2026-10-06', ?)")

    insert.run(null)
    insert.run(null)
    insert.run(KEY)

    expect(() => insert.run(KEY)).toThrow(/UNIQUE/)
  })

  it('are added to an old database by a migration that runs any number of times, leaving old rows as they were', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rubis-key-'))
    try {
      const path = join(dir, 'rubis-pos.db')
      const first = new RubisDatabase({ dbPath: path })
      first.init()
      conn(first).exec("INSERT INTO orders (total, created_at, payment_method) VALUES (99.5, '2026-10-01T08:00:00.000Z', 'cash')")
      conn(first).exec('DROP INDEX idx_orders_checkout_key')
      conn(first).exec('ALTER TABLE orders DROP COLUMN checkout_key')
      const old = conn(first).prepare('SELECT * FROM orders').all()
      conn(first).close()

      for (let run = 0; run < 3; run += 1) {
        const db = new RubisDatabase({ dbPath: path })
        expect(() => db.init()).not.toThrow()
        conn(db).close()
      }

      const raw = new BetterSqlite3(path, { readonly: true })
      const columns = (raw.prepare('PRAGMA table_info(orders)').all() as Array<{ name: string }>).map((c) => c.name)
      const rows = raw.prepare('SELECT * FROM orders').all() as Array<Record<string, unknown>>
      const index = raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_orders_checkout_key'").get() as { sql: string }
      raw.close()

      expect(columns.filter((c) => c === 'checkout_key')).toHaveLength(1)
      expect(rows.map(({ checkout_key: key, ...rest }) => ({ key, rest }))).toEqual((old as Array<Record<string, unknown>>).map((rest) => ({ key: null, rest })))
      expect(index.sql).toContain('WHERE checkout_key IS NOT NULL')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('the screen', () => {
  const sent = (): Array<string | undefined> => vi.mocked(window.api.checkout).mock.calls.map(([request]) => (request as { checkoutKey?: string }).checkoutKey)

  beforeEach(() => {
    useCartStore.setState({ items: [], cartToken: null, checkoutKey: null, cartDiscount: null, checkoutStatus: 'idle', lastReceipt: null, checkoutError: null })
    window.api = { checkout: vi.fn(), printReceipt: vi.fn().mockResolvedValue({ success: true }) } as unknown as typeof window.api
    useCartStore.getState().addItem({ id: item.id, productId: item.productId, title: item.title, variantTitle: item.variantTitle, price: 60, image: null })
  })

  it('sends one key with every submit of a cart, and a new one for the next cart', async () => {
    vi.mocked(window.api.checkout)
      .mockResolvedValueOnce({ success: false, error: 'offline' })
      .mockResolvedValueOnce({ success: true, data: { localId: 1, mode: 'queued-offline', fiscalStatus: null, fiscalErrorReason: null, fiscalErrorKind: null, fiscalDataIssue: null } })
      .mockResolvedValueOnce({ success: true, data: { localId: 2, mode: 'queued-offline', fiscalStatus: null, fiscalErrorReason: null, fiscalErrorKind: null, fiscalDataIssue: null } })
    const params = { staffId: 1, paymentMethod: 'cash' as const, tenderedAmount: 60, changeDue: 0 }

    await useCartStore.getState().checkout(params)
    await useCartStore.getState().checkout(params)
    useCartStore.getState().addItem({ id: item.id, productId: item.productId, title: item.title, variantTitle: item.variantTitle, price: 60, image: null })
    await useCartStore.getState().checkout(params)

    const keys = sent()
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).toMatch(/^[0-9a-f-]{36}$/)
    expect(keys[2]).not.toBe(keys[0])
  })

  it('starts a cart put back from hold or from its saved draft with no key', () => {
    useCartStore.setState({ checkoutKey: KEY })
    useCartStore.getState().restoreCart([item], 'token-1')
    expect(useCartStore.getState().checkoutKey).toBeNull()

    useCartStore.setState({ checkoutKey: KEY })
    useCartStore.getState().resumeHeldSale({ items: [item], cartDiscount: null, customerPin: '', companyName: '' }, 'token-2', { id: 1, label: 'Held 1', total: 120 } as never)
    expect(useCartStore.getState().checkoutKey).toBeNull()
  })
})
