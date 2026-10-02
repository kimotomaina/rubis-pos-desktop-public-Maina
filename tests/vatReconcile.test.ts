/**
 * VAT table reconciliation (docs/phase-198-1): the gross-to-net helpers, the
 * fallback table built from the lines, the reconcile of stored device groups
 * against the till's VAT, what the slip prints when they disagree, the mock's
 * groups, and the Needs Attention list "VAT figures to reconcile".
 */

import { describe, it, expect, vi } from 'vitest'
import { grossToNet, netGroupTotals } from '../src/main/lib/vatClass.js'
import { reconcileVatGroups, VAT_RECONCILE_TOLERANCE } from '../src/main/lib/vatReconcile.js'
import { buildReceiptLayout, isReceiptLayoutQr } from '../src/main/lib/receiptLayout.js'
import type { ReceiptLayoutEntry, ReceiptLayoutOrder } from '../src/main/lib/receiptLayout.js'
import { findVatMismatches } from '../src/main/services/vat-reconcile.js'
import { MockFiscalizationProvider } from '../src/main/services/integrations/mock-etims-provider.js'
import type { FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'
import { freshDb, seedSale } from './helpers/slipOrders.js'

const SETTINGS = { taxRate: 0.16, tradingName: 'ENJOY' }

const sale = (amount: number, vatGroups?: ReceiptLayoutOrder['vatGroups'], vatClass = 'A'): ReceiptLayoutOrder => ({
  localId: 7,
  createdAt: '2026-10-02T10:00:00.000Z',
  cashierName: 'Mary',
  paymentMethod: 'cash',
  tenderedAmount: amount,
  changeDue: 0,
  fiscalInvoiceNumber: '0123456789012345678',
  traderInvNum: 'INV-000000007',
  total: amount,
  vatGroups,
  items: [{ title: 'Mug', variantTitle: '', quantity: 1, unitPrice: amount, vatClass }]
})

const lines = (entries: ReceiptLayoutEntry[]): string[] =>
  entries.map((entry) => (isReceiptLayoutQr(entry) ? '[qr]' : entry.text))

const warnLogger = () => ({ warn: vi.fn() })

describe('grossToNet and netGroupTotals', () => {
  it('turns a VAT-inclusive class A amount into net: x 100/116, two places', () => {
    expect(grossToNet('A', 1650)).toBe(1422.41)
    expect(grossToNet('A', 60)).toBe(51.72)
    expect(grossToNet('A', 116)).toBe(100)
  })

  it('turns a class B amount into net: x 100/108', () => {
    expect(grossToNet('B', 108)).toBe(100)
    expect(grossToNet('B', 100)).toBe(92.59)
  })

  it('leaves C, D and E unchanged', () => {
    expect(grossToNet('C', 2.5)).toBe(2.5)
    expect(grossToNet('D', 7.77)).toBe(7.77)
    expect(grossToNet('E', 1)).toBe(1)
  })

  it('works per class over the lines, with a blank class as A', () => {
    const totals = netGroupTotals([
      { unitPrice: 100, quantity: 1, vatClass: 'A' },
      { unitPrice: 16, quantity: 1, vatClass: '' },
      { unitPrice: 108, quantity: 1, vatClass: 'B' },
      { unitPrice: 1, quantity: 1, vatClass: 'c' },
      { unitPrice: 2.5, quantity: 1, vatClass: 'E' }
    ])

    expect(totals).toEqual({ A: 100, B: 100, C: 1, D: 0, E: 2.5 })
  })
})

describe('reconcileVatGroups', () => {
  it('agrees when the groups, read as net, give the till VAT', () => {
    const result = reconcileVatGroups({ A: '51.72' }, { vatIncluded: 8.28 })

    expect(result).toEqual({ consistent: true, diff: 0, groupVat: 8.28, tillVat: 8.28 })
  })

  it('disagrees when the device holds the gross amount: VAT 9.60 against the till 8.28', () => {
    const result = reconcileVatGroups({ A: '60.00' }, { vatIncluded: 8.28 })

    expect(result.consistent).toBe(false)
    expect(result.diff).toBe(1.32)
    expect(result.groupVat).toBe(9.6)
    expect(result.tillVat).toBe(8.28)
  })

  it('tolerates a difference of 0.05 and no more', () => {
    expect(VAT_RECONCILE_TOLERANCE).toBe(0.05)
    expect(reconcileVatGroups({ A: '51.72' }, { vatIncluded: 8.33 }).consistent).toBe(true)
    expect(reconcileVatGroups({ A: '51.72' }, { vatIncluded: 8.34 }).consistent).toBe(false)
    expect(reconcileVatGroups({ A: '51.72' }, { vatIncluded: 8.23 }).consistent).toBe(true)
    expect(reconcileVatGroups({ A: '51.72' }, { vatIncluded: 8.22 }).consistent).toBe(false)
  })

  it('counts C and E as no VAT, and B at 8%', () => {
    expect(reconcileVatGroups({ A: '86.21', C: '1.00', E: '2.50' }, { vatIncluded: 13.79 }).consistent).toBe(true)
    expect(reconcileVatGroups({ B: '100.00' }, { vatIncluded: 8 }).consistent).toBe(true)
  })

  it('cannot compare a sale with a class D amount, and says nothing against it', () => {
    const result = reconcileVatGroups({ A: '51.72', D: '500.00' }, { vatIncluded: 99 })

    expect(result.consistent).toBe(true)
    expect(result.diff).toBe(0)
  })

  it('reads a group that is not a number as 0', () => {
    expect(reconcileVatGroups({ A: 'abc' }, { vatIncluded: 0 }).consistent).toBe(true)
  })
})

describe('the VAT table on the slip', () => {
  it('prints the table with no extra line when the device groups agree with the till', () => {
    const logger = warnLogger()

    const out = lines(buildReceiptLayout(sale(60, { A: '51.72' }), SETTINGS, { width: 48, logger }))

    expect(out).toContain('A 16% 51.72 8.28 60.00')
    expect(out.some((l) => l.startsWith('Device figures'))).toBe(false)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('prints the device figures and one line under them when they disagree, and logs at warn', () => {
    const logger = warnLogger()

    const out = lines(buildReceiptLayout(sale(60, { A: '60.00' }), SETTINGS, { width: 48, logger }))

    const row = out.indexOf('A 16% 60.00 9.60 69.60')
    expect(row).toBeGreaterThan(-1)
    expect(out[row + 1]).toBe('Device figures. Till VAT: 8.28.')
    expect(out[row + 2]).toBe('-'.repeat(48))
    expect(out).toContain('VAT                                         8.28')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(String(logger.warn.mock.calls[0][0])).toContain('Order 7')
  })

  it('wraps the note on a narrow printer without hiding either figure', () => {
    const out = lines(buildReceiptLayout(sale(60, { A: '60.00' }), SETTINGS, { width: 32, logger: warnLogger() }))

    expect(out.join(' ')).toContain('Device figures. Till VAT: 8.28.')
    expect(out).toContain('A 16% 60.00 9.60 69.60')
  })

  it('prints no note for a table built from the lines, even when it would not reconcile', () => {
    const logger = warnLogger()
    const discounted: ReceiptLayoutOrder = {
      ...sale(1485),
      items: [{ title: 'Mug', variantTitle: '', quantity: 1, unitPrice: 1650, vatClass: 'A', discount: { type: 'percent', value: 10 } }]
    }

    const out = lines(buildReceiptLayout(discounted, SETTINGS, { width: 48, logger }))

    expect(out.some((l) => l.startsWith('Device figures'))).toBe(false)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('builds the fallback table from net amounts: a 1,650.00 sale prints 1,422.41 + 227.59 = 1,650.00', () => {
    const out = lines(buildReceiptLayout(sale(1650), SETTINGS, { width: 48, logger: warnLogger() }))

    expect(out).toContain('A 16% 1,422.41 227.59 1,650.00')
  })

  it('builds the fallback per class for a mixed sale, and its VAT agrees with the till', () => {
    const mixed: ReceiptLayoutOrder = {
      ...sale(103.5),
      items: [
        { title: 'Bread', variantTitle: '', quantity: 1, unitPrice: 100, vatClass: 'A' },
        { title: 'Rice', variantTitle: '', quantity: 1, unitPrice: 1, vatClass: 'C' },
        { title: 'Flour', variantTitle: '', quantity: 1, unitPrice: 2.5, vatClass: 'E' }
      ]
    }

    const out = lines(buildReceiptLayout(mixed, SETTINGS, { width: 48, logger: warnLogger() }))

    expect(out).toContain('A 16% 86.21 13.79 100.00')
    expect(out).toContain('C 0% 1.00 0.00 1.00')
    expect(out).toContain('E 0% 2.50 0.00 2.50')
  })

  it('never prints a gross larger than the sale in a fallback table', () => {
    const out = lines(buildReceiptLayout(sale(60), SETTINGS, { width: 48, logger: warnLogger() }))

    expect(out).toContain('A 16% 51.72 8.28 60.00')
    expect(out.some((l) => l.includes('69.60'))).toBe(false)
  })
})

describe('the mock provider reports its groups as net', () => {
  const request = (items: FiscalInvoiceRequest['items']): FiscalInvoiceRequest =>
    ({ clientOrderUuid: '9f3c2a17-0000-4000-8000-000000000001', items, total: 60, taxAmount: 8.28 }) as FiscalInvoiceRequest

  it('reports 51.72 for a 60.00 class A sale', async () => {
    const outcome = await new MockFiscalizationProvider(0).submitInvoice(
      request([{ description: 'Mug', quantity: 1, unitPrice: 60, taxRate: 0.16 }])
    )

    expect(outcome.ok && outcome.data.vatGroups).toEqual({ A: '51.72' })
  })

  it('reports each class that has a line, and no other', async () => {
    const outcome = await new MockFiscalizationProvider(0).submitInvoice(
      request([
        { description: 'Bread', quantity: 1, unitPrice: 100, taxRate: 0.16, vatClass: 'A' },
        { description: 'Rice', quantity: 1, unitPrice: 1, taxRate: 0, vatClass: 'C' }
      ])
    )

    expect(outcome.ok && outcome.data.vatGroups).toEqual({ A: '86.21', C: '1.00' })
  })

  it('gives a slip that reconciles, with the table the device figures print', async () => {
    const outcome = await new MockFiscalizationProvider(0).submitInvoice(
      request([{ description: 'Mug', quantity: 1, unitPrice: 60, taxRate: 0.16 }])
    )
    const groups = outcome.ok ? outcome.data.vatGroups : undefined
    const logger = warnLogger()

    const out = lines(buildReceiptLayout(sale(60, groups), SETTINGS, { width: 48, logger }))

    expect(out).toContain('A 16% 51.72 8.28 60.00')
    expect(out.some((l) => l.startsWith('Device figures'))).toBe(false)
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('the Needs Attention list "VAT figures to reconcile"', () => {
  /** Seeds a filed sale of 60.00 whose stored device groups are `groups`. */
  function filed(db: ReturnType<typeof freshDb>, groups: { A: string }): number {
    const { localId } = seedSale(db)
    db.setOrderFiscalInfo(localId, `CU${localId}`, 'qr', groups)
    return localId
  }

  it('lists a sale whose device groups disagree, with both VAT figures, and leaves out one that agrees', () => {
    const db = freshDb()
    const agrees = filed(db, { A: '51.72' })
    const disagrees = filed(db, { A: '60.00' })

    const rows = findVatMismatches(db.getFiscalisedOrdersWithVatGroups(), 0.16)

    expect(rows.map((r) => r.local_id)).toEqual([disagrees])
    expect(rows[0]).toMatchObject({ group_vat: 9.6, till_vat: 8.28, diff: 1.32, total: 60, staff_name: 'Mary Wanjiku' })
    expect(rows.some((r) => r.local_id === agrees)).toBe(false)
  })

  it('does not list a sale with no stored groups, or an unfiled sale', () => {
    const db = freshDb()
    const { localId: noGroups } = seedSale(db)
    db.setOrderFiscalInfo(noGroups, 'CU1', 'qr')
    seedSale(db)

    expect(db.getFiscalisedOrdersWithVatGroups()).toEqual([])
  })

  it('skips an order whose stored JSON cannot be read, and still lists the others', () => {
    const db = freshDb()
    const disagrees = filed(db, { A: '60.00' })
    const rows = db.getFiscalisedOrdersWithVatGroups()

    const result = findVatMismatches([{ ...rows[0], local_id: 99, payload_json: 'not json' }, ...rows], 0.16)

    expect(result.map((r) => r.local_id)).toEqual([disagrees])
  })

  it('follows the stored groups: once they agree, the sale leaves the list', () => {
    const db = freshDb()
    const { localId } = seedSale(db)
    db.setOrderFiscalInfo(localId, 'CU1', 'qr', { A: '51.72' })

    expect(findVatMismatches(db.getFiscalisedOrdersWithVatGroups(), 0.16)).toEqual([])
  })
})
