/**
 * Phase 228: a printer whose status cannot be read, such as a Windows queue, shows as "Status unknown": grey, never
 * green and never red, in the header's status list and in the connectivity window. A printer that is probed and does
 * not answer is still red.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import NavStatusButton from '../src/renderer/src/components/NavStatusButton.js'
import ConnectivityModal from '../src/renderer/src/components/ConnectivityModal.js'
import type { ConnectivityStatusPayload } from '../src/renderer/src/types/connectivity.js'

let container: HTMLDivElement
let root: Root

const result = (connected: boolean, extra: Record<string, unknown> = {}) => ({
  connected,
  lastCheckedAt: new Date().toISOString(),
  ...extra
})

const statusWith = (printer: ReturnType<typeof result>): ConnectivityStatusPayload => ({
  mpesa: result(true),
  fiscal: result(true),
  printer
})

function mountButton(printer: ReturnType<typeof result>): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() =>
    root.render(
      createElement(NavStatusButton, {
        online: true,
        unfiledCount: 0,
        onUnfiledClick: vi.fn(),
        connectivityStatus: statusWith(printer),
        barcodeStatus: 'connected',
        onSelectIntegration: vi.fn()
      })
    )
  )
  act(() => (container.querySelector('button') as HTMLButtonElement).click())
}

/** The status dot beside a row's label in the open dialog. */
function dotOf(label: string): string {
  const row = Array.from(container.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent?.includes(label))
  return row?.querySelector('span[aria-hidden]')?.className ?? ''
}

const overallTitle = (): string | null => container.querySelector('button[aria-label="Till status"]')?.getAttribute('title') ?? null

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the header status list', () => {
  const UNKNOWN = result(false, { notApplicable: true, error: 'Printer "EPSON" : its status cannot be read from here.' })

  it('shows a printer whose status cannot be read as "Status unknown", grey', () => {
    mountButton(UNKNOWN)

    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Status unknown')
    expect(dialog.textContent).not.toContain('Disconnected')
    expect(dotOf('Receipt Printer')).toContain('bg-slate-400')
  })

  it('does not turn the overall dot red because of it', () => {
    mountButton(UNKNOWN)

    expect(overallTitle()).toBe('All statuses normal')
  })

  it('still shows a printer that was probed and did not answer as Disconnected, red, and the overall dot as needing attention', () => {
    mountButton(result(false, { error: 'Timed out connecting to 192.168.1.50:9100' }))

    expect(container.querySelector('[role="dialog"]')!.textContent).toContain('Disconnected')
    expect(dotOf('Receipt Printer')).toContain('bg-rose-500')
    expect(overallTitle()).toBe('Some statuses need attention')
  })

  it('still shows a printer that answered as Connected, green', () => {
    mountButton(result(true, { latencyMs: 3 }))

    expect(container.querySelector('[role="dialog"]')!.textContent).toContain('Connected')
    expect(dotOf('Receipt Printer')).toContain('bg-emerald-500')
    expect(overallTitle()).toBe('All statuses normal')
  })
})

describe('the connectivity window', () => {
  const mountModal = (integration: 'printer' | 'mpesa', check: ReturnType<typeof result>): void => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    window.api = {} as unknown as typeof window.api
    const status = { ...statusWith(result(true)), [integration]: check }
    act(() =>
      root.render(
        createElement(ConnectivityModal, {
          integration,
          status,
          barcodeStatus: 'unknown',
          onBarcodeDetected: vi.fn(),
          onClose: vi.fn()
        })
      )
    )
  }

  it('reads "Status unknown" for a printer, with its explanation in the neutral box', () => {
    mountModal('printer', result(false, { notApplicable: true, error: 'Printer "EPSON": its status cannot be read from here.' }))

    expect(container.textContent).toContain('Status: Status unknown')
    expect(container.textContent).not.toContain('Not applicable')
    const note = Array.from(container.querySelectorAll('p')).find((p) => p.textContent?.includes('cannot be read'))
    expect(note?.className).toContain('bg-slate-50')
  })

  it('still reads "Not applicable" for M-Pesa in a mode with nothing to probe', () => {
    mountModal('mpesa', result(false, { notApplicable: true }))

    expect(container.textContent).toContain('Status: Not applicable')
  })

  it('reads Disconnected for a printer that did not answer', () => {
    mountModal('printer', result(false, { error: 'Timed out' }))

    expect(container.textContent).toContain('Status: Disconnected')
  })
})
