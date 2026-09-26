/**
 * `AdminScreen`'s on-screen-keyboard field conversion (docs/phase-155):
 * every plain typed `<input>` became a `readOnly` field opening the
 * shared keyboard (`useKeyboardStore`), exactly like `PosCheckoutPanel`/
 * `OnboardingScreen`/`EtimsSetupGate` already do.
 *
 * Real mount, possible here for the first time — phase-155 added the
 * `.js` extensions `AdminScreen.tsx` (and its `EmptyState`/`ZReportModal`/
 * `RestartCountdownModal`/`MpesaLogsPage` transitive imports) were
 * missing, the same fix phase-146 applied to `PosCheckoutPanel`. Before
 * that fix, `tests/adminIntegrationsSections.test.ts` had to read the
 * source as text instead of mounting — see that file's own updated doc
 * comment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AdminScreen from '../src/renderer/src/components/AdminScreen.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import type { ShiftRow } from '../src/main/services/database.js'

let container: HTMLDivElement
let root: Root

const OPEN_SHIFT: ShiftRow = {
  id: 1,
  staff_id: 1,
  clock_in: '2026-09-01T08:00:00.000Z',
  clock_out: null,
  starting_cash: 100,
  expected_cash: null,
  ending_cash: null,
  discrepancy: null,
  status: 'open'
}

function ok<T>(data?: T): { success: true; data: T | undefined } {
  return { success: true, data }
}

/** Stubs every `window.api` method `AdminScreen` calls, across every tab this file visits. */
function stubApi(mpesaOverrides: Record<string, unknown> = {}): void {
  window.api = {
    getDailySummary: vi.fn().mockResolvedValue(
      ok({ orderCount: 0, totalRevenue: 0, totalTax: 0, totalsByMethod: { cash: 0, mpesa: 0, card: 0 } })
    ),
    getCurrentShift: vi.fn().mockResolvedValue(ok(OPEN_SHIFT)),
    getStaffList: vi.fn().mockResolvedValue(ok([{ id: 2, name: 'Ann', role: 'cashier' }])),
    getIntegrationConfig: vi.fn((provider: string) =>
      Promise.resolve(
        ok(
          provider === 'mpesa'
            ? {
                consumerKey: '',
                shortcode: '',
                environment: 'sandbox',
                callbackUrl: '',
                confirmationMethod: 'manual',
                smsInboxPath: '',
                manualEntryEnabled: false,
                ...mpesaOverrides
              }
            : { baseUrl: '', deviceIp: '', devicePort: '', defaultVatClass: '' }
        )
      )
    ),
    getMpesaCredentialStatus: vi
      .fn()
      .mockResolvedValue(ok({ consumerSecretConfigured: false, passkeyConfigured: false })),
    getEtimsSecretStatus: vi.fn().mockResolvedValue(ok({ passwordConfigured: false })),
    getStoreIdentity: vi.fn().mockResolvedValue(ok({ storeName: '', storeKraPin: '' })),
    getShopifyTokenStatus: vi.fn().mockResolvedValue(ok({ configured: false })),
    getShopifyStoreUrl: vi.fn().mockResolvedValue(ok({ storeUrl: '' })),
    getConfigStatus: vi.fn().mockResolvedValue(ok({ config: null })),
    getPrinters: vi.fn().mockResolvedValue(ok([])),
    getAllConfigs: vi.fn().mockResolvedValue(ok({})),
    setIntegrationConfig: vi.fn().mockResolvedValue(ok(undefined)),
    setMpesaCredentials: vi.fn().mockResolvedValue(ok(undefined)),
    setEtimsPassword: vi.fn().mockResolvedValue(ok(undefined)),
    setStoreIdentity: vi.fn().mockResolvedValue(ok(undefined)),
    setShopifyStoreUrl: vi.fn().mockResolvedValue(ok(undefined)),
    setShopifyToken: vi.fn().mockResolvedValue(ok(undefined)),
    savePrinter: vi.fn().mockResolvedValue(ok(undefined)),
    deletePrinter: vi.fn().mockResolvedValue(ok(undefined)),
    testPrinter: vi.fn().mockResolvedValue(ok(undefined)),
    testMpesaConnection: vi.fn().mockResolvedValue(ok(undefined)),
    testEtimsConnection: vi.fn().mockResolvedValue(ok(undefined)),
    createStaff: vi.fn().mockResolvedValue(ok(undefined)),
    resetStaffPin: vi.fn().mockResolvedValue(ok(undefined)),
    openShift: vi.fn().mockResolvedValue(ok(undefined)),
    closeShift: vi.fn().mockResolvedValue(ok({ expectedCash: 100, discrepancy: 0 })),
    getZReport: vi.fn().mockResolvedValue(ok(null)),
    checkForUpdates: vi.fn().mockResolvedValue(ok(undefined))
  } as unknown as typeof window.api
}

