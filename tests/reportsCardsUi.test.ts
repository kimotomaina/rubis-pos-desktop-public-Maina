/**
 * The layout of the Reports tab (docs/phase-246-1): the scope picker is fixed at the top; under it a row of cards (Takings, the
 * Z report only while the scope is one shift, Checks, Detail, Shifts) each with one headline figure; tapping a card opens that
 * section alone, in its own scroll area, with its actions (Print, Approve, Move a sale) in a fixed bar below the scroll area.
 * Takings is open at first. jsdom has no layout, so "fixed" is pinned by structure: the bar is a sibling of the scroll area
 * and never inside it. Layout: not checked by check:fit (owner's rule). For the owner to check on the till.
 *
 * It is layout only: no report call, calculation or IPC changed, which the call-count test and the headline tests pin.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReportsPage from '../src/renderer/src/pages/ReportsPage.js'
import { reportsTabApi, openSection } from './helpers/reportsTabApi.js'
import {
  HEADLINE_LOADING,
  approvalRowsHeadline,
  detailHeadline,
  shiftEndOfDayHeadline,
  shiftsHeadline,
  takingsHeadline,
  zReportHeadline
} from '../src/renderer/src/lib/reportHeadlines.js'
import type { SalesSummary, ShiftApprovalRow, ShiftEndOfDayReport, ZReport } from '../src/main/services/reports.js'
import type { ShiftRow } from '../src/main/services/database.js'
import { EMPTY_SUMMARY } from './helpers/reportsTabApi.js'

let container: HTMLDivElement
let root: Root

const ok = <T,>(data?: T): { success: true; data: T | undefined } => ({ success: true, data })
const plain = (text: string | null | undefined): string => (text ?? '').replace(/ /g, ' ')
const KEYS = ['takings', 'z', 'checks', 'detail', 'shifts'] as const

const SHIFT_ROW = (id: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  staff_id: 1,
  clock_in: '2026-09-01T08:00:00.000Z',
  clock_out: '2026-09-01T16:00:00.000Z',
  starting_cash: 100,
  expected_cash: 300,
  ending_cash: 300,
  discrepancy: 0,
  status: 'closed',
  window_type: 'day',
  ...extra
})

const SUMMARY: SalesSummary = { ...EMPTY_SUMMARY, orderCount: 5, totalRevenue: 1250.5, totalsByMethod: { cash: 1000, mpesa: 250.5, card: 0 } } as SalesSummary

const Z_REPORT = {
  shiftId: 3,
  staffName: 'Ann',
  openedAt: '2026-09-01T08:00:00.000Z',
  closedAt: '2026-09-01T16:00:00.000Z',
  status: 'closed',
  startingCash: 100,
  totalsByMethod: { cash: 200, mpesa: 80, card: 0 },
  mpesaByMode: { manual: 30, daraja: 50 },
  orderCount: 5,
  totalRevenue: 280,
  vatIncluded: 38.62,
  vatRate: 0.16,
  expectedCash: 300,
  endingCash: 295,
  discrepancy: -5
} as ZReport

const entry = (paymentId: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  paymentId,
  orderLocalId: 1000 + paymentId,
  createdAt: '2026-09-01T10:00:00.000Z',
  localDay: '2026-09-01',
  staffId: 1,
  staffName: 'Ann',
  reference: `REF${String(paymentId).padStart(6, '0')}`,
  amount: 10,
  approved: false,
  reconciledAt: null,
  reconciledByStaffId: null,
  reconciledByStaffName: null,
  sameApproverAsRecorder: false,
  lastExclusion: null,
  ...extra
})

/** The end of day of shift #3 with `count` manual entries, all waiting. */
const endOfDay = (count: number, extra: Record<string, unknown> = {}): ShiftEndOfDayReport =>
  ({
    localDay: '2026-09-01',
    shiftId: 3,
    shiftStatus: 'closed',
    openedAt: '2026-09-01T08:00:00.000Z',
    closedAt: '2026-09-01T16:00:00.000Z',
    windowType: 'day',
    mergedInto: null,
    approval: null,
    canApprove: true,
    cannotApproveBecause: null,
    cashiers: [],
    totalsByMethod: { cash: 0, mpesa: count * 10, card: 0 },
    manualEntries: Array.from({ length: count }, (_, index) => entry(index + 1)),
    carryOver: [],
    pendingIds: Array.from({ length: count }, (_, index) => index + 1),
    pendingManualTotal: count * 10,
    ...extra
  }) as unknown as ShiftEndOfDayReport

