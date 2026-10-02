/**
 * `getEtrCopyEligibility` (docs/phase-196-2): which Order History rows may
 * offer "Print ETR copy".
 */

import { describe, it, expect } from 'vitest'
import type { OrderRow } from '../src/main/services/database.js'
import {
  ETR_COPY_NOT_FILED_REASON,
  ETR_COPY_NOT_LATEST_REASON,
  getEtrCopyEligibility
} from '../src/renderer/src/lib/etrCopy.js'

const order = (localId: number, overrides: Partial<OrderRow> = {}): OrderRow =>
  ({
    local_id: localId,
    fiscal_status: 'fiscalized',
    fiscal_invoice_number: `000000000000000${localId.toString().padStart(4, '0')}`,
    fiscal_fiscalized_at: `2026-10-02T10:0${localId}:00.000Z`,
    ...overrides
  }) as OrderRow

describe('getEtrCopyEligibility', () => {
  it('enables only the most recently filed order', () => {
    const orders = [order(3), order(2), order(1)]
    expect(getEtrCopyEligibility(orders, orders[0])).toEqual({ enabled: true, reason: null })
    expect(getEtrCopyEligibility(orders, orders[1])).toEqual({ enabled: false, reason: ETR_COPY_NOT_LATEST_REASON })
    expect(getEtrCopyEligibility(orders, orders[2])).toEqual({ enabled: false, reason: ETR_COPY_NOT_LATEST_REASON })
  })

  it('disables an order that is not filed, with the not-filed reason, even when it is the newest sale', () => {
    const waiting = order(4, { fiscal_status: 'waiting', fiscal_invoice_number: null, fiscal_fiscalized_at: null })
    const orders = [waiting, order(3)]
    expect(getEtrCopyEligibility(orders, waiting)).toEqual({ enabled: false, reason: ETR_COPY_NOT_FILED_REASON })
    expect(getEtrCopyEligibility(orders, orders[1]).enabled).toBe(true)
  })

  it('goes by filing time, not creation order: a retried older sale filed last is the one offered', () => {
    const olderFiledLate = order(1, { fiscal_fiscalized_at: '2026-10-02T12:00:00.000Z' })
    const newerFiledEarly = order(2, { fiscal_fiscalized_at: '2026-10-02T09:00:00.000Z' })
    const orders = [newerFiledEarly, olderFiledLate]
    expect(getEtrCopyEligibility(orders, olderFiledLate).enabled).toBe(true)
    expect(getEtrCopyEligibility(orders, newerFiledEarly).enabled).toBe(false)
  })

  it('falls back to the higher local id when filing times tie', () => {
    const a = order(1, { fiscal_fiscalized_at: '2026-10-02T09:00:00.000Z' })
    const b = order(2, { fiscal_fiscalized_at: '2026-10-02T09:00:00.000Z' })
    expect(getEtrCopyEligibility([a, b], b).enabled).toBe(true)
    expect(getEtrCopyEligibility([a, b], a).enabled).toBe(false)
  })

  it('offers nothing when no order is filed', () => {
    const only = order(1, { fiscal_status: null, fiscal_invoice_number: null })
    expect(getEtrCopyEligibility([only], only).enabled).toBe(false)
  })
})
