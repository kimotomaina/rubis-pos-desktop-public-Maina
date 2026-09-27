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
  vatRate: 0.16,
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
        vatRate: 0.16,
        totalsByMethod: { cash: 100, mpesa: 50, card: 0 },
        mpesaByMode: { manual: 20, daraja: 30 },
        vatFromDeviceGroups: 13.79,
        vatFromDeviceGroupsCoverage: { ordersWithFigure: 2, ordersFiscalized: 3 }
      })
    ),
    getFiscalStatusByDay: vi.fn().mockResolvedValue(
      ok([{ localDay: '2026-09-26', fiscalized: 4, waiting: 1, needsFixing: 0 }])
    ),
    getFiscalReconciliation: vi.fn().mockResolvedValue(
      ok({
        startIso: '2026-09-26T00:00:00.000Z',
        endIso: '2026-09-27T00:00:00.000Z',
        label: 'Today (2026-09-26)',
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
  // docs/phase-163: gained a sixth sub-view, "Fiscal Reconciliation" —
  // was five named sub-views, now six.
  it('declares the six named sub-views', async () => {
    stubApi()
    await mount()
    for (const label of [
      'Shift History',
      'Sales Summary',
      'Fiscal Status',
      'Fiscal Reconciliation',
      'Invoice List',
      'Export'
    ]) {
      expect(() => button(label)).not.toThrow()
    }
  })
})

/**
 * DELIBERATE TEST CHANGE (docs/phase-167 Part A): Reports opened
 * straight to Shift History by default (the other five sub-views'
 * tests already clicked their own button, so only these three needed
 * touching) — it now opens to a card grid, same as Admin and
 * Integrations, and Shift History renders only once its own card is
 * tapped.
 *   Old assertion: `mount()` alone already shows Shift History.
 *   New assertion: `mount()` then `click('Shift History')`.
 */
describe('ReportsPage > Shift History', () => {
  it('lists shifts and opens the Z-report on tap, with a working Reprint button', async () => {
    stubApi()
    await mount()
    await click('Shift History')

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

  it('labels the Z-report VAT figure from the report\'s own rate, not a hardcoded 16% (docs/phase-158-1)', async () => {
    const getZReport = vi.fn().mockResolvedValue(ok({ ...SAMPLE_Z_REPORT, vatRate: 0.08, vatIncluded: 20.74 }))
    stubApi({ getZReport })
    await mount()
    await click('Shift History')

    await act(async () => {
      const row = Array.from(container.querySelectorAll('tr')).find((tr) => tr.textContent?.includes('#7'))
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('VAT included (calculated at 8%)')
    expect(container.textContent).not.toContain('16%')
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
    await click('Shift History')

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
        vatRate: 0.16,
        totalsByMethod: { cash: 100, mpesa: 50, card: 0 },
        mpesaByMode: { manual: 20, daraja: 30 },
        vatFromDeviceGroups: 13.79,
        vatFromDeviceGroupsCoverage: { ordersWithFigure: 2, ordersFiscalized: 3 }
      })
    )
    stubApi({ getSalesSummary })
    await mount()
    await click('Sales Summary')

    expect(getSalesSummary).toHaveBeenCalledWith('today')
    expect(container.textContent).toContain('150')
    expect(container.textContent).toContain('VAT included (calculated at 16%)')

    await click('This week')
    expect(getSalesSummary).toHaveBeenCalledWith('thisWeek')
  })

  /** docs/phase-163-1 — the coverage caption shown next to "VAT from device groups". */
  it('shows the "VAT from device groups" coverage caption', async () => {
    const getSalesSummary = vi.fn().mockResolvedValue(
      ok({
        startIso: '2026-09-26T00:00:00.000Z',
        endIso: '2026-09-27T00:00:00.000Z',
        label: 'Today (2026-09-26)',
        orderCount: 15,
        totalRevenue: 150,
        vatIncluded: 20.69,
        vatRate: 0.16,
        totalsByMethod: { cash: 100, mpesa: 50, card: 0 },
        mpesaByMode: { manual: 20, daraja: 30 },
        vatFromDeviceGroups: 16,
        vatFromDeviceGroupsCoverage: { ordersWithFigure: 12, ordersFiscalized: 15 }
      })
    )
    stubApi({ getSalesSummary })
    await mount()
    await click('Sales Summary')

    expect(container.textContent).toContain('VAT from device groups')
    expect(container.textContent).toContain('from 12 of 15 sales; group D not included')
  })

  it('labels the VAT figure from the configured rate, not a hardcoded 16% (docs/phase-158-1)', async () => {
    const getSalesSummary = vi.fn().mockResolvedValue(
      ok({
        startIso: '2026-09-26T00:00:00.000Z',
        endIso: '2026-09-27T00:00:00.000Z',
        label: 'Today (2026-09-26)',
        orderCount: 3,
        totalRevenue: 150,
        vatIncluded: 11.11,
        vatRate: 0.08,
        totalsByMethod: { cash: 100, mpesa: 50, card: 0 },
        mpesaByMode: { manual: 20, daraja: 30 },
        vatFromDeviceGroups: 5.93,
        vatFromDeviceGroupsCoverage: { ordersWithFigure: 3, ordersFiscalized: 3 }
      })
    )
    stubApi({ getSalesSummary })
    await mount()
    await click('Sales Summary')

    expect(container.textContent).toContain('VAT included (calculated at 8%)')
    expect(container.textContent).not.toContain('16%')
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

describe('ReportsPage > Fiscal Reconciliation (docs/phase-163)', () => {
  it('shows summary counts and lists a mismatch row with charged/device/difference/status', async () => {
    stubApi()
    await mount()
    await click('Fiscal Reconciliation')

    expect(window.api.getFiscalReconciliation).toHaveBeenCalledWith('today')
    expect(container.textContent).toContain('INV-000000001')
    expect(container.textContent).toContain('CU-001')
    expect(container.textContent).toContain('mismatch')
  })

  it('switching presets requests a new report', async () => {
    stubApi()
    await mount()
    await click('Fiscal Reconciliation')

    await click('This week')
    expect(window.api.getFiscalReconciliation).toHaveBeenCalledWith('thisWeek')
  })

  it('shows "no device figure" (not blank) for a row with no stored device figure', async () => {
    const getFiscalReconciliation = vi.fn().mockResolvedValue(
      ok({
        startIso: '2026-09-26T00:00:00.000Z',
        endIso: '2026-09-27T00:00:00.000Z',
        label: 'Today (2026-09-26)',
        rows: [
          {
            localId: 2,
            createdAt: '2026-09-26T09:00:00.000Z',
            traderInvoiceNumber: 'INV-000000002',
            cuInvoiceNumber: 'CU-002',
            charged: 100,
            deviceTotal: null,
            difference: null,
            status: 'no-device-figure',
            vatByGroup: {}
          }
        ],
        totals: { matched: 0, mismatch: 0, noDeviceFigure: 1, sumCharged: 100, sumDevice: 0, sumDifference: 0 }
      })
    )
    stubApi({ getFiscalReconciliation })
    await mount()
    await click('Fiscal Reconciliation')

    expect(container.textContent).toContain('no device figure')
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
