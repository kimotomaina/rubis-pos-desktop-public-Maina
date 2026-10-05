/**
 * `OrderHistory` scrolling tests (docs/phase-225): the list scrolls inside
 * its own region and every order renders, with no pager.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import OrderHistory from '../src/renderer/src/components/OrderHistory.js'
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
    root.render(createElement(OrderHistory, { onRetry: vi.fn(), onPrint: vi.fn(), requestManagerPin: vi.fn() }))
    await Promise.resolve()
  })
}

function orderNumbers(): string[] {
  return Array.from(container.querySelectorAll('p')).map((p) => p.textContent ?? '').filter((t) => t.startsWith('Order #'))
}

const scrollRegion = (): HTMLElement => container.querySelector('[data-testid="order-history-scroll"]') as HTMLElement

describe('OrderHistory scrolling (docs/phase-225)', () => {
  it('renders all 50 orders with no pager', async () => {
    await mount(Array.from({ length: 50 }, (_, i) => makeOrder(i + 1)))

    expect(orderNumbers()).toHaveLength(50)
    expect(container.textContent).not.toContain('Page 1 of')
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Next')).toBe(false)
  })

  it('puts every order inside the scroll region, which fills the root and can shrink', async () => {
    await mount(Array.from({ length: 50 }, (_, i) => makeOrder(i + 1)))

    const region = scrollRegion()
    expect(region.className).toContain('overflow-y-auto')
    expect(region.className).toContain('min-h-0')
    expect(region.className).toContain('flex-1')
    expect(region.className).toContain('touch-scrollbar')
    expect(region.querySelectorAll('p').length).toBeGreaterThanOrEqual(50)
    expect((region.parentElement as HTMLElement).className).toContain('flex-col')
  })

  it('is the only element in the list with vertical overflow auto or scroll', async () => {
    await mount(Array.from({ length: 50 }, (_, i) => makeOrder(i + 1)))

    const scrollers = Array.from(container.querySelectorAll('*')).filter((el) =>
      /overflow-(?:y-)?(?:auto|scroll)\b/.test(el.getAttribute('class') ?? '')
    )
    expect(scrollers).toEqual([scrollRegion()])
  })

  it('shows the fade only while more is below', async () => {
    await mount(Array.from({ length: 50 }, (_, i) => makeOrder(i + 1)))
    const fade = () => container.querySelector('[data-testid="order-history-fade"]')
    expect(fade()).toBeNull()

    const region = scrollRegion()
    Object.defineProperty(region, 'scrollHeight', { value: 5000, configurable: true })
    Object.defineProperty(region, 'clientHeight', { value: 500, configurable: true })
    region.scrollTop = 0
    await act(async () => {
      region.dispatchEvent(new Event('scroll'))
    })
    expect(fade()).not.toBeNull()

    region.scrollTop = 4500
    await act(async () => {
      region.dispatchEvent(new Event('scroll'))
    })
    expect(fade()).toBeNull()
  })
})
