/**
 * The cart is locked while a split holds a recorded payment (docs/phase-252-1): no add, remove, quantity change or
 * clear, and one line says why. Removing every payment, or cancelling the split, unlocks it. A sale paid one way is not
 * affected. Real mount: the cart table and the checkout panel side by side, wired to the cart store through the same
 * guarded actions `App.tsx` uses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import PosCheckoutPanel from '../src/renderer/src/components/PosCheckoutPanel.js'
import PosCartTable from '../src/renderer/src/components/PosCartTable.js'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import { useFiscalModeStore } from '../src/renderer/src/stores/fiscalModeStore.js'
import { usePaymentActivityStore } from '../src/renderer/src/stores/paymentActivityStore.js'
import { createGuardedCartActions, type GuardedCartActions } from '../src/renderer/src/lib/guardedCartActions.js'
import { CART_LOCKED_BY_SPLIT_MESSAGE } from '../src/renderer/src/lib/splitPayments.js'

let container: HTMLDivElement
let root: Root
let guarded: GuardedCartActions
const requestManagerPin = vi.fn()
const notify = vi.fn()

const line = { id: 'v1', productId: 'p1', title: 'Kabras Milk', variantTitle: 'Small', price: 65, quantity: 2, image: null }
const other = { id: 'v2', productId: 'p2', title: 'Bread', variantTitle: 'Loaf', price: 55, image: null }

/** The cart table and the checkout panel, with the table's actions as `App.tsx` builds them. */
function Harness() {
  const items = useCartStore((state) => state.items)
  const store = useCartStore.getState()
  guarded = createGuardedCartActions({
    getItems: () => useCartStore.getState().items,
    getCartToken: () => useCartStore.getState().cartToken,
    getStaffId: () => 1,
    requestManagerPin,
    recordRemovals: vi.fn().mockResolvedValue({ success: true }),
    apply: { setQuantity: store.updateQuantity, remove: store.removeItem, clear: store.clearCart },
    notify,
    lockedReason: () => (useCartStore.getState().splitLocked ? CART_LOCKED_BY_SPLIT_MESSAGE : null)
  })
  return createElement(
    Fragment,
    null,
    createElement(PosCartTable, { items, onUpdateQuantity: guarded.updateQuantity, onRemove: guarded.remove, onClear: guarded.clear }),
    createElement(PosCheckoutPanel, { requestManagerPin: vi.fn() })
  )
}

async function mount(): Promise<void> {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getMpesaCapabilities: vi.fn().mockResolvedValue({ success: true, data: { mode: 'manual', manualEntryEnabled: true, manualCodeSupported: false } })
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(Harness)))
}

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
  if (!el) throw new Error(`No button "${label}"`)
  return el as HTMLButtonElement
}
const byLabel = (label: string): HTMLButtonElement => container.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement
const tap = (el: HTMLElement): void => act(() => el.click())
const quantities = (): number[] => useCartStore.getState().items.map((item) => item.quantity)
const lockLine = (): string | null => container.querySelector('[data-testid="cart-locked"]')?.textContent ?? null

/** Opens the split and records one card payment of 50, through the card screen. */
function recordOneCardPayment(): void {
  tap(button('Split payment'))
  tap(button('+ Card'))
  for (const digit of '50') tap(button(digit))
  tap(button('Next'))
  tap(container.querySelector('input[aria-label="Reference from the PDQ slip"]') as HTMLInputElement)
  act(() => useKeyboardStore.getState().request?.onChange('PDQ1'))
  tap(container.querySelector('input[type="checkbox"]') as HTMLInputElement)
  tap(button('Record payment'))
}

/** Every way the cashier changes the cart: each is refused while locked, and each works once unlocked. */
function tryEveryChange(): void {
  act(() => useCartStore.getState().addItem(other))
  act(() => guarded.updateQuantity('v1', 3))
  act(() => guarded.remove('v1'))
  act(() => guarded.clear())
}

