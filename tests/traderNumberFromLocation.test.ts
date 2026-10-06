/**
 * docs/phase-211: the trader system invoice number is built from the location id, fixed when the sale
 * is created, stored with it, and sent unchanged on every filing and retry.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AxiosInstance } from 'axios'
import { RubisDatabase } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { runCheckout } from '../src/main/services/checkout.js'
import type { RunCheckoutDeps } from '../src/main/services/checkout.js'
import { RealFiscalizationProvider } from '../src/main/services/integrations/real-etims-provider.js'
import { MockFiscalizationProvider } from '../src/main/services/integrations/mock-etims-provider.js'
import type { FiscalInvoiceRequest, FiscalSubmitOutcome } from '../src/main/services/integrations/etims.js'
import { buildOrdersCsv, buildLinesCsv } from '../src/main/services/reportsExport.js'
import { buildReconciliationRow } from '../src/main/services/reports.js'
import {
  TRADER_SEQ_EPOCH_MS,
  buildLocationTraderInvNum,
  buildTraderSystemInvNum,
  locationCode,
  nextTraderSeq,
  resolveTraderSystemInvNum
} from '../src/main/lib/traderSystemInvoiceNumber.js'
import type { OrderRow, RubisDatabase as Db, StaffRow, CheckoutRequest } from '../src/main/services/database.js'
import type { ReportRange } from '../src/main/services/reports.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'
import { legsOf } from './helpers/paymentLegs.js'

const KISUMU = 'gid://shopify/Location/77557989479'
const HAILE_SELASSIE = 'gid://shopify/Location/78361919591'
/** 36^7: the first location id whose base 36 code is 8 characters. */
const FIRST_EIGHT_CHAR_ID = 78364164096
/** 36^8: the first id whose code is 9 characters, too long for the 15-character field. */
const FIRST_NINE_CHAR_ID = 2821109907456
const SALE_AT = Date.UTC(2026, 9, 3, 0, 0, 0)

describe('locationCode', () => {
  it('is the numeric id in uppercase base 36', () => {
    expect(locationCode(KISUMU)).toBe('ZMO0VON')
    expect(locationCode(HAILE_SELASSIE)).toBe('ZZYNW4N')
  })

  it('is 7 characters today and 8 once ids pass 36^7', () => {
    expect(locationCode(`gid://shopify/Location/${FIRST_EIGHT_CHAR_ID - 1}`)).toHaveLength(7)
    expect(locationCode(`gid://shopify/Location/${FIRST_EIGHT_CHAR_ID}`)).toBe('10000000')
  })

  it.each(['77557989479', 'gid://shopify/Product/1', 'gid://shopify/Location/', ''])(
    'throws for %j, which is not a location id',
    (bad) => {
      expect(() => locationCode(bad)).toThrow(/not a Shopify location id/)
    }
  )
})

describe('buildLocationTraderInvNum', () => {
  it('builds the two example numbers for a sale at 2026-10-03T00:00:00Z', () => {
    const seq = nextTraderSeq(SALE_AT, 0)

    expect(seq).toBe(23_760_000)
    expect(buildLocationTraderInvNum(KISUMU, seq)).toBe('LZMO0VON0E59C0')
    expect(buildLocationTraderInvNum(HAILE_SELASSIE, seq)).toBe('LZZYNW4N0E59C0')
  })

  it('is 14 characters with a 7-character code and 15 with an 8-character code', () => {
    expect(buildLocationTraderInvNum(KISUMU, 5)).toHaveLength(14)
    expect(buildLocationTraderInvNum(`gid://shopify/Location/${FIRST_EIGHT_CHAR_ID}`, 5)).toHaveLength(15)
  })

  it('pads the sequence to 6 characters, so numbers of one length with different codes differ in the code', () => {
    expect(buildLocationTraderInvNum(KISUMU, 0)).toBe('LZMO0VON000000')
    expect(buildLocationTraderInvNum(KISUMU, 35)).toBe('LZMO0VON00000Z')
  })

  it('starts with L, so it can never equal a legacy INV- number', () => {
    expect(buildLocationTraderInvNum(KISUMU, 1).startsWith('L')).toBe(true)
    expect(buildTraderSystemInvNum(1, 'u').startsWith('INV-')).toBe(true)
  })

  it('throws, rather than truncating, when the result passes 15 characters', () => {
    expect(() => buildLocationTraderInvNum(`gid://shopify/Location/${FIRST_NINE_CHAR_ID}`, 1)).toThrow(/longer than 15/)
  })

  it('throws when the sequence does not fit 6 characters, is negative, or is not an integer', () => {
    expect(() => buildLocationTraderInvNum(KISUMU, 36 ** 6)).toThrow(/does not fit/)
    expect(() => buildLocationTraderInvNum(KISUMU, -1)).toThrow(/does not fit/)
    expect(() => buildLocationTraderInvNum(KISUMU, 1.5)).toThrow(/does not fit/)
  })

  it('throws when asked to build without a location', () => {
    expect(() => buildLocationTraderInvNum('', 1)).toThrow(/not a Shopify location id/)
  })
})

