/**
 * Split payments on the till screen (docs/phase-252). The "Split payment" button shows only while the setting is on; the
 * cashier records each payment through the screen a sale paid that way uses, and it must succeed there before it is
 * added; Complete sale is active only when the payments add up to the total, and sends one checkout with the whole list;
 * Hold is refused once any payment is recorded. Real mount, the same pattern as `posCheckoutPanelCard.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import PosCheckoutPanel from '../src/renderer/src/components/PosCheckoutPanel.js'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import { useFiscalModeStore } from '../src/renderer/src/stores/fiscalModeStore.js'
import { usePaymentActivityStore, isPaymentInProgress } from '../src/renderer/src/stores/paymentActivityStore.js'
import { decideHold } from '../src/renderer/src/lib/heldSale.js'
import {
  amountDue,
  canAddPayment,
  canCompleteSplit,
  maxNonCashPayment,
  splitChange
} from '../src/renderer/src/lib/splitPayments.js'

let container: HTMLDivElement
let root: Root

const item = {
  id: 'gid://shopify/ProductVariant/1',
  productId: 'gid://shopify/Product/1',
  title: 'Kabras Milk 500ml',
  variantTitle: 'Default Title',
  price: 65,
  quantity: 2,
  image: null
}

async function mount(settings: Record<string, string>): Promise<void> {
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    getAllConfigs: vi.fn().mockResolvedValue({ success: true, data: settings }),
    getMpesaCapabilities: vi.fn().mockResolvedValue({ success: true, data: { mode: 'manual', manualEntryEnabled: true, manualCodeSupported: false } }),
    checkout: vi.fn().mockResolvedValue({
      success: true,
      data: { localId: 9, mode: 'queued-offline', fiscalStatus: null, fiscalErrorReason: null, fiscalErrorKind: null, fiscalDataIssue: null }
    }),
    printReceipt: vi.fn().mockResolvedValue({ success: true })
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(PosCheckoutPanel, { requestManagerPin: vi.fn() })))
}

function queryButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined
}

function button(label: string): HTMLButtonElement {
  const el = queryButton(label)
  if (!el) throw new Error(`No button "${label}"`)
  return el
}

const tap = (el: HTMLElement): void => act(() => el.click())
const type = (digits: string): void => {
  for (const digit of digits) tap(button(digit))
}
const due = (): string => container.querySelector('[data-testid="split-due"]')?.textContent ?? ''

/** Records a card payment of `amount` through the card screen, exactly as a card sale is recorded. */
function recordCard(amount: string, reference: string): void {
  tap(button('+ Card'))
  type(amount)
  tap(button('Next'))
  tap(container.querySelector('input[aria-label="Reference from the PDQ slip"]') as HTMLInputElement)
  act(() => useKeyboardStore.getState().request?.onChange(reference))
  tap(container.querySelector('input[type="checkbox"]') as HTMLInputElement)
  tap(button('Record payment'))
}

beforeEach(() => {
  useCartStore.setState({ items: [item], cartDiscount: null, checkoutStatus: 'idle', checkoutError: null, checkoutKey: null })
  useAuthStore.setState({ currentStaff: { id: 1, name: 'Cashier', role: 'cashier' } })
  useKeyboardStore.setState({ request: null })
  useFiscalModeStore.setState({ fiscalLive: 'mock', initialized: true })
  usePaymentActivityStore.setState({ active: {} })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useCartStore.setState({ items: [], cartDiscount: null, checkoutStatus: 'idle', checkoutError: null, checkoutKey: null })
  useAuthStore.setState({ currentStaff: null })
  useFiscalModeStore.setState({ fiscalLive: 'unknown', initialized: false })
})

/**
 * CHANGED (docs/phase-252-2). OLD: the button showed only while `split_payments_enabled` was 'true'. NEW: there is no
 * setting; the button is always beside Cash, M-Pesa and Card, and an old row of the setting is ignored.
 */
describe('the Split payment button, always on the cart (docs/phase-252-2)', () => {
  const isCashSelected = (): boolean => button('CASH').className.includes('bg-rose-600')

  it('shows, enabled, with no setting row at all', async () => {
    await mount({})
    expect(button('Split payment').disabled).toBe(false)
  })

  it('shows, enabled, with an old row set to false', async () => {
    await mount({ split_payments_enabled: 'false' })
    expect(button('Split payment').disabled).toBe(false)
  })

  it('sits in the method row beside Cash, M-Pesa and Card', async () => {
    await mount({})
    const row = button('CASH').parentElement!
    expect(Array.from(row.querySelectorAll('button')).map((b) => b.textContent?.trim())).toEqual(['CASH', 'M-PESA', 'CARD', 'Split payment'])
  })

  it('a new sale starts paid one way, Cash selected, as before', async () => {
    await mount({})
    expect(isCashSelected()).toBe(true)
    expect(container.querySelector('[data-testid="split-panel"]')).toBeNull()
    expect(queryButton('COMPLETE SALE')).toBeDefined()
  })

  it('is disabled while the M-Pesa screen of a one-way sale is open', async () => {
    await mount({})
    tap(button('M-PESA'))
    expect(button('Split payment').disabled).toBe(true)
  })

  it('is disabled while the card screen of a one-way sale is open', async () => {
    await mount({})
    tap(button('CARD'))
    expect(button('Split payment').disabled).toBe(true)
  })

  it('Cancel split returns to a one-way payment, with the cart unlocked', async () => {
    await mount({})
    tap(button('Split payment'))
    recordCard('50', 'PDQ1')
    expect(useCartStore.getState().splitLocked).toBe(true)

    tap(button('Cancel split'))

    expect(container.querySelector('[data-testid="split-panel"]')).toBeNull()
    expect(isCashSelected()).toBe(true)
    expect(useCartStore.getState().splitLocked).toBe(false)
  })

  it('after a split sale completes, the next sale starts in one-way mode', async () => {
    await mount({})
    tap(button('Split payment'))
    recordCard('50', 'PDQ1')
    tap(button('+ Cash'))
    type('80')
    tap(button('Record cash'))
    await act(async () => button('COMPLETE SALE').click())

    act(() => useCartStore.setState({ items: [item] }))

    expect(container.querySelector('[data-testid="split-panel"]')).toBeNull()
    expect(isCashSelected()).toBe(true)
    expect(useCartStore.getState().splitLocked).toBe(false)
  })
})