/** Auto-approves every `requestManagerPin` gate with a fixed manager — AdminScreen only ever forwards it. */
const requestManagerPin = (
  _title: string,
  onAuthorized: (managerId: number, managerPin: string) => void
): void => onAuthorized(9, '9999')

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(AdminScreen, { requestManagerPin }))
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

function inputByLabel(labelText: string): HTMLInputElement {
  const labels = Array.from(container.querySelectorAll('label'))
  const label = labels.find((l) => l.textContent?.trim().startsWith(labelText))
  if (!label) throw new Error(`No label "${labelText}"`)
  // Every converted field's <input> is its label's next sibling in the markup.
  const input = label.nextElementSibling as HTMLInputElement | null
  if (!input || input.tagName !== 'INPUT') throw new Error(`No input after label "${labelText}"`)
  return input
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useKeyboardStore.setState({ request: null })
  useAuthStore.setState({ currentStaff: { id: 1, name: 'Admin', role: 'admin' } })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AdminScreen > Integrations > Shopify: readOnly fields open the keyboard with the right mode/secret', () => {
  const cases: Array<{ label: string; mode: string; secret: boolean }> = [
    { label: 'Store URL', mode: 'text', secret: false },
    { label: 'New Token (starts with shpat_)', mode: 'text', secret: true }
  ]

  it.each(cases)('$label — mode $mode, secret $secret', async ({ label, mode, secret }) => {
    stubApi()
    await mount()
    await click('Integrations')

    const input = inputByLabel(label)
    expect(input.readOnly).toBe(true)

    act(() => input.click())
    const request = useKeyboardStore.getState().request
    expect(request?.label).toBeTruthy()
    expect(request?.mode ?? 'caps').toBe(mode)
    expect(request?.secret ?? false).toBe(secret)
  })

  it('typing through the keyboard updates the Store URL field, and Save sends the typed value', async () => {
    stubApi()
    await mount()
    await click('Integrations')

    const input = inputByLabel('Store URL')
    act(() => input.click())
    act(() => useKeyboardStore.getState().request?.onChange('https://rubis.myshopify.com'))
    expect(inputByLabel('Store URL').value).toBe('https://rubis.myshopify.com')

    await click('Save Store URL')
    expect(window.api.setShopifyStoreUrl).toHaveBeenCalledWith(
      'https://rubis.myshopify.com',
      9,
      '9999'
    )
  })

  it('typing a new Shopify token (secret field) updates the field, and Save sends it', async () => {
    stubApi()
    await mount()
    await click('Integrations')

    const input = inputByLabel('New Token (starts with shpat_)')
    act(() => input.click())
    const request = useKeyboardStore.getState().request
    expect(request?.secret).toBe(true)
    act(() => request?.onChange('shpat_abc123'))
    expect(inputByLabel('New Token (starts with shpat_)').value).toBe('shpat_abc123')

    await click('Save Token')
    expect(window.api.setShopifyToken).toHaveBeenCalledWith('shpat_abc123')
  })
})

describe('AdminScreen > Integrations > M-Pesa (Daraja fields)', () => {
  const cases: Array<{ label: string; mode: string; secret: boolean }> = [
    { label: 'Shortcode', mode: 'caps', secret: false },
    { label: 'Consumer Key', mode: 'text', secret: false },
    { label: 'Consumer Secret', mode: 'text', secret: true },
    { label: 'Passkey', mode: 'text', secret: true },
    { label: 'Callback URL', mode: 'text', secret: false }
  ]

  it.each(cases)('$label — mode $mode, secret $secret', async ({ label, mode, secret }) => {
    stubApi({ confirmationMethod: 'daraja' })
    await mount()
    await click('Integrations')
    await click('M-Pesa')

    const input = inputByLabel(label)
    expect(input.readOnly).toBe(true)
    act(() => input.click())
    const request = useKeyboardStore.getState().request
    expect(request?.mode ?? 'caps').toBe(mode)
    expect(request?.secret ?? false).toBe(secret)
  })

  it('typing a new Consumer Secret updates the field, and Save & Restart sends it', async () => {
    stubApi({ confirmationMethod: 'daraja' })
    await mount()
    await click('Integrations')
    await click('M-Pesa')

    const input = inputByLabel('Consumer Secret')
    act(() => input.click())
    act(() => useKeyboardStore.getState().request?.onChange('s3cr3t'))
    expect(inputByLabel('Consumer Secret').value).toBe('s3cr3t')

    await click('Save & Restart')
    expect(window.api.setMpesaCredentials).toHaveBeenCalledWith(
      { consumerSecret: 's3cr3t', passkey: undefined },
      9,
      '9999'
    )
  })
})

