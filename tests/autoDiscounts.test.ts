/**
 * The pairs discount on the till (docs/phase-253-2): buy 1 loaf, get 1 loaf at Ksh 31 off. The main process prices the
 * sale at payment from its own copy and sells the discounted units as their own line, so the stored sale, the fiscal
 * request, the receipt, the reports and the Shopify order all read the lines actually sold. Real `:memory:` SQLite, the
 * real `runCheckout`, the real readers; the device and Shopify are fakes.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import type { CheckoutPaymentLeg, CheckoutRequest } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { runCheckout, PRICES_CHANGED_MESSAGE } from '../src/main/services/checkout.js'
import type { RunCheckoutDeps } from '../src/main/services/checkout.js'
import type { FiscalInvoiceRequest, FiscalSubmitOutcome } from '../src/main/services/integrations/etims.js'
import { applyAutoDiscounts, priceLines, type AutoDiscount } from '../src/main/lib/autoDiscounts.js'
import { shouldRefuseCheckoutForDiscount } from '../src/main/lib/requestHasDiscount.js'
import { checkoutRequestSchema, validate } from '../src/main/lib/ipcValidator.js'
import { generateSalesSummary } from '../src/main/services/reports.js'
import { buildLinesCsv } from '../src/main/services/reportsExport.js'
import { buildOrderInput } from '../src/main/services/orders.js'
import { buildReceiptLayout, isReceiptLayoutQr, type ReceiptLayoutEntry, type ReceiptLayoutOrder, type ReceiptWidth } from '../src/main/lib/receiptLayout.js'
import { buildEnjoySlip } from '../src/main/lib/enjoySlip.js'
import type { OfflineOrderPayload } from '../src/main/services/shopify-types.js'

const LOCATION = { locationId: 'gid://shopify/Location/77557989479', locationName: 'Rubis Kisumu' }
const EVERYTHING = { startIso: '2000-01-01T00:00:00.000Z', endIso: '2100-01-01T00:00:00.000Z', label: 'all' }
const PAYMENT_TIME = new Date('2026-10-07T09:00:00Z')
const filed: FiscalSubmitOutcome = { ok: true, data: { invoiceNumber: 'KRA-0001', qrCode: 'qr', fiscalizedAt: '2026-10-07T09:00:01.000Z' } }

/** The owner's discount after step by step A (docs/phase-253-audit). */
const PAIRS: AutoDiscount = {
  id: 'gid://shopify/DiscountAutomaticNode/1',
  title: 'Probakery Bread 2 @99/=',
  startsAt: '2026-10-06T10:12:00Z',
  endsAt: null,
  buysQuantity: 1,
  getsQuantity: 1,
  variantIds: [],
  productIds: ['10235718041703'],
  effect: { type: 'amount', amount: 31 },
  usesPerOrderLimit: null
}

const bread = (quantity: number) => ({
  id: 'gid://shopify/ProductVariant/50363428241511',
  productId: '10235718041703',
  title: 'PB WHITE BREAD 400G',
  variantTitle: 'Default Title',
  price: 65,
  quantity,
  image: null
})
const milk = (quantity: number) => ({
  id: 'gid://shopify/ProductVariant/2',
  productId: '2',
  title: 'Kabras Milk 500ml',
  variantTitle: 'Default Title',
  price: 65,
  quantity,
  image: null
})

const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn

function setup(discounts: AutoDiscount[] = [PAIRS]): { db: RubisDatabase; staffId: number } {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  db.replaceCatalogue({ discounts })
  const { staffId } = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'admin' })
  return { db, staffId }
}

function deps(db: RubisDatabase, overrides: Partial<RunCheckoutDeps> = {}): RunCheckoutDeps {
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
    autoDiscounts: () => db.getAutoDiscounts(),
    now: () => PAYMENT_TIME,
    ...overrides
  }
}

