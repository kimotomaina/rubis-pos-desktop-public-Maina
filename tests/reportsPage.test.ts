/**
 * The Reports tab (docs/phase-158, rebuilt in docs/phase-246): one tab laid out as the end-of-day routine. Real mount, the
 * project's established style (`react-dom/client`, real DOM clicks).
 *
 * CHANGED (docs/phase-246). OLD: this file drove six sub-views, each reached from a card (Shift History, Sales Summary, Fiscal
 * Status, Fiscal Reconciliation, Invoice List, Export), each with its own row of preset buttons. NEW: the tab has one scope
 * picker and five sections (Scope, Takings, Checks, Detail, Shifts); the same figures, VAT labels, coverage caption,
 * reconciliation rows, invoice list and export are asserted against it. The Shift History tests that were here are in
 * `shiftHistoryPagingUi`, `oneShiftPerWindowUi`, `frozenShiftsUi` and `shiftCaptureUi`, which mount this page.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReportsPage from '../src/renderer/src/pages/ReportsPage.js'
import { reportsTabApi, EMPTY_SUMMARY } from './helpers/reportsTabApi.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import type { ZReport } from '../src/main/services/reports.js'

let container: HTMLDivElement
let root: Root

const ok = <T,>(data?: T): { success: true; data: T | undefined } => ({ success: true, data })
const plain = (text: string | null | undefined): string => (text ?? '').replace(/\u00a0/g, ' ')

const STAFF = [
  { id: 1, name: 'Ann', role: 'cashier' as const },
  { id: 2, name: 'Bob', role: 'admin' as const }
]

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

const SAMPLE_Z_REPORT: ZReport = {
  shiftId: 7,
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
  endingCash: 300,
  discrepancy: 0
}

const SUMMARY = { ...EMPTY_SUMMARY, orderCount: 3, totalRevenue: 150, vatIncluded: 20.69, totalsByMethod: { cash: 100, mpesa: 50, card: 0 }, mpesaByMode: { manual: 20, daraja: 30 }, vatFromDeviceGroups: 13.79, vatFromDeviceGroupsCoverage: { ordersWithFigure: 2, ordersFiscalized: 3 } }

/** Stubs every `window.api` method the tab calls, across every section. */
function stubApi(overrides: Record<string, unknown> = {}): void {
  window.api = {
    ...reportsTabApi(),
    getStaffList: vi.fn().mockResolvedValue(ok(STAFF)),
    getShiftsList: vi.fn().mockResolvedValue(ok({ shifts: [SHIFT_ROW(7), SHIFT_ROW(6, { window_type: 'night' })], total: 2, page: 1 })),
    getSalesSummary: vi.fn().mockResolvedValue(ok(SUMMARY)),
    getFiscalStatusByDay: vi.fn().mockResolvedValue(ok([{ localDay: '2026-09-26', fiscalized: 4, waiting: 1, needsFixing: 0 }])),
    getFiscalReconciliation: vi.fn().mockResolvedValue(
      ok({
        startIso: SUMMARY.startIso,
        endIso: SUMMARY.endIso,
        label: SUMMARY.label,
        rows: [
          {
            localId: 1,
            createdAt: '2026-09-26T09:00:00.000Z',
            traderInvoiceNumber: 'INV-000000001',
            cuInvoiceNumber: 'CU-001',
            charged: 190,
            deviceTotal: 200,
            difference: 10,
            status: 'mismatch',
            vatByGroup: { A: { amount: 200, vat: 27.59 } }
          }
        ],
        totals: { matched: 0, mismatch: 1, noDeviceFigure: 0, sumCharged: 190, sumDevice: 200, sumDifference: 10 }
      })
    ),
    getInvoiceList: vi.fn().mockResolvedValue(
      ok({
        invoices: [
          {
            order: { local_id: 1, created_at: '2026-09-26T09:00:00.000Z', fiscal_invoice_number: 'CU-001', fiscal_status: 'fiscalized', total: 500, payment_method: 'cash', staff_id: 1 },
            traderInvoiceNumber: 'INV-000000001'
          }
        ],
        total: 1,
        page: 1
      })
    ),
    exportReportsCsv: vi.fn().mockResolvedValue(ok({ saved: true, filePath: 'D:/exports/orders.csv' })),
    getZReport: vi.fn().mockResolvedValue(ok(SAMPLE_Z_REPORT)),
    printZReport: vi.fn().mockResolvedValue(ok({ mock: true })),
    autoAssignSales: vi.fn().mockResolvedValue(ok({ touched: [], waiting: 0 })),
    ...overrides
  } as unknown as typeof window.api
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(ReportsPage))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement {
  // A Detail header carries its open or shut mark after the label.
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label || b.textContent?.trim().replace(/\s*[▸▾]$/, '') === label)
  if (!el) throw new Error(`No button "${label}"`)
  return el as HTMLButtonElement
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
    await Promise.resolve()
    await Promise.resolve()
  })
  await flush()
}

