/**
 * Per-item VAT class on the receipt and in the reports (docs/phase-194,
 * commit 2). A-only output is pinned to what the pre-change build printed
 * (`tests/fixtures/receipt-class-a-golden.json`); mixed output is derived
 * from a real checkout against a recording device.
 */

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildReceiptLayout, isReceiptLayoutQr } from '../src/main/lib/receiptLayout.js'
import type { ReceiptLayoutEntry, ReceiptLayoutOrder } from '../src/main/lib/receiptLayout.js'
import { computeReceiptTotals } from '../src/main/lib/receiptTotals.js'
import {
  buildReconciliationRow,
  computeVatIncluded,
  generateDailySummary,
  generateSalesSummary,
  generateZReport,
  orderVatBase
} from '../src/main/services/reports.js'
import { buildOrdersCsv } from '../src/main/services/reportsExport.js'
import type { OrderRow, RubisDatabase } from '../src/main/services/database.js'
import { GOLDEN_SALES, makeCheckoutHarness, sellCash } from './helpers/vatClassWire.js'

const SETTINGS = {
  taxRate: 0.16,
  tradingName: 'ENJOY',
  legalName: 'Rubis Energy Kenya PLC',
  address: 'Enjoy Westlands, Waiyaki Way, Nairobi',
  phone: '0700 000 000',
  sellerPin: 'P051XXXXXXXX',
  footerMessage: 'Thank you for shopping at Enjoy!'
}

const texts = (entries: ReceiptLayoutEntry[]): string[] =>
  entries.filter((e): e is Extract<ReceiptLayoutEntry, { text: string }> => !isReceiptLayoutQr(e)).map((e) => e.text)

const HS = { hsCode: '0013.12.02', hsName: 'Maize' }
const NO_WARN = { warn: () => {} }

// ---------------------------------------------------------------- receipt

const GOLDEN = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/receipt-class-a-golden.json'), 'utf8')) as {
  layouts: Record<string, unknown>
}

const BASE: ReceiptLayoutOrder = {
  localId: 42,
  createdAt: '2026-09-27T15:58:00.000Z',
  cashierName: 'Mary W.',
  paymentMethod: 'mpesa',
  tenderedAmount: 0,
  changeDue: 0,
  referenceNumber: 'SJK4XYZ123',
  customerPin: 'P000123456Z',
  buyerName: 'ACME TRADERS LTD',
  fiscalInvoiceNumber: 'INV-000000042',
  traderInvNum: 'INV-000000042',
  fiscalQrCode: 'https://itax.kra.go.ke/verify/abc123',
  fiscalizedAt: '27-09-2026 18:58:41',
  fiscalizedAtSource: 'device',
  cuSerial: 'KRAMW0XXXXXXXXXX',
  total: 1650,
  // CHANGED (docs/phase-214). OLD: { A: '1422.41' }, the net amount, because the slip read the device's
  // group amounts as net. NEW: { A: '1650.00' }, the gross amount the device returns (confirmed by the
  // first live filing). The golden layout is unchanged: both inputs print A 16% 1,422.41 227.59 1,650.00.
  vatGroups: { A: '1650.00' },
  items: [
    { title: 'Coca-Cola 500ml', variantTitle: '', quantity: 2, unitPrice: 100, vatClass: 'A' },
    { title: 'Bosch AeroTwin Wipers', variantTitle: 'Pair', quantity: 1, unitPrice: 1450, vatClass: 'A' }
  ]
}

const A_ONLY_SCENARIOS: Record<string, ReceiptLayoutOrder> = {
  filedWithGroups: BASE,
  filedNoGroups: { ...BASE, vatGroups: undefined },
  filedNoClassOnItems: { ...BASE, items: BASE.items.map((item) => ({ ...item, vatClass: undefined })) },
  duplicate: { ...BASE, isDuplicate: true },
  slip: {
    ...BASE,
    fiscalInvoiceNumber: undefined,
    fiscalQrCode: undefined,
    fiscalizedAt: undefined,
    cuSerial: undefined,
    fiscalPending: true,
    paymentMethod: 'cash',
    tenderedAmount: 2000,
    changeDue: 350
  },
  discounted: {
    ...BASE,
    total: 1485,
    // CHANGED (docs/phase-214). OLD: { A: '1280.17' } (net). NEW: { A: '1485.00' } (gross). Same printed rows.
    vatGroups: { A: '1485.00' },
    items: [
      { title: 'Coca-Cola 500ml', variantTitle: '', quantity: 2, unitPrice: 100, vatClass: 'A', discount: { type: 'percent', value: 10 } },
      BASE.items[1]
    ],
    cartDiscount: { type: 'fixed', value: 0 }
  }
}

