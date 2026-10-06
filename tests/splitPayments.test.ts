/**
 * Split payments (docs/phase-252). The cashier records the payments one by one; Complete sale sends one checkout with the
 * whole list; the main process checks it and writes the order, every payment, every `mpesa_payments` row, the trader
 * number, the Shopify queue row and the fiscal row in one transaction, then makes one fiscal call. Anything refused writes
 * nothing. Off by default (`split_payments_enabled`). Real `:memory:` SQLite (a real file for the migration), the real
 * `runCheckout`, the real readers.
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database as SqliteConnection } from 'better-sqlite3'
import { RubisDatabase } from '../src/main/services/database.js'
import type { CheckoutPaymentLeg, CheckoutRequest } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import {
  runCheckout,
  checkSplitPayments,
  SPLIT_ABOVE_DUE_MESSAGE,
  SPLIT_CASH_NOT_LAST_MESSAGE,
  SPLIT_NOT_ADDING_UP_MESSAGE,
  SPLIT_PAYMENTS_OFF_MESSAGE,
  SPLIT_SAME_CODE_MESSAGE,
  SPLIT_TOO_MANY_MESSAGE,
  SPLIT_TWO_CASH_MESSAGE,
  UNCONFIRMED_MPESA_MESSAGE
} from '../src/main/services/checkout.js'
import type { CheckoutDb, RunCheckoutDeps } from '../src/main/services/checkout.js'
import type { FiscalSubmitOutcome } from '../src/main/services/integrations/etims.js'
import { checkoutRequestSchema, validate } from '../src/main/lib/ipcValidator.js'
import { describePayment } from '../src/main/lib/paymentLegs.js'
import {
  generateDailySummary,
  generateSalesSummary,
  generateShiftEndOfDay,
  generateZReport
} from '../src/main/services/reports.js'
import { buildOrdersCsv } from '../src/main/services/reportsExport.js'
import { buildOrderInput } from '../src/main/services/orders.js'
import { buildReceiptLayout, isReceiptLayoutQr } from '../src/main/lib/receiptLayout.js'
import type { ReceiptLayoutEntry, ReceiptLayoutOrder } from '../src/main/lib/receiptLayout.js'
import { buildEnjoySlip } from '../src/main/lib/enjoySlip.js'
import type { OfflineOrderPayload } from '../src/main/services/shopify-types.js'

const KEY = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'
const LOCATION = { locationId: 'gid://shopify/Location/77557989479', locationName: 'Rubis Kisumu' }
const EVERYTHING = { startIso: '2000-01-01T00:00:00.000Z', endIso: '2100-01-01T00:00:00.000Z', label: 'all' }
const STK_RECEIPT = 'QDF73HK9LM'
const MANUAL_CODE = 'QAB45GH6IJ'

const conn = (db: RubisDatabase): SqliteConnection => (db as unknown as { conn: SqliteConnection }).conn

const filed: FiscalSubmitOutcome = { ok: true, data: { invoiceNumber: 'KRA-0001', qrCode: 'qr', fiscalizedAt: '2026-10-06T10:00:00.000Z' } }

/** Every table's row count, and the trader sequence: "nothing written in any table" is these, unchanged. */
function snapshot(db: RubisDatabase): Record<string, unknown> {
  const c = conn(db)
  const tables = c.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'sqlite_sequence' ORDER BY name").all() as Array<{ name: string }>
  return {
    ...Object.fromEntries(tables.map(({ name }) => [name, (c.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n])),
    traderSeq: db.getSetting('last_trader_seq')
  }
}

function setup(): { db: RubisDatabase; staffId: number } {
  const db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  const { staffId } = db.createStaff({ name: 'Alex', pinHash: hashPin('1234'), role: 'admin' })
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
    splitPaymentsEnabled: true,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    debugLogging: false,
    ...overrides
  }
}

/** A Daraja STK push this till saw confirmed: the happy path, as the gate reads it. */
function confirmStk(db: RubisDatabase, receipt: string, amount: number): void {
  db.logMpesaTransaction({ checkoutRequestId: `ws_CO_${receipt}`, merchantRequestId: 'm', phoneNumber: '712345678', amount, status: 'pending' })
  db.updateMpesaTransactionStatus(`ws_CO_${receipt}`, 'success', receipt)
}

