/**
 * The screens of a frozen shift (docs/phase-243): Shift History marks a closed shift that is not the latest closed one
 * as Locked and offers no Correct figures on it; its Z report offers none either.
 *
 * Layout: not checked by check:fit (owner's rule). For the owner to check on the till.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReportsPage from '../src/renderer/src/pages/ReportsPage.js'
import ZReportModal from '../src/renderer/src/components/ZReportModal.js'
import type { ShiftRow } from '../src/main/services/database.js'
import type { ZReport } from '../src/main/services/reports.js'

let container: HTMLDivElement
let root: Root
const ok = <T,>(data?: T) => ({ success: true as const, data })
const iso = (t: string): string => new Date(`${t}+03:00`).toISOString()

const closedShift = (id: number, extra: Partial<ShiftRow> = {}): ShiftRow => ({
  id,
  staff_id: 2,
  clock_in: iso(`2026-10-0${id}T10:00:00`),
  clock_out: iso(`2026-10-0${id}T17:30:00`),
  starting_cash: 0,
  expected_cash: 0,
  ending_cash: 0,
  discrepancy: 0,
  status: 'closed',
  shift_type: 'day',
  window_type: 'day',
  window_date: `2026-10-0${id}`,
  window_shift_count: 1,
  ...extra
})

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

describe('Shift History with a frozen shift', () => {
  const rows = (): HTMLTableRowElement[] => Array.from(container.querySelectorAll('tbody tr'))

  it('marks an older closed shift Locked and gives it no Correct figures, while the latest closed one keeps it', async () => {
    window.api = {
      getStaffList: vi.fn().mockResolvedValue(ok([{ id: 2, name: 'manager mo', role: 'admin' }])),
      getShiftsList: vi.fn().mockResolvedValue(ok({ shifts: [closedShift(3), closedShift(2, { frozen: true }), closedShift(1, { frozen: true })], total: 3, page: 1 })),
      autoAssignSales: vi.fn().mockResolvedValue(ok({ touched: [], waiting: 0 })),
      getZReport: vi.fn().mockResolvedValue(ok(undefined))
    } as unknown as typeof window.api
    await act(async () => {
      root.render(createElement(ReportsPage))
      await Promise.resolve()
    })
    const card = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Shift History'))!
    await act(async () => {
      card.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    const [latest, older, oldest] = rows()
    expect(latest.textContent).toContain('Correct figures')
    expect(latest.textContent).not.toContain('Locked')
    for (const row of [older, oldest]) {
      expect(row.textContent).toContain('Locked')
      // CHANGED (docs/phase-244). Old: `.not.toContain('Correct figures')`. New: the button stays, because it opens the form
      // where an admin may override the freeze; the form refuses without the tick (shiftOverride.test.ts).
      expect(row.textContent).toContain('Correct figures')
      expect(row.textContent).toContain('Z report')
    }
  })
})

describe('the Z report of a frozen shift', () => {
  const base: ZReport = {
    shiftId: 1,
    staffName: 'manager mo',
    openedAt: iso('2026-10-05T10:00:00'),
    closedAt: iso('2026-10-05T17:30:00'),
    status: 'closed',
    startingCash: 0,
    totalsByMethod: { cash: 0, mpesa: 0, card: 0 },
    mpesaByMode: { manual: 0, daraja: 0 },
    orderCount: 0,
    totalRevenue: 0,
    vatIncluded: 0,
    vatRate: 0.16,
    expectedCash: 0,
    endingCash: 0,
    discrepancy: 0
  }
  const show = async (report: ZReport): Promise<void> => {
    window.api = {} as unknown as typeof window.api
    await act(async () => {
      root.render(createElement(ZReportModal, { report, onClose: vi.fn() }))
      await Promise.resolve()
    })
  }

  it('offers Correct figures on the latest closed shift', async () => {
    await show(base)

    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Correct figures')).toBe(true)
  })

  it('offers it on a frozen one too, for the admin override, and still prints', async () => {
    await show({ ...base, frozen: true })

    // CHANGED (docs/phase-244). Old: offered none on a frozen shift. New: the button opens the form with the override tick.
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Correct figures')).toBe(true)
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Print Z-Report')).toBe(true)
  })
})
