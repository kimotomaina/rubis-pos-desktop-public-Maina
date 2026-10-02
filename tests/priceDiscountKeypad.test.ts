/**
 * The cart discount field's on-screen-keypad conversion (docs/phase-156):
 * `PosCheckoutPanel`'s cart-level discount editor became a `readOnly` field
 * opening the shared keyboard (`useKeyboardStore`), decimal mode — same
 * pattern as `AdminScreen.tsx`'s fields (docs/phase-155). The per-line
 * "Edit Price"/"Discount" editors this file also covered lived in
 * `CartLineItem`, deleted in docs/phase-197-1 (it was never rendered).
 *
 * Real mount, `react-dom/client` + real DOM clicks, matching
 * `posCheckoutPanelFit.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import PosCheckoutPanel from '../src/renderer/src/components/PosCheckoutPanel.js'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import { useFiscalModeStore } from '../src/renderer/src/stores/fiscalModeStore.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

let container: HTMLDivElement
let root: Root

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
  if (!el) throw new Error(`No button "${label}"`)
  return el as HTMLButtonElement
}

function tap(el: HTMLElement): void {
  act(() => el.click())
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useKeyboardStore.setState({ request: null })
  /**
   * Setup only, no assertion below changed (docs/phase-161-1): this
   * keyboard-conversion test (docs/phase-156) predates the discount
   * safeguard and has always assumed the "+ Discount" control is visible
   * and clickable. docs/phase-161-1
   * made the store fail closed - its own default is now `'unknown'`,
   * which hides them - so a confirmed mock read is set explicitly to
   * keep this test's long-standing assumption true. This test is about
   * the on-screen-keyboard conversion, not fiscal-mode gating; that has
   * its own dedicated coverage in `posCheckoutPanelFiscalGate.test.ts`.
   */
  useFiscalModeStore.setState({ fiscalLive: 'mock', initialized: true })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useFiscalModeStore.setState({ fiscalLive: 'unknown', initialized: false })
})

const baseItem: CartItem = {
  id: 'gid://shopify/ProductVariant/1',
  productId: 'gid://shopify/Product/1',
  title: 'Total Quartz 9000 5W-40',
  variantTitle: '1L',
  price: 2500,
  quantity: 2,
  basePrice: 2500,
  image: null
}

describe('PosCheckoutPanel > cart discount', () => {
  beforeEach(() => {
    useCartStore.setState({
      items: [{ ...baseItem }],
      cartDiscount: null,
      checkoutStatus: 'idle',
      checkoutError: null
    })
    useAuthStore.setState({ currentStaff: { id: 1, name: 'Cashier', role: 'cashier' } })
  })

  afterEach(() => {
    useCartStore.setState({ items: [], cartDiscount: null, checkoutStatus: 'idle', checkoutError: null })
    useAuthStore.setState({ currentStaff: null })
  })

  function mount(): void {
    act(() => {
      root.render(createElement(PosCheckoutPanel, { requestManagerPin: vi.fn() }))
    })
    tap(button('+ Discount'))
  }

  it('the discount field is readOnly and opens the keyboard, decimal mode', () => {
    mount()

    const input = container.querySelector('[aria-label="Discount amount"]') as HTMLInputElement
    expect(input.readOnly).toBe(true)
    tap(input)
    expect(useKeyboardStore.getState().request?.mode).toBe('decimal')
  })

  it('typing a discount (under the 10% manager-PIN threshold) and tapping Apply sends the same value as before', () => {
    mount()

    const input = container.querySelector('[aria-label="Discount amount"]') as HTMLInputElement
    tap(input)
    act(() => useKeyboardStore.getState().request?.onChange('7.5'))
    expect((container.querySelector('[aria-label="Discount amount"]') as HTMLInputElement).value).toBe(
      '7.5'
    )

    tap(button('Apply'))
    expect(useCartStore.getState().cartDiscount).toEqual({ type: 'percent', value: 7.5 })
  })
})