const stk = (amount: number, referenceNumber = STK_RECEIPT): CheckoutPaymentLeg => ({ method: 'mpesa', amount, referenceNumber })
const manual = (amount: number, code = MANUAL_CODE): CheckoutPaymentLeg => ({
  method: 'mpesa',
  amount,
  referenceNumber: code,
  manualApproval: { acknowledgedUnverified: true }
})
const card = (amount: number, reference = 'PDQ123'): CheckoutPaymentLeg => ({ method: 'card', amount, cardApproval: { reference, confirmRecorded: true } })
const cash = (amount: number, tendered: number): CheckoutPaymentLeg => ({ method: 'cash', amount, tendered })

function splitSale(staffId: number, total: number, payments: CheckoutPaymentLeg[], overrides: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    items: [{ id: 'gid://shopify/ProductVariant/201', productId: 'gid://shopify/Product/101', title: 'Diesel', variantTitle: '', price: total, quantity: 1, image: null }],
    total,
    staffId,
    paymentMethod: 'split',
    tenderedAmount: 0,
    changeDue: 0,
    payments,
    checkoutKey: KEY,
    ...LOCATION,
    ...overrides
  }
}

function paymentRows(db: RubisDatabase): unknown[] {
  return conn(db)
    .prepare('SELECT order_local_id, leg_no, method, mpesa_mode, amount, reference, tendered, change_due FROM order_payments ORDER BY id')
    .all()
}

describe('the example: 1,500 paid 500 by STK and 1,000 by a typed M-Pesa code', () => {
  it('gives one order, two payments, two M-Pesa rows of 500 and 1,000, one trader number and one fiscal call', async () => {
    const { db, staffId } = setup()
    confirmStk(db, STK_RECEIPT, 500)
    const d = deps(db)

    const result = await runCheckout(d, splitSale(staffId, 1500, [stk(500), manual(1000)]))

    expect(result.success).toBe(true)
    const order = db.getOrder(result.data!.localId)!
    expect(db.getOrders()).toHaveLength(1)
    expect(order.payment_method).toBe('split')
    expect(paymentRows(db)).toEqual([
      { order_local_id: order.local_id, leg_no: 1, method: 'mpesa', mpesa_mode: 'daraja', amount: 500, reference: STK_RECEIPT, tendered: null, change_due: null },
      { order_local_id: order.local_id, leg_no: 2, method: 'mpesa', mpesa_mode: 'manual', amount: 1000, reference: MANUAL_CODE, tendered: null, change_due: null }
    ])
    expect(db.listMpesaPayments().map((p) => [p.mode, p.verification_status, p.reference, p.amount]).reverse()).toEqual([
      ['daraja', 'confirmed', STK_RECEIPT, 500],
      ['manual', 'manual_unverified', MANUAL_CODE, 1000]
    ])
    expect(order.fiscal_trader_inv_num).toBeTruthy()
    expect(d.fiscalizationProvider.submitInvoice).toHaveBeenCalledTimes(1)
    expect(db.paymentLegsFor([order.local_id]).get(order.local_id)).toEqual([
      { orderId: order.local_id, method: 'mpesa', amount: 500, voided: false },
      { orderId: order.local_id, method: 'mpesa', amount: 1000, voided: false }
    ])
  })
})

