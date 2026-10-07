/**
 * Phase 254, the screens: after login a cashier lands on the catalogue and an admin where the screen was (C4); "My
 * shifts and sales" lists the cashier's shifts and sales, closes the open shift with counted figures and shows its Z
 * with Print and no Correct figures (C2, C3, C5). Real stores and a real mount.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import MyShiftsPage from '../src/renderer/src/pages/MyShiftsPage.js'
import ZReportModal from '../src/renderer/src/components/ZReportModal.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useUiStore, type ActiveView } from '../src/renderer/src/stores/uiStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import { useHeldSalesStore } from '../src/renderer/src/stores/heldSalesStore.js'
import type { ZReport } from '../src/main/services/reports.js'

const ok = <T,>(data?: T) => ({ success: true as const, data })

const CASHIER = { id: 2, name: 'Amina', role: 'cashier' as const }
const ADMIN = { id: 1, name: 'Admin', role: 'admin' as const }

describe('C4: where a login lands', () => {
  const loginAs = async (staff: typeof CASHIER | typeof ADMIN, from: ActiveView): Promise<ReturnType<typeof vi.fn>> => {
    const login = vi.fn().mockResolvedValue(ok(staff))
    window.api = { login, catalogSync: vi.fn().mockResolvedValue(ok(null)) } as unknown as typeof window.api
    useAuthStore.setState({ currentStaff: null })
    useUiStore.setState({ activeView: from })
    await useAuthStore.getState().login(staff.id, '1111')
    return login
  }

  it.each<ActiveView>(['admin', 'orders', 'mine', 'catalog'])('a cashier lands on the catalogue, from %s', async (from) => {
    const login = await loginAs(CASHIER, from)
    expect(useUiStore.getState().activeView).toBe('catalog')
    expect(useAuthStore.getState().currentStaff).toEqual(CASHIER)
    expect(login).toHaveBeenCalledWith(CASHIER.id, '1111', { session: true })
  })

  it.each<ActiveView>(['admin', 'orders', 'catalog'])('an admin lands where the screen was, %s, as today', async (from) => {
    await loginAs(ADMIN, from)
    expect(useUiStore.getState().activeView).toBe(from)
  })

  it("an admin is never left on a cashier's page, which admins have no tab for", async () => {
    await loginAs(ADMIN, 'mine')
    expect(useUiStore.getState().activeView).toBe('catalog')
  })

  it('a failed login changes neither the screen nor who is signed in', async () => {
    window.api = { login: vi.fn().mockResolvedValue({ success: false, error: 'Incorrect PIN' }) } as unknown as typeof window.api
    useAuthStore.setState({ currentStaff: null })
    useUiStore.setState({ activeView: 'admin' })
    expect(await useAuthStore.getState().login(CASHIER.id, '0000')).toBe(false)
    expect(useUiStore.getState().activeView).toBe('admin')
    expect(useAuthStore.getState().currentStaff).toBeNull()
  })
})

describe('C5: My shifts and sales', () => {
  let container: HTMLDivElement
  let root: Root

  const openShift = { id: 7, staff_id: 3, clock_in: '2026-10-07T04:00:00.000Z', clock_out: null, status: 'open', starting_cash: 500 }
  const ownShift = { id: 5, staff_id: 2, clock_in: '2026-10-06T04:00:00.000Z', clock_out: '2026-10-06T14:40:00.000Z', status: 'closed', starting_cash: 500 }
  const report: ZReport = {
    shiftId: 7,
    staffName: 'Brian',
    closedByName: 'Amina',
    openedAt: openShift.clock_in,
    closedAt: '2026-10-07T14:40:00.000Z',
    status: 'closed',
    startingCash: 500,
    totalsByMethod: { cash: 300, mpesa: 150, card: 80 },
    mpesaByMode: { manual: 0, daraja: 150 },
    orderCount: 3,
    totalRevenue: 530,
    vatIncluded: 73.1,
    vatRate: 0.16,
    expectedCash: 800,
    endingCash: 790,
    discrepancy: -10
  }

  function stubApi(closeAllowed = true): void {
    window.api = {
      getMyShifts: vi.fn().mockResolvedValue(ok({ shifts: [openShift, ownShift], total: 2, page: 1 })),
      getMySales: vi.fn().mockResolvedValue(
        ok({
          invoices: [
            {
              order: { local_id: 41, created_at: '2026-10-07T07:00:00.000Z', fiscal_invoice_number: '0040000123', fiscal_status: 'fiscalized', total: 164, payment_method: 'cash', staff_id: 2 },
              traderInvoiceNumber: 'KSM-000041',
              paymentText: 'cash'
            }
          ],
          total: 1,
          page: 1
        })
      ),
      getShiftWindowStatus: vi.fn().mockResolvedValue(
        ok({ openShift: { id: 7, closeAllowed, closeMessage: closeAllowed ? null : 'This shift can be closed from 17:30.' } })
      ),
      closeShift: vi.fn().mockResolvedValue(ok({ expectedCash: 800, discrepancy: -10, mpesaExpected: null, mpesaDifference: null })),
      getZReport: vi.fn().mockResolvedValue(ok(report)),
      printZReport: vi.fn().mockResolvedValue(ok({ mock: true })),
      getCurrentShift: vi.fn().mockResolvedValue(ok(null))
    } as unknown as typeof window.api
  }

  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }
  const button = (label: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
  const click = async (label: string): Promise<void> => {
    await act(async () => button(label)!.click())
    await flush()
  }
  const type = (index: number, value: string): void => {
    const input = document.querySelectorAll<HTMLInputElement>('[data-testid="close-shift-form"] input')[index]
    act(() => input.click())
    act(() => useKeyboardStore.getState().request?.onChange(value))
  }
  const mount = async (): Promise<void> => {
    await act(async () => root.render(createElement(MyShiftsPage)))
    await flush()
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useAuthStore.setState({ currentStaff: CASHIER })
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('lists the open shift first with Close shift and Print Z, then the cashier\'s own, then their sales', async () => {
    stubApi()
    await mount()

    const rows = Array.from(container.querySelectorAll('[data-testid^="my-shift-"]'))
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual(['my-shift-7', 'my-shift-5'])
    expect(rows[0].textContent).toContain('Close shift')
    expect(rows[0].textContent).toContain('Print Z')
    expect(rows[1].textContent).not.toContain('Close shift')
    expect(rows[1].textContent).toContain('Z report')
    const sales = container.querySelector('[data-testid="my-sales"]')!.textContent ?? ''
    expect(sales).toContain('KSM-000041')
    expect(sales).toContain('0040000123')
    expect(sales).toContain('164.00')
  })

  it('sends the page only, never a staff id', async () => {
    stubApi()
    await mount()
    expect(window.api.getMyShifts).toHaveBeenCalledWith(1)
    expect(window.api.getMySales).toHaveBeenCalledWith(1)
  })

  /** A button inside the close dialog, where "Close shift" is the final step, not the row's button. */
  const inDialog = (label: string): HTMLButtonElement | undefined =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"][aria-label="Close shift"] button')).find(
      (b) => b.textContent?.trim() === label
    )
  const clickInDialog = async (label: string): Promise<void> => {
    await act(async () => inDialog(label)!.click())
    await flush()
  }

  // CHANGED (docs/phase-256). OLD: the page's own close form, sent by Confirm. NEW: the shared close dialog: the figures,
  // Review, then Close shift.
  it('closes the open shift with counted cash, M-Pesa and card, after a review, then shows its Z with Print and no Correct figures', async () => {
    stubApi()
    await mount()

    await click('Close shift')
    type(0, '790')
    type(1, '340')
    type(2, '80')
    await clickInDialog('Review')
    const review = document.querySelector('[data-testid="close-review"]')?.textContent ?? ''
    expect(review).toMatch(/Counted cash.*790\.00/)
    expect(review).toMatch(/M-Pesa balance.*340\.00/)
    expect(review).toMatch(/Card settlement.*80\.00/)
    expect(window.api.closeShift).not.toHaveBeenCalled()
    await clickInDialog('Close shift')

    expect(window.api.closeShift).toHaveBeenCalledWith(7, 790, 340, 80)
    expect(window.api.getZReport).toHaveBeenCalledWith(7)
    expect(document.body.textContent).toContain('Closed by: Amina')
    expect(button('Print Z-Report')).toBeDefined()
    expect(button('Correct figures')).toBeUndefined()

    await click('Print Z-Report')
    expect(window.api.printZReport).toHaveBeenCalledWith(7)
  })

  it('Back from the review keeps the figures to change; Cancel closes nothing', async () => {
    stubApi()
    await mount()
    await click('Close shift')
    type(0, '790')
    await clickInDialog('Review')
    await clickInDialog('Back')
    expect(container.querySelector<HTMLInputElement>('[data-testid="close-shift-form"] input')?.value).toBe('790')
    await clickInDialog('Cancel')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(window.api.closeShift).not.toHaveBeenCalled()
  })

  it('Print Z on the open shift asks for the shift to be closed first, and reads or prints nothing', async () => {
    stubApi()
    await mount()

    await click('Print Z')

    expect(container.querySelector('[data-testid="z-locked"]')?.textContent).toContain(
      'Shift #7 is still open. Close the shift first: its Z report is locked until then.'
    )
    expect(window.api.getZReport).not.toHaveBeenCalled()
    expect(window.api.printZReport).not.toHaveBeenCalled()
    await click('Close shift')
    expect(container.querySelector('[data-testid="close-shift-form"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="z-locked"]')).toBeNull()
  })

  // CHANGED (docs/phase-256). OLD: the prompt named Shift Controls. NEW: it closes the shift there, and the Z then prints.
  it('on an admin screen, Print on an open shift\'s Z asks for the close, closes it there, and the closed Z prints', async () => {
    stubApi()
    useAuthStore.setState({ currentStaff: ADMIN })
    await act(async () =>
      root.render(createElement(ZReportModal, { report: { ...report, status: 'open', closedAt: null, endingCash: null, discrepancy: null }, onClose: vi.fn() }))
    )
    await flush()

    await act(async () => button('Print Z-Report')!.click())
    await flush()
    expect(document.body.querySelector('[data-testid="z-locked"]')?.textContent).toContain('Close the shift first')
    expect(window.api.printZReport).not.toHaveBeenCalled()

    await click('Close shift')
    type(0, '790')
    await clickInDialog('Review')
    await clickInDialog('Close shift')
    expect(window.api.closeShift).toHaveBeenCalledWith(7, 790)
    expect(document.body.textContent).toContain('Closed by: Amina')
    await click('Print Z-Report')
    expect(window.api.printZReport).toHaveBeenCalledWith(7)
  })

  it('refuses a missing counted cash or a bad M-Pesa figure at Review, and closes nothing', async () => {
    stubApi()
    await mount()
    await click('Close shift')
    await clickInDialog('Review')
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('Enter a valid ending cash amount')
    type(0, '790')
    type(1, '12a')
    await clickInDialog('Review')
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('Enter a valid M-Pesa balance, or leave it blank')
    type(1, '')
    type(0, '-5')
    await clickInDialog('Review')
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('Enter a valid ending cash amount')
    expect(window.api.closeShift).not.toHaveBeenCalled()
  })

  it('shows blank M-Pesa and card figures as Not recorded, and sends the call it always sent', async () => {
    stubApi()
    await mount()
    await click('Close shift')
    type(0, '790')
    await clickInDialog('Review')
    expect(document.querySelector('[data-testid="close-review"]')?.textContent).toContain('Not recorded')
    await clickInDialog('Close shift')
    expect(window.api.closeShift).toHaveBeenCalledWith(7, 790)
  })

  it('a held sale stops the close before anything is counted', async () => {
    stubApi()
    useHeldSalesStore.setState({ sales: [{ id: 1, label: 'Customer 1', total: 50 } as never] })
    await mount()
    await click('Close shift')
    expect(document.querySelector('[data-testid="close-blocked"]')?.textContent).toContain('Customer 1')
    expect(container.querySelector('[data-testid="close-shift-form"]')).toBeNull()
    useHeldSalesStore.setState({ sales: [] })
  })

  it('shows the main process\'s refusal of the close, and the figures stay for another try', async () => {
    stubApi()
    window.api.closeShift = vi.fn().mockResolvedValue({ success: false, error: 'Shift 7 is already closed' })
    await mount()
    await click('Close shift')
    type(0, '790')
    await clickInDialog('Review')
    await clickInDialog('Close shift')
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe('Shift 7 is already closed')
    expect(container.querySelector<HTMLInputElement>('[data-testid="close-shift-form"] input')?.value).toBe('790')
    expect(window.api.getZReport).not.toHaveBeenCalled()
  })

  it('cannot be sent twice: Close shift is off while the close is on its way', async () => {
    stubApi()
    let finish: (value: unknown) => void = () => {}
    window.api.closeShift = vi.fn().mockReturnValue(new Promise((resolve) => (finish = resolve)))
    await mount()
    await click('Close shift')
    type(0, '790')
    await clickInDialog('Review')
    await clickInDialog('Close shift')
    expect(inDialog('Closing…')?.disabled).toBe(true)
    await act(async () => inDialog('Closing…')?.click())
    expect(window.api.closeShift).toHaveBeenCalledTimes(1)
    await act(async () => finish(ok({ expectedCash: 800, discrepancy: -10, mpesaExpected: null, mpesaDifference: null })))
    await flush()
  })

  it('offers Open shift when no shift is open, and opens it through the shared dialog', async () => {
    stubApi()
    window.api.getMyShifts = vi.fn().mockResolvedValue(ok({ shifts: [ownShift], total: 1, page: 1 }))
    window.api.getShiftWindowStatus = vi.fn().mockResolvedValue(
      ok({ window: { type: 'day', startDate: '2026-10-07', label: 'Day shift (07:00 to 17:30)', name: 'Day shift', endClock: '17:30' }, windowShift: null, windowShiftMessage: null, earlier: { count: 0, cash: 0, mpesa: 0 }, openShift: null })
    )
    window.api.openShift = vi.fn().mockResolvedValue(ok({ shiftId: 8 }))
    await mount()

    await click('Open shift')
    expect(document.querySelector('[role="dialog"][aria-label="Open shift"]')).not.toBeNull()
    expect(button('Close shift')).toBeUndefined()
  })

  it('says so when there are no shifts and no sales', async () => {
    stubApi()
    window.api.getMyShifts = vi.fn().mockResolvedValue(ok({ shifts: [], total: 0, page: 1 }))
    window.api.getMySales = vi.fn().mockResolvedValue(ok({ invoices: [], total: 0, page: 1 }))
    await mount()
    expect(container.textContent).toContain('No shifts yet.')
    expect(container.textContent).toContain('No sales yet.')
  })

  it('holds Close shift until the window end, and says when, as the Admin screen does', async () => {
    stubApi(false)
    await mount()
    expect(button('Close shift')!.disabled).toBe(true)
    expect(container.textContent).toContain('This shift can be closed from 17:30.')
  })

  it('shows the main process\'s refusal of a Z', async () => {
    stubApi()
    window.api.getZReport = vi.fn().mockResolvedValue({ success: false, error: 'This needs a manager.' })
    await mount()
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[data-testid="my-shift-5"] button')[0].click())
    await flush()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('This needs a manager.')
  })
})
