/**
 * The cart's price-override and discount fields' on-screen-keypad
 * conversion (docs/phase-156): `CartLineItem`'s "Edit Price"/"Discount"
 * editors and `PosCheckoutPanel`'s cart-level discount editor all became
 * `readOnly` fields opening the shared keyboard (`useKeyboardStore`),
 * decimal mode — same pattern as `AdminScreen.tsx`'s fields
 * (docs/phase-155).
 *
 * Real mount, `react-dom/client` + real DOM clicks, matching
 * `cartLayout.test.ts`/`posCheckoutPanelFit.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import CartLineItem from '../src/renderer/src/components/CartLineItem.js'
import PosCheckoutPanel from '../src/renderer/src/components/PosCheckoutPanel.js'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
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
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
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

describe('CartLineItem > Edit Price', () => {
  function mountAuthorized(): { onSetPrice: ReturnType<typeof vi.fn> } {
    const onSetPrice = vi.fn()
    act(() => {
      root.render(
        createElement(CartLineItem, {
          item: baseItem,
          onUpdateQuantity: vi.fn(),
          onRemove: vi.fn(),
          onSetPrice,
          onSetDiscount: vi.fn(),
          requestManagerPin: (_title, onAuthorized) => onAuthorized(9, '9999'),
          showToast: vi.fn()
        })
      )
    })
    tap(button('Edit Price'))
    return { onSetPrice }
  }

  it('the price field is readOnly and opens the keyboard, decimal mode', () => {
    mountAuthorized()

    const input = container.querySelector('[aria-label="New price"]') as HTMLInputElement
    expect(input.readOnly).toBe(true)
    tap(input)
    expect(useKeyboardStore.getState().request?.mode).toBe('decimal')
    expect(useKeyboardStore.getState().request?.label).toBe('New price')
  })

  it('typing a new price and tapping Save sends the same value as before', () => {
    const { onSetPrice } = mountAuthorized()

    const input = container.querySelector('[aria-label="New price"]') as HTMLInputElement
    tap(input)
    act(() => useKeyboardStore.getState().request?.onChange('2600'))
    expect((container.querySelector('[aria-label="New price"]') as HTMLInputElement).value).toBe(
      '2600'
    )

    tap(button('Save'))
    expect(onSetPrice).toHaveBeenCalledWith(baseItem.id, 2600)
  })

  /**
   * Relay mutation check (docs/phase-156, same protocol as phase-155):
   * every other test here drives the keyboard with one
   * `onChange(fullString)` call, which would still pass even if
   * `keyboardStore.ts`'s relay stopped keeping `request.value` in sync.
   * This one types digit by digit, reading `request.value` back between
   * keystrokes like the real `VirtualNumpad` does.
   *
   * Verified: temporarily removing the relay's `set(...)` line in
   * `keyboardStore.ts` made this fail (accumulation collapsed to the
   * last digit) while the single-shot test above kept passing; restored
   * immediately after, `git diff` on `keyboardStore.ts` clean.
   */
  it('consecutive keystrokes accumulate on the price field, not just a single replacement', () => {
    mountAuthorized()

    const input = container.querySelector('[aria-label="New price"]') as HTMLInputElement
    tap(input)

    for (const digit of ['2', '9', '9', '9']) {
      const current = useKeyboardStore.getState().request!.value
      act(() => useKeyboardStore.getState().request!.onChange(current + digit))
    }

    // Started from the editor's pre-filled current price ('2500'), per
    // `openPriceEditor` — this proves the relay keeps appending onto
    // whatever was really typed, not just onto a stale snapshot.
    expect((container.querySelector('[aria-label="New price"]') as HTMLInputElement).value).toBe(
      '25002999'
    )
  })
})

describe('CartLineItem > Discount', () => {
  function mount(): { onSetDiscount: ReturnType<typeof vi.fn> } {
    const onSetDiscount = vi.fn()
    act(() => {
      root.render(
        createElement(CartLineItem, {
          item: baseItem,
          onUpdateQuantity: vi.fn(),
          onRemove: vi.fn(),
          onSetPrice: vi.fn(),
          onSetDiscount,
          requestManagerPin: vi.fn(),
          showToast: vi.fn()
        })
      )
    })
    tap(button('Discount'))
    return { onSetDiscount }
  }

  it('the discount field is readOnly and opens the keyboard, decimal mode', () => {
    mount()

    const input = container.querySelector('[aria-label="Discount amount"]') as HTMLInputElement
    expect(input.readOnly).toBe(true)
    tap(input)
    expect(useKeyboardStore.getState().request?.mode).toBe('decimal')
  })

  it('typing a discount and tapping Apply sends the same value as before (no manager PIN under 10%)', () => {
    const { onSetDiscount } = mount()

    const input = container.querySelector('[aria-label="Discount amount"]') as HTMLInputElement
    tap(input)
    act(() => useKeyboardStore.getState().request?.onChange('5'))

    tap(button('Apply'))
    expect(onSetDiscount).toHaveBeenCalledWith(baseItem.id, { type: 'percent', value: 5 })
  })
})

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
