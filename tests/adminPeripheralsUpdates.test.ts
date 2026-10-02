/**
 * Where things live on the Admin screen after docs/phase-205: the App &
 * Updates panel is on the main Admin page (not Overview), and Peripherals is
 * a two-card grid, Scanner and Printers, with printer registration moved
 * there from Integrations.
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

function stubApi(): void {
  const named: Record<string, unknown> = {
    platform: 'linux',
    getCurrentShift: vi.fn().mockResolvedValue(ok(null)),
    getAppVersion: vi.fn().mockResolvedValue('2.1.6'),
    onUpdateStatus: vi.fn(() => () => {}),
    getPrinters: vi.fn().mockResolvedValue(ok([]))
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

const buttonTexts = (): string[] => Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '')

const crumbTexts = (): string[] =>
  Array.from(container.querySelectorAll('nav[aria-label="Breadcrumb"] li')).map(
    (li) => li.querySelector('button, [aria-current]')?.textContent ?? ''
  )

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

describe('App & Updates on the main Admin page', () => {
  it('is on screen with the card grid, with the version, the check and the install buttons', async () => {
    await mount()

    expect(container.textContent).toContain('App & Updates')
    expect(container.textContent).toContain('Installed version: 2.1.6')
    expect(buttonTexts()).toContain('Check for Updates')
    expect(buttonTexts()).toContain('Install update and restart')
    expect(buttonTexts()).toContain('Overview')
    expect(buttonTexts()).toContain('Peripherals')
  })

  it('is not on Overview, or on any other section', async () => {
    await mount()

    for (const card of ['Overview', 'Integrations', 'Peripherals', 'System']) {
      await click(card)
      expect(container.textContent).not.toContain('App & Updates')
      expect(buttonTexts()).not.toContain('Check for Updates')
      await click('Back to Admin')
    }
    expect(container.textContent).toContain('App & Updates')
  })

  it('leaves Overview with Today\'s Sales, Shift Controls and Staff', async () => {
    await mount()
    await click('Overview')

    expect(container.textContent).toContain("Today's Sales")
    expect(container.textContent).toContain('Shift Controls')
    expect(buttonTexts()).toContain('+ Add Staff')
  })

  it('checks for updates from the main page', async () => {
    await mount()

    await click('Check for Updates')

    expect(window.api.checkForUpdates).toHaveBeenCalledTimes(1)
  })
})

describe('Peripherals: Scanner and Printers', () => {
  it('opens to a grid of exactly two cards, Scanner then Printers, with no content until one is tapped', async () => {
    await mount()
    await click('Peripherals')

    const cards = buttonTexts().filter((text) => ['Scanner', 'Printers'].includes(text))
    expect(cards).toEqual(['Scanner', 'Printers'])
    expect(container.textContent).not.toContain('Barcode Scanner Stations')
    expect(container.querySelector('h3')).toBeNull()
    expect(window.api.getPrinters).not.toHaveBeenCalled()
  })

  it('shows the Barcode Scanner Stations instructions under Scanner', async () => {
    await mount()
    await click('Peripherals')
    await click('Scanner')

    expect(container.innerHTML).toContain('Barcode Scanner Stations</h3>')
    expect(container.textContent).not.toContain('Add Printer')
    expect(window.api.getPrinters).not.toHaveBeenCalled()
  })

  it('registers printers under Printers, and loads them only then', async () => {
    await mount()
    await click('Peripherals')
    await click('Printers')

    expect(container.innerHTML).toContain('>Printers</h3>')
    expect(buttonTexts()).toContain('Add Printer')
    expect(container.textContent).not.toContain('Barcode Scanner Stations')
    expect(window.api.getPrinters).toHaveBeenCalledTimes(1)
  })

  it('is no longer on the Integrations grid', async () => {
    await mount()
    await click('Integrations')

    expect(buttonTexts()).not.toContain('Printer')
    expect(buttonTexts()).not.toContain('Printers')
  })

  it('shows Admin › Peripherals › Printers as one breadcrumb row, and goes back a level from it', async () => {
    await mount()
    await click('Peripherals')
    expect(crumbTexts()).toEqual(['Back to Admin', 'Peripherals'])

    await click('Printers')
    expect(crumbTexts()).toEqual(['Back to Admin', 'Back to Peripherals', 'Printers'])

    await click('Back to Peripherals')
    expect(crumbTexts()).toEqual(['Back to Admin', 'Peripherals'])
    expect(buttonTexts()).toContain('Scanner')
  })

  it('starts at the Peripherals grid again after leaving from inside a section', async () => {
    await mount()
    await click('Peripherals')
    await click('Printers')

    await click('Back to Admin')
    await click('Peripherals')

    expect(crumbTexts()).toEqual(['Back to Admin', 'Peripherals'])
    expect(container.innerHTML).not.toContain('>Printers</h3>')
  })
})
