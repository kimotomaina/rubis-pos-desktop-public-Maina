/**
 * `StockTakePage`'s counted-lines pagination (docs/phase-166 Commit E4).
 *
 * `paginate`/`pageOfIndex` are already proven generically in
 * `tests/paginate.test.ts` — this checks the page size and the
 * jump-to-the-just-recorded-line wiring, which only shows up once real
 * DOM re-renders are involved. Same real-mount convention as
 * `tests/stockTakePageKeypad.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import StockTakePage, { STOCK_TAKE_LINES_PER_PAGE } from '../src/renderer/src/pages/StockTakePage.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useProductStore } from '../src/renderer/src/stores/productStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import type { StockTakeSessionView } from '../src/main/services/stock-take.js'
import type { StockTakeItemRow } from '../src/main/services/database.js'

let container: HTMLDivElement
let root: Root

function ok<T>(data?: T): { success: true; data: T | undefined } {
  return { success: true, data }
}

const SESSION = {
  id: 1,
  session_uuid: 'uuid-1',
  location_id: 'gid://shopify/Location/1',
  status: 'open' as const,
  opened_at: '2026-09-01T08:00:00.000Z',
  committed_at: null,
  counted_by_staff_id: 1,
  approved_by_staff_id: null,
  second_approver_staff_id: null,
  opening_levels_json: '[]',
  shopify_response_json: null,
  committed_reference_uri: null
}

const makeItem = (n: number): StockTakeItemRow => ({
  id: n,
  session_id: 1,
  variant_id: `variant-${n}`,
  inventory_item_id: `inv-${n}`,
  variant_label: `Item ${n}`,
  unit_price_at_count: 100,
  system_snapshot_qty: 10,
  snapshot_taken_at: '2026-09-01T08:00:00.000Z',
  counted_qty: 10,
  variance: 0,
  fresh_qty_at_commit: null,
  delta_pushed: null,
  commit_status: null,
  commit_error: null
})

function stubApi(overrides: Record<string, unknown> = {}): void {
  window.api = {
    getActiveStockTake: vi.fn().mockResolvedValue(ok<StockTakeSessionView>({ session: SESSION, items: [] })),
    listStockTakes: vi.fn().mockResolvedValue(ok([])),
    getStockTakeSettings: vi
      .fn()
      .mockResolvedValue(ok({ varianceThresholdKes: 500, allowSelfApproval: false, expiryHours: 24 })),
    openStockTake: vi.fn(),
    recordStockTakeCount: vi.fn(),
    removeStockTakeCount: vi.fn(),
    submitStockTake: vi.fn(),
    previewStockTake: vi.fn().mockResolvedValue(ok(null)),
    commitStockTake: vi.fn().mockResolvedValue(ok(null)),
    abandonStockTake: vi.fn().mockResolvedValue(ok(undefined)),
    saveStockTakeSettings: vi.fn().mockResolvedValue(ok(undefined)),
    login: vi.fn().mockResolvedValue({ success: true }),
    ...overrides
  } as unknown as typeof window.api
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(StockTakePage))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function lineLabels(): string[] {
  return Array.from(container.querySelectorAll('tbody tr td:first-child')).map((td) => td.textContent ?? '')
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useKeyboardStore.setState({ request: null })
  useAuthStore.setState({
    currentStaff: { id: 1, name: 'Cashier', role: 'cashier' },
    staffList: [{ id: 9, name: 'Manager', role: 'admin' }]
  })
  useProductStore.setState({ status: 'ready', cached: false, error: undefined, products: [] })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAuthStore.setState({ currentStaff: null, staffList: [] })
  useProductStore.setState({ products: [], status: 'idle', error: undefined, cached: false })
})

describe('StockTakePage lines pagination (docs/phase-166 Commit E4)', () => {
  it(`shows exactly ${STOCK_TAKE_LINES_PER_PAGE} lines per page`, async () => {
    const items = Array.from({ length: STOCK_TAKE_LINES_PER_PAGE + 4 }, (_, i) => makeItem(i + 1))
    stubApi({
      getActiveStockTake: vi.fn().mockResolvedValue(ok<StockTakeSessionView>({ session: SESSION, items }))
    })
    await mount()

    expect(lineLabels()).toHaveLength(STOCK_TAKE_LINES_PER_PAGE)
    expect(container.textContent).toContain('Page 1 of 2')
  })

  it('shows no pager when everything fits on one page', async () => {
    stubApi({
      getActiveStockTake: vi
        .fn()
        .mockResolvedValue(ok<StockTakeSessionView>({ session: SESSION, items: [makeItem(1)] }))
    })
    await mount()
    expect(container.textContent).not.toContain('Page 1 of')
  })

  it('recording a new line jumps the table to the page holding it', async () => {
    const startingItems = Array.from({ length: STOCK_TAKE_LINES_PER_PAGE }, (_, i) => makeItem(i + 1))
    const newItem = makeItem(STOCK_TAKE_LINES_PER_PAGE + 1)
    const afterRecording = [...startingItems, newItem]

    useProductStore.setState({
      status: 'ready',
      cached: false,
      error: undefined,
      products: [
        {
          id: 'gid://shopify/Product/new',
          title: 'New Item',
          handle: 'new-item',
          featuredImage: null,
          variants: [
            {
              id: newItem.variant_id,
              productId: 'gid://shopify/Product/new',
              title: 'Default Title',
              price: 100,
              availableForSale: true,
              inventoryQuantity: 5,
              image: null,
              barcode: '000111222'
            }
          ]
        }
      ]
    })

    stubApi({
      getActiveStockTake: vi
        .fn()
        .mockResolvedValue(ok<StockTakeSessionView>({ session: SESSION, items: startingItems })),
      recordStockTakeCount: vi
        .fn()
        .mockResolvedValue(ok<StockTakeSessionView>({ session: SESSION, items: afterRecording }))
    })
    await mount()

    // Starts on page 1 — the not-yet-recorded 11th line isn't there yet.
    expect(lineLabels()).not.toContain(`Item ${STOCK_TAKE_LINES_PER_PAGE + 1}`)

    const search = container.querySelector('input[placeholder="Barcode or product name"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(search, 'New Item')
      search.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })

    const qtyLabel = Array.from(container.querySelectorAll('label')).find((l) =>
      l.textContent?.startsWith('Counted quantity for New Item')
    )!
    const qtyInput = qtyLabel.nextElementSibling as HTMLInputElement
    act(() => qtyInput.click())
    act(() => useKeyboardStore.getState().request?.onChange('5'))

    const recordButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Record count'
    )!
    await act(async () => {
      recordButton.click()
      await Promise.resolve()
    })

    expect(lineLabels()).toEqual([`Item ${STOCK_TAKE_LINES_PER_PAGE + 1}`])
    expect(container.textContent).toContain('Page 2 of 2')
  })
})
