/**
 * The pairs discount on the screen (docs/phase-253-2): the cart's total and its lines use the screen's copy of the
 * pricing, which must give exactly what the main process gives; a resumed held sale is priced again; the checkout sends
 * the discounted total and the cart's lines as they are. Real stores and a real mount of the cart table.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { priceLines, type AutoDiscount } from '../src/main/lib/autoDiscounts.js'
import { priceCartLines } from '../src/renderer/src/lib/autoDiscounts.js'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import { useProductStore } from '../src/renderer/src/stores/productStore.js'
import PosCartTable from '../src/renderer/src/components/PosCartTable.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const PAIRS: AutoDiscount = {
  id: 'gid://shopify/DiscountAutomaticNode/1',
  title: 'Probakery Bread 2 @99/=',
  startsAt: '2026-10-06T10:12:00Z',
  endsAt: null,
  buysQuantity: 1,
  getsQuantity: 1,
  variantIds: [],
  productIds: ['10235718041703'],
  effect: { type: 'amount', amount: 31 },
  usesPerOrderLimit: null
}

const bread = (quantity: number, price = 65): CartItem => ({
  id: 'gid://shopify/ProductVariant/50363428241511',
  productId: '10235718041703',
  title: 'PB WHITE BREAD 400G',
  variantTitle: 'Default Title',
  price,
  quantity,
  image: null
})
const other = (id: string, price: number, quantity: number): CartItem => ({
  id: `gid://shopify/ProductVariant/${id}`,
  productId: id,
  title: `Item ${id}`,
  variantTitle: 'Default Title',
  price,
  quantity,
  image: null
})

beforeEach(() => {
  useProductStore.setState({ discounts: [PAIRS] })
  useCartStore.setState({ items: [], cartDiscount: null, checkoutStatus: 'idle', checkoutKey: null, splitLocked: false })
})

afterEach(() => {
  useProductStore.setState({ discounts: [] })
  useCartStore.setState({ items: [], cartDiscount: null, resumedHeld: null })
})

describe('the screen prices exactly as the main process does', () => {
  const now = new Date('2026-10-07T09:00:00Z')
  const twoKinds = { ...PAIRS, id: 'gid://shopify/DiscountAutomaticNode/2', title: 'Half off', productIds: ['7', '8'], effect: { type: 'percentage' as const, percentage: 0.5 } }
  const cases: Array<[string, CartItem[], AutoDiscount[]]> = [
    ['no loaves', [other('9', 10, 3)], [PAIRS]],
    ['1 loaf', [bread(1)], [PAIRS]],
    ['3 loaves', [bread(3)], [PAIRS]],
    ['4 loaves', [bread(4)], [PAIRS]],
    ['4 loaves with a cap', [bread(4)], [{ ...PAIRS, usesPerOrderLimit: 1 }]],
    ['two products under one discount, the cheaper discounted', [other('7', 80, 1), other('8', 50.55, 2)], [twoKinds]],
    ['a unit that would go to 0', [bread(2)], [{ ...PAIRS, effect: { type: 'amount', amount: 70 } }]],
    ['not yet started', [bread(2)], [{ ...PAIRS, startsAt: '2026-10-08T00:00:00Z' }]],
    ['two discounts on one loaf', [bread(2)], [{ ...PAIRS, id: 'z', title: 'Ten', effect: { type: 'amount', amount: 10 } }, PAIRS]]
  ]

  it.each(cases)('%s', (_name, items, discounts) => {
    expect(priceCartLines(items, discounts, now)).toEqual(priceLines(items, discounts, now))
  })
})

describe('the cart total', () => {
  it.each([
    [1, 65],
    [2, 99],
    [3, 164],
    [4, 198]
  ])('%i loaves come to %i', (loaves, total) => {
    useCartStore.setState({ items: [bread(loaves)] })
    expect(useCartStore.getState().getTotal()).toBe(total)
  })

  it('taking a loaf out of a pair gives 65 again', () => {
    useCartStore.setState({ items: [bread(2)] })
    useCartStore.getState().updateQuantity(bread(2).id, 1)
    expect(useCartStore.getState().getTotal()).toBe(65)
  })

  it('a resumed held sale is priced again', () => {
    useCartStore.getState().resumeHeldSale({ items: [bread(3)], cartDiscount: null, customerPin: '', companyName: '' }, 'token', { id: 1, label: 'Sale 1' })
    expect(useCartStore.getState().getTotal()).toBe(164)
  })

  it('a cart with a manual discount (mock mode) is priced exactly as before', () => {
    useCartStore.setState({ items: [bread(2)], cartDiscount: { type: 'fixed', value: 10 } })
    expect(useCartStore.getState().getTotal()).toBe(120)
  })

  it('with no discount in the copy, the cart is priced as before', () => {
    useProductStore.setState({ discounts: [] })
    useCartStore.setState({ items: [bread(3)] })
    expect(useCartStore.getState().getTotal()).toBe(195)
  })

  it('the checkout sends the discounted total and the cart lines as they are, with no discount on them', async () => {
    const checkout = vi.fn().mockResolvedValue({ success: false, error: 'stop here' })
    ;(window as unknown as { api: Record<string, unknown> }).api = { checkout, printReceipt: vi.fn() }
    useCartStore.setState({ items: [bread(3)] })

    await useCartStore.getState().checkout({ staffId: 1, paymentMethod: 'cash', tenderedAmount: 200, changeDue: 36 })

    const request = checkout.mock.calls[0][0] as { total: number; items: CartItem[] }
    expect(request.total).toBe(164)
    expect(request.items).toEqual([bread(3)])
  })
})

describe('the cart table', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows the normal price, the discount title and the saving, then the net', async () => {
    const items = [bread(3), other('9', 20, 1)]
    useCartStore.setState({ items })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root.render(createElement(PosCartTable, { items, onUpdateQuantity: vi.fn(), onRemove: vi.fn() })))

    const rows = Array.from(container.querySelectorAll('tbody tr')).map((row) => row.textContent?.replace(/\s+/g, ' ') ?? '')
    expect(rows[0]).toContain('PB WHITE BREAD 400G')
    expect(rows[0]).toContain('Probakery Bread 2 @99/= -')
    expect(rows[0]).toMatch(/65\.00/)
    expect(rows[0]).toMatch(/31\.00/)
    expect(rows[0]).toMatch(/164\.00/)
    expect(rows[1]).not.toContain('Probakery')
    expect(container.querySelectorAll('[data-testid="auto-discount-line"]')).toHaveLength(1)
  })
})
