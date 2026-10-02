/**
 * `reportsExport.ts` tests (docs/phase-158) — the CSV export builders,
 * against a lightweight fake `RubisDatabase` (no SQLite needed, matching
 * `tests/reports.test.ts`'s own style).
 */

import { describe, it, expect, vi } from 'vitest'
import { buildOrdersCsv, buildLinesCsv } from '../src/main/services/reportsExport.js'
import { buildTraderSystemInvNum } from '../src/main/lib/traderSystemInvoiceNumber.js'
import { buildOrderInput } from '../src/main/services/orders.js'
import type { RubisDatabase, OrderRow, MpesaPaymentRow, OrderStatus, StaffRow } from '../src/main/services/database.js'
import type { ReportRange } from '../src/main/services/reports.js'
import type { OfflineOrderPayload } from '../src/main/services/shopify-types.js'

const RANGE: ReportRange = {
  startIso: '2026-09-01T00:00:00.000Z',
  endIso: '2026-09-02T00:00:00.000Z',
  label: 'Today (2026-09-01)'
}

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    local_id: 1,
    shopify_order_id: null,
    total: 100,
    status: 'synced',
    created_at: '2026-09-01T09:00:00.000Z',
    payload_json: JSON.stringify({ clientOrderUuid: 'uuid-1', lineItems: [] }),
    staff_id: 1,
    payment_method: 'cash',
    tendered_amount: 100,
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

function fakeDb(options: {
  orders?: OrderRow[]
  payments?: Array<MpesaPaymentRow & { status: OrderStatus }>
  staff?: StaffRow[]
}): RubisDatabase {
  const staffById = new Map((options.staff ?? []).map((s) => [s.id, s]))
  return {
    getOrdersForDateRange: vi.fn(() => options.orders ?? []),
    getMpesaPaymentsForDateRange: vi.fn(() => options.payments ?? []),
    getStaffById: vi.fn((id: number) => staffById.get(id))
  } as unknown as RubisDatabase
}

const admin: StaffRow = { id: 1, name: 'Ann', pin_hash: 'x', role: 'cashier', is_active: 1 }

