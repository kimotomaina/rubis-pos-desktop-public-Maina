/**
 * The optional M-Pesa balance field on the Open Shift and Close Shift forms (docs/phase-222).
 *
 * Blank means "not recorded" and sends the call it always sent, so cash handling is unchanged; a figure is sent
 * as a fourth (open) or third (close) argument; a bad figure stops before anything is sent. Real mount, the same
 * way `tests/adminShiftWindows.test.ts` does it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AdminScreen from '../src/renderer/src/components/AdminScreen.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import type { ShiftRow } from '../src/main/services/database.js'

let container: HTMLDivElement
let root: Root

const ok = <T,>(data?: T) => ({ success: true as const, data })

const shiftRow = (overrides: Partial<ShiftRow> = {}): ShiftRow => ({
  id: 5,
  staff_id: 1,
  clock_in: '2026-10-02T07:00:00.000Z',
  clock_out: null,
  starting_cash: 100,
  expected_cash: null,
  ending_cash: null,
  discrepancy: null,
  status: 'open',
  ...overrides
})

function stubApi(shift: ShiftRow | null): void {
  const named: Record<string, unknown> = {
    platform: 'linux',
    getCurrentShift: vi.fn().mockResolvedValue(ok(shift)),
    getAppVersion: vi.fn().mockResolvedValue('2.2.1'),
    onUpdateStatus: vi.fn(() => () => {}),
    openShift: vi.fn().mockResolvedValue(ok({ shiftId: 6 })),
    closeShift: vi
      .fn()
      .mockResolvedValue(ok({ expectedCash: 100, discrepancy: 0, mpesaExpected: null, mpesaDifference: null })),
    getZReport: vi.fn().mockResolvedValue(ok(null))
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

// CHANGED (docs/phase-256). OLD: Confirm closed the shift. NEW: the shared close dialog shows the figures for review
// first: Review, then Close shift. A refused figure stops at Review, with its message.
async function confirmClose(): Promise<void> {
  await click('Review')
  if (Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Close shift')) await click('Close shift')
}

/** Types into the nth text field of the open form, through the on-screen keyboard as the till does. */
function type(index: number, value: string): void {
  act(() => container.querySelectorAll('input')[index]!.click())
  act(() => useKeyboardStore.getState().request?.onChange(value))
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

describe('Open Shift: M-Pesa balance (optional)', () => {
  const openForm = async (): Promise<void> => {
    stubApi(null)
    await mount()
    await click('Overview')
    await click('Open Shift')
  }

  it('shows the field as optional, empty and marked "Not recorded"', async () => {
    await openForm()

    expect(container.textContent).toContain('M-Pesa balance (optional)')
    const field = container.querySelectorAll('input')[1]!
    // CHANGED (docs/phase-246, R4): it started at 0. CHANGED again (docs/phase-246-2, the owner's ruling): it starts blank, "Not recorded".
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('Not recorded')
  })

  it('sends the call it always sent when the field is left blank', async () => {
    await openForm()
    type(0, '250')
    // CHANGED (docs/phase-246, R4). OLD: the field was blank already. NEW: it starts at 0, so it is cleared here.
    type(1, '')
    await click('Confirm')

    // CHANGED (docs/phase-232). OLD: openShift(1, 250, type), three arguments. NEW: openShift(1, 250, balance, options): no type is
    // sent, a blank balance is undefined, and the options carry what the form showed of the earlier sales.
    expect(vi.mocked(window.api.openShift).mock.calls[0].slice(0, 3)).toEqual([1, 250, undefined])
  })

  it('sends the balance as the third argument, and a typed 0 as 0', async () => {
    await openForm()
    type(0, '250')
    type(1, '1500.50')
    await click('Confirm')
    // CHANGED (docs/phase-232). OLD: [1, 250, type, 1500.5], the balance the fourth argument. NEW: it is the third.
    expect(vi.mocked(window.api.openShift).mock.calls[0].slice(0, 3)).toEqual([1, 250, 1500.5])

    act(() => root.unmount())
    root = createRoot(container)
    await openForm()
    type(0, '250')
    type(1, '0')
    await click('Confirm')
    expect(vi.mocked(window.api.openShift).mock.calls[0].slice(0, 3)).toEqual([1, 250, 0])
  })

  it('refuses a bad balance with a message and sends nothing', async () => {
    await openForm()
    type(0, '250')
    type(1, 'abc')
    await click('Confirm')

    expect(window.api.openShift).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Enter a valid M-Pesa balance, or leave it blank')
  })
})

describe('Close Shift: M-Pesa balance (optional)', () => {
  const closeForm = async (shift = shiftRow()): Promise<void> => {
    stubApi(shift)
    await mount()
    await click('Overview')
    await click('Close Shift')
  }

  it('sends the call it always sent when the field is left blank', async () => {
    await closeForm()
    type(0, '180')
    await confirmClose()

    expect(window.api.closeShift).toHaveBeenCalledWith(5, 180)
    expect(vi.mocked(window.api.closeShift).mock.calls[0]).toHaveLength(2)
  })

  it('sends the counted balance as the third argument', async () => {
    await closeForm()
    type(0, '180')
    type(1, '1480')
    await confirmClose()

    expect(window.api.closeShift).toHaveBeenCalledWith(5, 180, 1480)
  })

  it('refuses a negative balance and sends nothing', async () => {
    await closeForm()
    type(0, '180')
    type(1, '-5')
    await confirmClose()

    expect(window.api.closeShift).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Enter a valid M-Pesa balance, or leave it blank')
  })

  it('states the opening balance on the open shift when one was recorded, and says nothing when not', async () => {
    stubApi(shiftRow({ mpesa_opening_balance: 1000 }))
    await mount()
    await click('Overview')
    expect(container.textContent).toMatch(/starting cash and .*1,000\.00 M-Pesa balance\./)

    act(() => root.unmount())
    root = createRoot(container)
    stubApi(shiftRow())
    await mount()
    await click('Overview')
    expect(container.textContent).not.toContain('M-Pesa balance.')
  })
})

// ADDED (docs/phase-246, R5): the card settlement beside the M-Pesa balance on the Close Shift form.
describe('Close Shift: card settlement (optional)', () => {
  const closeForm = async (): Promise<void> => {
    stubApi(shiftRow())
    await mount()
    await click('Overview')
    await click('Close Shift')
  }

  it('is a third field, empty and marked "Not recorded"', async () => {
    await closeForm()

    expect(container.textContent).toContain('Card settlement (optional)')
    const field = container.querySelectorAll('input')[2]!
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('Not recorded')
  })

  it('sends the call it always sent when it is left blank, whatever M-Pesa holds', async () => {
    await closeForm()
    type(0, '180')
    await confirmClose()
    expect(window.api.closeShift).toHaveBeenCalledWith(5, 180)
    expect(vi.mocked(window.api.closeShift).mock.calls[0]).toHaveLength(2)

    act(() => root.unmount())
    root = createRoot(container)
    await closeForm()
    type(0, '180')
    type(1, '1480')
    await confirmClose()
    expect(vi.mocked(window.api.closeShift).mock.calls[0]).toEqual([5, 180, 1480])
  })

  it('sends the card figure as the fourth argument, with a null M-Pesa balance when only card is given, and a typed 0 as 0', async () => {
    await closeForm()
    type(0, '180')
    type(2, '3800')
    await confirmClose()
    expect(vi.mocked(window.api.closeShift).mock.calls[0]).toEqual([5, 180, null, 3800])

    act(() => root.unmount())
    root = createRoot(container)
    await closeForm()
    type(0, '180')
    type(1, '1480')
    type(2, '0')
    await confirmClose()
    expect(vi.mocked(window.api.closeShift).mock.calls[0]).toEqual([5, 180, 1480, 0])
  })

  it('refuses a bad figure with a message and sends nothing', async () => {
    await closeForm()
    type(0, '180')
    type(2, 'abc')
    await confirmClose()

    expect(window.api.closeShift).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Enter a valid card settlement amount, or leave it blank')
  })
})
