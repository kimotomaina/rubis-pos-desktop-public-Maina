/**
 * VAT extraction and Nairobi date-range preset tests (docs/phase-158).
 *
 * `now` is fixed to a known Saturday (2026-09-26, still the same
 * calendar day in Nairobi as in UTC at this hour) so every preset's
 * boundary is deterministic — the exact ISO values below were computed
 * independently with a small Node script mirroring `getLocalDayRange`'s
 * own arithmetic, then cross-checked against this file's own import.
 */

import { describe, it, expect } from 'vitest'
import {
  computeVatIncluded,
  formatVatRateLabel,
  getReportRange,
  generateFiscalStatusByDay,
  generateFiscalReconciliation,
  localDayOf
} from '../src/main/services/reports.js'
import type { RubisDatabase, OrderRow } from '../src/main/services/database.js'
import { vi } from 'vitest'

const NOW = new Date('2026-09-26T10:00:00.000Z') // Saturday, still 2026-09-26 in Nairobi (+3h)

describe('computeVatIncluded', () => {
  it('extracts 16.00 VAT from a 116.00 VAT-inclusive total at 16%', () => {
    expect(computeVatIncluded(116, 0.16)).toBe(16)
  })

  it('extracts 0.14 VAT from a 1.00 VAT-inclusive total at 16% (the task’s own worked example)', () => {
    expect(computeVatIncluded(1, 0.16)).toBe(0.14)
  })

  it('rounds to 2 decimal places', () => {
    // 10 * 0.16 / 1.16 = 1.37931... -> 1.38
    expect(computeVatIncluded(10, 0.16)).toBe(1.38)
  })

  it('returns 0 for a zero rate', () => {
    expect(computeVatIncluded(100, 0)).toBe(0)
  })
})

describe('formatVatRateLabel (docs/phase-158-1)', () => {
  it('labels a 16% rate', () => {
    expect(formatVatRateLabel(0.16)).toBe('VAT included (calculated at 16%)')
  })

  it('labels an 8% rate, not a hardcoded 16%', () => {
    expect(formatVatRateLabel(0.08)).toBe('VAT included (calculated at 8%)')
  })
})

describe('getReportRange presets (Nairobi time, now = Sat 2026-09-26)', () => {
  it('today', () => {
    const range = getReportRange('today', NOW)
    expect(range.startIso).toBe('2026-09-25T21:00:00.000Z')
    expect(range.endIso).toBe('2026-09-26T21:00:00.000Z')
  })

  it('yesterday', () => {
    const range = getReportRange('yesterday', NOW)
    expect(range.startIso).toBe('2026-09-24T21:00:00.000Z')
    expect(range.endIso).toBe('2026-09-25T21:00:00.000Z')
  })

  it('thisWeek starts Monday 2026-09-21 and ends Sunday 2026-09-27', () => {
    const range = getReportRange('thisWeek', NOW)
    expect(range.startIso).toBe('2026-09-20T21:00:00.000Z')
    expect(range.endIso).toBe('2026-09-27T21:00:00.000Z')
  })

  it('lastWeek starts Monday 2026-09-14 and ends Sunday 2026-09-20', () => {
    const range = getReportRange('lastWeek', NOW)
    expect(range.startIso).toBe('2026-09-13T21:00:00.000Z')
    expect(range.endIso).toBe('2026-09-20T21:00:00.000Z')
  })

  it('thisMonth spans all of September 2026', () => {
    const range = getReportRange('thisMonth', NOW)
    expect(range.startIso).toBe('2026-08-31T21:00:00.000Z')
    expect(range.endIso).toBe('2026-09-30T21:00:00.000Z')
  })

  it('lastMonth spans all of August 2026 (31 days)', () => {
    const range = getReportRange('lastMonth', NOW)
    expect(range.startIso).toBe('2026-07-31T21:00:00.000Z')
    expect(range.endIso).toBe('2026-08-31T21:00:00.000Z')
  })

  it('lastMonth crosses a year boundary correctly (now = January)', () => {
    const range = getReportRange('lastMonth', new Date('2026-01-15T10:00:00.000Z'))
    // December 2025: 1 to 31 Dec.
    expect(range.label).toContain('December 2025')
  })
})

