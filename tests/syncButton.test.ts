/**
 * The Sync button and the sync after login (docs/phase-253-1), real mounts with the bridge stubbed. The button is off
 * while the cart has items or a payment is in progress; it shows the last good sync in Nairobi time and the result;
 * login never waits for the sync, and goes on when Shopify cannot be reached.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import SyncButton, { lastSyncedLabel, syncResultMessage } from '../src/renderer/src/components/SyncButton.js'
import { useProductStore } from '../src/renderer/src/stores/productStore.js'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import { usePaymentActivityStore } from '../src/renderer/src/stores/paymentActivityStore.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useToastStore } from '../src/renderer/src/stores/toastStore.js'

let container: HTMLDivElement
let root: Root

const syncData = {
  products: [],
  discounts: [],
  skipped: [{ title: 'Probakery old', reason: 'amount off products' }],
  productsRefreshed: true,
  discountsRefreshed: false,
  refused: false,
  messages: ['Discounts not read: the Shopify token has no read_discounts access'],
  lastSyncedAt: '2026-10-07T06:05:00.000Z'
}

function stubApi(catalogSync: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}): void {
  ;(window as unknown as { api: Record<string, unknown> }).api = { catalogSync, ...extra }
}

async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(SyncButton)))
}

const syncButton = (): HTMLButtonElement =>
  Array.from(container.querySelectorAll('button')).find((b) => /Sync/.test(b.textContent ?? '')) as HTMLButtonElement

const item = { id: 'v1', productId: '1', title: 'PB WHITE BREAD 400G', variantTitle: 'Default Title', price: 65, quantity: 1, image: null }

beforeEach(() => {
  useProductStore.setState({ products: [], discounts: [], lastSyncedAt: null, syncing: false, status: 'idle', error: undefined, cached: false })
  useCartStore.setState({ items: [] })
  usePaymentActivityStore.setState({ active: {} })
  useToastStore.setState({ toasts: [] } as never)
})

afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove()
  useCartStore.setState({ items: [] })
  useAuthStore.setState({ currentStaff: null })
})

describe('the Sync button', () => {
  it('is enabled with an empty cart, and one press is one sync', async () => {
    const catalogSync = vi.fn().mockResolvedValue({ success: true, data: syncData })
    stubApi(catalogSync)
    await mount()

    expect(syncButton().disabled).toBe(false)
    await act(async () => syncButton().click())
    expect(catalogSync).toHaveBeenCalledTimes(1)
  })

  it('is disabled while the cart has items, and a press does nothing', async () => {
    const catalogSync = vi.fn()
    stubApi(catalogSync)
    useCartStore.setState({ items: [item] })
    await mount()

    expect(syncButton().disabled).toBe(true)
    await act(async () => syncButton().click())
    expect(catalogSync).not.toHaveBeenCalled()
  })

  it('is disabled while a payment is in progress', async () => {
    stubApi(vi.fn())
    usePaymentActivityStore.setState({ active: { mpesa: true } } as never)
    await mount()

    expect(syncButton().disabled).toBe(true)
  })

  it('shows the last good sync in Nairobi time, and the result with the skipped titles', async () => {
    stubApi(vi.fn().mockResolvedValue({ success: true, data: syncData }))
    await mount()
    expect(container.querySelector('[data-testid="last-synced"]')?.textContent).toBe('Not synced yet')

    await act(async () => syncButton().click())

    expect(container.querySelector('[data-testid="last-synced"]')?.textContent).toBe('Last synced 09:05')
    const toast = useToastStore.getState().toasts.find((t) => t.id === 'catalog-sync')
    expect(toast?.message).toBe(
      '0 products, 0 discounts. Skipped: Probakery old. Discounts not read: the Shopify token has no read_discounts access'
    )
  })

  it('formats its labels', () => {
    expect(lastSyncedLabel('2026-10-07T21:30:00Z')).toBe('Last synced 00:30')
    expect(syncResultMessage({ productCount: 2, discountCount: 1, skipped: [], messages: [] })).toBe('2 products, 1 discounts.')
  })
})

describe('the sync after login', () => {
  it('login completes without waiting for the sync', async () => {
    const catalogSync = vi.fn().mockReturnValue(new Promise(() => {}))
    stubApi(catalogSync, { login: vi.fn().mockResolvedValue({ success: true, data: { id: 1, name: 'Cashier', role: 'cashier' } }) })

    const loggedIn = await Promise.race([
      useAuthStore.getState().login(1, '1234'),
      new Promise((resolve) => setTimeout(() => resolve('waited'), 200))
    ])

    expect(loggedIn).toBe(true)
    expect(catalogSync).toHaveBeenCalledTimes(1)
  })

  it('login goes on when Shopify cannot be reached, with the copy already on screen', async () => {
    const product = { id: 'p1', title: 'PB WHITE BREAD 400G', handle: '', featuredImage: null, variants: [] }
    useProductStore.setState({ products: [product], status: 'ready' })
    stubApi(vi.fn().mockRejectedValue(new Error('Store unreachable')), {
      login: vi.fn().mockResolvedValue({ success: true, data: { id: 1, name: 'Cashier', role: 'cashier' } })
    })

    expect(await useAuthStore.getState().login(1, '1234')).toBe(true)
    await vi.waitFor(() => expect(useProductStore.getState().syncing).toBe(false))
    expect(useAuthStore.getState().currentStaff?.id).toBe(1)
    expect(useProductStore.getState().products).toEqual([product])
    expect(useProductStore.getState().status).toBe('ready')
  })
})
