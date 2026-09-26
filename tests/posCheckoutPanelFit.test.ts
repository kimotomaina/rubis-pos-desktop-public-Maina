/**
 * `PosCheckoutPanel` fits 1366x772 without an inner scroll (phase-146).
 *
 * phase-142/143 assumed the checkout aside needed 692px; the live
 * `check-fit` measurement (this phase) found its real natural height was
 * ~849-927px (57px customer row + 101px TOTAL block + 692px scroll body),
 * clipping the numpad's Clear row and hiding Complete Sale. This mounts
 * the real, tightened component — merged customer/TOTAL row, compact
 * numpad, no more `overflow-y-auto` — with real clicks, the
 * `setupScreens.test.ts` pattern.
 *
 * `PaymentModal.tsx` and `ManagerPinModal.tsx` needed a `.js` extension
 * added to a couple of their own relative imports to make this mountable
 * at all (`tests/**` compiles under `tsconfig.node.json`'s NodeNext
 * resolution — see `docs/phase-144.md`'s note on the same issue with
 * `AdminScreen.tsx`); those two additions are the only reason this test
 * can drive the real component instead of source-inspecting it.
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

function tap(el: HTMLElement): void {
  act(() => el.click())
}

beforeEach(() => {
  useCartStore.setState({
    items: [
      {
        id: 'gid://shopify/ProductVariant/1',
        productId: 'gid://shopify/Product/1',
        title: 'Kabras Milk 500ml',
        variantTitle: 'Default Title',
        price: 65,
        quantity: 2,
        image: null
      }
    ],
    cartDiscount: null,
    checkoutStatus: 'idle',
    checkoutError: null
  })
  useAuthStore.setState({ currentStaff: { id: 1, name: 'Cashier', role: 'cashier' } })
  useKeyboardStore.setState({ request: null })
  /**
   * Setup only, no assertion below changed (docs/phase-161-1): this
   * layout test predates the discount safeguard and has always assumed
   * the discount control is visible. docs/phase-161-1 made the store
   * fail closed - its own default is now `'unknown'`, which hides that
   * control - so a confirmed mock read is set explicitly here to keep
   * this test's own long-standing assumption true. This test is about
   * layout, not fiscal-mode gating; that gating has its own dedicated
   * coverage in `cartLineItemFiscalGate.test.ts`/
   * `posCheckoutPanelFiscalGate.test.ts`.
   */
  useFiscalModeStore.setState({ fiscalLive: 'mock', initialized: true })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useCartStore.setState({ items: [], cartDiscount: null, checkoutStatus: 'idle', checkoutError: null })
  useAuthStore.setState({ currentStaff: null })
  useFiscalModeStore.setState({ fiscalLive: 'unknown', initialized: false })
})

describe('PosCheckoutPanel fits without an inner scroll', () => {
  it('passes the compact numpad, not the default size', () => {
    mount()
    const digitKey = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '5')
    expect(digitKey).toBeTruthy()
    expect(digitKey!.className).toContain('h-12')
    expect(digitKey!.className).not.toContain('h-16')
  })

  it('no longer reserves an inner scroll region', () => {
    mount()
    expect(container.querySelector('.overflow-y-auto')).toBeNull()
    expect(container.querySelector('.overflow-hidden')).not.toBeNull()
  })

  it('merges the customer summary onto the TOTAL row', () => {
    mount()
    expect(container.textContent).toContain('TOTAL')
    expect(container.textContent).toContain('Walk-in')
    expect(container.textContent).toContain('Add KRA PIN')
  })

  it('the merged row still opens the KRA PIN keyboard, exactly as before', () => {
    mount()
    tap(button('Walk-in · Add KRA PIN'))

    const pinInput = container.querySelector('[aria-label="Customer KRA PIN"]') as HTMLInputElement
    expect(pinInput).toBeTruthy()
    tap(pinInput)

    expect(useKeyboardStore.getState().request?.label).toBe('Customer KRA PIN')
  })

  it('the merged row still opens the discount entry, exactly as before', () => {
    mount()
    tap(button('+ Discount'))

    expect(container.textContent).toContain('Apply')
    const applyButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Apply'
    )
    expect(applyButton).toBeTruthy()
  })

  it('Complete Sale is present and reachable without any element needing to scroll', () => {
    mount()
    expect(() => button('COMPLETE SALE')).not.toThrow()
  })
})
