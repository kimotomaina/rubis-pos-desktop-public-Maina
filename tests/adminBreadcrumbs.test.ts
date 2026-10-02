/**
 * The Admin screen's breadcrumb row (docs/phase-201): one row of crumbs for
 * wherever the card grids have been drilled to, instead of a "Back to ..."
 * button for each level stacked one above the other.
 *
 * Real mount, the same way `tests/adminScreen.test.ts` does it.
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

/** Every `window.api` method resolves an empty success; the screens under test only navigate. */
function stubApi(): void {
  const named: Record<string, unknown> = {
    platform: 'linux',
    getCurrentShift: vi.fn().mockResolvedValue(ok(null)),
    getAppVersion: vi.fn().mockResolvedValue('2.1.6'),
    onUpdateStatus: vi.fn(() => () => {})
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

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!el) throw new Error(`No button "${label}"`)
  return el as HTMLButtonElement
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
    await Promise.resolve()
  })
}

const navs = (): HTMLElement[] => Array.from(container.querySelectorAll('nav[aria-label="Breadcrumb"]'))

/** The crumbs in order, each with whether it is a button. */
function crumbs(): Array<{ text: string; isButton: boolean; current: boolean }> {
  const items = Array.from(navs()[0].querySelectorAll('li'))
  return items.map((li) => {
    const control = li.querySelector('button, [aria-current]') as HTMLElement
    return {
      text: control.textContent ?? '',
      isButton: control.tagName === 'BUTTON',
      current: control.getAttribute('aria-current') === 'page'
    }
  })
}

const backButtons = (): string[] =>
  Array.from(container.querySelectorAll('button'))
    .map((b) => b.textContent ?? '')
    .filter((text) => text.startsWith('Back to '))

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

describe('the Admin breadcrumb row', () => {
  it('shows no breadcrumb on the Admin card grid itself', async () => {
    await mount()

    expect(navs()).toHaveLength(0)
    expect(backButtons()).toEqual([])
  })

  it('shows Admin then the section on one row, the section being the current page', async () => {
    await mount()
    await click('Overview')

    expect(navs()).toHaveLength(1)
    expect(crumbs()).toEqual([
      { text: 'Back to Admin', isButton: true, current: false },
      { text: 'Overview', isButton: false, current: true }
    ])
  })

  it('puts every level of Integrations > Fiscal Device on the same row, as one nav', async () => {
    await mount()
    await click('Integrations')
    await click('Fiscal Device')

    expect(navs()).toHaveLength(1)
    expect(crumbs()).toEqual([
      { text: 'Back to Admin', isButton: true, current: false },
      { text: 'Back to Integrations', isButton: true, current: false },
      { text: 'Fiscal Device', isButton: false, current: true }
    ])
    const list = navs()[0].querySelector('ol') as HTMLElement
    expect(list.className).toContain('flex')
    expect(list.className).not.toContain('flex-col')
    expect(list.children).toHaveLength(3)
    expect(backButtons()).toEqual(['Back to Admin', 'Back to Integrations'])
  })

  it('shows only Admin and Integrations while the Integrations grid is showing', async () => {
    await mount()
    await click('Integrations')

    expect(crumbs()).toEqual([
      { text: 'Back to Admin', isButton: true, current: false },
      { text: 'Integrations', isButton: false, current: true }
    ])
  })

  it('names each crumb by its words, with the visible text the section name only', async () => {
    await mount()
    await click('Integrations')
    await click('M-Pesa')

    const visible = Array.from(navs()[0].querySelectorAll('button')).map((b) =>
      Array.from(b.childNodes)
        .filter((node) => !(node as HTMLElement).classList?.contains('sr-only'))
        .map((node) => node.textContent)
        .join('')
    )
    expect(visible).toEqual(['Admin', 'Integrations'])
    expect(navs()[0].querySelector('[aria-current="page"]')?.textContent).toBe('M-Pesa')
  })

  it('goes back one level from the Integrations crumb', async () => {
    await mount()
    await click('Integrations')
    await click('Fiscal Device')

    await click('Back to Integrations')

    expect(crumbs().map((c) => c.text)).toEqual(['Back to Admin', 'Integrations'])
    expect(container.innerHTML).not.toContain('>Fiscal Device</h3>')
  })

  it('goes straight to the Admin grid from the Admin crumb, and Integrations then opens at its own grid', async () => {
    await mount()
    await click('Integrations')
    await click('Fiscal Device')

    await click('Back to Admin')

    expect(navs()).toHaveLength(0)
    expect(container.textContent).toContain('Peripherals')

    await click('Integrations')
    expect(crumbs().map((c) => c.text)).toEqual(['Back to Admin', 'Integrations'])
    expect(container.innerHTML).not.toContain('>Fiscal Device</h3>')
  })

  it('goes back to the Admin grid from a section that has no sub-level', async () => {
    await mount()
    await click('Reports')

    await click('Back to Admin')

    expect(navs()).toHaveLength(0)
  })
})