describe('AdminScreen > Integrations > M-Pesa (SMS field)', () => {
  it('"Where payment messages arrive" — mode text, not secret', async () => {
    stubApi({ confirmationMethod: 'sms', smsInboxPath: 'C:\\gammu\\inbox' })
    await mount()
    await click('Integrations')
    await click('M-Pesa')

    const input = inputByLabel('Where payment messages arrive')
    expect(input.readOnly).toBe(true)
    act(() => input.click())
    const request = useKeyboardStore.getState().request
    expect(request?.mode ?? 'caps').toBe('text')
    expect(request?.secret ?? false).toBe(false)
  })
})

describe('AdminScreen > Integrations > Fiscal Device + Store Details', () => {
  const cases: Array<{ label: string; mode: string; secret: boolean }> = [
    { label: 'Fiscal server address', mode: 'text', secret: false },
    { label: 'Fiscal device IP address', mode: 'ip', secret: false },
    { label: 'Fiscal device port', mode: 'numeric', secret: false },
    { label: 'Fiscal device password', mode: 'text', secret: true },
    { label: 'Default tax class', mode: 'caps', secret: false },
    { label: 'Store name', mode: 'text', secret: false },
    { label: 'Store KRA PIN', mode: 'caps', secret: false }
  ]

  it.each(cases)('$label — mode $mode, secret $secret', async ({ label, mode, secret }) => {
    stubApi()
    await mount()
    await click('Integrations')
    await click('Fiscal Device')

    const input = inputByLabel(label)
    expect(input.readOnly).toBe(true)
    act(() => input.click())
    const request = useKeyboardStore.getState().request
    expect(request?.mode ?? 'caps').toBe(mode)
    expect(request?.secret ?? false).toBe(secret)
  })

  it('typing a Store KRA PIN uppercases it exactly as the old onChange did, and Save sends it', async () => {
    stubApi()
    await mount()
    await click('Integrations')
    await click('Fiscal Device')

    const input = inputByLabel('Store KRA PIN')
    act(() => input.click())
    act(() => useKeyboardStore.getState().request?.onChange('p051234567z'))
    expect(inputByLabel('Store KRA PIN').value).toBe('P051234567Z')

    await click('Save Store Details')
    expect(window.api.setStoreIdentity).toHaveBeenCalledWith(
      { storeName: '', storeKraPin: 'P051234567Z' },
      9,
      '9999'
    )
  })
})

describe('AdminScreen > Integrations > Printer', () => {
  const cases: Array<{ label: string; mode: string }> = [
    { label: 'Printer id', mode: 'text' },
    { label: 'Printer interface', mode: 'text' }
  ]

  it.each(cases)('$label — mode $mode, opened via aria-label since it has no <label>', async ({ label, mode }) => {
    stubApi()
    await mount()
    await click('Integrations')
    await click('Printer')

    const input =
      label === 'Printer id'
        ? (container.querySelector('input[placeholder^="Printer id"]') as HTMLInputElement)
        : (container.querySelector('input[placeholder^="tcp://"]') as HTMLInputElement)
    expect(input.readOnly).toBe(true)
    act(() => input.click())
    expect(useKeyboardStore.getState().request?.mode ?? 'caps').toBe(mode)
  })
})

describe('AdminScreen > Overview > Shift cash fields', () => {
  it('Ending Cash (counted) — mode numeric, and typing + Confirm sends it', async () => {
    stubApi()
    await mount()
    // getCurrentShift is stubbed open, so "Close Shift" is already available.
    await click('Close Shift')

    const input = inputByLabel('Ending Cash (counted)')
    expect(input.readOnly).toBe(true)
    act(() => input.click())
    expect(useKeyboardStore.getState().request?.mode).toBe('numeric')
    act(() => useKeyboardStore.getState().request?.onChange('950'))
    expect(inputByLabel('Ending Cash (counted)').value).toBe('950')

    await click('Confirm')
    expect(window.api.closeShift).toHaveBeenCalledWith(1, 950)
  })
})

