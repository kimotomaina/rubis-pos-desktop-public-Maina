/**
 * docs/phase-214: the device's VAT group amounts are gross. Built from the first live filing:
 * order 2 on 2026-10-03, one AQUAMIST PINEAPPLE 500ML at 90.00, filed as CU invoice
 * 0110605040001000810. The device returned the groups below; KRA's public verification page for
 * that invoice shows total 90, taxable 77.59, tax 12 (12.41 rounded).
 */

import { describe, it, expect, vi } from 'vitest'
import { buildReceiptLayout, isReceiptLayoutQr } from '../src/main/lib/receiptLayout.js'
import type { ReceiptLayoutEntry, ReceiptLayoutOrder } from '../src/main/lib/receiptLayout.js'
import { reconcileVatGroups } from '../src/main/lib/vatReconcile.js'
import { grossToVat } from '../src/main/lib/vatClass.js'
import { buildReconciliationRow } from '../src/main/services/reports.js'
import type { OrderRow } from '../src/main/services/database.js'

/** The groups the device returned for the live sale, stored verbatim. */
const LIVE_GROUPS = { A: '90.00', B: '0.00', C: '0.00', D: '0.00', E: '0.00' }

const SETTINGS = { taxRate: 0.16, tradingName: 'RUBIS' }

const liveSale: ReceiptLayoutOrder = {
  localId: 2,
  createdAt: '2026-10-03T00:48:03.119Z',
  cashierName: 'Admin',
  paymentMethod: 'cash',
  tenderedAmount: 500,
  changeDue: 410,
  fiscalInvoiceNumber: '0110605040001000810',
  traderInvNum: 'LZMO0VON0E5BK3',
  fiscalizedAt: '03-10-2026 03:41:00',
  fiscalizedAtSource: 'device',
  cuSerial: 'KRAMW011202207060504',
  total: 90,
  vatGroups: LIVE_GROUPS,
  items: [{ title: 'AQUAMIST PINEAPPLE 500ML', variantTitle: '', quantity: 1, unitPrice: 90, vatClass: 'A' }]
}

const texts = (entries: ReceiptLayoutEntry[]): string[] =>
  entries.map((entry) => (isReceiptLayoutQr(entry) ? '[qr]' : entry.text))

describe('the live sale of 2026-10-03: a 90.00 class A sale whose device group A is 90.00', () => {
  it('prints taxable 77.59, VAT 12.41, gross 90.00, the figures on KRA\'s invoice', () => {
    const out = texts(buildReceiptLayout(liveSale, SETTINGS, { width: 48, logger: { warn: vi.fn() } }))

    expect(out).toContain('A 16% 77.59 12.41 90.00')
  })

  it('prints no "Device figures" note and logs no warning: the device agrees with the till', () => {
    const logger = { warn: vi.fn() }

    const out = texts(buildReceiptLayout(liveSale, SETTINGS, { width: 48, logger }))

    expect(out.some((line) => line.startsWith('Device figures'))).toBe(false)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('never prints a gross larger than the amount charged (the defect printed 104.40)', () => {
    const out = texts(buildReceiptLayout(liveSale, SETTINGS, { width: 48, logger: { warn: vi.fn() } }))

    expect(out.some((line) => line.includes('104.40'))).toBe(false)
  })

  it('reconciles: the groups hold VAT 12.41 against the till\'s 12.41', () => {
    expect(reconcileVatGroups(LIVE_GROUPS, { vatIncluded: 12.41 })).toEqual({
      consistent: true,
      diff: 0,
      groupVat: 12.41,
      tillVat: 12.41
    })
  })

  it('is "matched" in the fiscal reconciliation report: device total 90.00 against 90.00 charged', () => {
    const order = {
      local_id: 2,
      created_at: '2026-10-03T00:48:03.119Z',
      total: 90,
      payload_json: JSON.stringify({ clientOrderUuid: 'ef91a714-a779-4b3b-93ef-132522f1a314' }),
      fiscal_invoice_number: '0110605040001000810',
      fiscal_trader_inv_num: 'LZMO0VON0E5BK3',
      fiscal_vat_groups_json: JSON.stringify(LIVE_GROUPS),
      fiscal_request_json: null
    } as unknown as OrderRow

    const row = buildReconciliationRow(order, { log: () => {}, warn: () => {}, error: () => {} })

    expect(row.status).toBe('matched')
    expect(row.deviceTotal).toBe(90)
    expect(row.vatByGroup.A).toEqual({ amount: 90, vat: 12.41 })
  })
})

describe('the slip and the reports read a device group the same way', () => {
  it.each([0.01, 1, 9.99, 60, 90, 116, 250.5, 1485, 1650, 99999.99])(
    'the VAT inside a group A amount of %s is the same on the slip row and in the report',
    (amount) => {
      const groups = { A: amount.toFixed(2) }
      const slip = texts(buildReceiptLayout({ ...liveSale, total: amount, vatGroups: groups }, SETTINGS, { width: 48, logger: { warn: vi.fn() } }))
      const row = slip.find((line) => line.startsWith('A 16% '))!
      const slipVat = Number(row.split(' ')[3].replace(/,/g, ''))
      const order = {
        local_id: 1,
        created_at: '2026-10-03T00:00:00.000Z',
        total: amount,
        payload_json: '{}',
        fiscal_vat_groups_json: JSON.stringify(groups),
        fiscal_request_json: null
      } as unknown as OrderRow

      const reportVat = buildReconciliationRow(order, { log: () => {}, warn: () => {}, error: () => {} }).vatByGroup.A!.vat

      expect(slipVat).toBe(reportVat)
      expect(slipVat).toBe(grossToVat('A', amount))
    }
  )
})