beforeEach(() => {
  useCartStore.setState({ items: [line], cartToken: 'cart-1', cartDiscount: null, checkoutStatus: 'idle', checkoutError: null, splitLocked: false })
  useAuthStore.setState({ currentStaff: { id: 1, name: 'Cashier', role: 'cashier' } })
  useKeyboardStore.setState({ request: null })
  useFiscalModeStore.setState({ fiscalLive: 'mock', initialized: true })
  usePaymentActivityStore.setState({ active: {} })
  requestManagerPin.mockClear()
  notify.mockClear()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useCartStore.setState({ items: [], cartToken: null, checkoutStatus: 'idle', checkoutError: null, splitLocked: false })
  useAuthStore.setState({ currentStaff: null })
  useFiscalModeStore.setState({ fiscalLive: 'unknown', initialized: false })
})

describe('with one payment recorded, the cart is locked', () => {
  it('an add is refused', async () => {
    await mount()
    recordOneCardPayment()

    act(() => useCartStore.getState().addItem(other))

    expect(useCartStore.getState().items.map((item) => item.id)).toEqual(['v1'])
  })

  it('a quantity change is refused, with no PIN asked, and the buttons are off', async () => {
    await mount()
    recordOneCardPayment()

    expect(byLabel('Increase Small quantity').disabled).toBe(true)
    expect(byLabel('Decrease Small quantity').disabled).toBe(true)
    act(() => guarded.updateQuantity('v1', 3))
    act(() => guarded.updateQuantity('v1', 1))

    expect(quantities()).toEqual([2])
    expect(requestManagerPin).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(CART_LOCKED_BY_SPLIT_MESSAGE)
  })

  it('a remove is refused, with no PIN asked', async () => {
    await mount()
    recordOneCardPayment()

    expect(byLabel('Remove Small').disabled).toBe(true)
    act(() => guarded.remove('v1'))

    expect(quantities()).toEqual([2])
    expect(requestManagerPin).not.toHaveBeenCalled()
  })

  it('a clear is refused, with no PIN asked', async () => {
    await mount()
    recordOneCardPayment()

    expect(button('Clear cart').disabled).toBe(true)
    act(() => guarded.clear())

    expect(quantities()).toEqual([2])
    expect(requestManagerPin).not.toHaveBeenCalled()
  })

  it('one line says why', async () => {
    await mount()
    expect(lockLine()).toBeNull()

    recordOneCardPayment()

    expect(lockLine()).toBe('Remove the recorded payments to change the cart.')
  })
})

describe('the cart unlocks', () => {
  it('when every recorded payment is removed', async () => {
    await mount()
    recordOneCardPayment()

    tap(byLabel('Remove Card payment'))
    tryEveryChange()

    expect(lockLine()).toBeNull()
    expect(useCartStore.getState().splitLocked).toBe(false)
    // The add went in and the increase too; remove and clear now ask for a manager, as they always have.
    expect(useCartStore.getState().items.map((item) => [item.id, item.quantity])).toEqual([['v1', 3], ['v2', 1]])
    expect(requestManagerPin).toHaveBeenCalledTimes(2)
  })

  it('when the split is cancelled', async () => {
    await mount()
    recordOneCardPayment()

    tap(button('Cancel split'))
    tryEveryChange()

    expect(lockLine()).toBeNull()
    expect(useCartStore.getState().items.map((item) => [item.id, item.quantity])).toEqual([['v1', 3], ['v2', 1]])
  })

  it('is not locked by an open split with no payment recorded', async () => {
    await mount()
    tap(button('Split payment'))

    act(() => useCartStore.getState().addItem(other))

    expect(useCartStore.getState().items).toHaveLength(2)
  })
})

describe('a sale paid one way is not affected', () => {
  it('on the cash screen, and on the M-Pesa screen', async () => {
    await mount()
    act(() => useCartStore.getState().addItem(other))
    expect(useCartStore.getState().items).toHaveLength(2)

    tap(button('M-PESA'))
    await act(async () => {})
    act(() => guarded.updateQuantity('v1', 3))

    expect(quantities()).toEqual([3, 1])
    expect(useCartStore.getState().splitLocked).toBe(false)
    expect(lockLine()).toBeNull()
  })
})