describe('buildOrdersCsv', () => {
  it('never exports a customer KRA PIN, only whether one was captured', () => {
    const withPin = order({
      local_id: 1,
      payload_json: JSON.stringify({ clientOrderUuid: 'uuid-1', customerPin: 'P051234567X', lineItems: [] })
    })
    const withoutPin = order({ local_id: 2 })
    const db = fakeDb({ orders: [withPin, withoutPin], staff: [admin] })

    const csv = buildOrdersCsv(db, RANGE, 0.16)

    expect(csv).not.toContain('P051234567X')
    expect(csv).toContain('yes')
    expect(csv).toContain('no')
  })

  it('marks a voided order as voided but still includes it, with the underlying sync status kept separately', () => {
    const voided = order({ local_id: 3, status: 'voided' })
    const active = order({ local_id: 4, status: 'synced' })
    const db = fakeDb({ orders: [voided, active], staff: [admin] })

    const csv = buildOrdersCsv(db, RANGE, 0.16)
    const lines = csv.split('\r\n').filter(Boolean)

    // header + 2 rows
    expect(lines.length).toBe(3)
    expect(lines[1]).toContain('voided')
    expect(lines[2]).toContain('completed')
    expect(lines[2]).toContain('synced')
  })

  it('uses the same trader invoice number format as the shared helper', () => {
    const db = fakeDb({ orders: [order({ local_id: 42 })], staff: [admin] })
    const csv = buildOrdersCsv(db, RANGE, 0.16)
    expect(csv).toContain(buildTraderSystemInvNum(42, 'uuid-1'))
  })

  it('includes the M-Pesa code and mode for an order with a matching payment', () => {
    const db = fakeDb({
      orders: [order({ local_id: 5, payment_method: 'mpesa' })],
      payments: [
        {
          id: 1,
          order_local_id: 5,
          mode: 'manual',
          verification_status: 'manual_unverified',
          reference: 'QDF73HK9LM',
          amount: 100,
          entered_by_staff_id: 1,
          approved_by_staff_id: null,
          reconciled_at: null,
          reconciled_by_staff_id: null,
          reconciliation_note: null,
          source_transaction_id: null,
          source_sms_message_id: null,
          created_at: '2026-09-01T09:00:00.000Z',
          status: 'synced'
        }
      ],
      staff: [admin]
    })

    const csv = buildOrdersCsv(db, RANGE, 0.16)
    expect(csv).toContain('QDF73HK9LM')
    expect(csv).toContain('manual')
  })

  it('computes VAT included using the same extraction formula as the reports, not total * rate', () => {
    const db = fakeDb({ orders: [order({ local_id: 6, total: 116 })], staff: [admin] })
    const csv = buildOrdersCsv(db, RANGE, 0.16)
    const dataRow = csv.split('\r\n')[1].split(',')
    // Column 9 (0-indexed) is "VAT included" - a fixed index, not a
    // substring search, so this cannot pass by accidentally matching the
    // Total column's own "116.00" the way a bare `toContain` would.
    expect(dataRow[9]).toBe('16.00')
  })

  it('resolves the cashier name from staff_id', () => {
    const db = fakeDb({ orders: [order({ local_id: 7, staff_id: 1 })], staff: [admin] })
    const csv = buildOrdersCsv(db, RANGE, 0.16)
    expect(csv).toContain('Ann')
  })

  it('exports the same client order UUID that orders.ts sends Shopify as the customAttribute and metafield (docs/phase-158-1)', () => {
    const payload: OfflineOrderPayload = {
      clientOrderUuid: 'uuid-42',
      total: 100,
      lineItems: [],
      createdAt: '2026-09-01T09:00:00.000Z',
      staffId: 1,
      staffName: 'Ann',
      paymentMethod: 'cash',
      tenderedAmount: 100,
      changeDue: 0
    }
    const db = fakeDb({
      orders: [order({ local_id: 10, payload_json: JSON.stringify(payload) })],
      staff: [admin]
    })

    const csv = buildOrdersCsv(db, RANGE, 0.16)
    const dataRow = csv.split('\r\n')[1].split(',')
    // Column 15 (0-indexed), "Client order UUID" — the last column before
    // docs/phase-163's reconciliation columns were appended after it.
    expect(dataRow[15]).toBe('uuid-42')

    // CHANGED (docs/phase-210). OLD: buildOrderInput(payload). NEW: it also takes the till's location
    // as a fallback, because an order cannot be built without one. The assertions are unchanged.
    const shopifyInput = buildOrderInput(payload, { id: 'gid://shopify/Location/77557989479', name: 'Rubis Kisumu' })
    const customAttributes = shopifyInput.order.customAttributes as Array<{ key: string; value: string }>
    const metafields = shopifyInput.order.metafields as Array<{ key: string; value: string }>
    expect(dataRow[15]).toBe(customAttributes[0].value)
    expect(dataRow[15]).toBe(metafields[0].value)
  })

  /**
   * docs/phase-163, Commit 2 — columns 16-23: Device total, Difference,
   * Reconciliation status, VAT groups A-E. Fixed indices (not `toContain`)
   * so this can't pass by accidentally matching another column's value.
   */
  describe('reconciliation columns (docs/phase-163)', () => {
    it('fills the reconciliation columns for a fiscalized order and the VAT-group columns from the raw device strings', () => {
      const db = fakeDb({
        orders: [
          order({
            local_id: 20,
            total: 190,
            fiscal_status: 'fiscalized',
            fiscal_invoice_number: 'KRA-0020',
            fiscal_vat_groups_json: JSON.stringify({ A: '200.00' })
          })
        ],
        staff: [admin]
      })

      const csv = buildOrdersCsv(db, RANGE, 0.16)
      const dataRow = csv.split('\r\n')[1].split(',')

      expect(dataRow[16]).toBe('200.00') // Device total
      expect(dataRow[17]).toBe('10.00') // Difference (200 - 190)
      expect(dataRow[18]).toBe('mismatch') // Reconciliation status
      expect(dataRow[19]).toBe('200.00') // VAT group A
      expect(dataRow[20]).toBe('') // VAT group B — absent from the device response
    })

    it('leaves the reconciliation columns blank for an order that was never fiscalized', () => {
      const db = fakeDb({
        orders: [order({ local_id: 21, fiscal_status: null, fiscal_vat_groups_json: null })],
        staff: [admin]
      })

      const csv = buildOrdersCsv(db, RANGE, 0.16)
      const dataRow = csv.split('\r\n')[1].split(',')

      expect(dataRow[16]).toBe('')
      expect(dataRow[17]).toBe('')
      expect(dataRow[18]).toBe('')
      expect(dataRow[19]).toBe('')
    })

    it('reports "no-device-figure" (not blank, not a mismatch) for a fiscalized order with no stored device figure', () => {
      const db = fakeDb({
        orders: [
          order({
            local_id: 22,
            fiscal_status: 'fiscalized',
            fiscal_invoice_number: 'KRA-0022',
            fiscal_vat_groups_json: null
          })
        ],
        staff: [admin]
      })

      const csv = buildOrdersCsv(db, RANGE, 0.16)
      const dataRow = csv.split('\r\n')[1].split(',')

      expect(dataRow[16]).toBe('') // Device total — null, not "0.00"
      expect(dataRow[18]).toBe('no-device-figure')
    })
  })
})

describe('buildLinesCsv', () => {
  it('emits one row per line item, prefixed with the trader invoice number', () => {
    const withLines = order({
      local_id: 8,
      payload_json: JSON.stringify({
        clientOrderUuid: 'uuid-8',
        lineItems: [
          { variantId: 'gid://1', title: 'Total Quartz', variantTitle: '1L', quantity: 2, unitPrice: 2500, discount: undefined },
          { variantId: 'gid://2', title: 'Oil Filter', variantTitle: 'Default', quantity: 1, unitPrice: 500, discount: { type: 'percent', value: 10 } }
        ]
      })
    })
    const db = fakeDb({ orders: [withLines] })

    const csv = buildLinesCsv(db, RANGE)
    const lines = csv.split('\r\n').filter(Boolean)

    expect(lines.length).toBe(3) // header + 2 line items
    expect(lines[1]).toContain('Total Quartz')
    expect(lines[1]).toContain(buildTraderSystemInvNum(8, 'uuid-8'))
    expect(lines[2]).toContain('Oil Filter')
    expect(lines[2]).toContain('percent 10')
  })

  it('produces no rows for an order with no line items', () => {
    const db = fakeDb({ orders: [order({ local_id: 9, payload_json: JSON.stringify({ clientOrderUuid: 'u', lineItems: [] }) })] })
    const csv = buildLinesCsv(db, RANGE)
    const lines = csv.split('\r\n').filter(Boolean)
    expect(lines.length).toBe(1) // header only
  })
})