describe('a sale at 00:30 Nairobi lands on the Nairobi day, not the UTC day it falls on', () => {
  it('localDayOf resolves 2026-08-31T21:30:00Z (00:30 Nairobi on 2026-09-01) to 2026-09-01', () => {
    expect(localDayOf('2026-08-31T21:30:00.000Z')).toBe('2026-09-01')
  })

  it('generateFiscalStatusByDay buckets that sale under 2026-09-01, not 2026-08-31', () => {
    const order: OrderRow = {
      local_id: 1,
      shopify_order_id: null,
      total: 100,
      status: 'synced',
      created_at: '2026-08-31T21:30:00.000Z',
      payload_json: '{}',
      staff_id: 1,
      payment_method: 'cash',
      tendered_amount: 100,
      change_due: 0,
      reference_number: null,
      shift_id: 1,
      fiscal_invoice_number: 'INV1',
      fiscal_qr_code: null,
      fiscal_fiscalized_at: null,
      fiscal_status: 'fiscalized',
      fiscal_error_reason: null,
      fiscal_error_kind: null,
      fiscal_request_json: null,
      fiscal_data_issue: null,
      fiscal_vat_groups_json: null
    }
    const db = { getOrdersForDateRange: vi.fn(() => [order]) } as unknown as RubisDatabase

    const rows = generateFiscalStatusByDay(db, {
      startIso: '2026-08-31T00:00:00.000Z',
      endIso: '2026-09-02T00:00:00.000Z',
      label: 'test range'
    })

    expect(rows).toEqual([{ localDay: '2026-09-01', fiscalized: 1, waiting: 0, needsFixing: 0 }])
  })
})

