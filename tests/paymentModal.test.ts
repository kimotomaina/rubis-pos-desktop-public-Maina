/**
 * `PaymentModal` renders an entirely different screen depending on the
 * till's M-Pesa mode (docs/phase-148.md step 2) — mounted with
 * `react-dom/client`, the `NeedsAttentionPage.test.ts` pattern for a
 * component whose interactive surface (which screen appears) is exactly
 * what needs covering, on top of the pure `mpesaProviderFactory.test.ts`/
 * `mpesaPaymentPoller.test.ts` logic tests.
 *
 * `window.api` is stubbed per test with only the methods this component
 * calls; `getMpesaCapabilities`'s resolved `mode` is what each test
 * exercises.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import PaymentModal from '../src/renderer/src/components/PaymentModal.js'

let container: HTMLDivElement
let root: Root

interface Capabilities {
  manualCodeSupported: boolean
  manualEntryEnabled: boolean
  mode: 'manual' | 'daraja' | 'sms'
}

function stubApi(capabilities: Capabilities): void {
  window.api = {
    getMpesaCapabilities: vi.fn().mockResolvedValue({ success: true, data: capabilities }),
    initiateMpesaStkPush: vi.fn(),
    logMpesaTransaction: vi.fn(),
    queryMpesaStatus: vi.fn()
  } as unknown as typeof window.api
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(PaymentModal, { total: 100, onPaid: vi.fn(), onCancel: vi.fn() }))
    await Promise.resolve()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('PaymentModal renders by mode', () => {
  it("manual mode (the default): one screen only, 'Record M-Pesa payment' — no STK form, no tab bar, no Manual Code", async () => {
    stubApi({ manualCodeSupported: false, manualEntryEnabled: true, mode: 'manual' })
    await mount()

    expect(container.textContent).toContain('Record M-Pesa payment')
    expect(container.textContent).not.toContain('Phone Number')
    expect(container.textContent).not.toContain('STK Push')
    expect(container.textContent).not.toContain('Manual Code')
    expect(container.querySelector('input[type="tel"]')).toBeNull()
  })

  it('daraja mode without the manual fallback: the STK form only, no tab bar', async () => {
    stubApi({ manualCodeSupported: false, manualEntryEnabled: false, mode: 'daraja' })
    await mount()

    expect(container.textContent).toContain('Phone Number')
    expect(container.textContent).not.toContain('Unverified')
    expect(container.textContent).not.toContain('Manual Code')
    expect(container.textContent).not.toContain('Record M-Pesa payment')
  })

  it('daraja mode with the manual fallback enabled: STK + Unverified tabs, never a Manual Code tab', async () => {
    stubApi({ manualCodeSupported: false, manualEntryEnabled: true, mode: 'daraja' })
    await mount()

    expect(container.textContent).toContain('STK Push')
    expect(container.textContent).toContain('Unverified')
    expect(container.textContent).not.toContain('Manual Code')
  })

  it('sms mode: a plain unavailable notice, no form and no tabs at all', async () => {
    stubApi({ manualCodeSupported: true, manualEntryEnabled: true, mode: 'sms' })
    await mount()

    expect(container.textContent).toContain('M-Pesa by SMS is not available on this till.')
    expect(container.textContent).not.toContain('Phone Number')
    expect(container.textContent).not.toContain('Record M-Pesa payment')
    expect(container.querySelector('input')).toBeNull()
  })

  it("defaults to daraja's STK form before the capabilities reply arrives, and fails closed the same way on error", async () => {
    // No hidden state depends on this beyond what's already covered above
    // — a rejected capabilities call must not throw or blank the screen.
    window.api = {
      getMpesaCapabilities: vi.fn().mockRejectedValue(new Error('IPC unavailable')),
      initiateMpesaStkPush: vi.fn(),
      logMpesaTransaction: vi.fn(),
      queryMpesaStatus: vi.fn()
    } as unknown as typeof window.api

    await mount()

    expect(container.textContent).toContain('Phone Number')
  })
})