describe('nextTraderSeq', () => {
  it('is the whole seconds since 2026-01-01T00:00:00Z', () => {
    expect(nextTraderSeq(TRADER_SEQ_EPOCH_MS + 1_999, 0)).toBe(1)
  })

  it('gives consecutive values to two sales in one second', () => {
    const first = nextTraderSeq(SALE_AT, 0)

    expect(nextTraderSeq(SALE_AT, first)).toBe(first + 1)
    expect(nextTraderSeq(SALE_AT, first + 1)).toBe(first + 2)
  })

  it('never repeats or goes down after the clock is set back', () => {
    const last = nextTraderSeq(SALE_AT, 0)

    expect(nextTraderSeq(SALE_AT - 3_600_000, last)).toBe(last + 1)
  })

  it('treats a clock before 2026 as 0, then applies the guard', () => {
    expect(nextTraderSeq(Date.UTC(2025, 5, 1), 0)).toBe(1)
    expect(nextTraderSeq(Date.UTC(2025, 5, 1), 41)).toBe(42)
  })
})

describe('resolveTraderSystemInvNum', () => {
  it('prefers the stored number', () => {
    expect(resolveTraderSystemInvNum('LZMO0VON0E59C0', 7, 'uuid')).toBe('LZMO0VON0E59C0')
  })

  it.each([null, undefined, ''])('falls back to the legacy INV-<local_id> form when the stored value is %j', (stored) => {
    expect(resolveTraderSystemInvNum(stored, 42, 'uuid')).toBe('INV-000000042')
  })
})

/** A staff member and a database to sell through. */
function setup(): { db: RubisDatabase; staffId: number } {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const staffId = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'cashier' }).staffId
  return { db, staffId }
}

const cartItem: CartItem = {
  id: 'gid://shopify/ProductVariant/50346858741863',
  productId: 'gid://shopify/Product/1',
  title: 'test',
  variantTitle: 'Default Title',
  price: 1,
  quantity: 1,
  image: null
}