describe('change is given on the cash payment only', () => {
  it('500 M-Pesa by code, then 1,000 cash with 1,200 handed over: change 200, on the cash payment', async () => {
    const { db, staffId } = setup()

    const result = await runCheckout(deps(db), splitSale(staffId, 1500, [manual(500), cash(1000, 1200)]))

    expect(result.success).toBe(true)
    const order = db.getOrder(result.data!.localId)!
    expect(paymentRows(db)).toEqual([
      { order_local_id: order.local_id, leg_no: 1, method: 'mpesa', mpesa_mode: 'manual', amount: 500, reference: MANUAL_CODE, tendered: null, change_due: null },
      { order_local_id: order.local_id, leg_no: 2, method: 'cash', mpesa_mode: null, amount: 1000, reference: null, tendered: 1200, change_due: 200 }
    ])
    expect([order.tendered_amount, order.change_due]).toEqual([1700, 200])
  })

  it('500 card, then 1,000 cash handed over exactly', async () => {
    const { db, staffId } = setup()

    const result = await runCheckout(deps(db), splitSale(staffId, 1500, [card(500), cash(1000, 1000)]))

    expect(result.success).toBe(true)
    expect(paymentRows(db)).toMatchObject([
      { leg_no: 1, method: 'card', amount: 500, reference: 'PDQ123', change_due: null },
      { leg_no: 2, method: 'cash', amount: 1000, tendered: 1000, change_due: 0 }
    ])
  })

  it('the rules alone: the change is the cash handed over less the cash due, never from a non-cash payment', () => {
    expect(checkSplitPayments(1500, [manual(500), cash(1000, 1200)])).toEqual({ change: 200 })
    expect(checkSplitPayments(1500, [card(500), manual(1000)])).toEqual({ change: 0 })
  })
})

describe('refused, and nothing is written in any table', () => {
  const CASES: Array<[string, number, CheckoutPaymentLeg[], string]> = [
    ['the payments do not add up', 1500, [manual(500), card(900)], SPLIT_NOT_ADDING_UP_MESSAGE],
    ['an M-Pesa or card payment above what is still due', 1500, [manual(500), card(1100)], SPLIT_ABOVE_DUE_MESSAGE],
    ['two cash payments', 1500, [cash(500, 500), cash(1000, 1000)], SPLIT_TWO_CASH_MESSAGE],
    ['cash not last', 1500, [cash(500, 500), card(1000)], SPLIT_CASH_NOT_LAST_MESSAGE],
    ['five payments', 1500, [card(300, 'A1'), card(300, 'A2'), card(300, 'A3'), card(300, 'A4'), card(300, 'A5')], SPLIT_TOO_MANY_MESSAGE],
    ['the same M-Pesa code on two payments', 1500, [manual(500), manual(1000)], SPLIT_SAME_CODE_MESSAGE],
    ['an M-Pesa payment its gate refuses (an STK reference never confirmed)', 1500, [stk(500, 'QNEVERPAID'), cash(1000, 1000)], UNCONFIRMED_MPESA_MESSAGE]
  ]

  it.each(CASES)('%s', async (_name, total, payments, message) => {
    const { db, staffId } = setup()
    const before = snapshot(db)
    const d = deps(db)

    const result = await runCheckout(d, splitSale(staffId, total, payments))

    expect(result).toEqual({ success: false, error: message })
    expect(snapshot(db)).toEqual(before)
    expect(d.fiscalizationProvider.submitInvoice).not.toHaveBeenCalled()
  })

  it('a split sent while the setting is off', async () => {
    const { db, staffId } = setup()
    const before = snapshot(db)
    const d = deps(db, { splitPaymentsEnabled: false })

    const result = await runCheckout(d, splitSale(staffId, 1500, [manual(500), cash(1000, 1000)]))

    expect(result).toEqual({ success: false, error: SPLIT_PAYMENTS_OFF_MESSAGE })
    expect(snapshot(db)).toEqual(before)
  })

  it('a split sent with the setting left out of the dependencies (off by default)', async () => {
    const { db, staffId } = setup()
    const { splitPaymentsEnabled: _omitted, ...rest } = deps(db)

    const result = await runCheckout(rest, splitSale(staffId, 1500, [manual(500), cash(1000, 1000)]))

    expect(result).toEqual({ success: false, error: SPLIT_PAYMENTS_OFF_MESSAGE })
    expect(db.getOrders()).toHaveLength(0)
  })

  it('a code already recorded on an earlier sale', async () => {
    const { db, staffId } = setup()
    await runCheckout(deps(db), splitSale(staffId, 1500, [manual(500), cash(1000, 1000)]))
    const before = snapshot(db)

    const again = await runCheckout(deps(db), splitSale(staffId, 900, [manual(400), cash(500, 500)], { checkoutKey: '9e8d7c6b-5a49-4382-a716-f5e4d3c2b1a0' }))

    expect(again.success).toBe(false)
    expect(snapshot(db)).toEqual(before)
  })
})