describe('an all-class-A receipt prints exactly what it printed before', () => {
  const cases = Object.keys(A_ONLY_SCENARIOS).flatMap((name) => [48, 32].map((width) => [name, width] as const))

  it.each(cases)('%s at width %d', (name, width) => {
    const entries = buildReceiptLayout(A_ONLY_SCENARIOS[name], SETTINGS, { width: width as 48 | 32 })
    expect(entries).toEqual(GOLDEN.layouts[`${name}@${width}`])
  })
})

describe('a mixed A + C + E receipt, from a real checkout', () => {
  const DEVICE = { A: '100.00', C: '1.00', E: '2.50' }

  async function mixedReceipt(): Promise<{ lines: string[]; storedGroups: unknown }> {
    const h = makeCheckoutHarness(DEVICE)
    const base = GOLDEN_SALES[0].items[0]
    const result = await sellCash(
      h,
      [
        { ...base, id: 'v1', title: 'Bread', price: 100 },
        { ...base, id: 'v2', title: 'Rice', price: 1, vatClass: 'C', ...HS },
        { ...base, id: 'v3', title: 'Maize flour', price: 2.5, vatClass: 'E', ...HS }
      ],
      103.5
    )
    const order = h.db.getOrder(result.data!.localId)!
    expect(order.fiscal_status).toBe('fiscalized')
    const request = JSON.parse(order.fiscal_request_json!) as { items: Array<{ description: string; quantity: number; unitPrice: number; vatClass: string }> }
    const layoutOrder: ReceiptLayoutOrder = {
      ...BASE,
      total: order.total,
      vatGroups: JSON.parse(order.fiscal_vat_groups_json!),
      items: request.items.map((item) => ({
        title: item.description,
        variantTitle: '',
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        vatClass: item.vatClass
      }))
    }
    return { lines: texts(buildReceiptLayout(layoutOrder, SETTINGS, { width: 48 })), storedGroups: JSON.parse(order.fiscal_vat_groups_json!) }
  }

  it("stores the device's group strings verbatim", async () => {
    expect((await mixedReceipt()).storedGroups).toEqual(DEVICE)
  })

  it('prints each class row with exactly the amount the device returned', async () => {
    const { lines } = await mixedReceipt()
    expect(lines.find((l) => l.startsWith('C '))).toBe('C 0% 1.00 0.00 1.00')
    expect(lines.find((l) => l.startsWith('E '))).toBe('E 0% 2.50 0.00 2.50')
    expect(lines.some((l) => l.startsWith('A ') && l.includes('100.00'))).toBe(true)
  })

  it('takes the VAT line from the class-A line alone', async () => {
    const { lines } = await mixedReceipt()
    const vat = lines.find((l) => /^VAT\s/.test(l))!
    expect(vat).toContain(String(computeVatIncluded(100, 0.16).toFixed(2)))
    expect(vat).not.toContain(computeVatIncluded(103.5, 0.16).toFixed(2))
  })

  it('marks each line with its class and keys only the classes on the receipt', async () => {
    const { lines } = await mixedReceipt()
    expect(lines.filter((l) => /1 x 1\.00 1\.00 C$/.test(l.trim()))).toHaveLength(1)
    expect(lines.filter((l) => /1 x 2\.50 2\.50 E$/.test(l.trim()))).toHaveLength(1)
    const footer = lines.join(' ')
    expect(footer).toContain('A = VAT 16%. C = Zero rated. E = Exempt. Prices include VAT.')
    expect(footer).not.toContain('B = ')
    expect(footer).not.toContain('D = ')
  })
})

describe('a filed sale with no stored device groups builds its table from the lines', () => {
  const mixedNoGroups: ReceiptLayoutOrder = {
    ...BASE,
    vatGroups: undefined,
    total: 103.5,
    items: [
      { title: 'Bread', variantTitle: '', quantity: 1, unitPrice: 100, vatClass: 'A' },
      { title: 'Rice', variantTitle: '', quantity: 1, unitPrice: 1, vatClass: 'c' },
      { title: 'Maize flour', variantTitle: '', quantity: 1, unitPrice: 2.5, vatClass: 'E' }
    ]
  }

  it('shows A, C and E rows with their own amounts, not the whole sale as A', () => {
    const lines = texts(buildReceiptLayout(mixedNoGroups, SETTINGS, { width: 48 }))
    expect(lines.find((l) => l.startsWith('C '))).toBe('C 0% 1.00 0.00 1.00')
    expect(lines.find((l) => l.startsWith('E '))).toBe('E 0% 2.50 0.00 2.50')
    expect(lines.some((l) => l.startsWith('A ') && l.includes('100.00') && !l.includes('103.50'))).toBe(true)
  })
})

