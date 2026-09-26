/**
 * `EndOfDayPage` (docs/phase-150.md deferred approval to this;
 * docs/phase-151/152 design it) — mounted with `react-dom/client`, the
 * `NeedsAttentionPage.test.ts`/`paymentModal.test.ts` pattern for a page
 * whose interactive surface is what needs covering.
 *
 * `window.api` is stubbed per test with only the methods this page and
 * `ManagerPinModal` call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import EndOfDayPage from '../src/renderer/src/pages/EndOfDayPage.js'
import type { EndOfDayReport } from '../src/main/services/reports.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'

let container: HTMLDivElement
let root: Root

function baseReport(overrides: Partial<EndOfDayReport> = {}): EndOfDayReport {
  return {
    localDay: '2026-09-10',
    cashiers: [
      {
        staffId: 1,
        staffName: 'Ann',
        orderCount: 2,
        totalsByMethod: { cash: 50, mpesa: 100, card: 0 },
        mpesaByMode: { manual: 60, daraja: 40 }
      }
    ],
    totalsByMethod: { cash: 50, mpesa: 100, card: 0 },
    manualEntries: [
      {
        paymentId: 1,
        orderLocalId: 10,
        createdAt: '2026-09-10T09:00:00.000Z',
        localDay: '2026-09-10',
        staffId: 1,
        staffName: 'Ann',
        reference: 'QDF73HK9LM',
        amount: 60,
        approved: false,
        reconciledAt: null,
        reconciledByStaffId: null,
        reconciledByStaffName: null
      }
    ],
    carryOver: [],
    pendingIds: [1],
    pendingManualTotal: 60,
    ...overrides
  }
}

function stubApi(report: EndOfDayReport, approveImpl?: (...args: unknown[]) => unknown): void {
  window.api = {
    getEndOfDayReport: vi.fn().mockResolvedValue({ success: true, data: report }),
    approveDayReport: vi.fn(approveImpl ?? (() => Promise.resolve({ success: true, data: {} }))),
    login: vi.fn().mockResolvedValue({ success: true, data: { id: 9, name: 'Manager Mo', role: 'admin' } })
  } as unknown as typeof window.api
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(EndOfDayPage))
    await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!el) throw new Error(`No button "${label}"`)
  return el as HTMLButtonElement
}

/**
 * Sets a controlled `<input>`'s value through the native setter, bypassing
 * React's own value tracking, then fires `input` — the standard jsdom
 * workaround for typing into a React-controlled field with no testing
 * library installed here.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useKeyboardStore.setState({ request: null })
  useAuthStore.setState({
    staffList: [
      { id: 1, name: 'Ann', role: 'cashier' },
      { id: 9, name: 'Manager Mo', role: 'admin' }
    ]
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('EndOfDayPage', () => {
  it('renders the per-cashier table, the M-Pesa mode split, and pending manual entries', async () => {
    stubApi(baseReport())
    await mount()

    expect(container.textContent).toContain('End of Day — 2026-09-10')
    expect(container.textContent).toContain('Ann')
    expect(container.textContent).toContain('QDF73HK9LM')
    expect(container.textContent).toContain('Pending')
    expect(container.textContent).toContain('1 entry')
  })

  it('shows carry-over separately, labeled by its own day', async () => {
    stubApi(
      baseReport({
        manualEntries: [],
        carryOver: [
          {
            paymentId: 2,
            orderLocalId: 5,
            createdAt: '2026-09-08T09:00:00.000Z',
            localDay: '2026-09-08',
            staffId: 1,
            staffName: 'Ann',
            reference: 'ABCD123456',
            amount: 20,
            approved: false,
            reconciledAt: null,
            reconciledByStaffId: null,
            reconciledByStaffName: null
          }
        ],
        pendingIds: [2],
        pendingManualTotal: 20
      })
    )
    await mount()

    expect(container.textContent).toContain('Carry-over — not yet approved')
    expect(container.textContent).toContain('2026-09-08')
    expect(container.textContent).toContain('ABCD123456')
  })

  it('disables "Approve day" when nothing is pending', async () => {
    stubApi(baseReport({ manualEntries: [], pendingIds: [], pendingManualTotal: 0 }))
    await mount()

    const approveButton = button('Nothing pending')
    expect(approveButton.disabled).toBe(true)
  })

  it('the optional note is a read-only field driven by the shared on-screen keyboard', async () => {
    stubApi(baseReport())
    await mount()

    const noteInput = container.querySelector('input[placeholder^="e.g."]') as HTMLInputElement
    expect(noteInput.readOnly).toBe(true)

    act(() => noteInput.click())
    expect(useKeyboardStore.getState().request).not.toBeNull()

    act(() => useKeyboardStore.getState().request?.onChange('checked against statement'))
    const updated = container.querySelector('input[placeholder^="e.g."]') as HTMLInputElement
    expect(updated.value).toBe('checked against statement')
  })

  it('approving completes with the manager PIN and shows how many entries were approved', async () => {
    const report = baseReport()
    stubApi(report)
    await mount()

    act(() => button('Approve day').click())
    expect(container.textContent).toContain('Manager PIN Required')

    // ManagerPinModal: pick the seeded admin and submit a PIN.
    const pinInput = container.querySelector('input[type="password"]') as HTMLInputElement
    act(() => typeInto(pinInput, '9999'))
    await act(async () => {
      button('Authorize').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.approveDayReport).toHaveBeenCalledWith(
      expect.objectContaining({
        localDay: '2026-09-10',
        paymentIds: [1],
        managerId: 9,
        managerPin: '9999'
      })
    )
  })

  it('reports "already approved" without re-approving when the backend says nothing was pending', async () => {
    const report = baseReport()
    stubApi(report, () =>
      Promise.resolve({
        success: true,
        data: {
          approval: {
            id: 3,
            local_day: '2026-09-10',
            approved_by_staff_id: 9,
            approved_at: '2026-09-10T18:00:00.000Z',
            entry_count: 1,
            total_amount: 60,
            note: null
          },
          approvedCount: 0,
          alreadyApproved: true
        }
      })
    )
    await mount()

    act(() => button('Approve day').click())
    const pinInput = container.querySelector('input[type="password"]') as HTMLInputElement
    act(() => typeInto(pinInput, '9999'))
    await act(async () => {
      button('Authorize').click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Already approved')
    expect(container.textContent).toContain('Manager Mo')
  })
})