describe('a repeat submit with the same checkout key', () => {
  it('gives one order, one set of payments, one trader number and one fiscal call', async () => {
    const { db, staffId } = setup()
    confirmStk(db, STK_RECEIPT, 500)
    const d = deps(db)
    const request = splitSale(staffId, 1500, [stk(500), manual(1000)])

    const first = await runCheckout(d, request)
    const afterFirst = snapshot(db)
    const second = await runCheckout(d, request)

    expect(second).toEqual({ success: true, data: expect.objectContaining({ localId: first.data!.localId }) })
    expect(snapshot(db)).toEqual(afterFirst)
    expect(paymentRows(db)).toHaveLength(2)
    expect(db.listMpesaPayments()).toHaveLength(2)
    expect(d.fiscalizationProvider.submitInvoice).toHaveBeenCalledTimes(1)
  })
})

describe('a sale paid one way', () => {
  it('writes one payment, its whole total, and a payload with no payments list (so its receipt and Shopify note are as before)', async () => {
    const { db, staffId } = setup()

    const result = await runCheckout(
      deps(db, { splitPaymentsEnabled: false }),
      splitSale(staffId, 120, [], { paymentMethod: 'cash', tenderedAmount: 200, changeDue: 80, payments: undefined })
    )

    const order = db.getOrder(result.data!.localId)!
    expect(order.payment_method).toBe('cash')
    expect(paymentRows(db)).toEqual([
      { order_local_id: order.local_id, leg_no: 1, method: 'cash', mpesa_mode: null, amount: 120, reference: null, tendered: 200, change_due: 80 }
    ])
    expect(JSON.parse(order.payload_json)).not.toHaveProperty('payments')
  })

  it('a manual M-Pesa sale records the whole total as before, with its mode on the payment', async () => {
    const { db, staffId } = setup()

    const result = await runCheckout(
      deps(db),
      splitSale(staffId, 120, [], { paymentMethod: 'mpesa', referenceNumber: MANUAL_CODE, manualApproval: { acknowledgedUnverified: true }, payments: undefined })
    )

    expect(result.success).toBe(true)
    expect(db.listMpesaPayments().map((p) => p.amount)).toEqual([120])
    expect(paymentRows(db)).toMatchObject([{ method: 'mpesa', mpesa_mode: 'manual', amount: 120, reference: MANUAL_CODE }])
  })

  it('payments sent without saying split are refused', async () => {
    const { db, staffId } = setup()

    const result = await runCheckout(deps(db), splitSale(staffId, 1500, [manual(500), cash(1000, 1000)], { paymentMethod: 'cash' }))

    expect(result.success).toBe(false)
    expect(db.getOrders()).toHaveLength(0)
  })
})