describe('generateFiscalReconciliation (docs/phase-163, Commit 2)', () => {
  const RANGE = { startIso: '2026-09-01T00:00:00.000Z', endIso: '2026-09-02T00:00:00.000Z', label: 'test range' }

  function order(overrides: Partial<OrderRow> = {}): OrderRow {
    return {
      local_id: 1,
      shopify_order_id: null,
      total: 100,
      status: 'synced',
      created_at: '2026-09-01T09:00:00.000Z',
      payload_json: JSON.stringify({ clientOrderUuid: '11111111-2222-3333-4444-555555555555' }),
      staff_id: 1,
      payment_method: 'cash',
      tendered_amount: 100,
      change_due: 0,
      reference_number: null,
      shift_id: 1,
      fiscal_invoice_number: 'KRA-0001',
      fiscal_qr_code: 'base64qr',
      fiscal_fiscalized_at: '2026-09-01T09:00:01.000Z',
      fiscal_status: 'fiscalized',
      fiscal_error_reason: null,
      fiscal_error_kind: null,
      fiscal_request_json: null,
      fiscal_data_issue: null,
      fiscal_vat_groups_json: null,
      ...overrides
    }
  }

  function dbOf(orders: OrderRow[]): RubisDatabase {
    return { getOrdersForDateRange: vi.fn(() => orders) } as unknown as RubisDatabase
  }

  const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

  it('matched: charged 1.00, device GA "1.00"', () => {
    const db = dbOf([order({ total: 1, fiscal_vat_groups_json: JSON.stringify({ A: '1.00' }) })])

    const report = generateFiscalReconciliation(db, RANGE)

    expect(report.rows).toHaveLength(1)
    expect(report.rows[0].status).toBe('matched')
    expect(report.rows[0].deviceTotal).toBe(1)
    expect(report.rows[0].difference).toBe(0)
  })

  it('mismatch: charged 190.00, device GA "200.00" (the docs/phase-160 discount case — the device was never told about the discount)', () => {
    const db = dbOf([order({ total: 190, fiscal_vat_groups_json: JSON.stringify({ A: '200.00' }) })])

    const report = generateFiscalReconciliation(db, RANGE)

    expect(report.rows[0].status).toBe('mismatch')
    expect(report.rows[0].deviceTotal).toBe(200)
    expect(report.rows[0].difference).toBe(10)
  })

  it('no device figure: fiscal_vat_groups_json is NULL (an older sale, or an already-filed recovery) — never reported as a mismatch', () => {
    const db = dbOf([order({ fiscal_vat_groups_json: null })])

    const report = generateFiscalReconciliation(db, RANGE)

    expect(report.rows[0].status).toBe('no-device-figure')
    expect(report.rows[0].deviceTotal).toBeNull()
    expect(report.rows[0].difference).toBeNull()
  })

  it('mixed groups: GA "116.00" + GE "50.00" -> device total 166.00, VAT 16.00 from group A, 0 from group E', () => {
    const db = dbOf([
      order({ total: 166, fiscal_vat_groups_json: JSON.stringify({ A: '116.00', E: '50.00' }) })
    ])

    const report = generateFiscalReconciliation(db, RANGE)

    expect(report.rows[0].deviceTotal).toBe(166)
    expect(report.rows[0].status).toBe('matched')
    expect(report.rows[0].vatByGroup.A).toEqual({ amount: 116, vat: 16 })
    expect(report.rows[0].vatByGroup.E).toEqual({ amount: 50, vat: 0 })
  })

  it('group D amount present: the amount is shown, VAT is "not-known" — never guessed at a rate', () => {
    const db = dbOf([order({ total: 80, fiscal_vat_groups_json: JSON.stringify({ D: '80.00' }) })])

    const report = generateFiscalReconciliation(db, RANGE)

    expect(report.rows[0].vatByGroup.D).toEqual({ amount: 80, vat: 'not-known' })
  })

  it('non-numeric value: reported as no device figure (not a mismatch), logged once', () => {
    const db = dbOf([order({ fiscal_vat_groups_json: JSON.stringify({ A: 'n/a' }) })])
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const report = generateFiscalReconciliation(db, RANGE, logger)

    expect(report.rows[0].status).toBe('no-device-figure')
    expect(report.rows[0].deviceTotal).toBeNull()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('non-numeric'))
  })

  it('a voided-but-fiscalised order is still listed — a filed sale stays filed with KRA', () => {
    const db = dbOf([
      order({
        status: 'voided',
        total: 100,
        fiscal_vat_groups_json: JSON.stringify({ A: '100.00' })
      })
    ])

    const report = generateFiscalReconciliation(db, RANGE, silentLogger)

    expect(report.rows).toHaveLength(1)
    expect(report.rows[0].status).toBe('matched')
  })

  it('excludes an order that was never fiscalized (waiting/needs_fixing) — nothing to reconcile yet', () => {
    const db = dbOf([order({ fiscal_status: 'waiting' }), order({ local_id: 2, fiscal_status: 'needs_fixing' })])

    const report = generateFiscalReconciliation(db, RANGE, silentLogger)

    expect(report.rows).toHaveLength(0)
  })

  it('lists mismatches first, ahead of no-device-figure and matched rows, otherwise in creation order', () => {
    const matched = order({ local_id: 1, total: 1, fiscal_vat_groups_json: JSON.stringify({ A: '1.00' }) })
    const noFigure = order({ local_id: 2, fiscal_vat_groups_json: null })
    const mismatch = order({ local_id: 3, total: 190, fiscal_vat_groups_json: JSON.stringify({ A: '200.00' }) })
    const db = dbOf([matched, noFigure, mismatch])

    const report = generateFiscalReconciliation(db, RANGE, silentLogger)

    expect(report.rows.map((row) => row.localId)).toEqual([3, 2, 1])
  })

  it('totals: counts per status, and sums charged/device/difference', () => {
    const db = dbOf([
      order({ local_id: 1, total: 1, fiscal_vat_groups_json: JSON.stringify({ A: '1.00' }) }),
      order({ local_id: 2, total: 190, fiscal_vat_groups_json: JSON.stringify({ A: '200.00' }) }),
      order({ local_id: 3, fiscal_vat_groups_json: null })
    ])

    const report = generateFiscalReconciliation(db, RANGE, silentLogger)

    expect(report.totals).toEqual({
      matched: 1,
      mismatch: 1,
      noDeviceFigure: 1,
      sumCharged: 291,
      sumDevice: 201,
      sumDifference: 10
    })
  })

  it('builds the trader invoice number from local_id, and carries the CU invoice number through', () => {
    const db = dbOf([
      order({ local_id: 42, fiscal_invoice_number: '0000000000123456', fiscal_vat_groups_json: JSON.stringify({ A: '100.00' }) })
    ])

    const report = generateFiscalReconciliation(db, RANGE, silentLogger)

    expect(report.rows[0].traderInvoiceNumber).toBe('INV-000000042')
    expect(report.rows[0].cuInvoiceNumber).toBe('0000000000123456')
  })
})