function cashSale(staffId: number, items: CheckoutRequest['items'], total: number, overrides: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return { items, total, staffId, paymentMethod: 'cash', tenderedAmount: total, changeDue: 0, ...LOCATION, ...overrides }
}

/** Every table's row count and the trader sequence: "nothing written" is these, unchanged. */
function snapshot(db: RubisDatabase): Record<string, unknown> {
  const c = conn(db)
  const tables = c.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'sqlite_sequence' ORDER BY name").all() as Array<{ name: string }>
  return {
    ...Object.fromEntries(tables.map(({ name }) => [name, (c.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n])),
    traderSeq: db.getSetting('last_trader_seq')
  }
}

const deviceLines = (d: RunCheckoutDeps): Array<[number, number]> => {
  const request = (d.fiscalizationProvider.submitInvoice as ReturnType<typeof vi.fn>).mock.calls[0][0] as FiscalInvoiceRequest
  return request.items.map((item) => [item.quantity, item.unitPrice])
}

const storedLines = (db: RubisDatabase, localId: number): OfflineOrderPayload['lineItems'] =>
  (JSON.parse(db.getOrder(localId)!.payload_json) as OfflineOrderPayload).lineItems

afterEach(() => vi.useRealTimers())

describe('the pairs deal: 1, 2, 3 and 4 loaves', () => {
  it.each([
    [1, 65, [[1, 65]]],
    [2, 99, [[1, 65], [1, 34]]],
    [3, 164, [[2, 65], [1, 34]]],
    [4, 198, [[2, 65], [2, 34]]]
  ])('%i loaves cost %i, sent to the device as %j', async (loaves, total, lines) => {
    const { db, staffId } = setup()
    const d = deps(db)

    const result = await runCheckout(d, cashSale(staffId, [bread(loaves)], total))

    expect(result.success).toBe(true)
    expect(deviceLines(d)).toEqual(lines)
    const stored = storedLines(db, result.data!.localId)
    expect(stored.map((line) => [line.quantity, line.unitPrice])).toEqual(lines)
    expect(db.getOrder(result.data!.localId)!.total).toBe(total)
    const discountedLine = stored.find((line) => line.autoDiscount)
    if (loaves >= 2) {
      expect(discountedLine?.autoDiscount).toEqual({ id: PAIRS.id, title: 'Probakery Bread 2 @99/=', amountOffEach: 31 })
      expect(stored.every((line) => line.discount === undefined)).toBe(true)
    } else {
      expect(discountedLine).toBeUndefined()
    }
  })

  it('taking a loaf out of a pair gives 65 again', () => {
    expect(applyAutoDiscounts([bread(2)], [PAIRS], PAYMENT_TIME).total).toBe(99)
    expect(applyAutoDiscounts([bread(1)], [PAIRS], PAYMENT_TIME).total).toBe(65)
  })

  it('a cap per order is honoured: one use only, so 4 loaves are 65 + 65 + 65 + 34', () => {
    const sale = applyAutoDiscounts([bread(4)], [{ ...PAIRS, usesPerOrderLimit: 1 }], PAYMENT_TIME)
    expect(sale.total).toBe(229)
    expect(sale.lines.map((line) => [line.quantity, line.price])).toEqual([[3, 65], [1, 34]])
  })

  it('a percentage rounds per unit, half up to the cent', () => {
    // 12.5 % of 0.99 is 12.375 cents: 12 cents off each, 0.87 each.
    const line = { ...bread(2), price: 0.99 }
    const sale = applyAutoDiscounts([line], [{ ...PAIRS, effect: { type: 'percentage', percentage: 0.125 } }], PAYMENT_TIME)
    expect(sale.lines.map((l) => [l.quantity, l.price])).toEqual([[1, 0.99], [1, 0.87]])
    // 15 % of 65.00 is exactly 9.75.
    expect(applyAutoDiscounts([bread(2)], [{ ...PAIRS, effect: { type: 'percentage', percentage: 0.15 } }], PAYMENT_TIME).total).toBe(120.25)
  })

  it('a discount that would bring a unit to 0 is not applied', () => {
    const sale = applyAutoDiscounts([bread(2)], [{ ...PAIRS, effect: { type: 'amount', amount: 65 } }], PAYMENT_TIME)
    expect(sale.total).toBe(130)
    expect(sale.lines.every((line) => !line.autoDiscount)).toBe(true)
  })

  it('the best saving wins when two discounts name the same loaf; a tie goes to the earliest start', () => {
    const smaller = { ...PAIRS, id: 'gid://shopify/DiscountAutomaticNode/2', title: 'Ten off', effect: { type: 'amount' as const, amount: 10 } }
    expect(priceLines([bread(2)], [smaller, PAIRS], PAYMENT_TIME)[0].discount?.title).toBe('Probakery Bread 2 @99/=')
    const later = { ...PAIRS, id: 'gid://shopify/DiscountAutomaticNode/0', title: 'Later', startsAt: '2026-10-07T00:00:00Z' }
    expect(priceLines([bread(2)], [later, PAIRS], PAYMENT_TIME)[0].discount?.title).toBe('Probakery Bread 2 @99/=')
  })
})

describe('judged by the time at payment, and the screen never trusted', () => {
  it('a discount not yet started is not applied: the screen total of 99 is refused, with nothing written', async () => {
    const { db, staffId } = setup()
    const before = snapshot(db)
    const d = deps(db, { now: () => new Date('2026-10-06T10:11:59Z') })

    const result = await runCheckout(d, cashSale(staffId, [bread(2)], 99))

    expect(result).toEqual({ success: false, error: PRICES_CHANGED_MESSAGE })
    expect(snapshot(db)).toEqual(before)
    expect(d.fiscalizationProvider.submitInvoice).not.toHaveBeenCalled()
  })

  it('an expired discount is not applied: the sale goes at the normal price', async () => {
    const { db, staffId } = setup([{ ...PAIRS, endsAt: '2026-10-07T08:59:59Z' }])
    const d = deps(db)

    const result = await runCheckout(d, cashSale(staffId, [bread(2)], 130))

    expect(result.success).toBe(true)
    expect(deviceLines(d)).toEqual([[2, 65]])
  })

  it('a screen total that differs from the till’s own price is refused, with nothing written', async () => {
    const { db, staffId } = setup()
    const before = snapshot(db)

    const result = await runCheckout(deps(db), cashSale(staffId, [bread(2)], 130))

    expect(result).toEqual({ success: false, error: PRICES_CHANGED_MESSAGE })
    expect(snapshot(db)).toEqual(before)
  })

  it('a repeat submit with the same key gives one sale', async () => {
    const { db, staffId } = setup()
    const d = deps(db)
    const sale = cashSale(staffId, [bread(3)], 164, { checkoutKey: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b' })

    const first = await runCheckout(d, sale)
    const second = await runCheckout(d, sale)

    expect(second.data?.localId).toBe(first.data?.localId)
    expect(db.getOrders()).toHaveLength(1)
  })

  it('a split payment of 164 (100 M-Pesa by code + 64 cash) works on the discounted total', async () => {
    const { db, staffId } = setup()
    const d = deps(db)
    const payments: CheckoutPaymentLeg[] = [
      { method: 'mpesa', amount: 100, referenceNumber: 'QAB45GH6IJ', manualApproval: { acknowledgedUnverified: true } },
      { method: 'cash', amount: 64, tendered: 100 }
    ]

    const result = await runCheckout(d, cashSale(staffId, [bread(3)], 164, { paymentMethod: 'split', tenderedAmount: 0, payments }))

    expect(result.success).toBe(true)
    expect(deviceLines(d)).toEqual([[2, 65], [1, 34]])
    expect(db.paymentLegsFor([result.data!.localId]).get(result.data!.localId)?.map((leg) => [leg.method, leg.amount])).toEqual([
      ['mpesa', 100],
      ['cash', 64]
    ])
  })
})

describe('the manual discounts and their refusal are not changed (docs/phase-161-1)', () => {
  it('the live refusal still refuses a manual discount, and never sees an automatic one', () => {
    expect(shouldRefuseCheckoutForDiscount(true, { items: [{ discount: { type: 'fixed', value: 31 } }] })).toBe(true)
    expect(shouldRefuseCheckoutForDiscount(true, { items: [{ ...bread(2), discount: undefined }] })).toBe(false)
  })

  it('a discount sent from the screen on a line is dropped by the validator, never trusted', () => {
    const checked = validate(checkoutRequestSchema, {
      ...cashSale(1, [{ ...bread(2), autoDiscount: { id: 'x', title: 'Free', amountOffEach: 65 } } as never], 99),
      checkoutKey: '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
    })
    expect(checked.success).toBe(true)
    expect(checked.success && (checked.data.items[0] as Record<string, unknown>).autoDiscount).toBeUndefined()
  })

  it('a cart with a manual discount (mock mode) is priced exactly as before, with no automatic discount', async () => {
    const { db, staffId } = setup()
    const d = deps(db)

    const result = await runCheckout(d, cashSale(staffId, [{ ...bread(2), discount: { type: 'fixed', value: 10 } }], 120))

    expect(result.success).toBe(true)
    expect(deviceLines(d)).toEqual([[2, 65]])
    expect(storedLines(db, result.data!.localId).every((line) => !line.autoDiscount)).toBe(true)
  })
})

describe('a sale with no discount is exactly as it was', () => {
  /** One sale of milk at a fixed time: what it stores, files and pushes, with or without a discount copy naming bread. */
  async function milkSale(discounts: AutoDiscount[], withDep: boolean): Promise<Record<string, unknown>> {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(PAYMENT_TIME)
    const { db, staffId } = setup(discounts)
    const d = deps(db, withDep ? {} : { autoDiscounts: undefined, now: undefined })
    const result = await runCheckout(d, cashSale(staffId, [milk(2)], 130))
    const order = db.getOrder(result.data!.localId)!
    const payload = JSON.parse(order.payload_json) as OfflineOrderPayload
    return {
      payload: order.payload_json,
      fiscalRequest: order.fiscal_request_json,
      shopify: JSON.stringify(buildOrderInput(payload)),
      summary: generateSalesSummary(db, 0.16, EVERYTHING)
    }
  }

  it('stores, files, pushes and reports the same with the bread discount in the copy as with no copy at all', async () => {
    const plain = await milkSale([], false)
    const withCopy = await milkSale([PAIRS], true)
    expect(withCopy).toEqual(plain)
    expect(withCopy.summary).not.toHaveProperty('autoDiscountsGiven')
    expect((JSON.parse(withCopy.shopify as string) as { order: { lineItems: unknown[] } }).order.lineItems).toEqual([
      { variantId: 'gid://shopify/ProductVariant/2', quantity: 2 }
    ])
  })
})

describe('the readers of the sold lines', () => {
  async function threeLoaves(): Promise<{ db: RubisDatabase; localId: number; payload: OfflineOrderPayload }> {
    const { db, staffId } = setup()
    const result = await runCheckout(deps(db), cashSale(staffId, [bread(3)], 164, { tenderedAmount: 200, changeDue: 36 }))
    const localId = result.data!.localId
    return { db, localId, payload: JSON.parse(db.getOrder(localId)!.payload_json) as OfflineOrderPayload }
  }

  const textLines = (entries: ReceiptLayoutEntry[]): string[] =>
    entries.filter((entry) => !isReceiptLayoutQr(entry)).map((entry) => (entry as { text: string }).text)

  function receipt(db: RubisDatabase, localId: number, payload: OfflineOrderPayload): ReceiptLayoutOrder {
    return {
      localId,
      createdAt: db.getOrder(localId)!.created_at,
      cashierName: payload.staffName,
      paymentMethod: payload.paymentMethod,
      tenderedAmount: payload.tenderedAmount,
      changeDue: payload.changeDue,
      total: db.getOrder(localId)!.total,
      items: payload.lineItems.map((line) => ({
        title: line.title,
        variantTitle: line.variantTitle,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        vatClass: 'A',
        ...(line.autoDiscount ? { autoDiscount: line.autoDiscount } : {})
      }))
    }
  }

  const settings = { taxRate: 0.16, tradingName: 'ENJOY', legalName: 'Rubis', address: 'Kisumu', phone: '0700', sellerPin: 'P051', footerMessage: 'Thanks' }

  it.each<ReceiptWidth>([48, 42])('the receipt at %i columns prints the lines filed, then the discount and the saving on one line', async (width) => {
    const { db, localId, payload } = await threeLoaves()
    const lines = textLines(buildReceiptLayout(receipt(db, localId, payload), settings, { width })).map((l) => l.replace(/\s+/g, ' ').trim())

    const at = lines.indexOf('1 x 34.00 34.00 A')
    expect(lines).toContain('2 x 65.00 130.00 A')
    expect(at).toBeGreaterThan(-1)
    expect(lines[at + 1]).toBe('Probakery Bread 2 @99/= saved 31.00')
    expect(lines.some((l) => l.includes('TOTAL KSH 164.00'))).toBe(true)
    expect(textLines(buildReceiptLayout(receipt(db, localId, payload), settings, { width })).every((l) => l.length <= width)).toBe(true)
  })

  it('the receipt at 32 columns wraps: the title, then the saving on its own line', async () => {
    const { db, localId, payload } = await threeLoaves()
    const raw = textLines(buildReceiptLayout(receipt(db, localId, payload), settings, { width: 32 }))

    expect(raw.every((l) => l.length <= 32)).toBe(true)
    const at = raw.findIndex((l) => l.trim() === 'Probakery Bread 2 @99/=')
    expect(at).toBeGreaterThan(-1)
    expect(raw[at + 1].trim()).toBe('saved 31.00')
  })

  it('the Enjoy slip prints the lines filed and the discount line, and adds up with no extra Discount row', async () => {
    const { db, localId, payload } = await threeLoaves()
    const lines = textLines(buildEnjoySlip(receipt(db, localId, payload), { locationName: 'Kisumu', address: 'Kisumu' }, { width: 48, kraNote: 'none' as never })).map(
      (l) => l.replace(/\s+/g, ' ').trim()
    )

    expect(lines).toContain('Probakery Bread 2 @99/= saved 31.00')
    expect(lines.some((l) => /^DISCOUNT/i.test(l))).toBe(false)
  })

  it('Shopify gets the same lines with their prices, and the discount in the note', async () => {
    const { payload } = await threeLoaves()
    const { order } = buildOrderInput(payload) as unknown as { order: { lineItems: unknown[]; note: string } }

    expect(order.lineItems).toEqual([
      { variantId: 'gid://shopify/ProductVariant/50363428241511', quantity: 2, priceSet: { shopMoney: { amount: '65.00', currencyCode: 'KES' } } },
      { variantId: 'gid://shopify/ProductVariant/50363428241511', quantity: 1, priceSet: { shopMoney: { amount: '34.00', currencyCode: 'KES' } } }
    ])
    expect(order.note.endsWith(' — discounts: Probakery Bread 2 @99/= -31.00')).toBe(true)
  })

  it('the Sales Summary shows the automatic discounts given; the lines CSV says which, on the discounted line', async () => {
    const { db } = await threeLoaves()

    expect(generateSalesSummary(db, 0.16, EVERYTHING).autoDiscountsGiven).toEqual({ amount: 31, saleCount: 1 })
    const csv = buildLinesCsv(db, EVERYTHING)
    expect(csv).toContain('automatic Probakery Bread 2 @99/=: 31.00 off each')
    expect(csv.split('\n').filter((row) => row.includes('automatic'))).toHaveLength(1)
  })
})