describe('every reader of a split sale gives the sum of its payments', () => {
  /** Shifts 1 and 2 closed on 5 Oct (one window), shift 3 open on 6 Oct; the same sales as the 250 reader tests. */
  function seedShifts(): { db: RubisDatabase; admin: number } {
    const { db, staffId: admin } = setup()
    const c = conn(db)
    const shift = c.prepare(
      `INSERT INTO shifts (staff_id, clock_in, clock_out, starting_cash, ending_cash, status, shift_type, mpesa_opening_balance, mpesa_closing_balance)
       VALUES (?, ?, ?, ?, ?, ?, 'day', ?, ?)`
    )
    shift.run(admin, '2026-10-05T04:00:00.000Z', '2026-10-05T10:00:00.000Z', 100, 400, 'closed', 50, 400)
    shift.run(admin, '2026-10-05T10:05:00.000Z', '2026-10-05T11:00:00.000Z', 0, 50, 'closed', null, null)
    shift.run(admin, '2026-10-06T04:00:00.000Z', null, 20, null, 'open', 10, null)
    const sale = c.prepare('INSERT INTO orders (total, status, created_at, payment_method, shift_id, staff_id) VALUES (?, ?, ?, ?, ?, ?)')
    sale.run(120.5, 'pending_sync', '2026-10-05T05:00:00.000Z', 'cash', 1, admin)
    sale.run(80, 'pending_sync', '2026-10-05T05:30:00.000Z', 'cash', 1, admin)
    sale.run(300.25, 'pending_sync', '2026-10-05T06:00:00.000Z', 'mpesa', 1, admin)
    sale.run(75, 'pending_sync', '2026-10-05T07:00:00.000Z', 'card', 1, admin)
    sale.run(40, 'pending_sync', '2026-10-05T10:10:00.000Z', 'cash', 2, admin)
    sale.run(60, 'pending_sync', '2026-10-05T10:20:00.000Z', 'mpesa', 2, admin)
    sale.run(25, 'pending_sync', '2026-10-05T10:30:00.000Z', 'card', 2, admin)
    sale.run(10, 'pending_sync', '2026-10-06T04:30:00.000Z', 'cash', 3, admin)
    sale.run(20, 'pending_sync', '2026-10-06T05:00:00.000Z', 'mpesa', 3, admin)
    return { db, admin }
  }

  /** 2,000 into the open shift #3: 1,000 by a typed M-Pesa code, 300 by card, 700 cash with 1,000 handed over. */
  async function splitIntoShift3(db: RubisDatabase, admin: number): Promise<number> {
    const result = await runCheckout(deps(db), splitSale(admin, 2000, [manual(1000), card(300, 'PDQ9'), cash(700, 1000)]))
    expect(result.success).toBe(true)
    return result.data!.localId
  }

  const totals = (t: { cash: number; mpesa: number; card: number }): number[] => [t.cash, t.mpesa, t.card]

  it('the Z report, the End of Day, the sales summary and the daily summary', async () => {
    const { db, admin } = seedShifts()
    await splitIntoShift3(db, admin)

    expect(totals(generateZReport(db, 3, 0.16).totalsByMethod)).toEqual([710, 1020, 300])
    expect(totals(generateShiftEndOfDay(db, 3).totalsByMethod)).toEqual([710, 1020, 300])
    expect(totals(generateSalesSummary(db, 0.16, EVERYTHING).totalsByMethod)).toEqual([950.5, 1380.25, 400])
    expect(totals(generateDailySummary(db, 0.16, EVERYTHING).totalsByMethod)).toEqual([950.5, 1380.25, 400])
  })

  it('closing the shift: expected cash, M-Pesa and card', async () => {
    const { db, admin } = seedShifts()
    await splitIntoShift3(db, admin)

    const closed = db.closeShift(3, 730, 1030, 300)

    expect([closed.expectedCash, closed.mpesaExpected, closed.cardExpected]).toEqual([730, 1030, 300])
    expect([closed.discrepancy, closed.mpesaDifference, closed.cardDifference]).toEqual([0, 0, 0])
  })

  it('the per-shift approval lists the manual payment (1,000), not the whole sale', async () => {
    const { db, admin } = seedShifts()
    await splitIntoShift3(db, admin)

    expect(generateShiftEndOfDay(db, 3).manualEntries.map((entry) => entry.amount)).toEqual([1000])
  })

  it('moving the sale: the preview, the ledger and the Z report after the move', async () => {
    const { db, admin } = seedShifts()
    const id = await splitIntoShift3(db, admin)

    const preview = db.previewSaleMove(id, 2, true)
    expect(preview.paymentMethod).toBe('split: mpesa 1000.00 + card 300.00 + cash 700.00')
    expect(preview.to?.expectedCash).toBe(740)

    db.reassignSale({ orderId: id, toShiftId: 2, managerId: admin, reason: 'Belongs to the earlier shift', acknowledgeDifferentWindow: true, override: true })
    const into = db.listShiftAdjustments(2).find((row) => row.kind === 'reassign_in')!
    expect([into.cash_total, into.mpesa_total, into.card_total]).toEqual([700, 1000, 300])
    expect(totals(generateZReport(db, 2, 0.16).totalsByMethod)).toEqual([740, 1060, 325])
  })

  it('merging the shift that holds the sale', async () => {
    const { db, admin } = seedShifts()
    const id = await splitIntoShift3(db, admin)
    db.reassignSale({ orderId: id, toShiftId: 2, managerId: admin, reason: 'Belongs to the earlier shift', acknowledgeDifferentWindow: true, override: true })

    const merged = db.previewShiftMerge(2, 1, true)

    // Shift 1: 100 + 200.50 cash; shift 2: 40 + 700. M-Pesa: 50 + 300.25 + 60 + 1,000.
    expect(merged.into?.expectedCash).toBe(1040.5)
    expect(merged.into?.mpesaExpected).toBe(1410.25)
  })

  it('the orders CSV: split with the payments, and both M-Pesa columns', async () => {
    const { db, admin } = seedShifts()
    await splitIntoShift3(db, admin)

    const rows = buildOrdersCsv(db, EVERYTHING, 0.16).split('\n')
    const splitRow = rows.find((row) => row.includes('split:'))!.split(',')
    expect(splitRow.slice(5, 8)).toEqual(['split: mpesa 1000.00 + card 300.00 + cash 700.00', MANUAL_CODE, 'manual'])
    expect(rows.filter((row) => row.split(',')[5] === 'cash')).toHaveLength(4)
  })
})