function queue(db: RubisDatabase, staffId: number, uuid: string, locationId?: string): ReturnType<RubisDatabase['queueOrder']> {
  return db.queueOrder({
    items: [cartItem],
    total: 1,
    clientOrderUuid: uuid,
    staffId,
    staffName: 'Alex',
    paymentMethod: 'cash',
    tenderedAmount: 1,
    changeDue: 0,
    locationId,
    locationName: locationId ? 'Rubis Kisumu' : undefined,
    buildFiscalRequest: (id, traderInvNum): FiscalInvoiceRequest => ({
      clientOrderUuid: uuid,
      localId: id,
      ...(traderInvNum ? { traderInvNum } : {}),
      items: [{ description: 'test', quantity: 1, unitPrice: 1, taxRate: 0.16 }],
      total: 1,
      taxAmount: 0.14,
      paymentMethod: 'cash'
    })
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('queueOrder allocates the number inside the sale\'s transaction', () => {
  it('stores it on the order, in the stored fiscal request and in the queued row, and remembers the sequence', () => {
    vi.useFakeTimers()
    vi.setSystemTime(SALE_AT)
    const { db, staffId } = setup()

    const queued = queue(db, staffId, 'uuid-a', KISUMU)

    expect(queued.traderInvNum).toBe('LZMO0VON0E59C0')
    const order = db.getOrder(queued.localId)!
    expect(order.fiscal_trader_inv_num).toBe('LZMO0VON0E59C0')
    expect(JSON.parse(order.fiscal_request_json!).traderInvNum).toBe('LZMO0VON0E59C0')
    expect(db.getPendingFiscalQueue(Number.MAX_SAFE_INTEGER)[0].payload.traderInvNum).toBe('LZMO0VON0E59C0')
    expect(db.getSetting('last_trader_seq')).toBe('23760000')
  })

  it('gives two sales in one second consecutive numbers', () => {
    vi.useFakeTimers()
    vi.setSystemTime(SALE_AT)
    const { db, staffId } = setup()

    const first = queue(db, staffId, 'uuid-1', KISUMU)
    const second = queue(db, staffId, 'uuid-2', KISUMU)

    expect(first.traderInvNum).toBe('LZMO0VON0E59C0')
    expect(second.traderInvNum).toBe('LZMO0VON0E59C1')
  })

  it('never repeats a number when the clock is set back', () => {
    vi.useFakeTimers()
    vi.setSystemTime(SALE_AT)
    const { db, staffId } = setup()
    const first = queue(db, staffId, 'uuid-1', KISUMU)

    vi.setSystemTime(SALE_AT - 86_400_000)
    const second = queue(db, staffId, 'uuid-2', KISUMU)

    expect(second.traderInvNum).not.toBe(first.traderInvNum)
    expect(second.traderInvNum).toBe('LZMO0VON0E59C1')
  })

  it('a wiped database continues from the clock, not from 1', () => {
    vi.useFakeTimers()
    vi.setSystemTime(SALE_AT)
    const wiped = setup()

    const queued = queue(wiped.db, wiped.staffId, 'uuid-1', KISUMU)

    expect(queued.localId).toBe(1)
    expect(queued.traderInvNum).toBe('LZMO0VON0E59C0')
    expect(queued.traderInvNum).not.toBe(buildTraderSystemInvNum(1, 'uuid-1'))
  })

  it('a sale with no location gets no number, so it files under the legacy form', () => {
    const { db, staffId } = setup()

    const queued = queue(db, staffId, 'uuid-legacy')

    expect(queued.traderInvNum).toBeUndefined()
    expect(db.getOrder(queued.localId)!.fiscal_trader_inv_num).toBeNull()
    expect(db.getSetting('last_trader_seq')).toBeUndefined()
    expect(db.getPendingFiscalQueue(Number.MAX_SAFE_INTEGER)[0].payload.traderInvNum).toBeUndefined()
  })

  it('a location id that cannot build a number aborts the whole sale write', () => {
    const { db, staffId } = setup()

    expect(() => queue(db, staffId, 'uuid-bad', 'not-a-location')).toThrow(/not a Shopify location id/)
    expect(db.getOrdersForDateRange('2000-01-01', '2100-01-01')).toHaveLength(0)
  })
})

describe('runCheckout files the sale under the stored number', () => {
  it('the request handed to the device carries the same number that was stored on the order', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(SALE_AT)
    const { db, staffId } = setup()
    const submitInvoice = vi.fn().mockResolvedValue({
      ok: true,
      data: { invoiceNumber: '0110605040001000810', qrCode: 'qr', fiscalizedAt: '2026-10-03T00:00:00.000Z' }
    } satisfies FiscalSubmitOutcome)
    const deps: RunCheckoutDeps = {
      db,
      mpesaProvider: { verifyTransactionCode: vi.fn() },
      fiscalizationProvider: { submitInvoice },
      fiscalEngine: { onCheckoutMade: vi.fn(), claim: vi.fn(), release: vi.fn() },
      monitor: { isOnline: () => false },
      engineTick: vi.fn().mockResolvedValue(undefined),
      idGen: () => 'uuid-checkout',
      taxRate: 0.16,
      verifyReferenceNumbers: false,
      claimsStoredPayments: false,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
      debugLogging: false
    }
    const request: CheckoutRequest = {
      items: [cartItem],
      total: 1,
      staffId,
      paymentMethod: 'cash',
      tenderedAmount: 1,
      changeDue: 0,
      locationId: KISUMU,
      locationName: 'Rubis Kisumu'
    }

    await runCheckout(deps, request)

    const sent = submitInvoice.mock.calls[0][0] as FiscalInvoiceRequest
    expect(sent.traderInvNum).toBe('LZMO0VON0E59C0')
    expect(db.getOrder(sent.localId!)!.fiscal_trader_inv_num).toBe(sent.traderInvNum)
  })
})

/** A provider over a device that accepts everything, recording the posted bodies. */
function makeRealProvider(): { provider: RealFiscalizationProvider; opens: string[] } {
  const opens: string[] = []
  const post = vi.fn().mockImplementation((_path: string, body: string) => {
    const command = /<Command Name="([^"]+)"/.exec(body)?.[1] ?? ''
    if (command === 'OpenInvoiceWithFreeCustomerData') opens.push(body)
    const reply: Record<string, string> = {
      ReadStatus: '<Res Code="0"><CU_fiscalized>1</CU_fiscalized><Paired_with_TIMS>1</Paired_with_TIMS></Res>',
      ReadCurrentReceiptInfo: '<Res Code="0"><OptionIsReceiptOpened>1</OptionIsReceiptOpened><SubtotalAmountVATGA>1.00</SubtotalAmountVATGA></Res>',
      CloseReceipt: '<Res Code="0"><InvoiceNum>0110605040001000810</InvoiceNum><QRcode>qr</QRcode></Res>',
      ReadDateTime: '<Res Code="0"><DateTime>03-10-2026 00:37</DateTime></Res>'
    }
    return Promise.resolve({ data: reply[command] ?? '<Res Code="0"/>' })
  })
  const client = {
    post,
    get: vi.fn().mockResolvedValue({ data: '<Res Code="0"/>' }),
    defaults: { baseURL: 'http://localhost:4444/' }
  } as unknown as AxiosInstance
  const provider = new RealFiscalizationProvider({
    deviceIp: '192.168.1.50',
    devicePort: '8000',
    password: 'test-device-password',
    httpClient: client
  })
  return { provider, opens }
}

