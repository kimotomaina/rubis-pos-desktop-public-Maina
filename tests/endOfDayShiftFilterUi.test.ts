/**
 * The shift filter on the End of Day screen (docs/phase-241): the shifts of the day as buttons, choosing one limits the
 * report to it, All shifts goes back, changing the day resets it, and a limited report cannot be approved.
 *
 * Layout: not checked by check:fit (owner's rule). For the owner to check on the till.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import EndOfDayPage from '../src/renderer/src/pages/EndOfDayPage.js'
import type { EndOfDayReport, ManualMpesaEntrySummary } from '../src/main/services/reports.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'

let container: HTMLDivElement
let root: Root

const entry = (paymentId: number, orderLocalId: number): ManualMpesaEntrySummary => ({
  paymentId,
  orderLocalId,
  createdAt: '2026-10-05T09:00:00.000Z',
  localDay: '2026-10-05',
  staffId: 1,
  staffName: 'Ann',
  reference: `REF${paymentId}`,
  amount: 60,
  approved: false,
  reconciledAt: null,
  reconciledByStaffId: null,
  reconciledByStaffName: null,
  sameApproverAsRecorder: false,
  lastExclusion: null
})

const shiftsOfDay = [
  { shiftId: 3, status: 'closed' as const, openedAt: '2026-10-05T07:00:00.000Z', closedAt: '2026-10-05T14:30:00.000Z', windowType: 'day' as const, windowDate: '2026-10-05', orderCount: 2 },
  { shiftId: 4, status: 'open' as const, openedAt: '2026-10-05T14:43:00.000Z', closedAt: null, windowType: 'night' as const, windowDate: '2026-10-05', orderCount: 1 }
]

const whole: EndOfDayReport = {
  localDay: '2026-10-05',
  shiftId: null,
  shiftsOfDay,
  cashiers: [{ staffId: 1, staffName: 'Ann', orderCount: 3, totalsByMethod: { cash: 150, mpesa: 120, card: 0 }, mpesaByMode: { manual: 120, daraja: 0 } }],
  totalsByMethod: { cash: 150, mpesa: 120, card: 0 },
  manualEntries: [entry(1, 10), entry(2, 11)],
  carryOver: [],
  pendingIds: [1, 2],
  pendingManualTotal: 120
}
const limited: EndOfDayReport = {
  ...whole,
  shiftId: 4,
  cashiers: [{ staffId: 1, staffName: 'Ann', orderCount: 1, totalsByMethod: { cash: 0, mpesa: 60, card: 0 }, mpesaByMode: { manual: 60, daraja: 0 } }],
  totalsByMethod: { cash: 0, mpesa: 60, card: 0 },
  manualEntries: [entry(2, 11)],
  pendingIds: [2],
  pendingManualTotal: 60
}

function stubApi(): void {
  window.api = {
    getEndOfDayReport: vi.fn().mockImplementation(async (_day?: string, shiftId?: number) => ({
      success: true,
      data: shiftId === 4 ? limited : whole
    })),
    getDiscardedHeldSales: vi.fn().mockResolvedValue({ success: true, data: [] }),
    approveDayReport: vi.fn(),
    login: vi.fn()
  } as unknown as typeof window.api
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(EndOfDayPage))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(labelStart: string): Promise<void> {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.startsWith(labelStart))
  if (!el) throw new Error(`No button starting "${labelStart}"`)
  await act(async () => {
    el.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const pressed = (): string[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="end-of-day-shifts"] button'))
    .filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent ?? '')

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useKeyboardStore.setState({ request: null })
  useAuthStore.setState({ staffList: [{ id: 1, name: 'Ann', role: 'cashier' }], fetchStaffList: vi.fn() } as never)
  stubApi()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('the shift filter on End of Day', () => {
  it('offers All shifts and each shift of the day, with its window, its hours and its sales, All shifts chosen', async () => {
    await mount()

    const buttons = Array.from(container.querySelectorAll('[data-testid="end-of-day-shifts"] button')).map((b) => b.textContent ?? '')
    expect(buttons).toHaveLength(3)
    expect(buttons[0]).toBe('All shifts')
    expect(buttons[1]).toMatch(/^#3 Day, \d{2}:\d{2} to \d{2}:\d{2} \(2 sales\)$/)
    expect(buttons[2]).toMatch(/^#4 Night, from \d{2}:\d{2}, open \(1 sale\)$/)
    expect(pressed()).toEqual(['All shifts'])
  })

  it('asks the main process for the day as it always did when no shift is chosen', async () => {
    await mount()

    expect(window.api.getEndOfDayReport).toHaveBeenCalledTimes(1)
    expect(vi.mocked(window.api.getEndOfDayReport).mock.calls[0]).toEqual([undefined])
  })

  it('limits the report to the chosen shift, and says so', async () => {
    await mount()

    await click('#4 Night')

    expect(window.api.getEndOfDayReport).toHaveBeenLastCalledWith('2026-10-05', 4)
    expect(container.textContent).toContain('End of Day — 2026-10-05 — shift #4')
    expect(container.textContent).toContain('Showing shift #4 only. To approve entries, choose All shifts.')
    expect(pressed()).toHaveLength(1)
    expect(pressed()[0]).toMatch(/^#4 Night/)
    // The other shift's entry is gone from the table; this shift's is there.
    expect(container.textContent).toContain('REF2')
    expect(container.textContent).not.toContain('REF1')
  })

  it('cannot approve a limited report: no tick boxes, the button is off and says where to approve', async () => {
    await mount()
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)

    await click('#4 Night')

    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    const approve = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'All shifts to approve') as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    expect(container.querySelector('[data-testid="end-of-day-limited"]')?.textContent).toContain(
      'Shift #4 only: 1 pending entry'
    )
    expect(container.querySelector('[data-testid="end-of-day-limited"]')?.textContent).toContain('Approving is done from All shifts.')
    approve.click()
    expect(window.api.approveDayReport).not.toHaveBeenCalled()
  })

  it('goes back to the whole day, approving again, with All shifts', async () => {
    await mount()
    await click('#4 Night')

    await click('All shifts')

    expect(vi.mocked(window.api.getEndOfDayReport).mock.calls.at(-1)).toEqual(['2026-10-05'])
    expect(pressed()).toEqual(['All shifts'])
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Approve')).toBe(true)
  })

  it('forgets the shift when the day changes: a shift belongs to its day', async () => {
    await mount()
    await click('#4 Night')

    await click('← Previous day')

    expect(vi.mocked(window.api.getEndOfDayReport).mock.calls.at(-1)).toEqual(['2026-10-04'])
  })

  it('shows no filter when the day has no shift with sales', async () => {
    window.api = {
      ...window.api,
      getEndOfDayReport: vi.fn().mockResolvedValue({ success: true, data: { ...whole, shiftsOfDay: [] } })
    } as unknown as typeof window.api

    await mount()

    expect(container.querySelector('[data-testid="end-of-day-shifts"]')).toBeNull()
  })

  it('still works with a report that carries no shift list (an older answer)', async () => {
    const { shiftId: _s, shiftsOfDay: _l, ...older } = whole
    window.api = {
      ...window.api,
      getEndOfDayReport: vi.fn().mockResolvedValue({ success: true, data: older })
    } as unknown as typeof window.api

    await mount()

    expect(container.querySelector('[data-testid="end-of-day-shifts"]')).toBeNull()
    expect(container.textContent).toContain('End of Day — 2026-10-05')
  })
})
