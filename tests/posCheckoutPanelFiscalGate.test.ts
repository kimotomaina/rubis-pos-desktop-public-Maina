/**
 * `PosCheckoutPanel`'s discount controls and stale-discount block, gated
 * by `fiscalLive` (docs/phase-160/161) — real mount, same pattern as
 * `posCheckoutPanelFit.test.ts`.
 *
 * Mock mode (`fiscalLive: false`) must be unaffected — `posCheckoutPanelFit.test.ts`'s
 * own existing tests already cover that and are left unmodified; this
 * file adds live-mode coverage plus the "already-stale cart" block.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import PosCheckoutPanel from '../src/renderer/src/components/PosCheckoutPanel.js'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useFiscalModeStore } from '../src/renderer/src/stores/fiscalModeStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'

let container: HTMLDivElement
let root: Root

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(createElement(PosCheckoutPanel, { requestManagerPin: vi.fn() })))
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
}

const plainItem = {
  id: 'gid://shopify/ProductVariant/1',
  productId: 'gid://shopify/Product/1',
  title: 'Kabras Milk 500ml',
  variantTitle: 'Default Title',
  price: 65,
  basePrice: 65,
  quantity: 2,
  image: null
}

beforeEach(() => {
  useCartStore.setState({
    items: [plainItem],
    cartDiscount: null,
    checkoutStatus: 'idle',
    checkoutError: null
  })
  useAuthStore.setState({ currentStaff: { id: 1, name: 'Cashier', role: 'cashier' } })
  useKeyboardStore.setState({ request: null })
  useFiscalModeStore.setState({ fiscalLive: false, initialized: true })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useCartStore.setState({ items: [], cartDiscount: null, checkoutStatus: 'idle', checkoutError: null })
  useAuthStore.setState({ currentStaff: null })
  useFiscalModeStore.setState({ fiscalLive: false, initialized: false })
})

describe('PosCheckoutPanel > live fiscal mode (fiscalLive: true), plain cart', () => {
  it('hides the cart-level discount control', () => {
    useFiscalModeStore.setState({ fiscalLive: true })
    mount()
    expect(button('+ Discount')).toBeUndefined()
  })

  it('leaves Complete Sale reachable — nothing stale to block', () => {
    useFiscalModeStore.setState({ fiscalLive: true })
    mount()
    expect(() => {
      const el = button('COMPLETE SALE')
      if (!el) throw new Error('missing')
    }).not.toThrow()
    expect(container.textContent).not.toContain('cannot yet be filed correctly')
  })
})

describe('PosCheckoutPanel > live fiscal mode, cart already carries a discount', () => {
  beforeEach(() => {
    useCartStore.setState({
      items: [{ ...plainItem, discount: { type: 'percent', value: 10 } }]
    })
  })

  it('replaces the payment section with a plain notice, not the Complete Sale button', () => {
    useFiscalModeStore.setState({ fiscalLive: true })
    mount()
    expect(container.textContent).toContain('cannot yet be filed correctly')
    expect(button('COMPLETE SALE')).toBeUndefined()
  })
})

describe('PosCheckoutPanel > live fiscal mode, cart already carries a price override', () => {
  beforeEach(() => {
    useCartStore.setState({
      items: [{ ...plainItem, price: 80, basePrice: 65 }]
    })
  })

  it('replaces the payment section with a plain notice', () => {
    useFiscalModeStore.setState({ fiscalLive: true })
    mount()
    expect(container.textContent).toContain('cannot yet be filed correctly')
    expect(button('COMPLETE SALE')).toBeUndefined()
  })
})

describe('PosCheckoutPanel > live fiscal mode, cart already carries a cart-level discount', () => {
  beforeEach(() => {
    useCartStore.setState({ cartDiscount: { type: 'fixed', value: 10 } })
  })

  it('replaces the payment section with a plain notice, and does not silently drop the discount', () => {
    useFiscalModeStore.setState({ fiscalLive: true })
    mount()
    expect(container.textContent).toContain('cannot yet be filed correctly')
    expect(button('COMPLETE SALE')).toBeUndefined()
    expect(useCartStore.getState().cartDiscount).toEqual({ type: 'fixed', value: 10 })
  })
})

describe('PosCheckoutPanel > mock mode with a discounted cart (fiscalLive: false)', () => {
  it('behaves exactly as before — Complete Sale reachable, no notice', () => {
    useCartStore.setState({
      items: [{ ...plainItem, discount: { type: 'percent', value: 10 } }]
    })
    mount()
    expect(container.textContent).not.toContain('cannot yet be filed correctly')
    expect(() => {
      const el = button('COMPLETE SALE')
      if (!el) throw new Error('missing')
    }).not.toThrow()
  })
})
