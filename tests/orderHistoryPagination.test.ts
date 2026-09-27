/**
 * `OrderHistory` pagination tests (docs/phase-166 Commit E4).
 *
 * `paginate` itself is already proven generically in
 * `tests/paginate.test.ts` — this checks the component's own wiring
 * (page size, the Pager appearing/behaving), which only shows up once
 * real DOM re-renders are involved. Mounted with `react-dom/client`,
 * the same pattern `screensFitDesignBox.test.ts`/`posCartTable.test.ts`
 * already use.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import OrderHistory, {
  ORDER_HISTORY_PAGE_SIZE
} from '../src/renderer/src/components/OrderHistory.js'
import type { OrderRow } from '../src/main/services/database.js'

const makeOrder = (localId: number): OrderRow => ({
  local_id: localId,
  shopify_order_id: `gid://shopify/Order/${localId}`,
  total: 10,
  status: 'synced',
  created_at: '2026-01-01T10:00:00Z',
  payload_json: '{}',
  staff_id: null,
  payment_method: 'cash',
  tendered_amount: 10,
  change_due: 0,
  reference_number: null,
  shift_id: null,
  fiscal_invoice_number: null,
  fiscal_qr_code: null,
  fiscal_fiscalized_at: null,
  fiscal_status: null,
  fiscal_error_reason: null,
  fiscal_error_kind: null,
  fiscal_data_issue: null,
  fiscal_request_json: null,
  fiscal_vat_groups_json: null,
  fiscal_fiscalized_at_source: null,
  fiscal_cu_serial: null,
  receipt_printed_at: null
})

let container: HTMLDivElement
let root: Root

afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove()
})

async function mount(orders: OrderRow[]): Promise<void> {
  window.api = {
    getLocalOrders: vi.fn().mockResolvedValue({ success: true, data: orders })
  } as unknown as typeof window.api

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(OrderHistory, { onRetry: vi.fn(), onPrint: vi.fn() }))
    await Promise.resolve()
  })
}

function orderNumbers(): string[] {
  return Array.from(container.querySelectorAll('p')).map((p) => p.textContent ?? '').filter((t) => t.startsWith('Order #'))
}

describe('OrderHistory pagination (docs/phase-166 Commit E4)', () => {
  it(`shows exactly ${ORDER_HISTORY_PAGE_SIZE} orders per page`, async () => {
    const orders = Array.from({ length: ORDER_HISTORY_PAGE_SIZE + 4 }, (_, i) => makeOrder(i + 1))
    await mount(orders)

    expect(orderNumbers()).toHaveLength(ORDER_HISTORY_PAGE_SIZE)
    expect(container.textContent).toContain('Page 1 of 2')
  })

  it('shows no pager when everything fits on one page', async () => {
    await mount([makeOrder(1), makeOrder(2)])
    expect(container.textContent).not.toContain('Page 1 of')
  })

  it('Next reveals the remaining orders on page 2', async () => {
    const orders = Array.from({ length: ORDER_HISTORY_PAGE_SIZE + 2 }, (_, i) => makeOrder(i + 1))
    await mount(orders)

    const next = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Next')!
    await act(async () => {
      next.click()
    })

    expect(orderNumbers()).toEqual([
      `Order #${ORDER_HISTORY_PAGE_SIZE + 1}`,
      `Order #${ORDER_HISTORY_PAGE_SIZE + 2}`
    ])
  })
})
