/**
 * Z-report and daily-summary aggregation tests.
 *
 * `generateZReport`/`generateDailySummary` are tested against a
 * lightweight fake implementing only the `RubisDatabase` methods they
 * call — no SQLite connection, real or mocked, is needed.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  generateZReport,
  generateDailySummary,
  generateSalesSummary,
  getUtcDayRange
} from '../src/main/services/reports.js'
import type { RubisDatabase, OrderRow, ShiftRow, StaffRow } from '../src/main/services/database.js'

const order = (overrides: Partial<OrderRow> = {}): OrderRow => ({
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
  ...overrides
})

function fakeDb(options: {
  shift?: ShiftRow
  staff?: StaffRow
  ordersForShift?: OrderRow[]
  ordersForRange?: OrderRow[]
  mpesaPaymentsForShift?: Array<{ mode: string; amount: number; status: string }>
  mpesaPaymentsForRange?: Array<{ mode: string; amount: number; status: string }>
}) {
  return {
    getShiftById: vi.fn(() => options.shift),
    getStaffById: vi.fn(() => options.staff),
    getOrdersForShift: vi.fn(() => options.ordersForShift ?? []),
    getOrdersForDateRange: vi.fn(() => options.ordersForRange ?? []),
    getMpesaPaymentsForShift: vi.fn(() => options.mpesaPaymentsForShift ?? []),
    getMpesaPaymentsForDateRange: vi.fn(() => options.mpesaPaymentsForRange ?? [])
  } as unknown as RubisDatabase
}

const closedShift: ShiftRow = {
  id: 1,
  staff_id: 1,
  clock_in: '2026-08-24T08:00:00.000Z',
  clock_out: '2026-08-24T16:00:00.000Z',
  starting_cash: 100,
  expected_cash: 180,
  ending_cash: 175,
  discrepancy: -5,
  status: 'closed'
}

const openShift: ShiftRow = {
  ...closedShift,
  clock_out: null,
  expected_cash: null,
  ending_cash: null,
  discrepancy: null,
  status: 'open'
}

const admin: StaffRow = {
  id: 1,
  name: 'Admin',
  pin_hash: 'x',
  role: 'admin',
  is_active: 1
}

describe('generateZReport', () => {
  it('sums revenue by payment method', () => {
    const db = fakeDb({
      shift: closedShift,
      staff: admin,
      ordersForShift: [
        order({ payment_method: 'cash', total: 50 }),
        order({ payment_method: 'cash', total: 30 }),
        order({ payment_method: 'mpesa', total: 20 }),
        order({ payment_method: 'card', total: 15 })
      ]
    })

    const report = generateZReport(db, 1, 0.08)

    expect(report.totalsByMethod).toEqual({ cash: 80, mpesa: 20, card: 15 })
    expect(report.orderCount).toBe(4)
    expect(report.totalRevenue).toBe(115)
  })

  /**
   * DELIBERATE TEST CHANGE (docs/phase-158, correcting docs/phase-157
   * Part 3 G2): the field was renamed `totalTax` -> `vatIncluded` and the
   * formula changed from adding tax on top of revenue (`total * rate`,
   * wrong for a VAT-inclusive shelf price) to extracting the VAT already
   * included in it (`total * rate / (1 + rate)`).
   *   Old assertion: `report.totalTax` is close to `8` (100 * 0.08).
   *   New assertion: `report.vatIncluded` is close to `7.41`
   *     (100 * 0.08 / 1.08).
   */
  it('extracts VAT already included in revenue, not stored per order', () => {
    const db = fakeDb({
      shift: closedShift,
      staff: admin,
      ordersForShift: [order({ total: 100 })]
    })

    const report = generateZReport(db, 1, 0.08)

    expect(report.vatIncluded).toBeCloseTo(7.41, 2)
  })

  it('splits the shift\'s M-Pesa revenue by manual vs Daraja', () => {
    const db = fakeDb({
      shift: closedShift,
      staff: admin,
      ordersForShift: [order({ payment_method: 'mpesa', total: 50 })],
      mpesaPaymentsForShift: [
        { mode: 'manual', amount: 20, status: 'pending_sync' },
        { mode: 'daraja', amount: 30, status: 'pending_sync' },
        { mode: 'manual', amount: 999, status: 'voided' }
      ]
    })

    const report = generateZReport(db, 1, 0)

    expect(report.mpesaByMode).toEqual({ manual: 20, daraja: 30 })
  })

  it('uses the persisted expected/ending cash and discrepancy for a closed shift', () => {
    const db = fakeDb({ shift: closedShift, staff: admin, ordersForShift: [] })

    const report = generateZReport(db, 1, 0)

    expect(report.expectedCash).toBe(180)
    expect(report.endingCash).toBe(175)
    expect(report.discrepancy).toBe(-5)
    expect(report.status).toBe('closed')
  })

  it('computes a live expected cash for a still-open shift (no discrepancy yet)', () => {
    const db = fakeDb({
      shift: openShift,
      staff: admin,
      ordersForShift: [order({ payment_method: 'cash', total: 40 })]
    })

    const report = generateZReport(db, 1, 0)

    // expected = starting (100) + live cash sales (40) = 140
    expect(report.expectedCash).toBe(140)
    expect(report.endingCash).toBeNull()
    expect(report.discrepancy).toBeNull()
    expect(report.status).toBe('open')
  })

  it('resolves the opening staff member\'s name', () => {
    const db = fakeDb({ shift: closedShift, staff: admin, ordersForShift: [] })
    const report = generateZReport(db, 1, 0)
    expect(report.staffName).toBe('Admin')
  })

  it('falls back to "Unknown" when the staff record is missing', () => {
    const db = fakeDb({ shift: closedShift, staff: undefined, ordersForShift: [] })
    const report = generateZReport(db, 1, 0)
    expect(report.staffName).toBe('Unknown')
  })

  it('throws for a non-existent shift', () => {
    const db = fakeDb({ shift: undefined })
    expect(() => generateZReport(db, 999, 0)).toThrow(/not found/i)
  })
})