const BASE_REQUEST: FiscalInvoiceRequest = {
  clientOrderUuid: 'c2770b2d-e10d-4ca7-9900-8b4e304600b3',
  localId: 42,
  items: [{ description: 'test', quantity: 1, unitPrice: 1, taxRate: 0.16 }],
  total: 1,
  taxAmount: 0.14,
  paymentMethod: 'cash'
}

/** The `TraderSystemInvNum` value posted in an OpenInvoice body. */
function sentNumber(body: string): string | undefined {
  return /Name="TraderSystemInvNum" Value="([^"]*)"/.exec(body)?.[1]
}

describe('the real provider', () => {
  it('sends the stored number unchanged, and the same number again on a retry', async () => {
    const { provider, opens } = makeRealProvider()

    await provider.submitInvoice({ ...BASE_REQUEST, traderInvNum: 'LZMO0VON0E59C0' })
    await provider.submitInvoice({ ...BASE_REQUEST, traderInvNum: 'LZMO0VON0E59C0', isRetry: true })

    expect(opens.map(sentNumber)).toEqual(['LZMO0VON0E59C0', 'LZMO0VON0E59C0'])
  })

  it('passes a 15-character number through the sanitiser without cutting it', async () => {
    const { provider, opens } = makeRealProvider()

    await provider.submitInvoice({ ...BASE_REQUEST, traderInvNum: 'L10000000ABCDEF' })

    expect(sentNumber(opens[0])).toBe('L10000000ABCDEF')
  })

  it('files a sale with no stored number under the legacy INV-<local_id> form', async () => {
    const { provider, opens } = makeRealProvider()

    await provider.submitInvoice(BASE_REQUEST)

    expect(sentNumber(opens[0])).toBe('INV-000000042')
  })
})