function typeInto(label: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) throw new Error(`No field "${label}"`)
  act(() => input.click())
  act(() => useKeyboardStore.getState().request?.onChange(value))
}

/** Opens the scope list and picks one of its buttons. */
async function pickScope(label: string | RegExp): Promise<void> {
  await click('Change scope')
  const list = container.querySelector('[data-testid="scope-list"]')!
  const el = Array.from(list.querySelectorAll('button')).find((b) => (typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? '')))
  if (!el) throw new Error(`No scope "${String(label)}"`)
  await act(async () => {
    el.click()
    await Promise.resolve()
    await Promise.resolve()
  })
  await flush()
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

describe('the Reports tab', () => {
  it('is five numbered sections in the order the day is closed: Scope, Takings, Checks, Detail, Shifts', async () => {
    stubApi()
    await mount()

    const headings = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent)

    expect(headings).toEqual(['1. Scope', '2. Takings', '3. Checks', '4. Detail', '5. Shifts'])
  })

  it('opens on Today, with no Z report, and every report asked for the preset as a plain string, as before', async () => {
    stubApi()
    await mount()

    expect(container.querySelector('[data-testid="scope-title"]')?.textContent).toBe('Today')
    expect(window.api.getSalesSummary).toHaveBeenCalledWith('today')
    expect(window.api.getFiscalStatusByDay).toHaveBeenCalledWith('today')
    expect(window.api.getFiscalReconciliation).toHaveBeenCalledWith('today')
    expect(window.api.getEndOfDayShifts).toHaveBeenCalledWith('today')
    expect(window.api.getZReport).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="takings-z-report"]')).toBeNull()
  })

  it('keeps the Detail section shut until it is opened, and asks for nothing of it meanwhile', async () => {
    stubApi()
    await mount()

    expect(window.api.getInvoiceList).not.toHaveBeenCalled()
    expect(window.api.exportReportsCsv).not.toHaveBeenCalled()
    expect(window.api.getMpesaTransactions).not.toHaveBeenCalled()
    for (const label of ['Invoice List', 'M-Pesa Logs', 'Export CSV']) expect(button(label).getAttribute('aria-expanded')).toBe('false')
    expect(Array.from(container.querySelectorAll('h3')).some((h) => h.textContent === 'Invoice List')).toBe(false)
  })
})

