/**
 * The screens for recording a shift after the fact (docs/phase-223): the period as Nairobi clock times, the
 * "Sales with no shift" block on Shift History, and the form that previews, validates and asks for the PIN.
 * Real mount, as `tests/reportsPage.test.ts` does it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReportsPage from '../src/renderer/src/pages/ReportsPage.js'
import PastShiftForm from '../src/renderer/src/components/PastShiftForm.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import { nairobiMinuteText, periodEdgeToIso } from '../src/renderer/src/lib/pastShiftPeriod.js'
import type { PastShiftPreview, UnattachedDay } from '../src/main/services/past-shifts.js'

vi.mock('../src/renderer/src/components/ManagerPinModal.js', () => ({
  default: ({ onAuthorized }: { onAuthorized: (id: number, pin: string) => void }) =>
    createElement('button', { onClick: () => onAuthorized(2, '1234') }, 'Authorize as manager')
}))

let container: HTMLDivElement
let root: Root

const ok = <T,>(data?: T) => ({ success: true as const, data })

const DAY: UnattachedDay = {
  localDay: '2026-10-03',
  count: 3,
  total: 950,
  firstAt: '2026-10-03T07:00:42.000Z', // 10:00 Nairobi
  lastAt: '2026-10-03T14:30:10.000Z' // 17:30 Nairobi
}

const PREVIEW: PastShiftPreview = {
  startIso: '2026-10-03T07:00:00.000Z',
  endIso: '2026-10-03T14:30:59.999Z',
  sales: [
    { id: 11, createdAt: '2026-10-03T08:00:00.000Z', method: 'cash', total: 500 },
    { id: 12, createdAt: '2026-10-03T09:00:00.000Z', method: 'mpesa', total: 300 },
    { id: 13, createdAt: '2026-10-03T10:00:00.000Z', method: 'card', total: 150 }
  ],
  count: 3,
  total: 950,
  totalsByMethod: { cash: 500, mpesa: 300, card: 150 },
  suggestedShiftType: 'day',
  problem: null
}

function stubApi(overrides: Record<string, unknown> = {}): void {
  window.api = {
    getStaffList: vi.fn().mockResolvedValue(ok([])),
    getShiftsList: vi.fn().mockResolvedValue(ok({ shifts: [], total: 0, page: 1 })),
    getUnattachedDays: vi.fn().mockResolvedValue(ok([DAY])),
    previewPastShift: vi.fn().mockResolvedValue(ok(PREVIEW)),
    createPastShift: vi.fn().mockResolvedValue(ok({ shiftId: 9, attachedCount: 3 })),
    ...overrides
  } as unknown as typeof window.api
}

const flush = async (): Promise<void> => {
  await act(async () => {
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

/** Types into a field by its aria-label, through the on-screen keyboard as the till does. */
function type(label: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) throw new Error(`No field "${label}"`)
  act(() => input.click())
  act(() => useKeyboardStore.getState().request?.onChange(value))
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

describe('the period, as Nairobi clock times', () => {
  it('shows an instant as the Nairobi minute it falls in, across the UTC day', () => {
    expect(nairobiMinuteText('2026-10-02T21:37:08.330Z')).toBe('2026-10-03 00:37')
    expect(nairobiMinuteText('2026-10-03T14:30:59.999Z')).toBe('2026-10-03 17:30')
  })

  it('starts at the first millisecond of a minute and ends at its last, so a sale at 17:30:42 is inside "to 17:30"', () => {
    expect(periodEdgeToIso('2026-10-03 10:00', 'start')).toBe('2026-10-03T07:00:00.000Z')
    expect(periodEdgeToIso('2026-10-03 17:30', 'end')).toBe('2026-10-03T14:30:59.999Z')
    expect(periodEdgeToIso('2026-10-03 00:30', 'start')).toBe('2026-10-02T21:30:00.000Z')
  })

  it('refuses text that is not a real date and time', () => {
    for (const bad of ['', '2026-10-03', '2026-10-03 25:00', '2026-10-03 10:60', '2026-13-03 10:00', '2026-02-31 10:00', 'x']) {
      expect(periodEdgeToIso(bad, 'start')).toBeNull()
    }
  })
})

