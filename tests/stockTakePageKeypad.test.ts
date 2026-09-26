/**
 * `StockTakePage`'s on-screen-keypad conversion (docs/phase-156): the
 * counted-quantity field, the second-approver KES threshold and the
 * count-expiry-hours field all became `readOnly` fields opening the
 * shared keyboard (`useKeyboardStore`), exactly like `AdminScreen.tsx`'s
 * own fields (docs/phase-155). The barcode/search box stays a plain
 * input (scanner input, same reasoning as the POS search boxes) and is
 * confirmed untouched here.
 *
 * Real mount, `react-dom/client` + real DOM clicks, matching this
 * project's established style for touch-UI components
 * (`adminScreen.test.ts`, `posCheckoutPanelFit.test.ts`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import StockTakePage from '../src/renderer/src/pages/StockTakePage.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useProductStore } from '../src/renderer/src/stores/productStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import type {
  StockTakeSessionView,
  StockTakeSettings
} from '../src/main/services/stock-take.js'

let container: HTMLDivElement
let root: Root

function ok<T>(data?: T): { success: true; data: T | undefined } {
  return { success: true, data }
}

const SETTINGS: StockTakeSettings = {
  varianceThresholdKes: 500,
  allowSelfApproval: false,
  expiryHours: 24
}

const OPEN_SESSION: StockTakeSessionView = {
  session: {
    id: 1,
    session_uuid: 'uuid-1',
    location_id: 'gid://shopify/Location/1',
    status: 'open',
    opened_at: '2026-09-01T08:00:00.000Z',
    committed_at: null,
    counted_by_staff_id: 1,
    approved_by_staff_id: null,
    second_approver_staff_id: null,
    opening_levels_json: '[]',
    shopify_response_json: null,
    committed_reference_uri: null
  },
  items: []
}

function stubApi(overrides: Record<string, unknown> = {}): void {
  window.api = {
    getActiveStockTake: vi.fn().mockResolvedValue(ok(null)),
    listStockTakes: vi.fn().mockResolvedValue(ok([])),
    getStockTakeSettings: vi.fn().mockResolvedValue(ok(SETTINGS)),
    openStockTake: vi.fn().mockResolvedValue(ok(OPEN_SESSION)),
    recordStockTakeCount: vi.fn().mockResolvedValue(ok(OPEN_SESSION)),
    removeStockTakeCount: vi.fn().mockResolvedValue(ok(OPEN_SESSION)),
    submitStockTake: vi.fn().mockResolvedValue(ok(OPEN_SESSION)),
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

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
  if (!el) throw new Error(`No button "${label}"`)
  return el as HTMLButtonElement
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
    await Promise.resolve()
  })
}

/** Finds an `<input>` immediately after a `<label>` starting with `labelText`, the `AdminScreen`-test convention. */
function inputByLabel(labelText: string): HTMLInputElement {
  const labels = Array.from(container.querySelectorAll('label'))
  const label = labels.find((l) => l.textContent?.trim().startsWith(labelText))
  if (!label) throw new Error(`No label "${labelText}"`)
  const input = label.nextElementSibling as HTMLInputElement | null
  if (!input || input.tagName !== 'INPUT') throw new Error(`No input after label "${labelText}"`)
  return input
}

/** Clicks the manager numpad's digit keys and Authorize, for the "settings" PIN gate. */
async function authorizeWithPin(pin: string): Promise<void> {
  for (const digit of pin) {
    await act(async () => {
      const key = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === digit)
      key!.click()
      await Promise.resolve()
    })
  }
  await click('Authorize')
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
  useProductStore.setState({
    status: 'ready',
    cached: false,
    error: undefined,
    products: [
      {
        id: 'gid://shopify/Product/1',
        title: 'Total Quartz 9000 5W-40',
        handle: 'total-quartz',
        featuredImage: null,
        variants: [
          {
            id: 'gid://shopify/ProductVariant/1',
            productId: 'gid://shopify/Product/1',
            title: '1L',
            price: 2500,
            availableForSale: true,
            inventoryQuantity: 10,
            image: null,
            barcode: '6001234567890'
          }
        ]
      }
    ]
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAuthStore.setState({ currentStaff: null, staffList: [] })
  useProductStore.setState({ products: [], status: 'idle', error: undefined, cached: false })
})