describe('the displays', () => {
  it('describePayment: the method alone for one payment, as before; split with each payment otherwise', () => {
    expect(describePayment([{ method: 'cash', amount: 120 }])).toBe('cash')
    expect(describePayment([{ method: null, amount: 120 }])).toBe('')
    expect(describePayment([])).toBe('')
    expect(describePayment([{ method: 'mpesa', amount: 500 }, { method: 'cash', amount: 1000 }])).toBe('split: mpesa 500.00 + cash 1000.00')
  })
})

describe('the Shopify order: one paid order, the payments in the note and as tags, no transactions', () => {
  it('a split sale', async () => {
    const { db, staffId } = setup()
    confirmStk(db, STK_RECEIPT, 500)
    const result = await runCheckout(deps(db), splitSale(staffId, 1500, [stk(500), manual(500), cash(500, 600)]))
    const payload = JSON.parse(db.getOrder(result.data!.localId)!.payload_json) as OfflineOrderPayload

    const { order } = buildOrderInput(payload)

    expect(order.financialStatus).toBe('PAID')
    expect(order).not.toHaveProperty('transactions')
    expect(order.tags).toEqual(['location:rubis-kisumu', 'pay:mpesa', 'pay:cash'])
    expect(order.note).toContain(
      `payment: split: mpesa 500.00 (ref ${STK_RECEIPT}) + mpesa 500.00 (ref ${MANUAL_CODE}) + cash 500.00 (tendered 600.00, change 100.00)`
    )
  })

  it('a sale paid one way keeps its note and tags', () => {
    const payload: OfflineOrderPayload = {
      clientOrderUuid: 'u-1',
      total: 120,
      lineItems: [],
      createdAt: '2026-10-06T10:00:00.000Z',
      staffId: 1,
      staffName: 'Alex',
      paymentMethod: 'mpesa',
      tenderedAmount: 120,
      changeDue: 0,
      referenceNumber: MANUAL_CODE,
      ...LOCATION
    }

    const { order } = buildOrderInput(payload)

    expect(order.tags).toEqual(['location:rubis-kisumu'])
    expect(order.note).toContain(`payment: mpesa (ref ${MANUAL_CODE})`)
  })
})