describe('Shift History: Sales with no shift', () => {
  const openHistory = async (): Promise<void> => {
    await act(async () => {
      root.render(createElement(ReportsPage))
      await Promise.resolve()
    })
    await click('Shift History')
    await flush()
  }

  it('adds one button to the title row, with the count, and no block of its own', async () => {
    stubApi()
    await openHistory()

    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Sales with no shift: 3')).toBe(true)
    expect(container.textContent).not.toContain('Create shift for these')
  })

  it('lists each day with its count, times and total, and a button to create the shift', async () => {
    stubApi()
    await openHistory()
    await click('Sales with no shift: 3')

    expect(container.textContent).toContain('2026-10-03')
    expect(container.textContent).toContain('3 sales')
    expect(container.textContent).toContain('10:00 to 17:30')
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Create shift for these')).toBe(true)

    await click('Back to Shift History')
    expect(container.textContent).toContain('Shift History')
  })

  it('shows no button at all when every sale has a shift', async () => {
    stubApi({ getUnattachedDays: vi.fn().mockResolvedValue(ok([])) })
    await openHistory()

    expect(container.textContent).not.toContain('Sales with no shift')
  })

  it('opens the form prefilled from that day, and Cancel returns to the list', async () => {
    stubApi()
    await openHistory()
    await click('Sales with no shift: 3')
    await click('Create shift for these')
    await flush()

    expect(container.textContent).toContain('Record a shift for 2026-10-03')
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Period start"]')!.value).toBe('2026-10-03 10:00')
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Period end"]')!.value).toBe('2026-10-03 17:30')

    await click('Cancel')
    expect(container.textContent).toContain('Sales with no shift')
    expect(container.textContent).not.toContain('Record a shift for')
  })

  it('marks a shift recorded afterwards in the table', async () => {
    stubApi({
      getUnattachedDays: vi.fn().mockResolvedValue(ok([])),
      getShiftsList: vi.fn().mockResolvedValue(
        ok({
          shifts: [
            { id: 9, staff_id: 2, clock_in: PREVIEW.startIso, clock_out: PREVIEW.endIso, starting_cash: 1, expected_cash: 1, ending_cash: 1, discrepancy: 0, status: 'closed', kind: 'retrospective' },
            { id: 8, staff_id: 2, clock_in: PREVIEW.startIso, clock_out: PREVIEW.endIso, starting_cash: 1, expected_cash: 1, ending_cash: 1, discrepancy: 0, status: 'closed' }
          ],
          total: 2,
          page: 1
        })
      )
    })
    await openHistory()

    expect(container.textContent?.match(/Recorded later/g)).toHaveLength(1)
  })
})

