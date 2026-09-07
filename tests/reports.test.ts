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
}) {
  return {
    getShiftById: vi.fn(() => options.shift),
    getStaffById: vi.fn(() => options.staff),
    getOrdersForShift: vi.fn(() => options.ordersForShift ?? []),
    getOrdersForDateRange: vi.fn(() => options.ordersForRange ?? [])
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

  it('computes total tax from the store tax rate, not stored per order', () => {
    const db = fakeDb({
      shift: closedShift,
      staff: admin,
      ordersForShift: [order({ total: 100 })]
    })

    const report = generateZReport(db, 1, 0.08)

    expect(report.totalTax).toBeCloseTo(8, 5)
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
    expect(summary.totalTax).toBeCloseTo(5, 5)
    expect(summary.totalsByMethod).toEqual({ cash: 20, mpesa: 0, card: 30 })
  })

  it('defaults to the current UTC calendar day when no range is given', () => {
    const db = fakeDb({ ordersForRange: [] })
    generateDailySummary(db, 0)
    expect(db.getOrdersForDateRange).toHaveBeenCalledTimes(1)
  })
})

describe('getUtcDayRange', () => {
  it('returns a [start, end) pair spanning exactly one UTC day', () => {
    const { startIso, endIso } = getUtcDayRange(new Date('2026-08-24T15:30:00.000Z'))
    expect(startIso).toBe('2026-08-24T00:00:00.000Z')
    expect(endIso).toBe('2026-08-25T00:00:00.000Z')
  })
})