describe('StockTakePage > Approval policy fields — readOnly, open the keyboard with the right mode', () => {
  const cases: Array<{ label: string; mode: string }> = [
    { label: 'Second-approver limit (KES)', mode: 'decimal' },
    { label: 'Count expires after (hours)', mode: 'numeric' }
  ]

  it.each(cases)('$label — mode $mode', async ({ label, mode }) => {
    stubApi()
    await mount()

    const input = inputByLabel(label)
    expect(input.readOnly).toBe(true)
    act(() => input.click())
    expect(useKeyboardStore.getState().request?.mode ?? 'caps').toBe(mode)
  })
})

describe('StockTakePage > the scan/search box stays a plain input', () => {
  it('is not readOnly and has no keyboard wiring', async () => {
    stubApi()
    await mount()
    await click('Start stock take')

    const search = container.querySelector(
      'input[placeholder="Barcode or product name"]'
    ) as HTMLInputElement
    expect(search).toBeTruthy()
    expect(search.readOnly).toBe(false)

    act(() => search.click())
    expect(useKeyboardStore.getState().request).toBeNull()
  })
})

describe('StockTakePage > counted quantity — open a session, count an item', () => {
  /**
   * `search`'s `value` is React-controlled — dispatching a plain
   * `'input'` event after a direct `.value =` assignment is a no-op in
   * React (it diffs against its own tracked value), so this goes through
   * the native `<input>` value setter first, same as React Testing
   * Library's own `fireEvent.change` does internally.
   */
  async function mountWithSessionAndMatch(): Promise<void> {
    stubApi()
    await mount()
    await click('Start stock take')

    const search = container.querySelector(
      'input[placeholder="Barcode or product name"]'
    ) as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(search, 'Quartz')
      search.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
  }

  it('the counted-quantity field is readOnly and opens the keyboard, numeric mode', async () => {
    await mountWithSessionAndMatch()

    const qtyInput = inputByLabel('Counted quantity for Total Quartz 9000 5W-40')
    expect(qtyInput.readOnly).toBe(true)
    act(() => qtyInput.click())
    expect(useKeyboardStore.getState().request?.mode).toBe('numeric')
  })

  it('typing a count and tapping Record count sends the same integer as before', async () => {
    await mountWithSessionAndMatch()

    const qtyInput = inputByLabel('Counted quantity for Total Quartz 9000 5W-40')
    act(() => qtyInput.click())
    act(() => useKeyboardStore.getState().request?.onChange('7'))
    expect(inputByLabel('Counted quantity for Total Quartz 9000 5W-40').value).toBe('7')

    await click('Record count')
    expect(window.api.recordStockTakeCount).toHaveBeenCalledWith({
      sessionId: 1,
      variantId: 'gid://shopify/ProductVariant/1',
      variantLabel: 'Total Quartz 9000 5W-40 — 1L',
      countedQty: 7
    })
  })

  /**
   * The relay mutation check (docs/phase-156, matching phase-155's own):
   * every other test in this file drives the keyboard with one
   * `onChange(fullString)` call, which passes whether or not
   * `keyboardStore.ts`'s relay keeps `request.value` in sync. This one
   * types character by character, exactly like the real `VirtualNumpad`
   * does, reading `request.value` back between keystrokes.
   *
   * Verified: temporarily removing the relay's `set(...)` line in
   * `keyboardStore.ts` made this test fail (accumulation collapsed to
   * the last digit typed) while the single-shot test above kept passing;
   * restored immediately after, `git diff` on `keyboardStore.ts` clean.
   */
  it('consecutive keystrokes accumulate on the counted-quantity field, not just a single replacement', async () => {
    await mountWithSessionAndMatch()

    const qtyInput = inputByLabel('Counted quantity for Total Quartz 9000 5W-40')
    act(() => qtyInput.click())

    for (const digit of ['1', '2']) {
      const current = useKeyboardStore.getState().request!.value
      act(() => useKeyboardStore.getState().request!.onChange(current + digit))
    }

    expect(inputByLabel('Counted quantity for Total Quartz 9000 5W-40').value).toBe('12')
  })
})

describe('StockTakePage > Save policy — typing a threshold sends it through the manager PIN gate', () => {
  it('typing a new threshold and authorizing sends it to saveStockTakeSettings', async () => {
    stubApi()
    await mount()

    const thresholdInput = inputByLabel('Second-approver limit (KES)')
    act(() => thresholdInput.click())
    act(() => useKeyboardStore.getState().request?.onChange('750.50'))
    expect(inputByLabel('Second-approver limit (KES)').value).toBe('750.50')

    await click('Save policy')
    await authorizeWithPin('9999')

    expect(window.api.saveStockTakeSettings).toHaveBeenCalledWith(
      { varianceThresholdKes: 750.5, allowSelfApproval: false, expiryHours: 24 },
      9,
      '9999'
    )
  })
})
