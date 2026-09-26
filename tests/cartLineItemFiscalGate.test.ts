/**
 * `CartLineItem`'s discount/price-override controls, gated by
 * `fiscalMode` (docs/phase-160/161, fails closed per docs/phase-161-1)
 * — real mount, matching this project's established style
 * (`react-dom/client`, real DOM clicks).
 *
 * Only a confirmed `'mock'` read shows the controls. `'unknown'` (the
 * store's initial state, and where a failed/thrown read leaves it) and
 * `'live'` both hide them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import CartLineItem from '../src/renderer/src/components/CartLineItem.js'
import { useFiscalModeStore } from '../src/renderer/src/stores/fiscalModeStore.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

let container: HTMLDivElement
let root: Root

const item: CartItem = {
  id: 'gid://shopify/ProductVariant/1',
  productId: 'gid://shopify/Product/1',
  title: 'Kabras Milk 500ml',
  variantTitle: 'Default Title',
  price: 65,
  basePrice: 65,
  quantity: 1,
  image: null
}

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() =>
    root.render(
      createElement(CartLineItem, {
        item,
        onUpdateQuantity: vi.fn(),
        onRemove: vi.fn(),
        onSetPrice: vi.fn(),
        onSetDiscount: vi.fn(),
        requestManagerPin: (_title: string, onAuthorized: (managerId: number, managerPin: string) => void) =>
          onAuthorized(1, '0000'),
        showToast: vi.fn()
      })
    )
  )
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
}

beforeEach(() => {
  useFiscalModeStore.setState({ fiscalLive: 'mock', initialized: true })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useFiscalModeStore.setState({ fiscalLive: 'unknown', initialized: false })
})

describe('CartLineItem > confirmed mock mode', () => {
  it('shows both Edit Price and Discount controls, unchanged', () => {
    mount()
    expect(button('Edit Price')).toBeTruthy()
    expect(button('Discount')).toBeTruthy()
  })
})

describe('CartLineItem > live fiscal mode', () => {
  it('hides both the price-override and the line-discount controls', () => {
    useFiscalModeStore.setState({ fiscalLive: 'live' })
    mount()
    expect(button('Edit Price')).toBeUndefined()
    expect(button('Discount')).toBeUndefined()
  })
})

describe('CartLineItem > unknown mode (docs/phase-161-1: startup race / failed read)', () => {
  it('hides both controls before init has resolved (the store\'s own default)', () => {
    useFiscalModeStore.setState({ fiscalLive: 'unknown', initialized: false })
    mount()
    expect(button('Edit Price')).toBeUndefined()
    expect(button('Discount')).toBeUndefined()
  })

  it('hides both controls when a read failed and left the mode unknown', () => {
    useFiscalModeStore.setState({ fiscalLive: 'unknown', initialized: true })
    mount()
    expect(button('Edit Price')).toBeUndefined()
    expect(button('Discount')).toBeUndefined()
  })
})