const APPROVAL_ROWS = [
  { shiftId: 8, status: 'open', openedAt: '2026-10-06T08:35:14.000Z', closedAt: null, windowType: 'day', windowDate: '2026-10-06', orderCount: 36, state: 'open', manualCount: 19, pendingCount: 19, pendingAmount: 24175, approvedAt: null, approvedByName: null },
  { shiftId: 3, status: 'closed', openedAt: '2026-10-05T06:14:00.000Z', closedAt: '2026-10-05T14:30:59.000Z', windowType: 'day', windowDate: '2026-10-05', orderCount: 42, state: 'not-approved', manualCount: 23, pendingCount: 23, pendingAmount: 19180.09, approvedAt: null, approvedByName: null },
  { shiftId: 1, status: 'closed', openedAt: '2026-10-05T14:43:21.000Z', closedAt: '2026-10-05T14:43:36.000Z', windowType: 'night', windowDate: '2026-10-05', orderCount: 59, state: 'not-approved', manualCount: 43, pendingCount: 43, pendingAmount: 1000, approvedAt: null, approvedByName: null },
  { shiftId: 2, status: 'closed', openedAt: '2026-10-04T14:43:21.000Z', closedAt: '2026-10-04T14:43:36.000Z', windowType: 'night', windowDate: '2026-10-04', orderCount: 3, state: 'approved', manualCount: 1, pendingCount: 0, pendingAmount: 0, approvedAt: '2026-10-06T10:00:00.000Z', approvedByName: 'Admin' }
] as unknown as ShiftApprovalRow[]

function stubApi(overrides: Record<string, unknown> = {}): void {
  window.api = {
    ...reportsTabApi(),
    getStaffList: vi.fn().mockResolvedValue(ok([{ id: 1, name: 'Ann', role: 'cashier' }])),
    getShiftsList: vi.fn().mockResolvedValue(ok({ shifts: [SHIFT_ROW(3)], total: 1, page: 1 })),
    getSalesSummary: vi.fn().mockResolvedValue(ok(SUMMARY)),
    getZReport: vi.fn().mockResolvedValue(ok(Z_REPORT)),
    printZReport: vi.fn().mockResolvedValue(ok({ mock: true })),
    autoAssignSales: vi.fn().mockResolvedValue(ok({ touched: [], waiting: 0 })),
    getShiftEndOfDayReport: vi.fn().mockResolvedValue(ok(endOfDay(2))),
    getDiscardedHeldSales: vi.fn().mockResolvedValue(ok([])),
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

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(ReportsPage))
    await Promise.resolve()
    await Promise.resolve()
  })
  await flush()
}