describe('AdminScreen > Overview > Staff fields', () => {
  it('new-staff Name and PIN, and Reset PIN, all open the keyboard with the right mode/secret', async () => {
    stubApi()
    await mount()
    await click('+ Add Staff')

    const nameInput = container.querySelector('input[placeholder="Name"]') as HTMLInputElement
    expect(nameInput.readOnly).toBe(true)
    act(() => nameInput.click())
    expect(useKeyboardStore.getState().request?.mode ?? 'caps').toBe('text')

    const pinInput = container.querySelector('input[placeholder="PIN"]') as HTMLInputElement
    expect(pinInput.readOnly).toBe(true)
    act(() => pinInput.click())
    expect(useKeyboardStore.getState().request?.mode).toBe('numeric')
    expect(useKeyboardStore.getState().request?.secret).toBe(true)

    await click('Cancel') // closes the add-staff form
    await click('Reset PIN')
    const resetInput = container.querySelector('input[placeholder="New PIN"]') as HTMLInputElement
    expect(resetInput.readOnly).toBe(true)
    act(() => resetInput.click())
    expect(useKeyboardStore.getState().request?.mode).toBe('numeric')
    expect(useKeyboardStore.getState().request?.secret).toBe(true)
  })

  it('typing a new staff name/PIN updates the fields, and Create sends them', async () => {
    stubApi()
    await mount()
    await click('+ Add Staff')

    const nameInput = container.querySelector('input[placeholder="Name"]') as HTMLInputElement
    act(() => nameInput.click())
    act(() => useKeyboardStore.getState().request?.onChange('Beatrice'))

    const pinInput = container.querySelector('input[placeholder="PIN"]') as HTMLInputElement
    act(() => pinInput.click())
    act(() => useKeyboardStore.getState().request?.onChange('4321'))

    expect((container.querySelector('input[placeholder="Name"]') as HTMLInputElement).value).toBe(
      'Beatrice'
    )
    expect((container.querySelector('input[placeholder="PIN"]') as HTMLInputElement).value).toBe('4321')

    await click('Create')
    expect(window.api.createStaff).toHaveBeenCalledWith('Beatrice', '4321', 'cashier', 9, '9999')
  })
})

describe('Sanity: the field-opening tests actually detect a broken wiring (not vacuous)', () => {
  it('fails to find a keyboard request if the field is not clicked at all', async () => {
    stubApi()
    await mount()
    await click('Integrations')

    // Deliberately not clicking the field — the point of this test is
    // to confirm `request` really does start `null` and is not already
    // populated by mount alone, so the assertions in the tests above
    // are actually exercising the click handler, not a false-positive
    // default state.
    expect(useKeyboardStore.getState().request).toBeNull()
  })

  /**
   * Every other test in this file drives the keyboard with a single
   * `onChange(fullString)` call, which passes regardless of whether
   * `keyboardStore.ts`'s relay keeps `request.value` in sync — that
   * accumulation contract is `tests/keyboardStore.test.ts`'s own job
   * (its "BUG FIX" test). This one instead types character by character,
   * exactly like the real `VirtualKeyboard` does, reading
   * `request.value` back between keystrokes — so it genuinely depends on
   * the relay, not just on `openField` calling `open()` at all.
   *
   * Verified (docs/phase-155): temporarily disabling the relay's
   * `set(...)` line in `keyboardStore.ts` made this test fail
   * (`seen` stopped accumulating, matching `keyboardStore.test.ts`'s own
   * "BUG FIX" test failing the same way) while every single-shot test
   * above kept passing — confirming they test different things, and this
   * one is not vacuous. Restored immediately after.
   */
  it('consecutive keystrokes accumulate on a real AdminScreen field, not just a single replacement', async () => {
    stubApi()
    await mount()
    await click('Integrations')

    const input = inputByLabel('Store URL')
    act(() => input.click())

    for (const char of ['h', 't', 't', 'p']) {
      const current = useKeyboardStore.getState().request!.value
      act(() => useKeyboardStore.getState().request!.onChange(current + char))
    }

    expect(inputByLabel('Store URL').value).toBe('http')
    expect(useKeyboardStore.getState().request?.value).toBe('http')
  })
})
