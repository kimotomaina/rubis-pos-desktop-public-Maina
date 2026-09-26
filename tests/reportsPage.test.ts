/**
 * `ReportsPage`'s five sub-views (docs/phase-158) — real mount, matching
 * this project's established style (`react-dom/client`, real DOM
 * clicks; `endOfDayPage.test.ts`/`adminScreen.test.ts`'s own pattern).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ReportsPage from '../src/renderer/src/pages/ReportsPage.js'
import type { ZReport } from '../src/main/services/reports.js'

let container: HTMLDivElement
let root: Root

function ok<T>(data?: T): { success: true; data: T | undefined } {
  return { success: true, data }
}

const STAFF = [
  { id: 1, name: 'Ann', role: 'cashier' as const },
  { id: 2, name: 'Bob', role: 'admin' as const }
]

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
  expectedCash: 300,
  endingCash: 300,
  discrepancy: 0
}

/** Stubs every `window.api` method `ReportsPage` calls, across every sub-view. */
function stubApi(overrides: Record<string, unknown> = {}): void {
  window.api = {
    getStaffList: vi.fn().mockResolvedValue(ok(STAFF)),
    getShiftsList: vi.fn().mockResolvedValue(
      ok({ shifts: [{ id: 7, staff_id: 1, clock_in: '2026-09-01T08:00:00.000Z', clock_out: '2026-09-01T16:00:00.000Z', starting_cash: 100, expected_cash: 300, ending_cash: 300, discrepancy: 0, status: 'closed' }], total: 1, page: 1 })
    ),
    getSalesSummary: vi.fn().mockResolvedValue(
      ok({
        startIso: '2026-09-26T00:00:00.000Z',
        endIso: '2026-09-27T00:00:00.000Z',
        label: 'Today (2026-09-26)',
        orderCount: 3,
        totalRevenue: 150,
        vatIncluded: 20.69,
        totalsByMethod: { cash: 100, mpesa: 50, card: 0 },
        mpesaByMode: { manual: 20, daraja: 30 }
      })
    ),
    getFiscalStatusByDay: vi.fn().mockResolvedValue(
      ok([{ localDay: '2026-09-26', fiscalized: 4, waiting: 1, needsFixing: 0 }])
    ),
    getInvoiceList: vi.fn().mockResolvedValue(
      ok({
        invoices: [
          {
            order: {
              local_id: 1,
              created_at: '2026-09-26T09:00:00.000Z',
              fiscal_invoice_number: 'CU-001',
              fiscal_status: 'fiscalized',
              total: 500,
              payment_method: 'cash',
              staff_id: 1
            },
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
    ...overrides
  } as unknown as typeof window.api
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(ReportsPage))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
  if (!el) throw new Error(`No button "${label}"`)
  return el as HTMLButtonElement
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ReportsPage > sub-nav', () => {
  it('declares the five named sub-views', async () => {
    stubApi()
    await mount()
    for (const label of ['Shift History', 'Sales Summary', 'Fiscal Status', 'Invoice List', 'Export']) {
      expect(() => button(label)).not.toThrow()
    }
  })
})

describe('ReportsPage > Shift History', () => {
  it('lists shifts and opens the Z-report on tap, with a working Reprint button', async () => {
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
    expect(container.textContent).toContain('Z-Report')
    expect(container.textContent).toContain('VAT included (calculated at 16%)')

    await click('Print Z-Report')
    expect(window.api.printZReport).toHaveBeenCalledWith(7)
  })

  it('shows a Previous/Next pager and requests the next page', async () => {
    const getShiftsList = vi.fn().mockImplementation((page: number) =>
      Promise.resolve(
        ok({
          shifts: [{ id: page, staff_id: 1, clock_in: '2026-09-01T08:00:00.000Z', clock_out: null, starting_cash: 0, expected_cash: null, ending_cash: null, discrepancy: null, status: 'open' }],
          total: 25,
          page
        })
      )
    )
    stubApi({ getShiftsList })
    await mount()

    expect(container.textContent).toContain('Page 1 of')
    await click('Next')
    expect(getShiftsList).toHaveBeenCalledWith(2)
  })
})

describe('ReportsPage > Sales Summary', () => {
  it('loads the default preset and switching presets requests a new one', async () => {
    const getSalesSummary = vi.fn().mockResolvedValue(
      ok({
        startIso: '2026-09-26T00:00:00.000Z',
        endIso: '2026-09-27T00:00:00.000Z',
        label: 'Today (2026-09-26)',
        orderCount: 3,
        totalRevenue: 150,
        vatIncluded: 20.69,
        totalsByMethod: { cash: 100, mpesa: 50, card: 0 },
        mpesaByMode: { manual: 20, daraja: 30 }
      })
    )
    stubApi({ getSalesSummary })
    await mount()
    await click('Sales Summary')

    expect(getSalesSummary).toHaveBeenCalledWith('today')
    expect(container.textContent).toContain('150')

    await click('This week')
    expect(getSalesSummary).toHaveBeenCalledWith('thisWeek')
  })
})

describe('ReportsPage > Fiscal Status by Day', () => {
  it('renders a day-count table for the selected preset', async () => {
    stubApi()
    await mount()
    await click('Fiscal Status')

    expect(window.api.getFiscalStatusByDay).toHaveBeenCalledWith('today')
    expect(container.textContent).toContain('2026-09-26')
    expect(container.textContent).toContain('4')
  })
})

describe('ReportsPage > Invoice List', () => {
  it('pairs the trader invoice number with the CU invoice number', async () => {
    stubApi()
    await mount()
    await click('Invoice List')

    expect(container.textContent).toContain('INV-000000001')
    expect(container.textContent).toContain('CU-001')
  })
})

describe('ReportsPage > Export', () => {
  it('exports orders CSV for the selected preset via the save dialog', async () => {
    stubApi()
    await mount()
    await click('Export')

    await click('Export orders CSV')
    expect(window.api.exportReportsCsv).toHaveBeenCalledWith('today', 'orders')
    expect(container.textContent).toContain('Saved to D:/exports/orders.csv')
  })

  it('exports lines CSV separately', async () => {
    stubApi()
    await mount()
    await click('Export')

    await click('Export lines CSV')
    expect(window.api.exportReportsCsv).toHaveBeenCalledWith('today', 'lines')
  })
})
