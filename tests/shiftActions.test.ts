/**
 * Phase 256: opening and closing the till's shift from the Reports tab's Shift History, through the dialogs every screen
 * uses, and the close dialog's rules by role: an admin may close before the window's end and is told so; a cashier is
 * not let past it. Real stores and a real mount.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReportsPage from '../src/renderer/src/pages/ReportsPage.js'
import CloseShiftDialog from '../src/renderer/src/components/CloseShiftDialog.js'
import { reportsTabApi } from './helpers/reportsTabApi.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useHeldSalesStore } from '../src/renderer/src/stores/heldSalesStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import type { ZReport } from '../src/main/services/reports.js'

const ok = <T,>(data?: T) => ({ success: true as const, data })
const ADMIN = { id: 1, name: 'Admin', role: 'admin' as const }
const CASHIER = { id: 2, name: 'Chea', role: 'cashier' as const }

const OPEN_ROW = { id: 2, staff_id: 1, clock_in: '2026-10-06T18:05:53.000Z', clock_out: null, status: 'open', starting_cash: 0, window_type: 'night' }
const CLOSED_ROW = { id: 1, staff_id: 0, clock_in: '2026-10-02T21:37:00.000Z', clock_out: '2026-10-03T00:48:59.000Z', status: 'closed', starting_cash: 0, window_type: 'night' }

const CLOSED_Z: ZReport = {
  shiftId: 2,
  staffName: 'Admin',
  closedByName: 'Admin',
  openedAt: OPEN_ROW.clock_in,
  closedAt: '2026-10-07T03:40:00.000Z',
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

/** The window status the main process gives, with shift #2 open or none. */
function status(open: { closeAllowed: boolean } | null) {
  return ok({
    window: { type: 'night', startDate: '2026-10-06', label: 'Night shift (17:31 to 06:59)', name: 'Night shift', endClock: '06:59' },
    windowShift: open ? { id: 2, open: true } : null,
    windowShiftMessage: null,
    earlier: { count: 0, cash: 0, mpesa: 0 },
    openShift: open
      ? {
          id: 2,
          windowType: 'night',
          windowName: 'Night shift',
          endClock: '06:59',
          closableFromIso: '2026-10-07T03:59:00.000Z',
          closeAllowed: open.closeAllowed,
          closeMessage: open.closeAllowed ? null : 'Night shift can be closed from 06:59. Selling can carry on.'
        }
      : null
  })
}

let container: HTMLDivElement
let root: Root

function stubApi(open: { closeAllowed: boolean } | null, overrides: Record<string, unknown> = {}): void {
  window.api = {
    ...reportsTabApi(),
    getStaffList: vi.fn().mockResolvedValue(ok([ADMIN, CASHIER])),
    getShiftsList: vi.fn().mockResolvedValue(ok({ shifts: open ? [OPEN_ROW, CLOSED_ROW] : [CLOSED_ROW], total: open ? 2 : 1, page: 1 })),
    autoAssignSales: vi.fn().mockResolvedValue(ok({ touched: [], waiting: 0 })),
    getShiftWindowStatus: vi.fn().mockResolvedValue(status(open)),
    closeShift: vi.fn().mockResolvedValue(ok({ expectedCash: 0, discrepancy: 0, mpesaExpected: null, mpesaDifference: null })),
    getZReport: vi.fn().mockResolvedValue(ok(CLOSED_Z)),
    printZReport: vi.fn().mockResolvedValue(ok({ mock: true })),
    getCurrentShift: vi.fn().mockResolvedValue(ok(null)),
    openShift: vi.fn().mockResolvedValue(ok({ shiftId: 3 })),
    ...overrides
  } as unknown as typeof window.api
}

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve()
  })
}
const buttons = (scope: ParentNode = document): HTMLButtonElement[] => Array.from(scope.querySelectorAll('button'))
const find = (label: string, scope: ParentNode = document): HTMLButtonElement | undefined =>
  buttons(scope).find((b) => b.textContent?.trim() === label)
