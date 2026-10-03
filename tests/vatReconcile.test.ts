/**
 * VAT table reconciliation (docs/phase-198-1, corrected by docs/phase-214): the gross-to-net
 * and gross-to-VAT helpers, the fallback table built from the lines, the reconcile of stored
 * device groups against the till's VAT, what the slip prints when they disagree, the mock's
 * groups, and the Needs Attention list "VAT figures to reconcile".
 *
 * The device's group amounts are GROSS (VAT included). Phase 198-1 read them as net "until the
 * live test"; the first live filing (a 90.00 sale came back as group A 90.00; KRA's invoice shows
 * taxable 77.59, tax 12.41) settled it. Tests below changed from net to gross inputs carry an
 * OLD/NEW note.
 */

import { describe, it, expect, vi } from 'vitest'
import { grossToNet, grossToVat } from '../src/main/lib/vatClass.js'
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

describe('grossToNet and grossToVat', () => {
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

  // CHANGED (docs/phase-214). OLD: a test of netGroupTotals, which turned the lines' totals into net amounts for the
  // slip's fallback table and the mock. NEW: that function is gone (the groups are gross, so the lines' own totals
  // are used as they are); these test grossToVat, the VAT inside a gross amount, the figure the table now prints.
  it('works out the VAT inside a class A amount: x 16/116, two places', () => {
    expect(grossToVat('A', 60)).toBe(8.28)
    expect(grossToVat('A', 90)).toBe(12.41)
    expect(grossToVat('A', 1650)).toBe(227.59)
    expect(grossToVat('A', 1485)).toBe(204.83)
  })

  it('works out the VAT inside a class B amount: x 8/108', () => {
    expect(grossToVat('B', 108)).toBe(8)
  })

  it('has no VAT figure for C, D and E', () => {
    expect(grossToVat('C', 2.5)).toBe(0)
    expect(grossToVat('D', 7.77)).toBe(0)
    expect(grossToVat('E', 1)).toBe(0)
  })
})

