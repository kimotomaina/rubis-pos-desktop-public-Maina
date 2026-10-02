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
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'

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

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!el) throw new Error(`No button "${label}"`)
  return el as HTMLButtonElement
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useKeyboardStore.setState({ request: null })
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

  it('shows a plain "Loading…" notice before the capabilities reply arrives — no form of any kind', () => {
    // A promise that never resolves during this test, so the effect's
    // `.then()` never fires and `capabilities` stays at its initial
    // 'loading' state.
    window.api = {
      getMpesaCapabilities: vi.fn(() => new Promise(() => {})),
      initiateMpesaStkPush: vi.fn(),
      logMpesaTransaction: vi.fn(),
      queryMpesaStatus: vi.fn()
    } as unknown as typeof window.api

    act(() => {
      root.render(createElement(PaymentModal, { total: 100, onPaid: vi.fn(), onCancel: vi.fn() }))
    })

    expect(container.textContent).toContain('Loading…')
    expect(container.textContent).not.toContain('Phone Number')
    expect(container.textContent).not.toContain('Record M-Pesa payment')
  })

  /**
   * DELIBERATE TEST CHANGE (docs/phase-150.md step 3, "point 1" — a user
   * correction to phase-149/Step 2's own fail-safe choice): a
   * failed/unsuccessful capabilities call used to fall back to the
   * Daraja STK form. That was the right default when Daraja was the
   * till's default *method*; it became the wrong screen once manual is,
   * since it let a manual till show a phone-number form it can never
   * use. It now shows a plain "unavailable" notice with no form instead.
   *   Old assertion: `container.textContent` contains 'Phone Number'.
   *   New assertion: `container.textContent` contains the plain
   *     unavailable notice and does **not** contain 'Phone Number'.
   */
  it('shows a plain unavailable notice, not the Daraja form, when the capabilities call is rejected', async () => {
    window.api = {
      getMpesaCapabilities: vi.fn().mockRejectedValue(new Error('IPC unavailable')),
      initiateMpesaStkPush: vi.fn(),
      logMpesaTransaction: vi.fn(),
      queryMpesaStatus: vi.fn()
    } as unknown as typeof window.api

    await mount()

    expect(container.textContent).toContain('M-Pesa is unavailable right now')
    expect(container.textContent).not.toContain('Phone Number')
  })

  it('shows the same unavailable notice when capabilities resolves without success', async () => {
    window.api = {
      getMpesaCapabilities: vi.fn().mockResolvedValue({ success: false, error: 'nope' }),
      initiateMpesaStkPush: vi.fn(),
      logMpesaTransaction: vi.fn(),
      queryMpesaStatus: vi.fn()
    } as unknown as typeof window.api

    await mount()

    expect(container.textContent).toContain('M-Pesa is unavailable right now')
    expect(container.textContent).not.toContain('Phone Number')
  })
})

/**
 * The Daraja phone-number field's on-screen-keypad conversion
 * (docs/phase-156): `readOnly`, opens the shared keyboard
 * (`useKeyboardStore`), numeric mode — same pattern as the M-Pesa manual
 * code field above (mode `caps`) and `AdminScreen.tsx`'s fields
 * (docs/phase-155). The existing `254` prefix handling and
 * `PHONE_PATTERN` validation are untouched — only the input method
 * changed.
 */
describe('Daraja phone number field', () => {
  it('is readOnly and opens the keyboard, numeric mode', async () => {
    stubApi({ manualCodeSupported: false, manualEntryEnabled: false, mode: 'daraja' })
    await mount()

    const input = container.querySelector('[aria-label="Phone Number"]') as HTMLInputElement
    expect(input.readOnly).toBe(true)
    act(() => input.click())
    expect(useKeyboardStore.getState().request?.mode).toBe('numeric')
  })

  it('typing a number (with the leading 0 stripped, as before) and sending the push uses the same phoneNumber as before', async () => {
    stubApi({ manualCodeSupported: false, manualEntryEnabled: false, mode: 'daraja' })
    window.api.initiateMpesaStkPush = vi.fn().mockResolvedValue({
      success: true,
      data: { checkoutRequestId: 'ws_1', merchantRequestId: 'mr_1' }
    })
    window.api.logMpesaTransaction = vi.fn().mockResolvedValue({ success: true })
    await mount()

    const input = container.querySelector('[aria-label="Phone Number"]') as HTMLInputElement
    act(() => input.click())
    act(() => useKeyboardStore.getState().request?.onChange('0712345678'))
    expect((container.querySelector('[aria-label="Phone Number"]') as HTMLInputElement).value).toBe(
      '0712345678'
    )

    await act(async () => {
      button('Send Request').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.initiateMpesaStkPush).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumber: '254712345678' })
    )
  })

  /**
   * Relay mutation check (docs/phase-156, same protocol as phase-155):
   * every other test here drives the keyboard with one
   * `onChange(fullString)` call, which would still pass even if
   * `keyboardStore.ts`'s relay stopped keeping `request.value` in sync.
   * This one types digit by digit, reading `request.value` back between
   * keystrokes like the real `VirtualNumpad` does.
   *
   * Verified: temporarily removing the relay's `set(...)` line in
   * `keyboardStore.ts` made this fail (accumulation collapsed to the
   * last digit) while the single-shot test above kept passing; restored
   * immediately after, `git diff` on `keyboardStore.ts` clean.
   */
  it('consecutive keystrokes accumulate on the phone field, not just a single replacement', async () => {
    stubApi({ manualCodeSupported: false, manualEntryEnabled: false, mode: 'daraja' })
    await mount()

    const input = container.querySelector('[aria-label="Phone Number"]') as HTMLInputElement
    act(() => input.click())

    for (const digit of ['0', '7', '1', '2']) {
      const current = useKeyboardStore.getState().request!.value
      act(() => useKeyboardStore.getState().request!.onChange(current + digit))
    }

    expect((container.querySelector('[aria-label="Phone Number"]') as HTMLInputElement).value).toBe(
      '0712'
    )
  })
})