describe('computeReceiptTotals', () => {
  const lines = (vatClasses: Array<string | undefined>) =>
    vatClasses.map((vatClass, index) => ({ unitPrice: 100 * (index + 1), quantity: 1, vatClass }))

  it('is the legacy whole-total extraction when every line is class A', () => {
    const totals = computeReceiptTotals({ localId: 1, lineItems: lines(['A', undefined, '']), total: 600 }, 0.16, NO_WARN)
    expect(totals.vatIncluded).toBe(computeVatIncluded(600, 0.16))
  })

  it('takes VAT from the class-A lines only when another class is present', () => {
    const totals = computeReceiptTotals({ localId: 1, lineItems: lines(['A', 'E', 'C']), total: 600 }, 0.16, NO_WARN)
    expect(totals.vatIncluded).toBe(computeVatIncluded(100, 0.16))
  })

  it('has no VAT for an all-exempt receipt', () => {
    const totals = computeReceiptTotals({ localId: 1, lineItems: lines(['E', 'E']), total: 300 }, 0.16, NO_WARN)
    expect(totals.vatIncluded).toBe(0)
  })
})

// ---------------------------------------------------------------- reports

const order = (overrides: Partial<OrderRow>): OrderRow =>
  ({
    local_id: 1,
    shopify_order_id: null,
    total: 10,
    status: 'pending_sync',
    created_at: '2026-08-24T09:00:00.000Z',
    payload_json: '{}',
    staff_id: 1,
    payment_method: 'cash',
    tendered_amount: 10,
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
  }) as OrderRow

const request = (...items: Array<[number, number, string | undefined]>): string =>
  JSON.stringify({
    items: items.map(([unitPrice, quantity, vatClass]) => ({ description: 'x', unitPrice, quantity, taxRate: 0.16, vatClass }))
  })

const MIXED = order({ local_id: 1, total: 103.5, fiscal_request_json: request([100, 1, 'A'], [1, 1, 'C'], [2.5, 1, 'E']) })
const A_ONLY = [
  order({ local_id: 2, total: 33.33, fiscal_request_json: request([33.33, 1, 'A']) }),
  order({ local_id: 3, total: 99.99, fiscal_request_json: request([33.33, 3, undefined]) }),
  order({ local_id: 4, total: 12.34, fiscal_request_json: null }),
  order({ local_id: 5, total: 7.77, fiscal_request_json: '{not json' })
]

function fakeDb(orders: OrderRow[]): RubisDatabase {
  return {
    getShiftById: vi.fn(() => ({
      id: 1, staff_id: 1, clock_in: '2026-08-24T08:00:00.000Z', clock_out: null, status: 'open',
      starting_cash: 0, expected_cash: null, ending_cash: null, discrepancy: null
    })),
    getStaffById: vi.fn(() => ({ id: 1, name: 'Alex' })),
    getOrdersForShift: vi.fn(() => orders),
    getOrdersForDateRange: vi.fn(() => orders),
    getMpesaPaymentsForShift: vi.fn(() => []),
    listShiftCorrections: vi.fn(() => []), // ADDED (docs/phase-224)
    listShiftAdjustments: vi.fn(() => []), // ADDED (docs/phase-232): the Z report reads the shift's adjustments
    listAdjustmentSales: vi.fn(() => []), // ADDED (docs/phase-232)
    getMpesaPaymentsForDateRange: vi.fn(() => [])
  } as unknown as RubisDatabase
}

const RANGE = { startIso: '2026-08-24T00:00:00.000Z', endIso: '2026-08-25T00:00:00.000Z', label: 'Test' }

describe('orderVatBase', () => {
  it('is the whole total for an all-A, class-less, request-less or unreadable order', () => {
    for (const o of A_ONLY) expect(orderVatBase(o)).toBe(o.total)
  })

  it('is the class-A lines for an order that also sold C or E', () => {
    expect(orderVatBase(MIXED)).toBe(100)
  })
})

