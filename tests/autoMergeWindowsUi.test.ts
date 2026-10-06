/**
 * Shift History shows a merged window once (docs/phase-242): the shift that holds the window is the row, the shifts
 * merged into it are named on it and open their own Z reports, and a window with one shift has no "Window report".
 *
 * Layout: not checked by check:fit (owner's rule). For the owner to check on the till.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReportsPage from '../src/renderer/src/pages/ReportsPage.js'
import { reportsTabApi, openSection } from './helpers/reportsTabApi.js'
import type { ShiftRow } from '../src/main/services/database.js'

let container: HTMLDivElement
let root: Root
const ok = <T,>(data?: T) => ({ success: true as const, data })
const iso = (t: string): string => new Date(`${t}+03:00`).toISOString()

const survivor: ShiftRow = {
  id: 2,
  staff_id: 2,
  clock_in: iso('2026-10-05T20:50:00'),
  clock_out: null,
  starting_cash: 3790,
  expected_cash: null,
  ending_cash: null,
  discrepancy: null,
  status: 'open',
  shift_type: 'night',
  window_type: 'night',
  window_date: '2026-10-05',
  window_shift_count: 1,
  absorbed_shifts: [{ id: 1, clock_in: iso('2026-10-05T17:43:21'), clock_out: iso('2026-10-05T17:43:36') }]
}
const plain: ShiftRow = {
  id: 3,
  staff_id: 2,
  clock_in: iso('2026-10-04T10:00:00'),
  clock_out: iso('2026-10-04T17:30:00'),
  starting_cash: 0,
  expected_cash: 0,
  ending_cash: 0,
  discrepancy: 0,
  status: 'closed',
  shift_type: 'day',
  window_type: 'day',
  window_date: '2026-10-04',
  window_shift_count: 1
}

// CHANGED (docs/phase-246). OLD: the Reports page opened on a card grid and Shift History was reached by tapping its card. NEW: Shift History
// is the last section of the one Reports tab, always there; the tab also calls the takings, the end of day and the fiscal checks, which
// `reportsTabApi()` answers with nothing.
function stubApi(shifts: ShiftRow[]): void {
  window.api = {
    ...reportsTabApi(),
    getStaffList: vi.fn().mockResolvedValue(ok([{ id: 2, name: 'manager mo', role: 'admin' }])),
    getShiftsList: vi.fn().mockResolvedValue(ok({ shifts, total: shifts.length, page: 1 })),
    autoAssignSales: vi.fn().mockResolvedValue(ok({ touched: [], waiting: 0 })),
    getZReport: vi.fn().mockResolvedValue(ok(undefined))
  } as unknown as typeof window.api
}

async function openHistory(): Promise<void> {
  await act(async () => {
    root.render(createElement(ReportsPage))
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  await openSection(container, 'shifts')
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('Shift History after the till merged a window', () => {
  it('shows one row for the window, with the merged shift named on it', async () => {
    stubApi([survivor, plain])

    await openHistory()

    const rows = container.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('#2')
    expect(rows[0].textContent).toContain('includes #1')
    expect(container.textContent).not.toContain('Merged into')
    expect(rows[1].textContent).not.toContain('includes')
  })

  it('opens the merged shift\'s own Z report from that name, and not the row\'s', async () => {
    stubApi([survivor])
    await openHistory()

    const includes = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'includes #1') as HTMLButtonElement
    await act(async () => {
      includes.click()
      await Promise.resolve()
    })

    expect(window.api.getZReport).toHaveBeenCalledTimes(1)
    expect(window.api.getZReport).toHaveBeenCalledWith(1)
  })

  it('has no Window report button or Merge action for a window that now holds one shift', async () => {
    stubApi([survivor])
    await openHistory()

    expect(container.textContent).not.toContain('Window report')
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.startsWith('Merge into'))).toBe(false)
  })
})
