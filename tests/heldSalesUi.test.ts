/**
 * Holding a sale on the till's screen (docs/phase-217): the held-sales store
 * against a real database, the strip and its ageing, the payment-in-progress
 * signal, the checkout panel's reset after a hold, the Log Out warning, the
 * Hold button, and the End of Day list.
 *
 * `window.api` here is a shim over the real main-process services and a real
 * in-memory database, so the store and the rules are exercised together.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RubisDatabase } from '../src/main/services/database.js'
import { hashPin } from '../src/main/services/auth.js'
import { discardHeldSaleApproved, holdCart } from '../src/main/services/held-sales.js'
import { discardHeldSaleSchema, holdSaleSchema, validate } from '../src/main/lib/ipcValidator.js'
import HeldSalesStrip from '../src/renderer/src/components/HeldSalesStrip.js'
import LogoutHeldWarning from '../src/renderer/src/components/LogoutHeldWarning.js'
import PaymentModal from '../src/renderer/src/components/PaymentModal.js'
import CardEntryPanel from '../src/renderer/src/components/CardEntryPanel.js'
import PosCheckoutPanel from '../src/renderer/src/components/PosCheckoutPanel.js'
import PosCartTable from '../src/renderer/src/components/PosCartTable.js'
import EndOfDayPage from '../src/renderer/src/pages/EndOfDayPage.js'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useHeldSalesStore } from '../src/renderer/src/stores/heldSalesStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import { useToastStore } from '../src/renderer/src/stores/toastStore.js'
import { useFiscalModeStore } from '../src/renderer/src/stores/fiscalModeStore.js'
import { usePaymentActivityStore, isPaymentInProgress } from '../src/renderer/src/stores/paymentActivityStore.js'
import {
  HELD_AMBER_AFTER_MS,
  HELD_RED_AFTER_MS,
  HOLD_LIMIT_REASON,
  HOLD_PAYMENT_REASON,
  RESUME_CART_NOT_EMPTY_REASON,
  closeShiftBlockedMessage,
  decideHold,
  decideResume,
  formatHeldAge,
  heldAgeTone,
  parseHeldPayload
} from '../src/renderer/src/lib/heldSale.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'
import type { EndOfDayReport } from '../src/main/services/reports.js'

const mug: CartItem = {
  id: 'v1',
  productId: 'p1',
  title: 'Mug',
  variantTitle: 'Small',
  price: 55,
  basePrice: 60,
  quantity: 2,
  image: null,
  discount: { type: 'percent', value: 10 }
}
const milk: CartItem = { id: 'v2', productId: 'p2', title: 'Milk', variantTitle: 'Default Title', price: 65, quantity: 1, image: null }

let db: RubisDatabase
let cashierId: number
let managerId: number
let container: HTMLDivElement
let root: Root
let checkout: ReturnType<typeof vi.fn>

function installApi(extra: Record<string, unknown> = {}): void {
  checkout = vi.fn()
  window.api = {
    checkout,
    listHeldSales: async () => ({ success: true, data: db.listOpenHeldSales() }),
    holdSale: async (request: unknown) => {
      const checked = validate(holdSaleSchema, request)
      return checked.success ? holdCart(db, checked.data) : { success: false, error: checked.error }
    },
    resumeHeldSale: async (id: number) => {
      try {
        return { success: true, data: db.resumeHeldSale(id) }
      } catch (err) {
        return { success: false, error: (err as Error).message }
      }
    },
    renameHeldSale: async (id: number, label: string) => {
      try {
        return { success: true, data: db.renameHeldSale(id, label) }
      } catch (err) {
        return { success: false, error: (err as Error).message }
      }
    },
    discardHeldSale: async (request: unknown) => {
      const checked = validate(discardHeldSaleSchema, request)
      return checked.success ? discardHeldSaleApproved(db, checked.data) : { success: false, error: checked.error }
    },
    getMpesaCapabilities: vi.fn().mockResolvedValue({ success: true, data: { mode: 'manual', manualEntryEnabled: true } }),
    initiateMpesaStkPush: vi.fn().mockResolvedValue({ success: true, data: { checkoutRequestId: 'ws_CO_1', merchantRequestId: 'm1' } }),
    logMpesaTransaction: vi.fn().mockResolvedValue({ success: true }),
    queryMpesaStatus: vi.fn().mockResolvedValue({ success: true, data: { status: 'pending' } }),
    ...extra
  } as unknown as typeof window.api
}

function fillCart(items: CartItem[] = [mug, milk], token = 'cart-live'): void {
  useCartStore.setState({
    items,
    cartToken: token,
    cartDiscount: { type: 'fixed', value: 5 },
    customerPin: 'P051234567Z',
    companyName: 'ACME TRADERS LTD',
    resumedHeld: null,
    checkoutStatus: 'idle'
  })
}

beforeEach(() => {
  db = new RubisDatabase({ dbPath: ':memory:' })
  db.init()
  cashierId = db.createStaff({ name: 'Cash', pinHash: hashPin('1111'), role: 'cashier' }).staffId
  managerId = db.createStaff({ name: 'Mgr', pinHash: hashPin('2222'), role: 'admin' }).staffId
  installApi()
  useCartStore.getState().clearCart()
  useHeldSalesStore.setState({ sales: [], resetEpoch: 0 })
  usePaymentActivityStore.setState({ active: {} })
  useKeyboardStore.setState({ request: null })
  useToastStore.setState({ toasts: [] } as never)
  useAuthStore.setState({ currentStaff: { id: cashierId, name: 'Cash', role: 'cashier' }, staffList: [] })
  useFiscalModeStore.setState({ fiscalLive: 'mock', initialized: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  db.close()
  vi.useRealTimers()
  useFiscalModeStore.setState({ fiscalLive: 'unknown', initialized: false })
})

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function button(label: string | RegExp): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) =>
    typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? '')
  )
  if (!el) throw new Error(`No button ${String(label)}`)
  return el as HTMLButtonElement
}

function byLabel(label: string): HTMLButtonElement {
  const el = container.querySelector(`button[aria-label="${label}"]`)
  if (!el) throw new Error(`No button labelled "${label}"`)
  return el as HTMLButtonElement
}

describe('the pure rules', () => {
  it('a held sale is normal under 5 minutes, amber from 5, red from 15', () => {
    const now = Date.parse('2026-10-03T12:00:00.000Z')
    const heldAt = (ms: number): string => new Date(now - ms).toISOString()

    expect(heldAgeTone(heldAt(0), now)).toBe('normal')
    expect(heldAgeTone(heldAt(HELD_AMBER_AFTER_MS - 1), now)).toBe('normal')
    expect(heldAgeTone(heldAt(HELD_AMBER_AFTER_MS), now)).toBe('amber')
    expect(heldAgeTone(heldAt(HELD_RED_AFTER_MS - 1), now)).toBe('amber')
    expect(heldAgeTone(heldAt(HELD_RED_AFTER_MS), now)).toBe('red')
    expect(HELD_AMBER_AFTER_MS).toBe(5 * 60_000)
    expect(HELD_RED_AFTER_MS).toBe(15 * 60_000)
  })

  it('formats how long a sale has been held', () => {
    const now = Date.parse('2026-10-03T12:00:00.000Z')
    const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()

    expect(formatHeldAge(ago(0), now)).toBe('just now')
    expect(formatHeldAge(ago(4), now)).toBe('4 min')
    expect(formatHeldAge(ago(65), now)).toBe('1 h 05')
  })

  it('refuses a hold while a payment is in progress, on a full till, and on an empty cart', () => {
    const base = { itemCount: 2, paymentInProgress: false, openHeldCount: 0, cartIsResumedSale: false }

    expect(decideHold(base)).toEqual({ allowed: true })
    expect(decideHold({ ...base, paymentInProgress: true })).toEqual({ allowed: false, reason: HOLD_PAYMENT_REASON })
    expect(decideHold({ ...base, openHeldCount: 3 })).toEqual({ allowed: false, reason: HOLD_LIMIT_REASON })
    expect(decideHold({ ...base, itemCount: 0 }).allowed).toBe(false)
    expect(decideHold({ ...base, openHeldCount: 3, cartIsResumedSale: true })).toEqual({ allowed: true })
  })

  it('resumes only onto an empty cart', () => {
    expect(decideResume(0)).toEqual({ allowed: true })
    expect(decideResume(1)).toEqual({ allowed: false, reason: RESUME_CART_NOT_EMPTY_REASON })
  })

  it('reads a stored cart back, and refuses an unreadable one', () => {
    const json = JSON.stringify({ items: [mug], cartDiscount: { type: 'fixed', value: 5 }, customerPin: 'P1', companyName: 'ACME' })

    expect(parseHeldPayload(json)).toEqual({ items: [mug], cartDiscount: { type: 'fixed', value: 5 }, customerPin: 'P1', companyName: 'ACME' })
    expect(parseHeldPayload('not json')).toBeNull()
    expect(parseHeldPayload(JSON.stringify({ items: [] }))).toBeNull()
    expect(parseHeldPayload(JSON.stringify({ items: [{ id: 'x', price: 1, quantity: 0 }] }))).toBeNull()
  })

  it('says why Close Shift is refused, naming each held sale', () => {
    expect(closeShiftBlockedMessage([])).toBeNull()
    expect(closeShiftBlockedMessage([{ label: 'Customer 1', total: 163 }])).toBe(
      '1 sale is on hold: Customer 1 (163.00). Complete or discard it before closing the shift.'
    )
    expect(closeShiftBlockedMessage([{ label: 'A', total: 1 }, { label: 'B', total: 2 }])).toContain('2 sales are on hold: A (1.00), B (2.00)')
  })
})

describe('holding and resuming through the store', () => {
  it('hold parks the cart and leaves a fresh empty one; resume brings back every line, price, discount, customer and token exactly', async () => {
    fillCart()

    const held = await useHeldSalesStore.getState().hold(cashierId)
    const afterHold = useCartStore.getState()

    expect(held).toEqual({ ok: true })
    expect(afterHold.items).toEqual([])
    expect(afterHold.cartToken).toBeNull()
    expect(afterHold.cartDiscount).toBeNull()
    expect(afterHold.customerPin).toBe('')
    expect(afterHold.companyName).toBe('')
    expect(useHeldSalesStore.getState().sales).toHaveLength(1)

    const id = useHeldSalesStore.getState().sales[0].id
    const resumed = await useHeldSalesStore.getState().resume(id)
    const back = useCartStore.getState()

    expect(resumed).toEqual({ ok: true })
    expect(back.items).toEqual([mug, milk])
    expect(back.items[0].price).toBe(55)
    expect(back.items[0].basePrice).toBe(60)
    expect(back.cartDiscount).toEqual({ type: 'fixed', value: 5 })
    expect(back.customerPin).toBe('P051234567Z')
    expect(back.companyName).toBe('ACME TRADERS LTD')
    expect(back.cartToken).toBe('cart-live')
    expect(back.resumedHeld).toEqual({ id, label: 'Customer 1' })
  })

  it('sends nothing to the fiscal provider or Shopify: checkout is never called, no order, no queue row, no trader number', async () => {
    fillCart()

    await useHeldSalesStore.getState().hold(cashierId)
    await useHeldSalesStore.getState().resume(useHeldSalesStore.getState().sales[0].id)

    const conn = (db as unknown as { conn: { prepare: (s: string) => { get: () => { n: number } } } }).conn
    expect(checkout).not.toHaveBeenCalled()
    expect(conn.prepare('SELECT COUNT(*) AS n FROM orders').get().n).toBe(0)
    expect(conn.prepare('SELECT COUNT(*) AS n FROM sync_queue').get().n).toBe(0)
    expect(db.getSetting('last_trader_seq')).toBeUndefined()
  })

  it('refuses a hold while a payment is in progress, and leaves the cart as it was', async () => {
    fillCart()
    usePaymentActivityStore.getState().setActive('mpesa', true)

    const held = await useHeldSalesStore.getState().hold(cashierId)

    expect(held).toEqual({ ok: false, error: HOLD_PAYMENT_REASON })
    expect(useCartStore.getState().items).toHaveLength(2)
    expect(db.listOpenHeldSales()).toHaveLength(0)
  })

  it('refuses a fourth hold with the limit message', async () => {
    for (const token of ['a', 'b', 'c']) {
      fillCart([milk], token)
      await useHeldSalesStore.getState().hold(cashierId)
    }
    fillCart([mug], 'd')

    const fourth = await useHeldSalesStore.getState().hold(cashierId)

    expect(fourth).toEqual({ ok: false, error: HOLD_LIMIT_REASON })
    expect(useCartStore.getState().items).toEqual([mug])
    expect(db.listOpenHeldSales()).toHaveLength(3)
  })

  it('refuses a resume onto a non-empty cart, and the sale stays held', async () => {
    fillCart([milk], 'a')
    await useHeldSalesStore.getState().hold(cashierId)
    fillCart([mug], 'b')

    const resumed = await useHeldSalesStore.getState().resume(useHeldSalesStore.getState().sales[0].id)

    expect(resumed).toEqual({ ok: false, error: RESUME_CART_NOT_EMPTY_REASON })
    expect(useCartStore.getState().items).toEqual([mug])
    expect(db.listOpenHeldSales()[0].status).toBe('held')
  })

  it('a resumed sale that is held again reuses its label even when the till is full', async () => {
    for (const token of ['a', 'b', 'c']) {
      fillCart([milk], token)
      await useHeldSalesStore.getState().hold(cashierId)
    }
    await useHeldSalesStore.getState().resume(useHeldSalesStore.getState().sales[1].id)

    const again = await useHeldSalesStore.getState().hold(cashierId)

    expect(again).toEqual({ ok: true })
    expect(useHeldSalesStore.getState().sales.map((sale) => sale.label).sort()).toEqual(['Customer 1', 'Customer 2', 'Customer 3'])
  })

  it('a completed sale clears the resumed marker and the checkout reads the cart token held with it', async () => {
    fillCart()
    await useHeldSalesStore.getState().hold(cashierId)
    await useHeldSalesStore.getState().resume(useHeldSalesStore.getState().sales[0].id)
    window.api.checkout = vi.fn().mockResolvedValue({ success: true, data: { localId: 7, mode: 'synced' } }) as never
    window.api.printReceipt = vi.fn().mockResolvedValue({ success: true, data: { printed: true } }) as never

    await useCartStore.getState().checkout({ staffId: cashierId, paymentMethod: 'cash', tenderedAmount: 200, changeDue: 37 })

    const request = (window.api.checkout as ReturnType<typeof vi.fn>).mock.calls[0][0] as { cartToken: string }
    expect(request.cartToken).toBe('cart-live')
    expect(useCartStore.getState().resumedHeld).toBeNull()
    expect(useCartStore.getState().items).toEqual([])
  })
})

describe('the payment-in-progress signal', () => {
  async function mountPayment(element: ReturnType<typeof createElement>): Promise<void> {
    await act(async () => {
      root.render(element)
      await Promise.resolve()
    })
  }

  it('is set while a manual M-Pesa code is typed, and cleared when the panel goes away', async () => {
    await mountPayment(createElement(PaymentModal, { total: 100, onPaid: vi.fn(), onCancel: vi.fn() }))
    expect(isPaymentInProgress(usePaymentActivityStore.getState().active)).toBe(false)

    await act(async () => {
      container.querySelector<HTMLInputElement>('input[aria-label^="M-Pesa code"]')!.click()
    })
    await act(async () => useKeyboardStore.getState().request!.onChange('QDF73'))
    expect(usePaymentActivityStore.getState().active).toEqual({ mpesa: true })

    fillCart()
    expect(await useHeldSalesStore.getState().hold(cashierId)).toEqual({ ok: false, error: HOLD_PAYMENT_REASON })

    await mountPayment(createElement('div'))
    expect(isPaymentInProgress(usePaymentActivityStore.getState().active)).toBe(false)
  })

  it('is set while a Daraja push is waiting for confirmation, and Hold is refused', async () => {
    await mountPayment(
      createElement(PaymentModal, {
        total: 100,
        onPaid: vi.fn(),
        onCancel: vi.fn(),
        forcedCapabilities: { status: 'ready', mode: 'daraja', manualEntryEnabled: false }
      })
    )
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[aria-label="Phone Number"]')!.click()
    })
    await act(async () => useKeyboardStore.getState().request!.onChange('712345678'))
    expect(isPaymentInProgress(usePaymentActivityStore.getState().active)).toBe(false)

    await act(async () => {
      button('Send Request').click()
      await Promise.resolve()
      await Promise.resolve()
    })
    await flush()

    expect(container.textContent).toContain('Waiting for M-Pesa Confirmation')
    expect(usePaymentActivityStore.getState().active).toEqual({ mpesa: true })
    fillCart()
    expect(await useHeldSalesStore.getState().hold(cashierId)).toEqual({ ok: false, error: HOLD_PAYMENT_REASON })
    expect(db.listOpenHeldSales()).toHaveLength(0)
  })

  it('is set while a card reference is typed', async () => {
    await mountPayment(createElement(CardEntryPanel, { total: 100, onPaid: vi.fn(), onCancel: vi.fn() }))
    expect(isPaymentInProgress(usePaymentActivityStore.getState().active)).toBe(false)

    await act(async () => {
      container.querySelector<HTMLInputElement>('input[aria-label^="Reference"]')!.click()
    })
    await act(async () => useKeyboardStore.getState().request!.onChange('TXN9001'))

    expect(usePaymentActivityStore.getState().active).toEqual({ card: true })
  })

  it('shows a resumed sale\'s label and total in large type above the code field', async () => {
    await mountPayment(createElement(PaymentModal, { total: 163, onPaid: vi.fn(), onCancel: vi.fn(), heldLabel: 'lady in red' }))

    const banner = container.querySelector('[data-testid="held-sale-banner"]')!
    const field = container.querySelector('input[aria-label^="M-Pesa code"]')!

    expect(banner.textContent).toContain('lady in red')
    expect(banner.textContent).toContain('163')
    expect(banner.className).toContain('text-2xl')
    expect(banner.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows no banner for an ordinary sale', async () => {
    await mountPayment(createElement(PaymentModal, { total: 163, onPaid: vi.fn(), onCancel: vi.fn() }))

    expect(container.querySelector('[data-testid="held-sale-banner"]')).toBeNull()
  })
})

describe('the checkout panel after a hold', () => {
  it('goes back to Cash: a sale held with M-Pesa selected does not leave M-Pesa showing over the next customer', async () => {
    fillCart()
    await act(async () => {
      root.render(createElement(PosCheckoutPanel, { requestManagerPin: vi.fn() }))
      await Promise.resolve()
    })
    await act(async () => {
      button('M-PESA').click()
      await Promise.resolve()
    })
    await flush()
    expect(container.textContent).toContain('Record M-Pesa payment')

    await act(async () => {
      await useHeldSalesStore.getState().hold(cashierId)
    })
    await flush()

    expect(container.textContent).not.toContain('Record M-Pesa payment')
    expect(container.textContent).toContain('Amount Tendered')
    expect(container.textContent).toContain('COMPLETE SALE')
  })

  it('clears the amount tendered and the customer fields, so nothing of the last customer shows', async () => {
    fillCart()
    await act(async () => {
      root.render(createElement(PosCheckoutPanel, { requestManagerPin: vi.fn() }))
      await Promise.resolve()
    })
    expect(container.textContent).toContain('P051234567Z')

    await act(async () => {
      await useHeldSalesStore.getState().hold(cashierId)
    })
    await flush()

    expect(container.textContent).not.toContain('P051234567Z')
    expect(container.textContent).not.toContain('ACME')
    expect(container.textContent).toContain('Walk-in · Add KRA PIN')
  })
})

describe('the Hold button', () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ ...milk, id: `v${i}`, title: `Item ${i}` }))

  function mountTable(props: Record<string, unknown>): void {
    act(() => {
      root.render(
        createElement(PosCartTable, { items, onUpdateQuantity: vi.fn(), onRemove: vi.fn(), onClear: vi.fn(), ...props })
      )
    })
  }

  it('is next to Clear cart and calls onHold', () => {
    const onHold = vi.fn()
    mountTable({ onHold, holdBlockedReason: null })

    act(() => button('Hold sale').click())

    expect(onHold).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Clear cart')
  })

  it('is disabled with its reason shown while Hold is not allowed', () => {
    const onHold = vi.fn()
    mountTable({ onHold, holdBlockedReason: HOLD_PAYMENT_REASON })

    expect(button('Hold sale').disabled).toBe(true)
    expect(container.textContent).toContain(HOLD_PAYMENT_REASON)
  })

  it('is absent when no onHold is given, and the table keeps 7 lines a page by default and 6 with the strip showing', () => {
    mountTable({})
    expect(container.textContent).not.toContain('Hold sale')
    expect(container.querySelectorAll('tbody tr')).toHaveLength(7)

    mountTable({ linesPerPage: 6 })
    expect(container.querySelectorAll('tbody tr')).toHaveLength(6)
  })
})

describe('the held-sales strip', () => {
  async function seedHeld(count: number, ageMs = 0): Promise<void> {
    for (let i = 0; i < count; i++) {
      fillCart([milk], `seed-${i}`)
      await useHeldSalesStore.getState().hold(cashierId)
    }
    if (ageMs > 0) {
      const conn = (db as unknown as { conn: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).conn
      conn.prepare('UPDATE held_sales SET held_at = ?').run(new Date(Date.now() - ageMs).toISOString())
      await useHeldSalesStore.getState().load()
    }
    useCartStore.getState().clearCart()
  }

  async function mountStrip(requestManagerPin = vi.fn()): Promise<void> {
    await act(async () => {
      root.render(createElement(HeldSalesStrip, { requestManagerPin }))
      await Promise.resolve()
    })
  }

  it('renders nothing with no held sales, and one card each (up to three) with label, total and items', async () => {
    await mountStrip()
    expect(container.querySelector('[data-testid="held-sales-strip"]')).toBeNull()

    await seedHeld(3)
    await mountStrip()

    const cards = container.querySelectorAll('[data-testid="held-sale-card"]')
    expect(cards).toHaveLength(3)
    expect(cards[0].textContent).toContain('Customer 1')
    expect(cards[0].textContent).toContain('60.00')
    expect(cards[0].textContent).toContain('1 item')
  })

  it('cannot be closed or collapsed: its only controls are resume, rename and discard', async () => {
    await seedHeld(2)
    await mountStrip()

    const labels = Array.from(container.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? '')

    expect(labels).toHaveLength(6)
    expect(labels.every((label) => /^(Resume|Rename|Discard) /.test(label))).toBe(true)
  })

  it('turns amber at 5 minutes and red at 15 as time passes', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'))
    await seedHeld(1)
    await mountStrip()
    const tone = (): string | null => container.querySelector('[data-testid="held-sale-card"]')!.getAttribute('data-tone')

    expect(tone()).toBe('normal')

    await act(async () => {
      vi.advanceTimersByTime(HELD_AMBER_AFTER_MS)
    })
    expect(tone()).toBe('amber')

    await act(async () => {
      vi.advanceTimersByTime(HELD_RED_AFTER_MS - HELD_AMBER_AFTER_MS)
    })
    expect(tone()).toBe('red')
  })

  it('resumes onto an empty cart with one tap', async () => {
    await seedHeld(1)
    await mountStrip()

    await act(async () => {
      byLabel('Resume Customer 1').click()
      await Promise.resolve()
    })
    await flush()

    expect(useCartStore.getState().items).toEqual([milk])
    expect(useCartStore.getState().resumedHeld?.label).toBe('Customer 1')
  })

  it('offers to hold the current cart first when it is not empty, and then does both', async () => {
    await seedHeld(1)
    fillCart([mug], 'current')
    await mountStrip()

    await act(async () => {
      byLabel('Resume Customer 1').click()
    })
    expect(container.textContent).toContain('Hold the current cart first?')
    expect(useCartStore.getState().items).toEqual([mug])

    await act(async () => {
      button('Hold it and resume').click()
      await Promise.resolve()
    })
    await flush()
    await flush()

    expect(useCartStore.getState().items).toEqual([milk])
    expect(db.listOpenHeldSales().map((sale) => [sale.label, sale.status])).toEqual([
      ['Customer 1', 'resumed'],
      ['Customer 2', 'held']
    ])
  })

  it('renames through the on-screen keyboard and saves when it closes', async () => {
    await seedHeld(1)
    await mountStrip()

    await act(async () => {
      byLabel('Rename Customer 1').click()
    })
    expect(useKeyboardStore.getState().request?.mode).toBe('text')
    await act(async () => useKeyboardStore.getState().request!.onChange('lady in red'))
    await act(async () => useKeyboardStore.getState().close())
    await flush()

    expect(db.listOpenHeldSales()[0].label).toBe('lady in red')
  })

  it('discarding asks for a reason, then a manager PIN, then records who, why and the manager', async () => {
    await seedHeld(1)
    const requestManagerPin = vi.fn()
    await mountStrip(requestManagerPin)

    await act(async () => {
      byLabel('Discard Customer 1').click()
    })
    expect(container.textContent).toContain('may already have paid')
    expect(button('Continue').disabled).toBe(true)

    await act(async () => {
      container.querySelector<HTMLInputElement>('input[aria-label="Reason for discarding this held sale"]')!.click()
    })
    await act(async () => useKeyboardStore.getState().request!.onChange('customer left without paying'))
    expect(button('Continue').disabled).toBe(false)
    await act(async () => {
      button('Continue').click()
    })

    expect(requestManagerPin).toHaveBeenCalledTimes(1)
    expect(requestManagerPin.mock.calls[0][0]).toContain('Customer 1')
    expect(db.listOpenHeldSales()).toHaveLength(1)

    await act(async () => {
      requestManagerPin.mock.calls[0][1](managerId, '2222')
      await Promise.resolve()
    })
    await flush()

    expect(db.listOpenHeldSales()).toHaveLength(0)
    const conn = (db as unknown as { conn: { prepare: (s: string) => { get: () => Record<string, unknown> } } }).conn
    expect(conn.prepare('SELECT status, discard_reason, discard_manager_id, discarded_by_staff_id FROM held_sales').get()).toEqual({
      status: 'discarded',
      discard_reason: 'customer left without paying',
      discard_manager_id: managerId,
      discarded_by_staff_id: cashierId
    })
  })

  it('a wrong manager PIN discards nothing and says so', async () => {
    await seedHeld(1)
    const requestManagerPin = vi.fn()
    await mountStrip(requestManagerPin)
    await act(async () => {
      byLabel('Discard Customer 1').click()
    })
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[aria-label="Reason for discarding this held sale"]')!.click()
    })
    await act(async () => useKeyboardStore.getState().request!.onChange('left'))
    await act(async () => {
      button('Continue').click()
    })

    await act(async () => {
      requestManagerPin.mock.calls[0][1](managerId, '0000')
      await Promise.resolve()
    })
    await flush()

    expect(db.listOpenHeldSales()).toHaveLength(1)
    expect(useToastStore.getState().toasts.some((toast) => toast.id === 'held-sale-notice')).toBe(true)
  })
})

describe('Log Out with sales held', () => {
  it('lists them, says they stay for the next cashier, and still lets the cashier log out', () => {
    const onLogout = vi.fn()
    const onStay = vi.fn()
    act(() => {
      root.render(
        createElement(LogoutHeldWarning, {
          sales: [
            { id: 1, cartToken: 'a', label: 'Customer 1', total: 163, lineCount: 2, unitCount: 3, heldAt: '2026-10-03T12:00:00.000Z', heldByStaffId: 1, status: 'held' },
            { id: 2, cartToken: 'b', label: 'lady in red', total: 65, lineCount: 1, unitCount: 1, heldAt: '2026-10-03T12:01:00.000Z', heldByStaffId: 1, status: 'resumed' }
          ],
          onLogout,
          onStay
        })
      )
    })

    expect(container.textContent).toContain('2 sales are on hold')
    expect(container.textContent).toContain('Customer 1')
    expect(container.textContent).toContain('lady in red (on screen)')
    expect(container.textContent).toContain('These stay on the till for the next cashier.')

    act(() => button('Log out').click())
    expect(onLogout).toHaveBeenCalledTimes(1)
    act(() => button('Stay').click())
    expect(onStay).toHaveBeenCalledTimes(1)
  })
})

describe('End of Day: held sales discarded', () => {
  function report(): EndOfDayReport {
    return {
      localDay: '2026-10-03',
      cashiers: [],
      totalsByMethod: { cash: 0, mpesa: 0, card: 0 },
      manualEntries: [],
      carryOver: [],
      pendingIds: [],
      pendingManualTotal: 0
    }
  }

  async function mountPage(discarded: unknown): Promise<void> {
    installApi({
      getStaffList: vi.fn().mockResolvedValue({ success: true, data: [] }),
      getEndOfDayReport: vi.fn().mockResolvedValue({ success: true, data: report() }),
      getDiscardedHeldSales: vi.fn().mockResolvedValue(discarded)
    })
    await act(async () => {
      root.render(createElement(EndOfDayPage))
      await Promise.resolve()
    })
    await flush()
  }

  const sale = (id: number, label: string): Record<string, unknown> => ({
    id,
    label,
    total: 163,
    lineCount: 2,
    heldAt: '2026-10-03T09:00:00.000Z',
    discardedAt: '2026-10-03T09:20:00.000Z',
    heldByName: 'cash',
    discardedByName: 'cash',
    managerName: 'mgr',
    reason: 'customer left without paying'
  })

  it('lists each discarded held sale with its label, total, lines, who held it, the approving manager and the reason', async () => {
    await mountPage({ success: true, data: [sale(1, 'Customer 1'), sale(2, 'lady in red')] })

    const section = container.querySelector('[data-testid="discarded-held-sales"]')!
    expect(section.textContent).toContain('Held sales discarded')
    expect(section.textContent).toContain('Customer 1')
    expect(section.textContent).toContain('lady in red')
    expect(section.textContent).toContain('163')
    expect(section.textContent).toContain('Mgr')
    expect(section.textContent).toContain('customer left without paying')
  })

  it('says so when there are none', async () => {
    await mountPage({ success: true, data: [] })

    expect(container.querySelector('[data-testid="discarded-held-sales"]')!.textContent).toContain('No held sales were discarded')
  })

  it('is paginated like the page\'s other lists: six a page', async () => {
    await mountPage({ success: true, data: Array.from({ length: 8 }, (_, i) => sale(i + 1, `Customer ${i + 1}`)) })

    const section = container.querySelector('[data-testid="discarded-held-sales"]')!
    expect(section.querySelectorAll('tbody tr')).toHaveLength(6)
    expect(section.textContent).toContain('Page 1 of 2')
  })

  it('says when the list could not be loaded, instead of showing an empty day', async () => {
    await mountPage({ success: false, error: 'boom' })

    expect(container.querySelector('[data-testid="discarded-held-sales"]')!.textContent).toContain('Could not load')
  })
})