describe('report VAT counts only what carries VAT', () => {
  it('Z report, daily and sales summaries: a mixed order adds only its class-A amount', () => {
    const db = fakeDb([MIXED])
    expect(generateZReport(db, 1, 0.16).vatIncluded).toBe(computeVatIncluded(100, 0.16))
    expect(generateDailySummary(db, 0.16, RANGE).vatIncluded).toBe(computeVatIncluded(100, 0.16))
    expect(generateSalesSummary(db, 0.16, RANGE).vatIncluded).toBe(computeVatIncluded(100, 0.16))
  })

  it('an all-class-A set gives the figure it always gave, to the cent', () => {
    const db = fakeDb(A_ONLY)
    const revenue = A_ONLY.reduce((sum, o) => sum + o.total, 0)
    expect(generateZReport(db, 1, 0.16).vatIncluded).toBe(computeVatIncluded(revenue, 0.16))
    expect(generateDailySummary(db, 0.16, RANGE).vatIncluded).toBe(computeVatIncluded(revenue, 0.16))
    expect(generateSalesSummary(db, 0.16, RANGE).vatIncluded).toBe(computeVatIncluded(revenue, 0.16))
  })

  it('a mixed set adds the class-A amounts of its mixed orders to the whole totals of the rest', () => {
    const db = fakeDb([MIXED, ...A_ONLY])
    const aOnlyRevenue = A_ONLY.reduce((sum, o) => sum + o.total, 0)
    expect(generateSalesSummary(db, 0.16, RANGE).vatIncluded).toBe(computeVatIncluded(100 + aOnlyRevenue, 0.16))
  })

  it('the orders CSV VAT column follows the same rule per order', () => {
    const csv = buildOrdersCsv(fakeDb([MIXED, A_ONLY[0]]), RANGE, 0.16)
    const rows = csv.replace(/^﻿/, '').trim().split(/\r?\n/)
    const column = rows[0].split(',').indexOf('VAT included')
    expect(column).toBeGreaterThan(-1)
    const vatCells = rows.slice(1).map((row) => row.split(',')[column])
    expect(Number(vatCells[0])).toBe(computeVatIncluded(100, 0.16))
    expect(Number(vatCells[1])).toBe(computeVatIncluded(33.33, 0.16))
  })

  it('a real shift: the Z report reads the stored request, which the shift query now returns', async () => {
    const h = makeCheckoutHarness({ A: '100.00', E: '2.50' })
    const { shiftId } = h.db.openShift(h.staffId, 0)
    const base = GOLDEN_SALES[0].items[0]
    await sellCash(
      h,
      [
        { ...base, id: 'v1', price: 100 },
        { ...base, id: 'v2', price: 2.5, vatClass: 'E', ...HS }
      ],
      102.5
    )
    expect(generateZReport(h.db, shiftId, 0.16).vatIncluded).toBe(computeVatIncluded(100, 0.16))
  })
})

describe('reconciliation per group', () => {
  const filed = (groups: Record<string, string>, requestJson: string | null, total = 103.5): OrderRow =>
    order({
      total,
      fiscal_status: 'fiscalized',
      fiscal_invoice_number: 'KRA-1',
      fiscal_vat_groups_json: JSON.stringify(groups),
      fiscal_request_json: requestJson
    })

  it('matches a mixed sale whose groups are where its lines say', () => {
    const row = buildReconciliationRow(filed({ A: '100.00', C: '1.00', E: '2.50' }, MIXED.fiscal_request_json), console)
    expect(row.status).toBe('matched')
    expect(row.groupMismatch).toBeNull()
    expect(row.expectedByGroup).toEqual({ A: 100, B: 0, C: 1, D: 0, E: 2.5 })
  })

  it('is a mismatch when the totals agree but the device put the E amount in group C', () => {
    const row = buildReconciliationRow(filed({ A: '100.00', C: '3.50' }, MIXED.fiscal_request_json), console)
    expect(row.difference).toBe(0)
    expect(row.status).toBe('mismatch')
    expect(row.groupMismatch).toMatch(/group C.*group E|group E.*group C/)
  })

  it('leaves an all-A or request-less sale to the total check alone', () => {
    const aOnly = buildReconciliationRow(filed({ A: '33.33' }, A_ONLY[0].fiscal_request_json, 33.33), console)
    expect(aOnly.status).toBe('matched')
    expect(aOnly.groupMismatch).toBeNull()
    const noRequest = buildReconciliationRow(filed({ A: '12.34' }, null, 12.34), console)
    expect(noRequest.status).toBe('matched')
    expect(noRequest.expectedByGroup).toBeNull()
  })
})