describe('generateDailySummary', () => {
  it('aggregates orders within the given range by payment method', () => {
    const db = fakeDb({
      ordersForRange: [
        order({ payment_method: 'cash', total: 20 }),
        order({ payment_method: 'card', total: 30 })
      ]
    })

    const summary = generateDailySummary(db, 0.1, {
      startIso: '2026-08-24T00:00:00.000Z',
      endIso: '2026-08-25T00:00:00.000Z'
    })

    expect(summary.orderCount).toBe(2)
    expect(summary.totalRevenue).toBe(50)
    // DELIBERATE TEST CHANGE (docs/phase-158, same reason as generateZReport's
    // equivalent test above): old `summary.totalTax` close to `5` (50 * 0.1)
    // -> new `summary.vatIncluded` close to `4.55` (50 * 0.1 / 1.1).
    expect(summary.vatIncluded).toBeCloseTo(4.5454545, 2)
    expect(summary.totalsByMethod).toEqual({ cash: 20, mpesa: 0, card: 30 })
  })

  it('defaults to the current UTC calendar day when no range is given', () => {
    const db = fakeDb({ ordersForRange: [] })
    generateDailySummary(db, 0)
    expect(db.getOrdersForDateRange).toHaveBeenCalledTimes(1)
  })
})

describe('generateSalesSummary (docs/phase-158)', () => {
  const range = {
    startIso: '2026-09-01T00:00:00.000Z',
    endIso: '2026-09-02T00:00:00.000Z',
    label: 'Today (2026-09-01)'
  }

  it('excludes voided orders from every figure', () => {
    const db = fakeDb({
      ordersForRange: [
        order({ payment_method: 'cash', total: 50, status: 'synced' }),
        order({ payment_method: 'cash', total: 999, status: 'voided' })
      ]
    })

    const summary = generateSalesSummary(db, 0.16, range)

    expect(summary.orderCount).toBe(1)
    expect(summary.totalRevenue).toBe(50)
    expect(summary.totalsByMethod).toEqual({ cash: 50, mpesa: 0, card: 0 })
  })

  it('splits M-Pesa revenue by manual vs Daraja, excluding a voided one', () => {
    const db = fakeDb({
      ordersForRange: [order({ payment_method: 'mpesa', total: 80 })],
      mpesaPaymentsForRange: [
        { mode: 'manual', amount: 30, status: 'synced' },
        { mode: 'daraja', amount: 50, status: 'synced' },
        { mode: 'manual', amount: 999, status: 'voided' }
      ]
    })

    const summary = generateSalesSummary(db, 0.16, range)

    expect(summary.mpesaByMode).toEqual({ manual: 30, daraja: 50 })
  })

  it('carries the range label through unchanged', () => {
    const db = fakeDb({ ordersForRange: [] })
    const summary = generateSalesSummary(db, 0.16, range)
    expect(summary.label).toBe('Today (2026-09-01)')
    expect(summary.startIso).toBe(range.startIso)
    expect(summary.endIso).toBe(range.endIso)
  })
})

describe('getUtcDayRange', () => {
  it('returns a [start, end) pair spanning exactly one UTC day', () => {
    const { startIso, endIso } = getUtcDayRange(new Date('2026-08-24T15:30:00.000Z'))
    expect(startIso).toBe('2026-08-24T00:00:00.000Z')
    expect(endIso).toBe('2026-08-25T00:00:00.000Z')
  })
})
