/**
 * `PosCheckoutPanel`'s discount controls and stale-discount block, gated
 * by `fiscalMode` (docs/phase-160/161, fails closed per docs/
 * phase-161-1) — real mount, same pattern as `posCheckoutPanelFit.test.ts`.
 *
 * Confirmed mock mode (`fiscalLive: 'mock'`) must be unaffected -
 * `posCheckoutPanelFit.test.ts`'s own existing tests already cover that
 * and are left unmodified; this file adds live/unknown-mode coverage
 * plus the "already-stale cart" block.
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
  useFiscalModeStore.setState({ fiscalLive: 'mock', initialized: true })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useCartStore.setState({ items: [], cartDiscount: null, checkoutStatus: 'idle', checkoutError: null })
  useAuthStore.setState({ currentStaff: null })
  useFiscalModeStore.setState({ fiscalLive: 'unknown', initialized: false })
})

describe('PosCheckoutPanel > live fiscal mode, plain cart', () => {
  it('hides the cart-level discount control', () => {
    useFiscalModeStore.setState({ fiscalLive: 'live' })
    mount()
    expect(button('+ Discount')).toBeUndefined()
  })

  it('leaves Complete Sale reachable — nothing stale to block', () => {
    useFiscalModeStore.setState({ fiscalLive: 'live' })
    mount()
    expect(() => {
      const el = button('COMPLETE SALE')
      if (!el) throw new Error('missing')
    }).not.toThrow()
    expect(container.textContent).not.toContain('cannot yet be filed correctly')
  })
})

describe('PosCheckoutPanel > unknown mode (docs/phase-161-1: startup race / failed read)', () => {
  it('hides the cart-level discount control before init has resolved', () => {
    useFiscalModeStore.setState({ fiscalLive: 'unknown', initialized: false })
    mount()
    expect(button('+ Discount')).toBeUndefined()
  })

  it('blocks Complete Sale on a plain cart the same as live mode would, once a discount is present', () => {
    useCartStore.setState({
      items: [{ ...plainItem, discount: { type: 'percent', value: 10 } }]
    })
    useFiscalModeStore.setState({ fiscalLive: 'unknown', initialized: true })
    mount()
    expect(container.textContent).toContain('cannot yet be filed correctly')
    expect(button('COMPLETE SALE')).toBeUndefined()
  })
})

describe('PosCheckoutPanel > live fiscal mode, cart already carries a discount', () => {
  beforeEach(() => {
    useCartStore.setState({
      items: [{ ...plainItem, discount: { type: 'percent', value: 10 } }]
    })
  })

  it('replaces the payment section with a plain notice, not the Complete Sale button', () => {
    useFiscalModeStore.setState({ fiscalLive: 'live' })
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
    useFiscalModeStore.setState({ fiscalLive: 'live' })
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
    useFiscalModeStore.setState({ fiscalLive: 'live' })
    mount()
    expect(container.textContent).toContain('cannot yet be filed correctly')
    expect(button('COMPLETE SALE')).toBeUndefined()
    expect(useCartStore.getState().cartDiscount).toEqual({ type: 'fixed', value: 10 })
  })
})

describe('PosCheckoutPanel > confirmed mock mode with a discounted cart', () => {
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
