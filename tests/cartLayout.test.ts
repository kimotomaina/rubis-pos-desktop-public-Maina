/**
 * `CartLineItem` layout smoke tests — cart controls live in a dedicated
 * bottom row.
 *
 * Mounted with `react-dom/client` directly and inspected via plain DOM
 * queries, matching this project's existing "inject the real thing,
 * mock only I/O" testing style (see `useBarcodeScanner.test.ts`,
 * `VirtualNumpad.test.ts`) — no @testing-library dependency added.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import CartLineItem from '../src/renderer/src/components/CartLineItem.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

let container: HTMLDivElement
let root: Root

const baseItem: CartItem = {
  id: 'gid://shopify/ProductVariant/1',
  productId: 'gid://shopify/Product/1',
  title: 'Total Quartz 9000 5W-40',
  variantTitle: '1L',
  price: 2500,
  quantity: 2,
  image: null
}

function mount(item: CartItem = baseItem): void {
  act(() => {
    root.render(
      createElement(CartLineItem, {
        item,
        onUpdateQuantity: vi.fn(),
        onRemove: vi.fn(),
        onSetPrice: vi.fn(),
        onSetDiscount: vi.fn(),
        requestManagerPin: vi.fn(),
        showToast: vi.fn()
      })
    )
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('CartLineItem layout', () => {
  it('renders without throwing', () => {
    expect(() => mount()).not.toThrow()
  })

  it('renders the product title and variant', () => {
    mount()
    expect(container.textContent).toContain('Total Quartz 9000 5W-40')
    expect(container.textContent).toContain('1L')
  })

  it('renders an image placeholder when item.image is null', () => {
    mount()
    expect(container.querySelector('img')).toBeNull()
  })

  it('renders a real <img> when item.image is set', () => {
    mount({ ...baseItem, image: 'https://example.com/oil.jpg' })
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('https://example.com/oil.jpg')
  })

  it('puts the quantity stepper and remove button in the same bottom-row group', () => {
    mount()
    const decrease = container.querySelector(
      `[aria-label="Decrease ${baseItem.variantTitle} quantity"]`
    )
    const increase = container.querySelector(
      `[aria-label="Increase ${baseItem.variantTitle} quantity"]`
    )
    const remove = container.querySelector(`[aria-label="Remove ${baseItem.variantTitle}"]`)
    expect(decrease).not.toBeNull()
    expect(increase).not.toBeNull()
    expect(remove).not.toBeNull()

    const controlsRow = decrease?.parentElement
    expect(controlsRow).toBe(increase?.parentElement)
    expect(controlsRow).toBe(remove?.parentElement)
  })

  it('calls onUpdateQuantity when the stepper buttons are tapped', () => {
    const onUpdateQuantity = vi.fn()
    act(() => {
      root.render(
        createElement(CartLineItem, {
          item: baseItem,
          onUpdateQuantity,
          onRemove: vi.fn(),
          onSetPrice: vi.fn(),
          onSetDiscount: vi.fn(),
          requestManagerPin: vi.fn(),
          showToast: vi.fn()
        })
      )
    })

    const increase = container.querySelector(
      `[aria-label="Increase ${baseItem.variantTitle} quantity"]`
    ) as HTMLButtonElement
    act(() => increase.click())

    expect(onUpdateQuantity).toHaveBeenCalledWith(baseItem.id, baseItem.quantity + 1)
  })

  it('calls onRemove when the trash button is tapped', () => {
    const onRemove = vi.fn()
    act(() => {
      root.render(
        createElement(CartLineItem, {
          item: baseItem,
          onUpdateQuantity: vi.fn(),
          onRemove,
          onSetPrice: vi.fn(),
          onSetDiscount: vi.fn(),
          requestManagerPin: vi.fn(),
          showToast: vi.fn()
        })
      )
    })

    const remove = container.querySelector(
      `[aria-label="Remove ${baseItem.variantTitle}"]`
    ) as HTMLButtonElement
    act(() => remove.click())

    expect(onRemove).toHaveBeenCalledWith(baseItem.id)
  })

  it('renders the Edit Price and Discount action pills', () => {
    mount()
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons).toContain('Edit Price')
    expect(buttons).toContain('Discount')
  })
})
