/**
 * Store Details on the Shopify card, two fields to a row (docs/phase-202).
 * It used to sit under the Fiscal Device settings; the fields, their
 * keyboard modes and the save are unchanged, only where they are reached.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AdminScreen from '../src/renderer/src/components/AdminScreen.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'

let container: HTMLDivElement
let root: Root

const ok = <T,>(data?: T) => ({ success: true as const, data })

const STORE_FIELDS = [
  'Store name',
  'Store KRA PIN',
  'Legal name',
  'Shop name and address',
  'Phone',
  'Receipt footer message'
]

function stubApi(): void {
  const named: Record<string, unknown> = {
    platform: 'linux',
    getCurrentShift: vi.fn().mockResolvedValue(ok(null)),
    getAppVersion: vi.fn().mockResolvedValue('2.1.6'),
    onUpdateStatus: vi.fn(() => () => {}),
    getStoreIdentity: vi.fn().mockResolvedValue(
      ok({ storeName: 'Enjoy', storeKraPin: 'P051234567X', legalName: '', address: '', phone: '', footerMessage: '' })
    )
  }
  window.api = new Proxy(named, {
    get: (target, name: string) => target[name] ?? (target[name] = vi.fn().mockResolvedValue(ok(undefined)))
  }) as unknown as typeof window.api
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(AdminScreen, { requestManagerPin: () => {} }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(label: string): Promise<void> {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!el) throw new Error(`No button "${label}"`)
  await act(async () => {
    el.click()
    await Promise.resolve()
  })
}

const labelTexts = (): string[] =>
  Array.from(container.querySelectorAll('label')).map((l) => l.textContent?.trim() ?? '')

const storeGrid = (): HTMLElement => {
  const grid = Array.from(container.querySelectorAll('h4'))
    .find((h) => h.textContent === 'Store Details')
    ?.parentElement?.querySelector('.grid') as HTMLElement | undefined
  if (!grid) throw new Error('No Store Details grid')
  return grid
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useKeyboardStore.setState({ request: null })
  useAuthStore.setState({ currentStaff: { id: 1, name: 'Admin', role: 'admin' } })
  stubApi()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Store Details', () => {
  it('is on the Shopify card, after the token, with all six fields', async () => {
    await mount()
    await click('Integrations')
    await click('Shopify')

    const text = container.textContent ?? ''
    expect(text).toContain('Store Details')
    expect(text.indexOf('Store Details')).toBeGreaterThan(text.indexOf('Admin API Token'))
    for (const field of STORE_FIELDS) {
      expect(labelTexts().some((l) => l.startsWith(field))).toBe(true)
    }
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Save Store Details')).toBe(true)
  })

  it('is no longer on the Fiscal Device card, which keeps only its own fields and save', async () => {
    await mount()
    await click('Integrations')
    await click('Fiscal Device')

    expect(container.textContent).not.toContain('Store Details')
    for (const field of STORE_FIELDS) {
      expect(labelTexts().some((l) => l.startsWith(field))).toBe(false)
    }
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons).toContain('Save Fiscal Device Settings')
    expect(buttons).not.toContain('Save Store Details')
  })

  it('lays the six fields out two to a row, three rows', async () => {
    await mount()
    await click('Integrations')
    await click('Shopify')

    const grid = storeGrid()
    expect(grid.className).toContain('grid-cols-2')
    expect(grid.children).toHaveLength(6)
    const order = Array.from(grid.children).map((cell) => cell.querySelector('label')?.textContent?.trim())
    expect(order).toEqual(STORE_FIELDS)
  })

  it('loads the saved values into the fields on the Shopify card', async () => {
    await mount()
    await click('Integrations')
    await click('Shopify')

    const values = Array.from(storeGrid().querySelectorAll('input')).map((i) => i.value)
    expect(values.slice(0, 2)).toEqual(['Enjoy', 'P051234567X'])
  })
})

describe('Shopify Connection and the Admin API token (docs/phase-203)', () => {
  const row = (): HTMLElement => {
    const heading = Array.from(container.querySelectorAll('h4')).find((h) => h.textContent === 'Admin API Token')
    const grid = heading?.parentElement?.parentElement?.parentElement as HTMLElement | undefined
    if (!grid) throw new Error('No connection row')
    return grid
  }

  it('puts the store URL and the token side by side in one two-column row', async () => {
    await mount()
    await click('Integrations')
    await click('Shopify')

    const grid = row()
    expect(grid.className).toContain('grid-cols-2')
    expect(grid.children).toHaveLength(2)
    expect(grid.children[0].textContent).toContain('Store URL')
    expect(grid.children[0].textContent).not.toContain('Token')
    expect(grid.children[1].textContent).toContain('Admin API Token')
    expect(grid.children[1].textContent).toContain('New Token (starts with shpat_)')
  })

  it('keeps each half’s own save button, and the token status beside its heading', async () => {
    await mount()
    await click('Integrations')
    await click('Shopify')

    const [left, right] = Array.from(row().children)
    expect(Array.from(left.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Save Store URL'])
    expect(Array.from(right.querySelectorAll('button')).map((b) => b.textContent)).toContain('Save Token')
    expect(right.textContent).toContain('Not configured')
  })

  it('keeps Store Details below the row, not inside it', async () => {
    await mount()
    await click('Integrations')
    await click('Shopify')

    expect(row().textContent).not.toContain('Store Details')
    expect(container.textContent!.indexOf('Store Details')).toBeGreaterThan(container.textContent!.indexOf('Save Token'))
  })
})