describe('PastShiftForm', () => {
  const mount = async (onRecorded = vi.fn(), onCancel = vi.fn()): Promise<void> => {
    await act(async () => {
      root.render(createElement(PastShiftForm, { day: DAY, onCancel, onRecorded }))
      await Promise.resolve()
    })
    await flush()
  }

  it('previews the sales for the period it was given, converted from Nairobi time to instants', async () => {
    stubApi()
    await mount()

    expect(window.api.previewPastShift).toHaveBeenCalledWith('2026-10-03T07:00:00.000Z', '2026-10-03T14:30:59.999Z')
    expect(container.textContent).toContain('3 sales, ')
    expect(container.textContent).toContain('#11')
    expect(container.textContent).toContain('#13')
  })

  it('shows the reason a period cannot be recorded, and sends nothing when asked to record it', async () => {
    stubApi({ previewPastShift: vi.fn().mockResolvedValue(ok({ ...PREVIEW, sales: [], count: 0, problem: 'This period overlaps shift #4' })) })
    await mount()

    expect(container.textContent).toContain('This period overlaps shift #4')
    await click('Record shift')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('This period overlaps shift #4')
    expect(window.api.createPastShift).not.toHaveBeenCalled()
  })

  it('says so when a period is typed that is not a date, and does not ask the main process', async () => {
    stubApi()
    await mount()
    vi.mocked(window.api.previewPastShift).mockClear()

    type('Period start', '2026-02-31 10:00')
    await flush()

    expect(container.textContent).toContain('Enter the start and the end as YYYY-MM-DD HH:MM')
    expect(window.api.previewPastShift).not.toHaveBeenCalled()
  })

  it('asks for both cash figures, then for a reason, before it asks for the PIN', async () => {
    stubApi()
    await mount()

    await click('Record shift')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Enter the starting cash and the counted ending cash'
    )

    type('Starting cash', '1000')
    type('Ending cash (counted)', '1480')
    await click('Record shift')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Say why this shift is being recorded after the fact'
    )
    expect(container.textContent).not.toContain('Authorize as manager')
  })

  it('refuses a bad optional M-Pesa balance before the PIN', async () => {
    stubApi()
    await mount()
    type('Starting cash', '1000')
    type('Ending cash (counted)', '1480')
    type('Reason', 'Till used without opening a shift')
    type('M-Pesa balance at end (optional)', 'abc')
    await click('Record shift')

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Enter a valid M-Pesa balance, or leave it blank')
  })

  it('sends exactly the sales shown, the figures, the type and the manager, once authorised', async () => {
    stubApi()
    const onRecorded = vi.fn()
    await mount(onRecorded)
    type('Starting cash', '1000')
    type('Ending cash (counted)', '1480')
    type('M-Pesa balance at start (optional)', '1000')
    type('Reason', 'Till used without opening a shift')

    await click('Record shift')
    await click('Authorize as manager')
    await flush()

    expect(window.api.createPastShift).toHaveBeenCalledWith({
      managerId: 2,
      managerPin: '1234',
      startIso: '2026-10-03T07:00:00.000Z',
      endIso: '2026-10-03T14:30:59.999Z',
      orderIds: [11, 12, 13],
      startingCash: 1000,
      endingCash: 1480,
      mpesaOpeningBalance: 1000,
      mpesaClosingBalance: null,
      shiftType: 'day',
      reason: 'Till used without opening a shift'
    })
    expect(onRecorded).toHaveBeenCalledWith('Shift #9 recorded for 3 sales.')
  })

  it('suggests the shift from the period start and lets the manager change it, which is then sent', async () => {
    stubApi({ previewPastShift: vi.fn().mockResolvedValue(ok({ ...PREVIEW, suggestedShiftType: 'night' })) })
    await mount()
    const checked = (): string | undefined =>
      Array.from(container.querySelectorAll('[role="radio"]')).find((r) => r.getAttribute('aria-checked') === 'true')?.textContent ?? undefined
    expect(checked()).toBe('Night shift (17:31 to 08:59)')

    await click('Day shift (09:00 to 17:30)')
    type('Starting cash', '1')
    type('Ending cash (counted)', '1')
    type('Reason', 'r')
    await click('Record shift')
    await click('Authorize as manager')
    await flush()

    expect(vi.mocked(window.api.createPastShift).mock.calls[0][0].shiftType).toBe('day')
  })

  it('shows the main process refusal and re-reads the list, so a stale one is replaced', async () => {
    stubApi({ createPastShift: vi.fn().mockResolvedValue({ success: false, error: 'Order #12 now belongs to shift #4' }) })
    const onRecorded = vi.fn()
    await mount(onRecorded)
    type('Starting cash', '1')
    type('Ending cash (counted)', '1')
    type('Reason', 'r')
    vi.mocked(window.api.previewPastShift).mockClear()

    await click('Record shift')
    await click('Authorize as manager')
    await flush()

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Order #12 now belongs to shift #4')
    expect(onRecorded).not.toHaveBeenCalled()
    expect(window.api.previewPastShift).toHaveBeenCalledTimes(1)
  })
})
