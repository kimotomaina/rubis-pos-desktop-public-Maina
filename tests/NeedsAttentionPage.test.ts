/**
 * `NeedsAttentionPage` tests (phase-94) — mounted with `react-dom/client`
 * and driven with real DOM `click()` calls, matching `VirtualKeyboard
 * .test.ts`'s stated exception to this repo's "test pure logic, don't
 * mount components" convention: this page's interactive surface (the
 * Resend / Correct PIN & Resend actions) is exactly what needs covering
 * here, on top of the pure `needsAttention.test.ts` helper tests.
 *
 * `window.api` is stubbed per test; the on-screen keyboard itself is
 * covered by `keyboardStore.test.ts` and `VirtualKeyboard.test.ts`, so
 * here a PIN is "typed" by invoking the store's relayed `onChange`
 * directly — exactly what `VirtualKeyboardModal` does on every keypress.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import NeedsAttentionPage from '../src/renderer/src/pages/NeedsAttentionPage.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import type { NeedsAttentionRow, FiscalResendResult } from '../src/main/services/database.js'

let container: HTMLDivElement
let root: Root

const WAITING_ROW: NeedsAttentionRow = {
  local_id: 1,
  created_at: '2026-09-07T05:00:00.000Z',
  total: 139.2,
  staff_name: 'Alex',
  fiscal_status: 'waiting',
  fiscal_error_reason: 'Fiscal server error (Code 30): ZFPLabServer cannot reach the fiscal device',
  fiscal_error_kind: 'technical',
  fiscal_data_issue: null
}

const WRONG_PIN_ROW: NeedsAttentionRow = {
  local_id: 2,
  created_at: '2026-09-07T05:10:00.000Z',
  total: 250,
  staff_name: 'Alex',
  fiscal_status: 'needs_fixing',
  fiscal_error_reason: 'Fiscal device error (Code 40): Wrong client PIN',
  fiscal_error_kind: 'data',
  fiscal_data_issue: 'wrong-pin'
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(NeedsAttentionPage))
    await Promise.resolve()
  })
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (el) => el.textContent === label
  )
  if (!button) throw new Error(`No button found for "${label}"`)
  return button as HTMLButtonElement
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

describe('NeedsAttentionPage', () => {
  it('renders the empty state when nothing needs attention', async () => {
    window.api = {
      getSalesNeedingAttention: vi.fn().mockResolvedValue({ success: true, data: [] })
    } as unknown as typeof window.api

    await mount()

    expect(container.textContent).toContain('No sales need attention.')
  })

  it('shows each row\'s plain-language reason and distinguishes stuck-waiting from needs_fixing', async () => {
    window.api = {
      getSalesNeedingAttention: vi.fn().mockResolvedValue({ success: true, data: [WAITING_ROW, WRONG_PIN_ROW] })
    } as unknown as typeof window.api

    await mount()

    expect(container.textContent).toContain('Fiscal server error (Code 30): ZFPLabServer cannot reach the fiscal device')
    expect(container.textContent).toContain('Stuck — retrying automatically')
    expect(container.textContent).toContain('Fiscal device error (Code 40): Wrong client PIN')
    expect(container.textContent).toContain('Needs fixing')
  })

  it('Resend calls the IPC and removes the row once it fiscalizes', async () => {
    const resendFiscalization = vi.fn().mockResolvedValue({
      success: true,
      data: {
        localId: 1,
        fiscal: { invoiceNumber: '0000000000000000777', qrCode: 'QR' },
        fiscalStatus: 'fiscalized',
        fiscalErrorReason: null,
        fiscalErrorKind: null,
        fiscalDataIssue: null
      } satisfies FiscalResendResult
    })
    window.api = {
      getSalesNeedingAttention: vi.fn().mockResolvedValue({ success: true, data: [WAITING_ROW] }),
      resendFiscalization
    } as unknown as typeof window.api

    await mount()
    expect(container.textContent).toContain('Order #1')

    await act(async () => {
      findButton('Resend').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(resendFiscalization).toHaveBeenCalledWith(1)
    expect(container.textContent).toContain('No sales need attention.')
  })

  it('Resend that still fails keeps the row with the updated reason', async () => {
    const resendFiscalization = vi.fn().mockResolvedValue({
      success: true,
      data: {
        localId: 1,
        fiscal: undefined,
        fiscalStatus: 'needs_fixing',
        fiscalErrorReason: 'Fiscal server error (Code 63): ZFPLabServer rejected the request format',
        fiscalErrorKind: 'system',
        fiscalDataIssue: null
      } satisfies FiscalResendResult
    })
    window.api = {
      getSalesNeedingAttention: vi.fn().mockResolvedValue({ success: true, data: [WAITING_ROW] }),
      resendFiscalization
    } as unknown as typeof window.api

    await mount()

    await act(async () => {
      findButton('Resend').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Order #1')
    expect(container.textContent).toContain('Needs fixing')
    expect(container.textContent).toContain(
      'Fiscal server error (Code 63): ZFPLabServer rejected the request format'
    )
  })

  it('a wrong-PIN row shows the correction affordance, gated on isValidKraPinFormat', async () => {
    const correctPinAndResend = vi.fn().mockResolvedValue({
      success: true,
      data: {
        localId: 2,
        fiscal: { invoiceNumber: '0000000000000000888', qrCode: 'QR' },
        fiscalStatus: 'fiscalized',
        fiscalErrorReason: null,
        fiscalErrorKind: null,
        fiscalDataIssue: null
      } satisfies FiscalResendResult
    })
    window.api = {
      getSalesNeedingAttention: vi.fn().mockResolvedValue({ success: true, data: [WRONG_PIN_ROW] }),
      correctPinAndResend
    } as unknown as typeof window.api

    await mount()

    await act(async () => {
      findButton('Correct PIN & Resend').click()
    })

    const saveButton = findButton('Save & Resend')
    expect(saveButton.disabled).toBe(true)

    // Open the keyboard (click the PIN field), then type an invalid PIN.
    const pinField = container.querySelector('input[aria-label="Corrected customer KRA PIN"]') as HTMLInputElement
    act(() => {
      pinField.click()
    })
    expect(useKeyboardStore.getState().request).not.toBeNull()
    act(() => {
      useKeyboardStore.getState().request!.onChange('bad')
    })
    expect(findButton('Save & Resend').disabled).toBe(true)

    // A valid KRA PIN enables Save & Resend.
    act(() => {
      useKeyboardStore.getState().request!.onChange('p051234567z')
    })
    expect(findButton('Save & Resend').disabled).toBe(false)

    await act(async () => {
      findButton('Save & Resend').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(correctPinAndResend).toHaveBeenCalledWith(2, 'P051234567Z')
    expect(container.textContent).toContain('No sales need attention.')
  })
})
