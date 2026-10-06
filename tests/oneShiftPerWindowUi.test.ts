/**
 * Phase 231, the screens: Shift History (every sale is given to its shift when it opens; a shift shown by its window;
 * "Created automatically"; the older pair's window report), the Move a sale form, the Z report's changes and note,
 * and the cart's window-end banner.
 *
 * Real mounts, as `tests/shiftCaptureUi.test.ts` does them. Layout: not checked by check:fit (owner's rule). For the
 * owner to check on the till.
 *
 * CHANGED (docs/phase-237). OLD: Day began at 09:00 and Night ended at 08:59 (docs/phase-199 D1). NEW: Day begins at
 * 07:00 and Night ends at 06:59, the owner's correction; the rule, the labels and the boundary seconds move with it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ReportsPage from '../src/renderer/src/pages/ReportsPage.js'
import ZReportModal from '../src/renderer/src/components/ZReportModal.js'
import MoveSaleForm from '../src/renderer/src/components/MoveSaleForm.js'
import WindowEndBanner, { shouldShowWindowEndBanner } from '../src/renderer/src/components/WindowEndBanner.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import { getShiftWindowStatus } from '../src/main/services/shift-window-status.js'
import type { ZReport } from '../src/main/services/reports.js'
import type { SaleMovePreview, ShiftMergePreview, ShiftRow } from '../src/main/services/database.js'

vi.mock('../src/renderer/src/components/ManagerPinModal.js', () => ({
  default: ({ onAuthorized }: { onAuthorized: (id: number, pin: string) => void }) =>
    createElement('button', { onClick: () => onAuthorized(2, '1234') }, 'Authorize as admin')
}))

let container: HTMLDivElement
let root: Root

const ok = <T,>(data?: T) => ({ success: true as const, data })
const iso = (t: string): string => new Date(`${t}+03:00`).toISOString()
const plain = (text: string | null | undefined): string => (text ?? '').replace(/ /g, ' ')

const shiftRow = (overrides: Partial<ShiftRow> = {}): ShiftRow => ({
  id: 1,
  staff_id: 2,
  clock_in: iso('2026-10-05T17:43:21'),
  clock_out: iso('2026-10-05T17:43:36'),
  starting_cash: 0,
  expected_cash: 0,
  ending_cash: 3790,
  discrepancy: 3790,
  status: 'closed',
  shift_type: 'day',
  window_type: 'night',
  window_date: '2026-10-05',
  labelled_as: 'day',
  ...overrides
})

function stubApi(overrides: Record<string, unknown> = {}): void {
  window.api = {
    getStaffList: vi.fn().mockResolvedValue(ok([{ id: 2, name: 'manager mo', role: 'admin' }])),
    getShiftsList: vi.fn().mockResolvedValue(ok({ shifts: [shiftRow()], total: 1, page: 1 })),
    autoAssignSales: vi.fn().mockResolvedValue(ok({ touched: [], waiting: 0 })),
    getZReport: vi.fn().mockResolvedValue(ok(undefined)),
    ...overrides
  } as unknown as typeof window.api
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(label: string): Promise<void> {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label || b.textContent?.startsWith(label))
  if (!el) throw new Error(`No button "${label}"`)
  await act(async () => {
    el.click()
    await Promise.resolve()
  })
}

function typeInto(label: string, value: string): void {
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
  vi.restoreAllMocks()
})

describe('Shift History', () => {
  const openHistory = async (): Promise<void> => {
    await act(async () => {
      root.render(createElement(ReportsPage))
      await Promise.resolve()
    })
    await click('Shift History')
    await flush()
  }

  it('gives every sale to its shift before it reads the list, and shows no list of sales with no shift', async () => {
    const order: string[] = []
    stubApi({
      autoAssignSales: vi.fn().mockImplementation(async () => {
        order.push('assign')
        return ok({ touched: [], waiting: 0 })
      }),
      getShiftsList: vi.fn().mockImplementation(async () => {
        order.push('list')
        return ok({ shifts: [shiftRow()], total: 1, page: 1 })
      })
    })

    await openHistory()

    expect(order).toEqual(['assign', 'list'])
    expect(container.textContent).not.toContain('Sales with no shift')
  })

  it('still shows the history when the automatic run fails: the main process logs it', async () => {
    stubApi({ autoAssignSales: vi.fn().mockRejectedValue(new Error('boom')) })

    await openHistory()

    expect(container.textContent).toContain('#1')
  })

  it('shows a shift by its window, with the label it was given when it differs', async () => {
    stubApi()

    await openHistory()

    expect(container.textContent).toContain('Night')
    expect(container.textContent).toContain('Labelled Day when opened')
  })

  it('names a shift the till made itself, in place of a cashier, with no "Recorded later" tag', async () => {
    stubApi({
      getShiftsList: vi.fn().mockResolvedValue(
        ok({
          shifts: [shiftRow({ id: 4, staff_id: 0, kind: 'retrospective', cash_not_counted: 1, labelled_as: undefined, shift_type: 'night' })],
          total: 1,
          page: 1
        })
      )
    })

    await openHistory()

    expect(container.textContent).toContain('Created automatically')
    expect(container.textContent).toContain('Cash not counted')
    expect(container.textContent).not.toContain('Recorded later')
  })

  it('offers the window report only for a window that holds more than one shift, and opens it', async () => {
    const report = {
      window: { type: 'night', startDate: '2026-10-05', name: 'Night shift, 5 Oct 2026' },
      shifts: [
        { report: { shiftId: 1, orderCount: 2, totalRevenue: 500, startingCash: 100, endingCash: 600, cashNotCounted: false }, difference: 0 },
        { report: { shiftId: 2, orderCount: 1, totalRevenue: 400, startingCash: 600, endingCash: null, cashNotCounted: true }, difference: null }
      ],
      totals: { orderCount: 3, totalRevenue: 900, vatIncluded: 0, byMethod: { cash: 800, mpesa: 100, card: 0 }, differenceSum: 0, notCountedShifts: 1 }
    }
    stubApi({
      getShiftsList: vi.fn().mockResolvedValue(
        ok({ shifts: [shiftRow({ id: 2, window_shift_count: 2 }), shiftRow({ id: 1, window_shift_count: 2 }), shiftRow({ id: 9, window_shift_count: 1, window_date: '2026-10-04' })], total: 3, page: 1 })
      ),
      getWindowReport: vi.fn().mockResolvedValue(ok(report))
    })
    await openHistory()

    expect(Array.from(container.querySelectorAll('button')).filter((b) => b.textContent?.startsWith('Window report'))).toHaveLength(2)
    await click('Window report (2 shifts)')
    await flush()

    expect(window.api.getWindowReport).toHaveBeenCalledWith('night', '2026-10-05')
    const text = plain(container.querySelector('[role="dialog"]')?.textContent)
    expect(text).toContain('Night shift, 5 Oct 2026')
    expect(text).toContain('#1')
    expect(text).toContain('#2')
    expect(text).toContain('Whole window')
    expect(text).toContain('3 orders')
    expect(text).toContain('1 shift not counted')
    expect(text).toContain('Starting, expected and counted cash are not added across shifts')
  })
})

describe('Move a sale', () => {
  const PREVIEW: SaleMovePreview = {
    orderId: 55,
    total: 400,
    paymentMethod: 'cash',
    createdAt: iso('2026-10-05T18:30:00'),
    fromShiftId: 1,
    toShiftId: 2,
    differentWindow: false,
    from: { expectedCash: 100, discrepancy: 600, mpesaExpected: null, mpesaDifference: null },
    to: { expectedCash: 450, discrepancy: -400, mpesaExpected: null, mpesaDifference: null },
    problem: null
  }
  const mount = async (onMoved = vi.fn()): Promise<ReturnType<typeof vi.fn>> => {
    await act(async () => {
      root.render(createElement(MoveSaleForm, { onCancel: vi.fn(), onMoved }))
      await Promise.resolve()
    })
    return onMoved
  }
  const fill = (): void => {
    typeInto('Order number', '55')
    typeInto('Shift number', '2')
  }

  it('shows what both shifts would show afterwards, and writes nothing, before anything is confirmed', async () => {
    stubApi({ previewSaleMove: vi.fn().mockResolvedValue(ok(PREVIEW)), moveSale: vi.fn() })
    await mount()
    fill()

    await click('Check')
    await flush()

    expect(window.api.previewSaleMove).toHaveBeenCalledWith(55, 2)
    const text = plain(container.querySelector('[data-testid="move-preview"]')?.textContent)
    expect(text).toContain('Shift #1 afterwards')
    expect(text).toContain('Expected cash: Ksh 100.00')
    expect(text).toContain('Difference: -Ksh 400.00')
    expect(window.api.moveSale).not.toHaveBeenCalled()
  })

  it('asks for a reason, then the admin PIN, and sends no figure at all', async () => {
    const moveSale = vi.fn().mockResolvedValue(ok({ fromShiftId: 1, toShiftId: 2 }))
    stubApi({ previewSaleMove: vi.fn().mockResolvedValue(ok(PREVIEW)), moveSale })
    const onMoved = await mount()
    fill()
    await click('Check')
    await flush()

    await click('Move sale')
    expect(container.textContent).toContain('Say why this sale is being moved')
    expect(moveSale).not.toHaveBeenCalled()

    typeInto('Reason', 'Rung up on the wrong shift')
    await click('Move sale')
    await click('Authorize as admin')
    await flush()

    expect(moveSale).toHaveBeenCalledWith({ managerId: 2, managerPin: '1234', orderId: 55, toShiftId: 2, reason: 'Rung up on the wrong shift' })
    expect(Object.keys(moveSale.mock.calls[0][0]).sort()).toEqual(['managerId', 'managerPin', 'orderId', 'reason', 'toShiftId'])
    expect(onMoved).toHaveBeenCalledWith('Order #55 moved from shift #1 to shift #2.')
  })

  it('needs the tick for a sale made in a different window, and sends it', async () => {
    const moveSale = vi.fn().mockResolvedValue(ok({ fromShiftId: 1, toShiftId: 2 }))
    stubApi({ previewSaleMove: vi.fn().mockResolvedValue(ok({ ...PREVIEW, differentWindow: true })), moveSale })
    await mount()
    fill()
    await click('Check')
    await flush()
    typeInto('Reason', 'It belongs there')

    await click('Move sale')
    expect(container.textContent).toContain('different window')
    expect(moveSale).not.toHaveBeenCalled()

    await act(async () => {
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
      await Promise.resolve()
    })
    await click('Move sale')
    await click('Authorize as admin')
    await flush()

    expect(moveSale).toHaveBeenCalledWith(expect.objectContaining({ acknowledgeDifferentWindow: true }))
  })

  it('shows the reason a sale cannot be moved and offers no move', async () => {
    stubApi({ previewSaleMove: vi.fn().mockResolvedValue(ok({ ...PREVIEW, problem: 'Order #55 was voided' })), moveSale: vi.fn() })
    await mount()
    fill()
    await click('Check')
    await flush()
    typeInto('Reason', 'x')

    await click('Move sale')

    expect(container.textContent).toContain('Order #55 was voided')
    expect(container.querySelector('[data-testid="move-preview"]')).toBeNull()
    expect(window.api.moveSale).not.toHaveBeenCalled()
  })

  it('asks for both numbers first', async () => {
    stubApi({ previewSaleMove: vi.fn(), moveSale: vi.fn() })
    await mount()

    await click('Check')

    expect(container.textContent).toContain('Enter the order number and the number of the shift it goes to')
    expect(window.api.previewSaleMove).not.toHaveBeenCalled()
  })
})

describe('the Z report window', () => {
  const base: ZReport = {
    shiftId: 1,
    staffName: 'manager mo',
    openedAt: iso('2026-10-05T17:43:21'),
    closedAt: iso('2026-10-05T17:43:36'),
    status: 'closed',
    startingCash: 0,
    totalsByMethod: { cash: 3901, mpesa: 0, card: 0 },
    mpesaByMode: { manual: 0, daraja: 0 },
    orderCount: 3,
    totalRevenue: 3901,
    vatIncluded: 0,
    vatRate: 0.16,
    expectedCash: 0,
    endingCash: 3790,
    discrepancy: 3790,
    shiftType: 'night',
    shiftWindowLabel: 'Night shift (17:31 to 06:59)',
    labelledAs: 'day',
    salesAtClose: { orderCount: 1, totalRevenue: 111, cash: 111, mpesa: 0, card: 0 },
    adjustments: [
      {
        id: 1,
        kind: 'auto',
        at: iso('2026-10-06T10:00:00'),
        byName: null,
        reason: 'Sales with no shift joined this shift automatically: they were made in its window',
        peerShiftId: null,
        salesCount: 2,
        salesTotal: 3790,
        cashTotal: 3790,
        mpesaTotal: 0,
        cardTotal: 0,
        firstSaleAt: iso('2026-10-05T17:35:00'),
        lastSaleAt: iso('2026-10-05T17:50:00'),
        openingDrawerCash: null,
        startingCash: 0,
        endingCash: 3790,
        expectedCash: 3901,
        discrepancy: -111,
        mpesaOpeningBalance: null,
        mpesaClosingBalance: null,
        mpesaExpected: null,
        mpesaDifference: null
      }
    ]
  }
  const show = async (report: ZReport): Promise<void> => {
    stubApi()
    await act(async () => {
      root.render(createElement(ZReportModal, { report, onClose: vi.fn() }))
      await Promise.resolve()
    })
  }

  it('keeps the original figures, says what the shift held at close, and shows the latest adjustment', async () => {
    await show(base)

    const text = plain(container.textContent)
    expect(text).toContain('Night shift (17:31 to 06:59)')
    expect(text).toContain('Labelled Day when opened')
    expect(text).toContain('Sales at close: 1 order, Ksh 111.00')
    expect(text).toContain('Expected Cash')
    expect(text).toContain('Ksh 3,790.00')
    expect(plain(container.querySelector('[data-testid="latest-adjustment"]')?.textContent)).toContain('2 sales (Ksh 3,790.00) joined automatically')
  })

  it('shows nothing extra for a shift with no adjustments', async () => {
    const { adjustments: _a, salesAtClose: _s, labelledAs: _l, ...plainReport } = base
    await show(plainReport as ZReport)

    expect(container.querySelector('[data-testid="latest-adjustment"]')).toBeNull()
    expect(container.querySelector('[data-testid="sales-at-close"]')).toBeNull()
    expect(container.textContent).not.toContain('Labelled')
  })

  it('says a shift was created automatically, in place of a cashier', async () => {
    await show({ ...base, createdAutomatically: true, kind: 'retrospective', createdAt: iso('2026-10-06T10:00:00'), reason: 'Created automatically for sales with no shift', cashNotCounted: true })

    expect(container.textContent).toContain('CREATED AUTOMATICALLY')
    expect(container.textContent).not.toContain('Opened by')
  })
})

describe('the cart window-end banner', () => {
  const statusAt = (t: string) =>
    getShiftWindowStatus(
      {
        getOpenShift: () => ({ id: 7, clock_in: iso('2026-10-05T10:00:00') }) as unknown as ShiftRow,
        listShiftWindows: () => [{ id: 7, clock_in: iso('2026-10-05T10:00:00'), clock_out: null }],
        listUnattachedSales: () => [],
        listAbsorbedShiftIds: () => [] // ADDED (docs/phase-242)
      },
      Date.parse(`${t}+03:00`)
    )

  it('shows from 17:30:00 and not before, decided by the main process', () => {
    expect(shouldShowWindowEndBanner(statusAt('2026-10-05T17:29:59'))).toBe(false)
    expect(shouldShowWindowEndBanner(statusAt('2026-10-05T17:30:00'))).toBe(true)
    expect(shouldShowWindowEndBanner(null)).toBe(false)
  })

  it('says the window ended and which shift to close, and sales carry on', async () => {
    await act(async () => {
      root.render(createElement(WindowEndBanner, { status: statusAt('2026-10-05T18:00:00') }))
    })

    expect(container.querySelector('[data-testid="window-end-banner"]')?.textContent).toBe(
      'Day window ended at 17:30. Count the drawer and close shift #7.'
    )
  })

  it('takes the "No shift open" strip\'s place in the cart, so the layout does not grow', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'), 'utf8')

    expect(source).toContain('{showWindowEndBanner && windowStatus && <WindowEndBanner status={windowStatus} />}')
    expect(source).toContain('(shouldShowNoShiftNotice(shiftPresence) || showWindowEndBanner ? 1 : 0)')
  })
})

describe('Shift History actions and merging (docs/phase-239)', () => {
  const zReport = (overrides: Partial<ZReport> = {}): ZReport =>
    ({
      shiftId: 2,
      staffName: 'manager mo',
      openedAt: iso('2026-10-05T20:50:55'),
      closedAt: iso('2026-10-06T06:59:00'),
      status: 'closed',
      startingCash: 500,
      totalsByMethod: { cash: 400, mpesa: 0, card: 0 },
      mpesaByMode: { manual: 0, daraja: 0 },
      orderCount: 1,
      totalRevenue: 400,
      vatIncluded: 55.17,
      vatRate: 0.16,
      expectedCash: 900,
      endingCash: 900,
      discrepancy: 0,
      ...overrides
    }) as ZReport
  const openHistory = async (): Promise<void> => {
    await act(async () => {
      root.render(createElement(ReportsPage))
      await Promise.resolve()
    })
    await click('Shift History')
    await flush()
  }
  const buttons = (label: string): HTMLButtonElement[] =>
    Array.from(container.querySelectorAll('button')).filter((b) => b.textContent === label) as HTMLButtonElement[]

  it('offers Correct figures on a closed shift, Merge into… only where the window has two shifts, and nothing on a merged shift', async () => {
    stubApi({
      getShiftsList: vi.fn().mockResolvedValue(
        ok({
          shifts: [
            shiftRow({ id: 9, status: 'open', clock_out: null, window_shift_count: 1, window_date: '2026-10-04', labelled_as: undefined, shift_type: 'night' }),
            shiftRow({ id: 2, window_shift_count: 2 }),
            shiftRow({ id: 1, window_shift_count: 2, merged_into: 2 })
          ],
          total: 3,
          page: 1
        })
      ),
      getZReport: vi.fn().mockResolvedValue(ok(zReport()))
    })
    await openHistory()

    expect(buttons('Z report')).toHaveLength(3)
    expect(buttons('Correct figures')).toHaveLength(1)
    expect(buttons('Merge into…')).toHaveLength(1)
    expect(container.textContent).toContain('Merged into #2')

    await click('Correct figures')
    await flush()

    expect(window.api.getZReport).toHaveBeenCalledWith(2)
    expect(container.textContent).toContain('Correct the figures of shift #2')
  })

  it('Merge into… lists the window\'s other shifts, previews the merge, and merges with a reason and the admin\'s PIN', async () => {
    const preview: ShiftMergePreview = {
      absorbedShiftId: 1,
      intoShiftId: 2,
      salesCount: 2,
      salesTotal: 500,
      into: { expectedCash: 1200, discrepancy: -300, mpesaExpected: null, mpesaDifference: null },
      problem: null
    }
    const windowReport = {
      window: { type: 'night', startDate: '2026-10-05', name: 'Night shift, 5 Oct 2026' },
      shifts: [
        { report: zReport({ shiftId: 1, orderCount: 2 }), difference: 500 },
        { report: zReport({ shiftId: 2, status: 'open', closedAt: null }), difference: null }
      ],
      totals: { orderCount: 3, totalRevenue: 900, vatIncluded: 0, byMethod: { cash: 800, mpesa: 100, card: 0 }, differenceSum: 500, notCountedShifts: 1 }
    }
    stubApi({
      getShiftsList: vi.fn().mockResolvedValue(
        ok({ shifts: [shiftRow({ id: 2, status: 'open', clock_out: null, window_shift_count: 2 }), shiftRow({ id: 1, window_shift_count: 2 })], total: 2, page: 1 })
      ),
      getWindowReport: vi.fn().mockResolvedValue(ok(windowReport)),
      previewShiftMerge: vi.fn().mockResolvedValue(ok(preview)),
      mergeShifts: vi.fn().mockResolvedValue(ok({ absorbedShiftId: 1, intoShiftId: 2, salesCount: 2 }))
    })
    await openHistory()
    expect(buttons('Merge into…')).toHaveLength(1) // only the closed shift #1

    await click('Merge into…')
    await flush()

    expect(container.textContent).toContain('Merge shift #1 into another shift')
    expect(window.api.getWindowReport).toHaveBeenCalledWith('night', '2026-10-05')
    expect(container.textContent).toContain('Shift #2 · open · 1 order')
    expect(container.textContent).not.toContain('Shift #1 · ')

    await click('Shift #2 · open')
    await flush()
    expect(window.api.previewShiftMerge).toHaveBeenCalledWith(1, 2)
    const text = plain(container.querySelector('[data-testid="merge-preview"]')?.textContent)
    expect(text).toContain('2 sales (Ksh 500.00) move from shift #1 to shift #2')
    expect(text).toContain('Expected cash: Ksh 1,200.00')
    expect(text).toContain('Difference: -Ksh 300.00')
    expect(window.api.mergeShifts).not.toHaveBeenCalled()

    await click('Merge shifts')
    expect(container.textContent).toContain('Say why these shifts are being merged')
    typeInto('Reason', 'Opened twice by mistake')
    await click('Merge shifts')
    await click('Authorize as admin')
    await flush()

    expect(window.api.mergeShifts).toHaveBeenCalledWith({ managerId: 2, managerPin: '1234', absorbedShiftId: 1, intoShiftId: 2, reason: 'Opened twice by mistake' })
    expect(container.textContent).toContain('Shift #1 merged into shift #2: 2 sales moved.')
  })

  it('the Z report of a merged shift says so and offers no Correct figures', async () => {
    stubApi()
    const merged = zReport({
      shiftId: 1,
      orderCount: 0,
      totalRevenue: 0,
      mergedInto: { shiftId: 2, at: iso('2026-10-06T10:00:00'), byName: 'manager mo', reason: 'Opened twice' }
    })
    await act(async () => {
      root.render(createElement(ZReportModal, { report: merged, onClose: vi.fn(), startCorrecting: true }))
      await Promise.resolve()
    })

    const banner = plain(container.querySelector('[data-testid="merged-into"]')?.textContent)
    expect(banner).toContain('Merged into shift #2 on ')
    expect(banner).toContain('by manager mo: Opened twice. Its sales are counted there now.')
    expect(buttons('Correct figures')).toHaveLength(0)
    expect(container.textContent).not.toContain('Correct the figures of shift #1')
  })

  it('startCorrecting opens an ordinary closed shift\'s Z report with the correction form showing', async () => {
    stubApi()
    await act(async () => {
      root.render(createElement(ZReportModal, { report: zReport(), onClose: vi.fn(), startCorrecting: true }))
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Correct the figures of shift #2')
  })
})