describe('the mock provider agrees with the real one', () => {
  it.each([
    ['a stored number', 'LZMO0VON0E59C0', 'LZMO0VON0E59C0'],
    ['no stored number', undefined, 'INV-000000042']
  ])('records the same number the real provider would send for %s', async (_label, stored, expected) => {
    const recorded: string[] = []
    const mock = new MockFiscalizationProvider(undefined, { recordTraderInvNum: (_id, number) => recorded.push(number) })
    const { provider, opens } = makeRealProvider()

    await mock.submitInvoice({ ...BASE_REQUEST, traderInvNum: stored })
    await provider.submitInvoice({ ...BASE_REQUEST, traderInvNum: stored })

    expect(recorded).toEqual([expected])
    expect(sentNumber(opens[0])).toBe(expected)
  })
})

describe('the readers show the stored number and fall back only on NULL', () => {
  const RANGE: ReportRange = { startIso: '2026-10-01T00:00:00.000Z', endIso: '2026-10-04T00:00:00.000Z', label: 'test' }
  const staff: StaffRow = { id: 1, name: 'Ann', pin_hash: 'x', role: 'cashier', is_active: 1 }

  function order(overrides: Partial<OrderRow>): OrderRow {
    return {
      local_id: 42,
      shopify_order_id: null,
      total: 1,
      status: 'synced',
      created_at: '2026-10-03T00:00:00.000Z',
      payload_json: JSON.stringify({ clientOrderUuid: 'uuid-42', lineItems: [{ variantId: 'v', title: 't', variantTitle: 'd', quantity: 1, unitPrice: 1 }] }),
      staff_id: 1,
      payment_method: 'cash',
      tendered_amount: 1,
      change_due: 0,
      reference_number: null,
      shift_id: 1,
      fiscal_invoice_number: null,
      fiscal_qr_code: null,
      fiscal_fiscalized_at: null,
      fiscal_status: null,
      fiscal_error_reason: null,
      fiscal_error_kind: null,
      fiscal_request_json: null,
      fiscal_data_issue: null,
      fiscal_vat_groups_json: null,
      fiscal_fiscalized_at_source: null,
      fiscal_cu_serial: null,
      receipt_printed_at: null,
      ...overrides
    }
  }

  function fakeDb(orders: OrderRow[]): Db {
    return {
      getOrdersForDateRange: vi.fn(() => orders),
      getMpesaPaymentsForDateRange: vi.fn(() => []),
      getStaffById: vi.fn(() => staff),
      paymentLegsFor: legsOf(orders) // ADDED (docs/phase-250): the readers take how each sale was paid from its legs, served here from the same rows.
    } as unknown as Db
  }

  it('orders.csv: the stored number, else the legacy form', () => {
    const stored = buildOrdersCsv(fakeDb([order({ fiscal_trader_inv_num: 'LZMO0VON0E59C0' })]), RANGE, 0.16)
    const legacy = buildOrdersCsv(fakeDb([order({ fiscal_trader_inv_num: null })]), RANGE, 0.16)

    expect(stored).toContain('LZMO0VON0E59C0')
    expect(stored).not.toContain('INV-000000042')
    expect(legacy).toContain('INV-000000042')
  })

  it('lines.csv: the stored number, else the legacy form', () => {
    const stored = buildLinesCsv(fakeDb([order({ fiscal_trader_inv_num: 'LZMO0VON0E59C0' })]), RANGE)
    const legacy = buildLinesCsv(fakeDb([order({ fiscal_trader_inv_num: null })]), RANGE)

    expect(stored).toContain('LZMO0VON0E59C0')
    expect(stored).not.toContain('INV-000000042')
    expect(legacy).toContain('INV-000000042')
  })

  it('the reconciliation row: the stored number, else the legacy form', () => {
    const logger = { log: () => {}, warn: () => {}, error: () => {} }

    expect(buildReconciliationRow(order({ fiscal_trader_inv_num: 'LZMO0VON0E59C0' }), logger).traderInvoiceNumber).toBe('LZMO0VON0E59C0')
    expect(buildReconciliationRow(order({ fiscal_trader_inv_num: null }), logger).traderInvoiceNumber).toBe('INV-000000042')
  })
})