describe('recording the payments one by one', () => {
  it('a card payment, then cash for the rest: Complete sale sends one checkout with both, change on the cash only', async () => {
    await mount({})
    tap(button('Split payment'))
    expect(button('+ Cash').disabled).toBe(true)
    expect(button('COMPLETE SALE').disabled).toBe(true)

    recordCard('50', 'PDQ1')
    expect(due()).toContain('80')
    expect(button('COMPLETE SALE').disabled).toBe(true)

    tap(button('+ Cash'))
    type('100')
    tap(button('Record cash'))
    expect(due()).toContain('0.00')
    expect(button('COMPLETE SALE').disabled).toBe(false)

    await act(async () => button('COMPLETE SALE').click())

    const api = (window as unknown as { api: { checkout: ReturnType<typeof vi.fn> } }).api
    expect(api.checkout).toHaveBeenCalledTimes(1)
    expect(api.checkout.mock.calls[0][0]).toMatchObject({
      total: 130,
      paymentMethod: 'split',
      tenderedAmount: 150,
      changeDue: 20,
      payments: [
        { method: 'card', amount: 50, cardManual: { reference: 'PDQ1', confirmRecorded: true } },
        { method: 'cash', amount: 80, tendered: 100 }
      ]
    })
  })

  it('a payment is added only once its own screen succeeds: backing out of the card screen adds nothing', async () => {
    await mount({})
    tap(button('Split payment'))
    tap(button('+ Card'))
    type('50')
    tap(button('Next'))
    tap(button('← Change payment method'))

    expect(container.querySelectorAll('[data-testid^="split-payment-"]')).toHaveLength(0)
    expect(due()).toContain('130')
  })

  it('the first M-Pesa or card payment cannot be the whole total, and none can be above what is due', async () => {
    await mount({})
    tap(button('Split payment'))
    tap(button('+ Card'))
    type('130')
    expect(button('Next').disabled).toBe(true)
  })

  it('a recorded payment can be removed, and what is due goes back up', async () => {
    await mount({})
    tap(button('Split payment'))
    recordCard('50', 'PDQ1')

    tap(container.querySelector('[aria-label="Remove Card payment"]') as HTMLButtonElement)

    expect(due()).toContain('130')
  })
})

describe('Hold', () => {
  it('is refused once any payment is recorded', async () => {
    await mount({})
    tap(button('Split payment'))
    expect(isPaymentInProgress(usePaymentActivityStore.getState().active)).toBe(false)

    recordCard('50', 'PDQ1')

    const active = usePaymentActivityStore.getState().active
    expect(active).toHaveProperty('split')
    expect(decideHold({ itemCount: 1, paymentInProgress: isPaymentInProgress(active), openHeldCount: 0, cartIsResumedSale: false }).allowed).toBe(false)
  })
})

describe('the arithmetic, in whole cents', () => {
  const legs = [
    { method: 'mpesa' as const, amount: 500 },
    { method: 'cash' as const, amount: 1000, tendered: 1200 }
  ]

  it('what is due, whether another payment can be added, and Complete sale', () => {
    expect(amountDue(1500, [legs[0]])).toBe(1000)
    expect(canAddPayment(1500, [legs[0]])).toBe(true)
    expect(canAddPayment(1500, legs)).toBe(false)
    expect(canCompleteSplit(1500, [legs[0]])).toBe(false)
    expect(canCompleteSplit(1500, legs)).toBe(true)
    expect(canCompleteSplit(1500.01, legs)).toBe(false)
    expect(splitChange(legs)).toBe(200)
  })

  it('the most the next M-Pesa or card payment may be', () => {
    expect(maxNonCashPayment(1500, [])).toBe(1499.99)
    expect(maxNonCashPayment(1500, [legs[0]])).toBe(1000)
  })

  it('no more than four payments', () => {
    const four = [1, 2, 3, 4].map(() => ({ method: 'card' as const, amount: 100 }))
    expect(canAddPayment(1000, four)).toBe(false)
  })
})