describe('the scope', () => {
  it('lists the shifts first, newest first, then the periods, then a custom range', async () => {
    stubApi()
    await mount()
    await click('Change scope')

    const list = container.querySelector('[data-testid="scope-list"]')!
    const text = plain(list.textContent)

    expect(text.indexOf('Shifts, newest first')).toBeLessThan(text.indexOf('Periods'))
    expect(text.indexOf('Periods')).toBeLessThan(text.indexOf('Custom range'))
    expect(window.api.getShiftsList).toHaveBeenCalledWith(1)
    const shifts = Array.from(list.querySelectorAll('button')).map((b) => b.textContent ?? '').filter((label) => label.startsWith('Shift #'))
    expect(shifts).toEqual(['Shift #7, Day, 1 Sep 11:00 to 19:00', 'Shift #6, Night, 1 Sep 11:00 to 19:00'])
    for (const label of ['Today', 'Yesterday', 'This week', 'Last week', 'This month', 'Last month']) {
      expect(Array.from(list.querySelectorAll('button')).some((b) => b.textContent === label)).toBe(true)
    }
  })

  it('names an open shift as "to now"', async () => {
    stubApi({ getShiftsList: vi.fn().mockResolvedValue(ok({ shifts: [SHIFT_ROW(8, { clock_out: null, status: 'open' })], total: 1, page: 1 })) })
    await mount()
    await click('Change scope')

    expect(plain(container.querySelector('[data-testid="scope-list"]')?.textContent)).toContain('Shift #8, Day, 1 Sep 11:00 to now')
  })

  it('gives every report a period as the same plain string, and a new period asks every report again', async () => {
    stubApi()
    await mount()

    await pickScope('This week')

    expect(container.querySelector('[data-testid="scope-title"]')?.textContent).toBe('This week')
    for (const call of [window.api.getSalesSummary, window.api.getFiscalStatusByDay, window.api.getFiscalReconciliation, window.api.getEndOfDayShifts]) {
      expect(call).toHaveBeenLastCalledWith('thisWeek')
    }
    expect(window.api.getZReport).not.toHaveBeenCalled()
  })

  it('gives every report a shift as its id, and the Z report the shift itself', async () => {
    stubApi()
    await mount()

    await pickScope(/^Shift #7/)

    expect(plain(container.querySelector('[data-testid="scope-title"]')?.textContent)).toContain('Shift #7, Day')
    for (const call of [window.api.getSalesSummary, window.api.getFiscalStatusByDay, window.api.getFiscalReconciliation]) {
      expect(call).toHaveBeenLastCalledWith({ shiftId: 7 })
    }
    expect(window.api.getZReport).toHaveBeenCalledWith(7)
    expect(window.api.getShiftEndOfDayReport).toBeUndefined()
  })

  it('takes a typed range of two date-times, and refuses one that is not YYYY-MM-DD HH:MM before asking anything', async () => {
    stubApi()
    await mount()
    await click('Change scope')

    typeInto('Range from', '5 Oct')
    typeInto('Range to', '2026-10-06 09:30')
    await click('Use this range')
    expect(container.textContent).toContain('Enter both date-times as YYYY-MM-DD HH:MM, Nairobi time')
    expect(window.api.getSalesSummary).toHaveBeenCalledTimes(1)

    typeInto('Range from', '2026-10-05 17:00')
    await click('Use this range')
    expect(window.api.getSalesSummary).toHaveBeenLastCalledWith({ from: '2026-10-05 17:00', to: '2026-10-06 09:30' })
    expect(container.querySelector('[data-testid="scope-title"]')?.textContent).toBe('2026-10-05 17:00 to 2026-10-06 09:30')
    expect(window.api.getZReport).not.toHaveBeenCalled()
  })

  it('goes back to Today in one tap', async () => {
    stubApi()
    await mount()
    await pickScope('Last month')

    await click('Back to Today')

    expect(container.querySelector('[data-testid="scope-title"]')?.textContent).toBe('Today')
  })
})

describe('the takings', () => {
  it('shows the sales summary the main process returned, its VAT label and its coverage caption, worked out nowhere on screen', async () => {
    stubApi({ getSalesSummary: vi.fn().mockResolvedValue(ok({ ...SUMMARY, orderCount: 15, totalRevenue: 999.5, vatFromDeviceGroups: 16, vatFromDeviceGroupsCoverage: { ordersWithFigure: 12, ordersFiscalized: 15 } })) })
    await mount()

    const text = plain(container.textContent)

    expect(text).toContain('VAT included (calculated at 16%)')
    expect(text).toContain('from 12 of 15 sales; group D not included')
    expect(text).toContain('999.50')
    expect(text).toMatch(/Orders\s*15/)
  })

  it('labels the VAT figure from the configured rate, not a hardcoded 16% (docs/phase-158-1)', async () => {
    stubApi({ getSalesSummary: vi.fn().mockResolvedValue(ok({ ...SUMMARY, vatRate: 0.08 })) })
    await mount()

    expect(container.textContent).toContain('VAT included (calculated at 8%)')
    expect(container.textContent).not.toContain('16%')
  })

  it('shows, for a shift, its Z report beside the summary with Print, and prints that shift', async () => {
    stubApi()
    await mount()

    await pickScope(/^Shift #7/)

    const block = container.querySelector('[data-testid="takings-z-report"]')!
    expect(block.textContent).toContain('Z-Report')
    expect(block.textContent).toContain('Shift #7')
    expect(block.textContent).toContain('VAT included (calculated at 16%)')
    await act(async () => {
      ;(Array.from(block.querySelectorAll('button')).find((b) => b.textContent === 'Print Z-Report') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(window.api.printZReport).toHaveBeenCalledWith(7)
  })

  it('says so when the shift\'s time range holds a different number of sales from its Z report, and says nothing when they agree', async () => {
    stubApi({ getSalesSummary: vi.fn().mockResolvedValue(ok({ ...SUMMARY, orderCount: 7 })) })
    await mount()
    await pickScope(/^Shift #7/)

    expect(container.querySelector('[data-testid="takings-count-note"]')?.textContent).toContain('This time range holds 7 sales and the shift')

    act(() => root.unmount())
    root = createRoot(container)
    stubApi({ getSalesSummary: vi.fn().mockResolvedValue(ok({ ...SUMMARY, orderCount: 5 })) })
    await mount()
    await pickScope(/^Shift #7/)

    expect(container.querySelector('[data-testid="takings-count-note"]')).toBeNull()
  })
})

describe('the checks', () => {
  it('shows fiscal status by day and the fiscal reconciliation for the scope', async () => {
    stubApi()
    await mount()

    expect(container.textContent).toContain('Fiscal Status by Day')
    expect(container.textContent).toContain('2026-09-26')
    expect(container.textContent).toContain('Fiscal Reconciliation')
    expect(container.textContent).toContain('INV-000000001')
    expect(container.textContent).toContain('CU-001')
    expect(container.textContent).toContain('mismatch')
  })

  it('shows "no device figure" (not blank) for a row with no stored device figure', async () => {
    stubApi({
      getFiscalReconciliation: vi.fn().mockResolvedValue(
        ok({
          startIso: SUMMARY.startIso,
          endIso: SUMMARY.endIso,
          label: SUMMARY.label,
          rows: [{ localId: 2, createdAt: '2026-09-26T09:00:00.000Z', traderInvoiceNumber: 'INV-000000002', cuInvoiceNumber: 'CU-002', charged: 100, deviceTotal: null, difference: null, status: 'no-device-figure', vatByGroup: {} }],
          totals: { matched: 0, mismatch: 0, noDeviceFigure: 1, sumCharged: 100, sumDevice: 0, sumDifference: 0 }
        })
      )
    })
    await mount()

    expect(container.textContent).toContain('no device figure')
  })

  it('lists the shifts of a period with where each one\'s approval stands, and offers no approve button there', async () => {
    const rows = [
      { shiftId: 8, status: 'open', openedAt: '2026-10-06T08:35:14.000Z', closedAt: null, windowType: 'day', windowDate: '2026-10-06', orderCount: 36, state: 'open', manualCount: 19, pendingCount: 19, pendingAmount: 24175, approvedAt: null, approvedByName: null },
      { shiftId: 3, status: 'closed', openedAt: '2026-10-05T06:14:00.000Z', closedAt: '2026-10-05T14:30:59.000Z', windowType: 'day', windowDate: '2026-10-05', orderCount: 42, state: 'not-approved', manualCount: 23, pendingCount: 23, pendingAmount: 19180.09, approvedAt: null, approvedByName: null },
      { shiftId: 5, status: 'closed', openedAt: '2026-10-02T12:32:00.000Z', closedAt: '2026-10-02T13:51:59.000Z', windowType: 'day', windowDate: '2026-10-02', orderCount: 3, state: 'approved-earlier', manualCount: 1, pendingCount: 0, pendingAmount: 0, approvedAt: null, approvedByName: null },
      { shiftId: 1, status: 'closed', openedAt: '2026-10-05T14:43:21.000Z', closedAt: '2026-10-05T14:43:36.000Z', windowType: 'night', windowDate: '2026-10-05', orderCount: 59, state: 'approved', manualCount: 43, pendingCount: 0, pendingAmount: 0, approvedAt: '2026-10-06T10:00:00.000Z', approvedByName: 'Admin' }
    ]
    stubApi({ getEndOfDayShifts: vi.fn().mockResolvedValue(ok(rows)) })
    await mount()

    const list = container.querySelector('[data-testid="shift-approval-list"]')!
    const text = plain(list.textContent)

    expect(Array.from(list.querySelectorAll('tbody tr'))).toHaveLength(4)
    for (const word of ['Open', 'Not approved', 'Approved earlier', 'Approved']) expect(text).toContain(word)
    expect(text).toContain('23 of 23 waiting')
    expect(text).toContain('by Admin')
    expect(Array.from(container.querySelectorAll('button')).some((b) => /^Approve$|Record review/.test(b.textContent ?? ''))).toBe(false)
    expect(window.api.getShiftEndOfDayReport).toBeUndefined()
  })

  it('opens a shift of the list as the page\'s scope, where its end of day and its Approve are', async () => {
    const report = {
      localDay: '2026-10-05',
      shiftId: 3,
      shiftStatus: 'closed',
      openedAt: '2026-10-05T06:14:00.000Z',
      closedAt: '2026-10-05T14:30:59.000Z',
      windowType: 'day',
      mergedInto: null,
      approval: null,
      canApprove: true,
      cannotApproveBecause: null,
      cashiers: [],
      totalsByMethod: { cash: 0, mpesa: 60, card: 0 },
      manualEntries: [
        { paymentId: 1, orderLocalId: 85, createdAt: '2026-10-05T14:34:57.000Z', localDay: '2026-10-05', staffId: 1, staffName: 'Ann', reference: 'QDF73HK9LM', amount: 60, approved: false, reconciledAt: null, reconciledByStaffId: null, reconciledByStaffName: null, sameApproverAsRecorder: false, lastExclusion: null }
      ],
      carryOver: [],
      pendingIds: [1],
      pendingManualTotal: 60
    }
    stubApi({
      getEndOfDayShifts: vi.fn().mockResolvedValue(
        ok([{ shiftId: 3, status: 'closed', openedAt: '2026-10-05T06:14:00.000Z', closedAt: '2026-10-05T14:30:59.000Z', windowType: 'day', windowDate: '2026-10-05', orderCount: 42, state: 'not-approved', manualCount: 1, pendingCount: 1, pendingAmount: 60, approvedAt: null, approvedByName: null }])
      ),
      getShiftEndOfDayReport: vi.fn().mockResolvedValue(ok(report)),
      getDiscardedHeldSales: vi.fn().mockResolvedValue(ok([]))
    })
    await mount()

    await click('Open shift #3')

    expect(plain(container.querySelector('[data-testid="scope-title"]')?.textContent)).toContain('Shift #3, Day')
    expect(window.api.getShiftEndOfDayReport).toHaveBeenCalledWith(3)
    expect(container.querySelector('[data-testid="shift-end-of-day"]')).not.toBeNull()
    expect(button('Approve')).toBeDefined()
  })
})

describe('the detail', () => {
  it('opens the invoice list on one tap and pairs the trader invoice number with the CU invoice number', async () => {
    stubApi()
    await mount()

    await click('Invoice List')

    expect(window.api.getInvoiceList).toHaveBeenCalledWith('today', 1)
    expect(container.textContent).toContain('INV-000000001')
    expect(container.textContent).toContain('CU-001')
  })

  it('gives the invoice list the scope too, a shift by its id', async () => {
    stubApi()
    await mount()
    await pickScope(/^Shift #7/)

    await click('Invoice List')

    expect(window.api.getInvoiceList).toHaveBeenLastCalledWith({ shiftId: 7 }, 1)
  })

  it('says the M-Pesa logs are the latest 50 and not limited to the scope', async () => {
    stubApi()
    await mount()

    await click('M-Pesa Logs')

    expect(container.textContent).toContain('The latest 50 M-Pesa transactions, not limited to Today.')
    expect(window.api.getMpesaTransactions).toHaveBeenCalledWith(50)
  })

  it('exports orders and lines for the scope through the save dialog', async () => {
    stubApi()
    await mount()
    await click('Export CSV')

    await click('Export orders CSV')
    expect(window.api.exportReportsCsv).toHaveBeenCalledWith('today', 'orders')
    expect(container.textContent).toContain('Saved to D:/exports/orders.csv')
    await click('Export lines CSV')
    expect(window.api.exportReportsCsv).toHaveBeenLastCalledWith('today', 'lines')
  })
})

describe('the shifts', () => {
  it('lists shifts and opens the Z-report on tap, with a working Print', async () => {
    stubApi()
    await mount()

    expect(container.textContent).toContain('#7')
    expect(container.textContent).toContain('Ann')
    await act(async () => {
      const row = Array.from(container.querySelectorAll('tr')).find((tr) => tr.textContent?.includes('#7'))
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(window.api.getZReport).toHaveBeenCalledWith(7)
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Z-Report')
    await act(async () => {
      ;(Array.from(container.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === 'Print Z-Report') as HTMLButtonElement).click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(window.api.printZReport).toHaveBeenCalledWith(7)
  })
})

describe('the Admin menu and the page', () => {
  const read = (...parts: string[]): string => readFileSync(join(process.cwd(), 'src', 'renderer', 'src', ...parts), 'utf8').replace(/\r\n/g, '\n')

  it('has no End of Day or M-Pesa Logs card of its own: both are sections of the Reports tab', () => {
    const admin = read('components', 'AdminScreen.tsx')

    expect(admin).not.toContain("key: 'endOfDay'")
    expect(admin).not.toContain("key: 'mpesaLogs'")
    expect(admin).not.toContain('EndOfDayPage')
    expect(admin).not.toContain('MpesaLogsPage')
    expect(admin).toContain("{ key: 'reports', label: 'Reports'")
  })

  it('scrolls as a whole, in one place, with the always-visible bar', async () => {
    stubApi()
    await mount()

    const scroll = container.querySelector('[data-testid="reports-scroll"]') as HTMLElement

    expect(scroll.className).toEqual(expect.stringContaining('overflow-y-auto'))
    expect(scroll.className).toEqual(expect.stringContaining('touch-scrollbar'))
    expect(scroll.className).toEqual(expect.stringContaining('min-h-0'))
    expect(scroll.className).toEqual(expect.stringContaining('flex-1'))
    expect(scroll.contains(container.querySelector('[data-testid="scope-title"]'))).toBe(true)
  })

  it('works nothing out itself: the only sums in the page file are counts of rows and pages', () => {
    const page = read('pages', 'ReportsPage.tsx')
    const reduces = page.match(/\.reduce\(/g) ?? []

    expect(reduces).toHaveLength(0)
    expect(page).not.toMatch(/orderCount\s*[+*-]|totalRevenue\s*[+*-]/)
  })
})
