/**
 * `PosCheckoutPanel`'s Card toggle and the embedded `CardEntryPanel`
 * (docs/phase-176.md Part 2 §3) — real mount, same pattern as
 * `posCheckoutPanelFit.test.ts`/`posCheckoutPanelFiscalGate.test.ts`.
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

let container: HTMLDivElement
let root: Root

function mount(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(createElement(PosCheckoutPanel, { requestManagerPin: vi.fn() })))
}

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
  if (!el) throw new Error(`No button "${label}"`)
  return el as HTMLButtonElement
}

function queryButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label
  ) as HTMLButtonElement | undefined
}

function tap(el: HTMLElement): void {
  act(() => el.click())
}

const plainItem = {
  id: 'gid://shopify/ProductVariant/1',
  productId: 'gid://shopify/Product/1',
  title: 'Kabras Milk 500ml',
  variantTitle: 'Default Title',
  price: 65,
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

describe('PosCheckoutPanel > three toggles', () => {
  it('renders CASH, M-PESA and CARD, all present at once', () => {
    mount()
    expect(() => button('CASH')).not.toThrow()
    expect(() => button('M-PESA')).not.toThrow()
    expect(() => button('CARD')).not.toThrow()
  })

  /**
   * `grid-cols-2` still renders all three buttons (it just wraps the
   * third onto its own row — check:fit's overflow census does not
   * catch that at any measured size, docs/phase-176.md Part 2 §3), so
   * this is the assertion that actually guards the three-equal-columns
   * layout the brief asks for.
   */
  it('lays the toggle row out as three equal columns, not a wrapped two', () => {
    mount()
    const row = button('CASH').parentElement
    expect(row?.className).toContain('grid-cols-3')
  })

  it('selecting CARD shows CardEntryPanel, not the cash numpad or PaymentModal', () => {
    mount()
    tap(button('CARD'))

    expect(container.textContent).toContain('Record card payment')
    expect(container.querySelector('[aria-label="Reference from the PDQ slip"]')).toBeTruthy()
    expect(container.textContent).not.toContain('Amount Tendered')
  })
})

describe('PosCheckoutPanel > CardEntryPanel', () => {
  it('Complete Sale is disabled with no reference and no tick', () => {
    mount()
    tap(button('CARD'))

    expect(button('Complete Sale').disabled).toBe(true)
  })

  it('stays disabled with a reference typed but the box unticked', () => {
    mount()
    tap(button('CARD'))
    const referenceField = container.querySelector(
      '[aria-label="Reference from the PDQ slip"]'
    ) as HTMLInputElement
    tap(referenceField)
    act(() => useKeyboardStore.getState().request?.onChange('TXN9001'))

    expect(button('Complete Sale').disabled).toBe(true)
  })

  it('stays disabled with the box ticked but no reference', () => {
    mount()
    tap(button('CARD'))
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    act(() => {
      checkbox.click()
    })

    expect(button('Complete Sale').disabled).toBe(true)
  })

  it('enables Complete Sale once both a reference and the tick are present', () => {
    mount()
    tap(button('CARD'))
    const referenceField = container.querySelector(
      '[aria-label="Reference from the PDQ slip"]'
    ) as HTMLInputElement
    tap(referenceField)
    act(() => useKeyboardStore.getState().request?.onChange('TXN9001'))
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    act(() => {
      checkbox.click()
    })

    expect(button('Complete Sale').disabled).toBe(false)
  })

  it('"← Change payment method" returns to Cash', () => {
    mount()
    tap(button('CARD'))
    tap(button('← Change payment method'))

    expect(container.textContent).toContain('Amount Tendered')
    expect(queryButton('Complete Sale')).toBeUndefined()
  })
})