describe('reconcileVatGroups', () => {
  // CHANGED (docs/phase-214). OLD: groups read as net, so { A: '51.72' } agreed with a till VAT of 8.28. NEW: groups
  // are gross, so { A: '60.00' } agrees with 8.28, and the old net figure 51.72 would now be a disagreement.
  it('agrees when the gross groups hold the till VAT', () => {
    const result = reconcileVatGroups({ A: '60.00' }, { vatIncluded: 8.28 })

    expect(result).toEqual({ consistent: true, diff: 0, groupVat: 8.28, tillVat: 8.28 })
  })

  // CHANGED (docs/phase-214). OLD: { A: '60.00' } disagreed (VAT 9.60 against 8.28), because 60.00 was read as net.
  // NEW: a group that is lower than the sale disagrees: { A: '51.72' } holds VAT 7.13 against the till's 8.28.
  it('disagrees when the device holds less than the sale: VAT 7.13 against the till 8.28', () => {
    const result = reconcileVatGroups({ A: '51.72' }, { vatIncluded: 8.28 })

    expect(result.consistent).toBe(false)
    expect(result.diff).toBe(-1.15)
    expect(result.groupVat).toBe(7.13)
    expect(result.tillVat).toBe(8.28)
  })

  it('tolerates a difference of 0.05 and no more', () => {
    expect(VAT_RECONCILE_TOLERANCE).toBe(0.05)
    // CHANGED (docs/phase-214): the group is { A: '60.00' } (gross) where it was '51.72' (net); the VAT it holds is the same 8.28.
    expect(reconcileVatGroups({ A: '60.00' }, { vatIncluded: 8.33 }).consistent).toBe(true)
    expect(reconcileVatGroups({ A: '60.00' }, { vatIncluded: 8.34 }).consistent).toBe(false)
    expect(reconcileVatGroups({ A: '60.00' }, { vatIncluded: 8.23 }).consistent).toBe(true)
    expect(reconcileVatGroups({ A: '60.00' }, { vatIncluded: 8.22 }).consistent).toBe(false)
  })

  it('counts C and E as no VAT, and B at 8%', () => {
    // CHANGED (docs/phase-214): A is '100.00' (gross) where it was '86.21' (net); B is '108.00' where it was '100.00'.
    expect(reconcileVatGroups({ A: '100.00', C: '1.00', E: '2.50' }, { vatIncluded: 13.79 }).consistent).toBe(true)
    expect(reconcileVatGroups({ B: '108.00' }, { vatIncluded: 8 }).consistent).toBe(true)
  })

  it('cannot compare a sale with a class D amount, and says nothing against it', () => {
    const result = reconcileVatGroups({ A: '60.00', D: '500.00' }, { vatIncluded: 99 })

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

    // CHANGED (docs/phase-214). OLD: the device group was { A: '51.72' } (net). NEW: { A: '60.00' } (gross). Same row.
    const out = lines(buildReceiptLayout(sale(60, { A: '60.00' }), SETTINGS, { width: 48, logger }))

    expect(out).toContain('A 16% 51.72 8.28 60.00')
    expect(out.some((l) => l.startsWith('Device figures'))).toBe(false)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('prints the device figures and one line under them when they disagree, and logs at warn', () => {
    const logger = warnLogger()

    // CHANGED (docs/phase-214). OLD: { A: '60.00' } disagreed and printed 'A 16% 60.00 9.60 69.60' (gross 69.60 for a 60.00 sale).
    // NEW: a device group of { A: '51.72' } disagrees and prints its own gross, 'A 16% 44.59 7.13 51.72'.
    const out = lines(buildReceiptLayout(sale(60, { A: '51.72' }), SETTINGS, { width: 48, logger }))

    const row = out.indexOf('A 16% 44.59 7.13 51.72')
    expect(row).toBeGreaterThan(-1)
    expect(out[row + 1]).toBe('Device figures. Till VAT: 8.28.')
    expect(out[row + 2]).toBe('-'.repeat(48))
    expect(out).toContain('VAT                                         8.28')
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(String(logger.warn.mock.calls[0][0])).toContain('Order 7')
  })

  it('wraps the note on a narrow printer without hiding either figure', () => {
    // CHANGED (docs/phase-214): { A: '51.72' } and 'A 16% 44.59 7.13 51.72' replace { A: '60.00' } and 'A 16% 60.00 9.60 69.60'.
    const out = lines(buildReceiptLayout(sale(60, { A: '51.72' }), SETTINGS, { width: 32, logger: warnLogger() }))

    expect(out.join(' ')).toContain('Device figures. Till VAT: 8.28.')
    expect(out).toContain('A 16% 44.59 7.13 51.72')
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

  it('builds the fallback table from gross amounts: a 1,650.00 sale prints 1,422.41 + 227.59 = 1,650.00', () => {
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

// CHANGED (docs/phase-214). OLD: the mock reported its groups as net (51.72 for a 60.00 sale). NEW: gross, as the real
// device does (60.00); the slip it gives is the same.
describe('the mock provider reports its groups as gross', () => {
  const request = (items: FiscalInvoiceRequest['items']): FiscalInvoiceRequest =>
    ({ clientOrderUuid: '9f3c2a17-0000-4000-8000-000000000001', items, total: 60, taxAmount: 8.28 }) as FiscalInvoiceRequest

  it('reports 60.00 for a 60.00 class A sale', async () => {
    const outcome = await new MockFiscalizationProvider(0).submitInvoice(
      request([{ description: 'Mug', quantity: 1, unitPrice: 60, taxRate: 0.16 }])
    )

    expect(outcome.ok && outcome.data.vatGroups).toEqual({ A: '60.00' })
  })

  it('reports each class that has a line, and no other', async () => {
    const outcome = await new MockFiscalizationProvider(0).submitInvoice(
      request([
        { description: 'Bread', quantity: 1, unitPrice: 100, taxRate: 0.16, vatClass: 'A' },
        { description: 'Rice', quantity: 1, unitPrice: 1, taxRate: 0, vatClass: 'C' }
      ])
    )

    expect(outcome.ok && outcome.data.vatGroups).toEqual({ A: '100.00', C: '1.00' })
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

  // CHANGED (docs/phase-214). OLD: { A: '51.72' } agreed and { A: '60.00' } disagreed (VAT 9.6, diff 1.32), groups read as net.
  // NEW: { A: '60.00' } agrees and { A: '51.72' } disagrees (VAT 7.13 against 8.28, diff -1.15), groups read as gross.
  it('lists a sale whose device groups disagree, with both VAT figures, and leaves out one that agrees', () => {
    const db = freshDb()
    const agrees = filed(db, { A: '60.00' })
    const disagrees = filed(db, { A: '51.72' })

    const rows = findVatMismatches(db.getFiscalisedOrdersWithVatGroups(), 0.16)

    expect(rows.map((r) => r.local_id)).toEqual([disagrees])
    expect(rows[0]).toMatchObject({ group_vat: 7.13, till_vat: 8.28, diff: -1.15, total: 60, staff_name: 'Mary Wanjiku' })
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
    const disagrees = filed(db, { A: '51.72' })
    const rows = db.getFiscalisedOrdersWithVatGroups()

    const result = findVatMismatches([{ ...rows[0], local_id: 99, payload_json: 'not json' }, ...rows], 0.16)

    expect(result.map((r) => r.local_id)).toEqual([disagrees])
  })

  it('follows the stored groups: once they agree, the sale leaves the list', () => {
    const db = freshDb()
    const { localId } = seedSale(db)
    db.setOrderFiscalInfo(localId, 'CU1', 'qr', { A: '60.00' })

    expect(findVatMismatches(db.getFiscalisedOrdersWithVatGroups(), 0.16)).toEqual([])
  })
})