const dialog = (): HTMLElement | null => document.querySelector('[role="dialog"][aria-label="Close shift"]')
const click = async (el: HTMLButtonElement | undefined): Promise<void> => {
  if (!el) throw new Error('No such button')
  await act(async () => el.click())
  await flush()
}
const type = (index: number, value: string): void => {
  const input = document.querySelectorAll<HTMLInputElement>('[data-testid="close-shift-form"] input')[index]
  act(() => input.click())
  act(() => useKeyboardStore.getState().request?.onChange(value))
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useAuthStore.setState({ currentStaff: ADMIN })
  useHeldSalesStore.setState({ sales: [] })
  useKeyboardStore.setState({ request: null })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Reports, Shift History: opening and closing', () => {
  const mount = async (): Promise<void> => {
    await act(async () => root.render(createElement(ReportsPage)))
    await flush()
  }

  it('the open shift\'s row has Close shift, and the bar names the open shift', async () => {
    stubApi({ closeAllowed: true })
    await mount()
    const rows = Array.from(container.querySelectorAll('tbody tr'))
    expect(find('Close shift', rows[0])).toBeDefined()
    expect(find('Close shift', rows[1])).toBeUndefined()
    expect(find('Close shift #2')).toBeDefined()
    expect(find('Open shift')).toBeUndefined()
  })

  it('closes the open shift there: figures, review, close; then its Z opens, ready to print, and the list is read again', async () => {
    stubApi({ closeAllowed: true })
    await mount()
    const listReads = vi.mocked(window.api.getShiftsList).mock.calls.length

    await click(find('Close shift #2'))
    type(0, '0')
    await click(find('Review', dialog()!))
    await click(find('Close shift', dialog()!))

    expect(window.api.closeShift).toHaveBeenCalledWith(2, 0)
    expect(dialog()).toBeNull()
    expect(document.body.textContent).toContain('Closed by: Admin')
    await click(find('Print Z-Report'))
    expect(window.api.printZReport).toHaveBeenCalledWith(2)
    expect(vi.mocked(window.api.getShiftsList).mock.calls.length).toBeGreaterThan(listReads)
  })

  it('the row\'s Close shift opens the same dialog, not the Z report', async () => {
    stubApi({ closeAllowed: true })
    await mount()
    await click(find('Close shift', container.querySelector('tbody tr')!))
    expect(dialog()).not.toBeNull()
    expect(window.api.getZReport).not.toHaveBeenCalled()
  })

  it('with no shift open, offers Open shift, through the shared dialog', async () => {
    stubApi(null)
    await mount()
    expect(find('Close shift #2')).toBeUndefined()
    await click(find('Open shift'))
    expect(document.querySelector('[role="dialog"][aria-label="Open shift"]')).not.toBeNull()
  })

  it('says nothing about opening or closing while the main process has not said which shift is open', async () => {
    stubApi({ closeAllowed: true }, { getShiftWindowStatus: vi.fn().mockResolvedValue({ success: false, error: 'down' }) })
    await mount()
    expect(find('Open shift')).toBeUndefined()
    expect(find('Close shift #2')).toBeUndefined()
  })
})

describe('the close dialog, by role', () => {
  const mountDialog = async (onClosed = vi.fn()): Promise<ReturnType<typeof vi.fn>> => {
    await act(async () => root.render(createElement(CloseShiftDialog, { shiftId: 2, onCancel: vi.fn(), onClosed })))
    await flush()
    return onClosed
  }

  it('an admin before the window end is told it is early, may close, and the review says so again', async () => {
    stubApi({ closeAllowed: false })
    const onClosed = await mountDialog()
    expect(document.querySelector('[data-testid="close-early"]')?.textContent).toBe(
      'Night shift can be closed from 06:59. Selling can carry on. As an admin you may close it early.'
    )
    type(0, '120')
    await click(find('Review', dialog()!))
    expect(document.querySelector('[data-testid="close-early"]')?.textContent).toBe('Closing early: the night shift window ends at 06:59.')
    await click(find('Close shift', dialog()!))
    expect(window.api.closeShift).toHaveBeenCalledWith(2, 120)
    expect(onClosed).toHaveBeenCalledWith(CLOSED_Z)
  })

  it('a cashier before the window end is not let past it: the reason, and OK', async () => {
    useAuthStore.setState({ currentStaff: CASHIER })
    stubApi({ closeAllowed: false })
    await mountDialog()
    expect(document.querySelector('[data-testid="close-blocked"]')?.textContent).toBe('Night shift can be closed from 06:59. Selling can carry on.')
    expect(document.querySelector('[data-testid="close-shift-form"]')).toBeNull()
    expect(find('OK', dialog()!)).toBeDefined()
  })

  it('a cashier after the window end closes as an admin does, with no early note', async () => {
    useAuthStore.setState({ currentStaff: CASHIER })
    stubApi({ closeAllowed: true })
    await mountDialog()
    expect(document.querySelector('[data-testid="close-early"]')).toBeNull()
    type(0, '120')
    await click(find('Review', dialog()!))
    await click(find('Close shift', dialog()!))
    expect(window.api.closeShift).toHaveBeenCalledWith(2, 120)
  })

  it('a held sale stops an admin too', async () => {
    stubApi({ closeAllowed: true })
    useHeldSalesStore.setState({ sales: [{ id: 1, label: 'Customer 3', total: 80 } as never] })
    await mountDialog()
    expect(document.querySelector('[data-testid="close-blocked"]')?.textContent).toContain('Customer 3')
  })

  it('hands back no report when the Z cannot be read after the close, and the close stands', async () => {
    stubApi({ closeAllowed: true }, { getZReport: vi.fn().mockResolvedValue({ success: false, error: 'x' }) })
    const onClosed = await mountDialog()
    type(0, '120')
    await click(find('Review', dialog()!))
    await click(find('Close shift', dialog()!))
    expect(onClosed).toHaveBeenCalledWith(null)
  })
})