describe('the receipt: one receipt, two lines per M-Pesa or card payment, Tendered and Change only under cash', () => {
  const textLines = (entries: ReceiptLayoutEntry[]): string[] =>
    entries.filter((entry) => !isReceiptLayoutQr(entry)).map((entry) => (entry as { text: string }).text)
  const order: ReceiptLayoutOrder = {
    localId: 7,
    createdAt: new Date(2026, 9, 6, 18, 0, 0).toISOString(),
    cashierName: 'Alex',
    paymentMethod: 'split',
    tenderedAmount: 1600,
    changeDue: 100,
    payments: [
      { method: 'mpesa', amount: 500, reference: STK_RECEIPT, mpesaMode: 'daraja' },
      { method: 'card', amount: 500, reference: 'PDQ123' },
      { method: 'cash', amount: 500, tendered: 600, changeDue: 100 }
    ],
    total: 1500,
    items: [{ title: 'Diesel', variantTitle: '', quantity: 1, unitPrice: 1500, vatClass: 'A' }]
  }
  const settings = { taxRate: 0.16, tradingName: 'ENJOY', legalName: 'Rubis', address: 'Kisumu', phone: '0700', sellerPin: 'P051', footerMessage: 'Thanks' }

  it.each([48, 42, 32] as const)('at %i columns, every line fits and each payment prints its own block', (width) => {
    const lines = textLines(buildReceiptLayout(order, settings, { width }))
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(width)

    const from = lines.findIndex((line) => line.startsWith('PAID BY M-PESA'))
    expect(lines.slice(from, from + 7).map((line) => line.replace(/\s+/g, ' '))).toEqual([
      'PAID BY M-PESA 500.00',
      `M-Pesa ref: ${STK_RECEIPT}`,
      'PAID BY CARD 500.00',
      'Ref: PDQ123',
      'PAID BY CASH 500.00',
      'Tendered: 600.00',
      'Change: 100.00'
    ])
    expect(lines.filter((line) => line.startsWith('Tendered:'))).toHaveLength(1)
  })

  it('the Enjoy slip lists each payment, and the change under cash', () => {
    const lines = textLines(buildEnjoySlip(order, {}, { width: 48, kraNote: 'none' })).map((line) => line.replace(/\s+/g, ' '))
    expect(lines).toEqual(expect.arrayContaining(['Paid by M-Pesa KSh 500.00', 'Paid by card KSh 500.00', 'Paid by cash KSh 600.00', 'Change KSh 100.00']))
  })
})

describe('the IPC schema', () => {
  it('takes split with its payments, each manual code and card entry in the same shape as a sale paid one way', () => {
    const result = validate(checkoutRequestSchema, {
      items: [{ id: 'v', productId: 'p', title: 'Diesel', variantTitle: '', price: 1500, quantity: 1, image: null }],
      checkoutKey: KEY,
      total: 1500,
      staffId: 1,
      paymentMethod: 'split',
      tenderedAmount: 1500,
      changeDue: 0,
      payments: [
        { method: 'mpesa', amount: 500, referenceNumber: STK_RECEIPT },
        { method: 'mpesa', amount: 500, mpesaManual: { code: MANUAL_CODE, confirmUnverified: true } },
        { method: 'card', amount: 500, cardManual: { reference: 'PDQ123', confirmRecorded: true } }
      ]
    })
    expect(result.success).toBe(true)
  })
})

describe('the table', () => {
  it('migration run twice changes nothing, and the payments are append-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rubis-252-'))
    try {
      const path = join(dir, 'rubis-pos.db')
      const first = new RubisDatabase({ dbPath: path })
      first.init()
      const schema = (db: RubisDatabase): unknown =>
        conn(db).prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE '%order_payments%' ORDER BY name").all()
      const once = schema(first)
      conn(first).close()

      const second = new RubisDatabase({ dbPath: path })
      second.init()
      expect(schema(second)).toEqual(once)
      expect((once as unknown[]).length).toBe(4)

      conn(second).prepare("INSERT INTO orders (total, status, created_at) VALUES (10, 'pending_sync', '2026-10-06T10:00:00.000Z')").run()
      conn(second).prepare("INSERT INTO order_payments (order_local_id, leg_no, method, amount, created_at) VALUES (1, 1, 'cash', 10, 'x')").run()
      expect(() => conn(second).prepare('UPDATE order_payments SET amount = 5').run()).toThrow(/append-only/)
      expect(() => conn(second).prepare('DELETE FROM order_payments').run()).toThrow(/append-only/)
      expect(() =>
        conn(second).prepare("INSERT INTO order_payments (order_local_id, leg_no, method, amount, created_at) VALUES (1, 1, 'card', 10, 'x')").run()
      ).toThrow(/UNIQUE/)
      conn(second).close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
