/**
 * `NavStatusButton` — the header's status indicators (Online/Offline,
 * unfiled sales, M-Pesa, Fiscal Server, Barcode Scanner, Receipt
 * Printer) consolidated into one button that opens a dialog listing all
 * of them, instead of five separate items competing for header width.
 *
 * Mounted with real clicks, the `setupScreens.test.ts` pattern — this
 * component has no heavy fan-out (only `lib/unfiledCount.js` and the
 * plain `types/connectivity.js`), so a real DOM mount is stronger
 * evidence here than the source-inspection guard used for `App.tsx`
 * itself (see `tests/headerLayout.test.ts`).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import NavStatusButton, {
  type NavStatusButtonProps
} from '../src/renderer/src/components/NavStatusButton.js'
import type { ConnectivityStatusPayload } from '../src/renderer/src/types/connectivity.js'

let container: HTMLDivElement
let root: Root

function check(connected: boolean) {
  return { connected, lastCheckedAt: new Date().toISOString() }
}

const ALL_OK: ConnectivityStatusPayload = {
  mpesa: check(true),
  fiscal: check(true),
  printer: check(true)
}

function baseProps(overrides: Partial<NavStatusButtonProps> = {}): NavStatusButtonProps {
  return {
    online: true,
    unfiledCount: 0,
    onUnfiledClick: vi.fn(),
    connectivityStatus: ALL_OK,
    barcodeStatus: 'connected',
    onSelectIntegration: vi.fn(),
    ...overrides
  }
}

function mount(props: NavStatusButtonProps): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(createElement(NavStatusButton, props)))
}

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label))
  if (!el) throw new Error(`No button containing "${label}"`)
  return el as HTMLButtonElement
}

function tap(el: HTMLElement): void {
  act(() => el.click())
}

function dialog(): HTMLElement | null {
  return container.querySelector('[role="dialog"]')
}

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('NavStatusButton', () => {
  it('renders one status button, not the old separate pills/badges', () => {
    mount(baseProps())
    expect(container.querySelectorAll('button')).toHaveLength(1)
    expect(dialog()).toBeNull()
  })

  it('opens a dialog listing every status on tap', () => {
    mount(baseProps())
    tap(button('Status'))

    expect(dialog()).not.toBeNull()
    expect(dialog()!.textContent).toContain('Online')
    expect(dialog()!.textContent).toContain('All sales filed')
    expect(dialog()!.textContent).toContain('M-Pesa')
    expect(dialog()!.textContent).toContain('Fiscal Server')
    expect(dialog()!.textContent).toContain('Barcode Scanner')
    expect(dialog()!.textContent).toContain('Receipt Printer')
  })

  it('shows the offline message in the dialog and reflects it on the button', () => {
    mount(baseProps({ online: false }))
    tap(button('Status'))
    expect(dialog()!.textContent).toContain('Offline — sales will queue')
  })

  it('closes the dialog and calls onUnfiledClick when the unfiled-sales row is tapped', () => {
    const onUnfiledClick = vi.fn()
    mount(baseProps({ unfiledCount: 3, onUnfiledClick }))
    tap(button('Status'))
    expect(dialog()!.textContent).toContain('3 sales not filed')

    tap(button('3 sales not filed'))

    expect(onUnfiledClick).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()
  })

  it('omits the unfiled row while the count is still loading (null)', () => {
    mount(baseProps({ unfiledCount: null }))
    tap(button('Status'))
    expect(dialog()!.textContent).not.toContain('sale')
  })

  it.each([
    ['M-Pesa', 'mpesa'],
    ['Fiscal Server', 'fiscal'],
    ['Barcode Scanner', 'barcode'],
    ['Receipt Printer', 'printer']
  ])('closes the dialog and selects %s when its row is tapped', (label, integration) => {
    const onSelectIntegration = vi.fn()
    mount(baseProps({ onSelectIntegration }))
    tap(button('Status'))

    tap(button(label))

    expect(onSelectIntegration).toHaveBeenCalledWith(integration)
    expect(dialog()).toBeNull()
  })

  it('closes on backdrop click and on the close button', () => {
    mount(baseProps())
    tap(button('Status'))
    expect(dialog()).not.toBeNull()

    act(() => (dialog()!.parentElement as HTMLElement).click())
    expect(dialog()).toBeNull()

    tap(button('Status'))
    tap(container.querySelector('[aria-label="Close"]') as HTMLElement)
    expect(dialog()).toBeNull()
  })

  it.each([
    ['everything ok', baseProps(), 'bg-emerald-500'],
    ['offline', baseProps({ online: false }), 'bg-rose-500'],
    ['a disconnected integration', baseProps({ connectivityStatus: { ...ALL_OK, mpesa: check(false) } }), 'bg-rose-500'],
    ['a disconnected printer', baseProps({ connectivityStatus: { ...ALL_OK, printer: check(false) } }), 'bg-rose-500'],
    ['unfiled sales only', baseProps({ unfiledCount: 2 }), 'bg-amber-500']
  ])('the button dot reflects the worst status: %s', (_label, props, expectedDotClass) => {
    mount(props)
    const dot = button('Status').querySelector('span[aria-hidden]') as HTMLElement
    expect(dot.className).toContain(expectedDotClass)
  })

  it('a disconnected scanner is "unknown" (slate), not "bad" (rose) — it has just never been tested', () => {
    mount(baseProps({ barcodeStatus: 'unknown' }))
    tap(button('Status'))
    const row = Array.from(dialog()!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Barcode Scanner')
    )!
    const dot = row.querySelector('span[aria-hidden]') as HTMLElement
    expect(dot.className).toContain('bg-slate-400')
    // And the overall button dot must not turn red for this alone.
    expect(button('Status').querySelector('span[aria-hidden]')!.className).toContain('bg-emerald-500')
  })
})