describe('manual mode completes with no manager PIN (docs/phase-150.md step 3)', () => {
  it('completes a manual sale with no PIN, entering the code via the on-screen keyboard', async () => {
    stubApi({ manualCodeSupported: false, manualEntryEnabled: true, mode: 'manual' })
    const onPaid = vi.fn()
    await act(async () => {
      root.render(createElement(PaymentModal, { total: 100, onPaid, onCancel: vi.fn() }))
      await Promise.resolve()
    })

    // Opens the shared on-screen keyboard, exactly like the customer
    // KRA PIN field in PosCheckoutPanel — see keyboardStore.ts.
    const codeInput = container.querySelector(
      'input[aria-label="M-Pesa code from the customer’s message"]'
    ) as HTMLInputElement
    act(() => codeInput.click())
    expect(useKeyboardStore.getState().request).not.toBeNull()

    act(() => useKeyboardStore.getState().request?.onChange('QDF73HK9LM'))

    act(() => button('Complete Sale').click())

    expect(onPaid).toHaveBeenCalledWith('QDF73HK9LM', {
      code: 'QDF73HK9LM',
      confirmUnverified: true
    })
    // No manager-PIN prompt anywhere in this flow.
    expect(container.textContent).not.toContain('PIN')
  })

  it.each(['manual', 'daraja'] as const)('has no confirmation checkbox or attestation text in %s mode', async (mode) => {
    stubApi({ manualCodeSupported: false, manualEntryEnabled: true, mode })
    await act(async () => {
      root.render(createElement(PaymentModal, { total: 100, onPaid: vi.fn(), onCancel: vi.fn() }))
      await Promise.resolve()
    })
    if (mode === 'daraja') act(() => button('Unverified').click())

    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
    expect(container.textContent).not.toContain('I have seen the M-Pesa confirmation message')
    expect(container.querySelector('input[aria-label="M-Pesa code from the customer’s message"]')).toBeTruthy()
  })

  it('Complete Sale is inactive until the whole code is entered, then becomes active', async () => {
    stubApi({ manualCodeSupported: false, manualEntryEnabled: true, mode: 'manual' })
    const onPaid = vi.fn()
    await act(async () => {
      root.render(createElement(PaymentModal, { total: 100, onPaid, onCancel: vi.fn() }))
      await Promise.resolve()
    })

    const codeInput = container.querySelector(
      'input[aria-label="M-Pesa code from the customer’s message"]'
    ) as HTMLInputElement
    act(() => codeInput.click())

    expect(button('Complete Sale').disabled).toBe(true)

    act(() => useKeyboardStore.getState().request?.onChange('QDF73HK9L'))
    expect(button('Complete Sale').disabled).toBe(true)
    act(() => button('Complete Sale').click())
    expect(onPaid).not.toHaveBeenCalled()

    act(() => useKeyboardStore.getState().request?.onChange('QDF73HK9LM'))
    expect(button('Complete Sale').disabled).toBe(false)

    act(() => useKeyboardStore.getState().request?.onChange('QDF73HK9L'))
    expect(button('Complete Sale').disabled).toBe(true)
  })

  it('shows no error text for a partial code: the button simply is not active yet', async () => {
    stubApi({ manualCodeSupported: false, manualEntryEnabled: true, mode: 'manual' })
    await act(async () => {
      root.render(createElement(PaymentModal, { total: 100, onPaid: vi.fn(), onCancel: vi.fn() }))
      await Promise.resolve()
    })
    const codeInput = container.querySelector(
      'input[aria-label="M-Pesa code from the customer’s message"]'
    ) as HTMLInputElement
    act(() => codeInput.click())
    act(() => useKeyboardStore.getState().request?.onChange('QDF'))

    expect(container.textContent).not.toMatch(/Enter the 10-character|Confirm that you have seen/)
  })
})