async function pickShift(): Promise<void> {
  const change = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Change scope') as HTMLButtonElement
  await act(async () => {
    change.click()
    await Promise.resolve()
    await Promise.resolve()
  })
  await flush()
  const list = container.querySelector('[data-testid="scope-list"]')!
  const shift = Array.from(list.querySelectorAll('button')).find((b) => /^Shift #/.test(b.textContent ?? '')) as HTMLButtonElement
  await act(async () => {
    shift.click()
    await Promise.resolve()
    await Promise.resolve()
  })
  await flush()
}

const card = (key: string): HTMLElement => container.querySelector(`[data-testid="card-${key}"]`) as HTMLElement
const panel = (key: string): HTMLElement => container.querySelector(`[data-testid="section-${key}"]`) as HTMLElement
const scrollOf = (key: string): HTMLElement => container.querySelector(`[data-testid="section-scroll-${key}"]`) as HTMLElement
const barOf = (key: string): HTMLElement => container.querySelector(`[data-testid="section-actions-${key}"]`) as HTMLElement
const headline = (key: string): string => plain(container.querySelector(`[data-testid="card-headline-${key}"]`)?.textContent)
const openPanels = (): string[] => Array.from(container.querySelectorAll<HTMLElement>('[role="tabpanel"]')).filter((p) => !p.hidden).map((p) => p.dataset.testid ?? '')
const buttonIn = (parent: HTMLElement, label: string): HTMLButtonElement | undefined =>
  Array.from(parent.querySelectorAll('button')).find((b) => b.textContent === label)

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

describe('the row of cards', () => {
  it('has four cards for a period and five when a shift is picked, the Z report second', async () => {
    stubApi()
    await mount()

    expect(Array.from(container.querySelectorAll('[role="tab"]')).map((c) => (c as HTMLElement).dataset.testid)).toEqual(['card-takings', 'card-checks', 'card-detail', 'card-shifts'])

    await pickShift()

    const cards = Array.from(container.querySelectorAll('[role="tab"]'))
    expect(cards.map((c) => (c as HTMLElement).dataset.testid)).toEqual(['card-takings', 'card-z', 'card-checks', 'card-detail', 'card-shifts'])
    expect(cards.map((c) => c.querySelector('span')?.textContent)).toEqual(['Takings', 'Z-Report', 'Checks', 'Detail', 'Shifts'])
  })

  it('keeps the scope picker outside the row and the sections, so it never scrolls away', async () => {
    stubApi()
    await mount()

    const picker = container.querySelector('[data-testid="scope-card"]') as HTMLElement

    expect(picker.contains(container.querySelector('[data-testid="scope-title"]'))).toBe(true)
    expect(picker.contains(container.querySelector('[data-testid="section-cards"]'))).toBe(false)
    for (const key of ['takings', 'checks', 'detail', 'shifts']) expect(picker.contains(panel(key))).toBe(false)
    expect(picker.className).toEqual(expect.stringContaining('shrink-0'))
  })

  it('opens on Takings, and only Takings', async () => {
    stubApi()
    await mount()

    expect(card('takings').getAttribute('aria-selected')).toBe('true')
    expect(openPanels()).toEqual(['section-takings'])
    expect(plain(scrollOf('takings').textContent)).toContain('Sales Summary')
  })

  it('opens one section at a time: a tap on another card swaps it, and the other cards are not selected', async () => {
    stubApi()
    await mount()
    await pickShift()

    for (const key of KEYS) {
      await openSection(container, key)

      expect(openPanels()).toEqual([`section-${key}`])
      expect(Array.from(container.querySelectorAll('[role="tab"]')).filter((c) => c.getAttribute('aria-selected') === 'true')).toEqual([card(key)])
    }
  })

  it('goes back to Takings when the scope stops being a shift while the Z report is open', async () => {
    stubApi()
    await mount()
    await pickShift()
    await openSection(container, 'z')
    expect(openPanels()).toEqual(['section-z'])

    const back = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Back to Today') as HTMLButtonElement
    await act(async () => {
      back.click()
      await Promise.resolve()
    })
    await flush()

    expect(card('z')).toBeNull()
    expect(openPanels()).toEqual(['section-takings'])
  })

  it('keeps what a section holds while another is looked at: an entry left out stays left out', async () => {
    stubApi()
    await mount()
    await pickShift()
    await openSection(container, 'checks')
    const tick = (): HTMLInputElement => container.querySelector('input[aria-label="Include REF000001 in this review"]') as HTMLInputElement
    await act(async () => {
      tick().click()
      await Promise.resolve()
    })
    expect(tick().checked).toBe(false)

    await openSection(container, 'takings')
    await openSection(container, 'checks')

    expect(tick().checked).toBe(false)
    expect(plain(barOf('checks').textContent)).toContain('Approving 1 of 2 entries. 1 left out.')
  })

  it('asks for nothing when a card is tapped: every report was asked once per scope, and tapping the cards asks no more', async () => {
    stubApi()
    await mount()
    await pickShift()
    const calls = (): number[] =>
      [window.api.getSalesSummary, window.api.getFiscalStatusByDay, window.api.getFiscalReconciliation, window.api.getZReport, window.api.getShiftEndOfDayReport].map(
        (fn) => (fn as unknown as ReturnType<typeof vi.fn>).mock.calls.length
      )
    const before = calls()

    for (const key of KEYS) await openSection(container, key)

    // Once for Today when the page opened and once for the shift picked; the Z report and the shift's end of day only for the shift.
    expect(before).toEqual([2, 2, 2, 1, 1])
    expect(calls()).toEqual(before)
    expect(window.api.getSalesSummary).toHaveBeenLastCalledWith({ shiftId: 3 })
    expect(window.api.getZReport).toHaveBeenCalledWith(3)
  })
})

describe('the headline figure on each card', () => {
  it('shows Takings as the revenue and Detail as the number of sales, both from the summary the main process returned', async () => {
    stubApi()
    await mount()

    expect(headline('takings')).toBe('Revenue Ksh 1,250.50')
    expect(headline('detail')).toBe('5 sales')
  })

  it('shows a shift scope\'s Checks as the entries to approve and its Z report as the cash difference', async () => {
    stubApi()
    await mount()
    await pickShift()

    expect(headline('checks')).toBe('2 entries to approve')
    expect(headline('z')).toBe('Cash difference -Ksh 5.00')
  })

  it('shows a period\'s Checks as the shifts that still await approval', async () => {
    stubApi({ getEndOfDayShifts: vi.fn().mockResolvedValue(ok(APPROVAL_ROWS)) })
    await mount()

    expect(headline('checks')).toBe('2 shifts to approve')
  })

  it('shows Shifts as the open shift', async () => {
    stubApi({ getShiftsList: vi.fn().mockResolvedValue(ok({ shifts: [SHIFT_ROW(8, { status: 'open', clock_out: null }), SHIFT_ROW(7)], total: 2, page: 1 })) })
    await mount()

    expect(headline('shifts')).toBe('Shift #8 open')
  })

  it('says so when nothing is open, nothing awaits approval, or the shift is approved', async () => {
    stubApi({ getEndOfDayShifts: vi.fn().mockResolvedValue(ok([])) })
    await mount()

    expect(headline('shifts')).toBe('No shift open')
    expect(headline('checks')).toBe('Nothing to approve')

    act(() => root.unmount())
    root = createRoot(container)
    stubApi({ getShiftEndOfDayReport: vi.fn().mockResolvedValue(ok(endOfDay(2, { approval: { approvalId: 1, approvedAt: '2026-09-01T17:00:00.000Z', approvedByName: 'Admin', entryCount: 2, excludedCount: 0, totalAmount: 20 }, canApprove: false, pendingIds: [] }))) })
    await mount()
    await pickShift()

    expect(headline('checks')).toBe('Approved')
  })

  it('words each figure from what the main process returned, and shows an ellipsis until it has', () => {
    expect(takingsHeadline(null)).toBe(HEADLINE_LOADING)
    expect(detailHeadline(null)).toBe(HEADLINE_LOADING)
    expect(zReportHeadline(null)).toBe(HEADLINE_LOADING)
    expect(shiftEndOfDayHeadline(null)).toBe(HEADLINE_LOADING)
    expect(approvalRowsHeadline(null)).toBe(HEADLINE_LOADING)
    expect(detailHeadline({ ...SUMMARY, orderCount: 1 })).toBe('1 sale')
    expect(zReportHeadline({ ...Z_REPORT, discrepancy: null, status: 'open' })).toBe('Shift open')
    expect(zReportHeadline({ ...Z_REPORT, cashNotCounted: true })).toBe('Cash not counted')
    expect(shiftEndOfDayHeadline(endOfDay(1))).toBe('1 entry to approve')
    expect(shiftEndOfDayHeadline(endOfDay(0))).toBe('Nothing to approve')
    expect(shiftEndOfDayHeadline(endOfDay(3, { canApprove: false }))).toBe('Cannot approve yet')
    expect(approvalRowsHeadline([APPROVAL_ROWS[1]])).toBe('1 shift to approve')
    expect(shiftsHeadline([SHIFT_ROW(2), SHIFT_ROW(1)] as unknown as ShiftRow[])).toBe('No shift open')
  })
})

describe('the actions of the open section', () => {
  it('draws Print Z-Report and Correct figures in the Z section\'s bar, outside its scroll area', async () => {
    stubApi()
    await mount()
    await pickShift()
    await openSection(container, 'z')

    for (const label of ['Print Z-Report', 'Correct figures']) {
      const el = buttonIn(barOf('z'), label)!
      expect(el).toBeDefined()
      expect(scrollOf('z').contains(el)).toBe(false)
    }
    expect(scrollOf('z').textContent).toContain('Shift #3')
  })

  it('draws Approve in the Checks section\'s bar, outside its scroll area, and prints nothing else there', async () => {
    stubApi()
    await mount()
    await pickShift()
    await openSection(container, 'checks')

    const approve = buttonIn(barOf('checks'), 'Approve')!

    expect(approve).toBeDefined()
    expect(scrollOf('checks').contains(approve)).toBe(false)
    expect(scrollOf('checks').textContent).toContain('End of Day for shift #3')
    expect(barOf('checks').contains(scrollOf('checks'))).toBe(false)
  })

  it('draws Move a sale and the pager in the Shifts section\'s bar, outside its scroll area', async () => {
    stubApi({ getShiftsList: vi.fn().mockResolvedValue(ok({ shifts: [SHIFT_ROW(3)], total: 25, page: 1 })) })
    await mount()
    await openSection(container, 'shifts')

    for (const label of ['Move a sale', 'Next']) {
      const el = buttonIn(barOf('shifts'), label)!
      expect(el).toBeDefined()
      expect(scrollOf('shifts').contains(el)).toBe(false)
    }
  })

  it('keeps the action bar in the document and outside the scroll area when the list has 200 rows', async () => {
    stubApi({ getShiftEndOfDayReport: vi.fn().mockResolvedValue(ok(endOfDay(200))) })
    await mount()
    await pickShift()
    await openSection(container, 'checks')

    const approve = buttonIn(barOf('checks'), 'Approve')!

    expect(scrollOf('checks').querySelectorAll('input[type="checkbox"]')).toHaveLength(200)
    expect(document.body.contains(approve)).toBe(true)
    expect(scrollOf('checks').contains(approve)).toBe(false)
    expect(plain(barOf('checks').textContent)).toContain('Approving 200 of 200 entries. 0 left out.')
  })

  it('shows an empty bar for a section with no actions, so it takes no room', async () => {
    stubApi()
    await mount()

    expect(barOf('takings').childNodes).toHaveLength(0)
    expect(barOf('takings').className).toEqual(expect.stringContaining('empty:hidden'))
  })
})

describe('the scroll areas', () => {
  const read = (...parts: string[]): string => readFileSync(join(process.cwd(), 'src', 'renderer', 'src', ...parts), 'utf8').replace(/\r\n/g, '\n')

  it('gives each section one scroll area with the always-visible bar, and a bar that does not shrink', async () => {
    stubApi()
    await mount()

    for (const key of ['takings', 'checks', 'detail', 'shifts']) {
      expect(scrollOf(key).className).toEqual(expect.stringContaining('overflow-y-auto'))
      expect(scrollOf(key).className).toEqual(expect.stringContaining('touch-scrollbar'))
      expect(scrollOf(key).className).toEqual(expect.stringContaining('min-h-0 flex-1'))
      expect(barOf(key).className).toEqual(expect.stringContaining('shrink-0'))
      expect(panel(key).contains(scrollOf(key))).toBe(true)
      expect(panel(key).contains(barOf(key))).toBe(true)
      expect(scrollOf(key).contains(barOf(key))).toBe(false)
    }
  })

  it('hides a section that is not open, and does not take its room', async () => {
    stubApi()
    await mount()

    expect(panel('checks').hidden).toBe(true)
    expect(panel('checks').className).toBe('hidden')
    expect(panel('takings').className).toEqual(expect.stringContaining('flex min-h-0 flex-1 flex-col'))
  })

  it('works nothing out on the cards: the headlines are words made from what the main process returned', () => {
    const lib = read('lib', 'reportHeadlines.ts')
    const page = read('pages', 'ReportsPage.tsx')

    expect(lib.match(/\.reduce\(/g) ?? []).toHaveLength(0)
    expect(page.match(/\.reduce\(/g) ?? []).toHaveLength(0)
    expect(lib).not.toMatch(/totalRevenue\s*[+*/-]|orderCount\s*[+*/-]/)
  })

  it('drops the scope list over the cards instead of pushing them down', () => {
    const picker = read('components', 'ScopePicker.tsx')

    expect(picker).toContain('absolute inset-x-0 top-full')
    expect(picker).toContain('max-h-96')
  })
})
