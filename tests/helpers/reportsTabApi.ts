/**
 * The `window.api` methods the Reports tab calls besides the ones a test is about (docs/phase-246, R2): the tab shows the
 * takings, the end of day and the fiscal checks all at once, so a test that mounts it needs an answer for each of them.
 * Every method answers "nothing to show" unless the test overrides it.
 */

import { vi } from 'vitest'
import { act } from 'react'

const ok = <T>(data: T): { success: true; data: T } => ({ success: true, data })

export const EMPTY_SUMMARY = {
  startIso: '2026-09-26T00:00:00.000Z',
  endIso: '2026-09-27T00:00:00.000Z',
  label: 'Today (2026-09-26)',
  orderCount: 0,
  totalRevenue: 0,
  vatIncluded: 0,
  vatRate: 0.16,
  totalsByMethod: { cash: 0, mpesa: 0, card: 0 },
  mpesaByMode: { manual: 0, daraja: 0 },
  vatFromDeviceGroups: 0,
  vatFromDeviceGroupsCoverage: { ordersWithFigure: 0, ordersFiscalized: 0 }
}

/**
 * @returns {Record<string, unknown>} one mock per call the Reports tab makes that is not Shift History's own
 */
export function reportsTabApi(): Record<string, unknown> {
  return {
    getSalesSummary: vi.fn().mockResolvedValue(ok(EMPTY_SUMMARY)),
    getFiscalStatusByDay: vi.fn().mockResolvedValue(ok([])),
    getFiscalReconciliation: vi.fn().mockResolvedValue(
      ok({
        startIso: EMPTY_SUMMARY.startIso,
        endIso: EMPTY_SUMMARY.endIso,
        label: EMPTY_SUMMARY.label,
        rows: [],
        totals: { matched: 0, mismatch: 0, noDeviceFigure: 0, sumCharged: 0, sumDevice: 0, sumDifference: 0 }
      })
    ),
    getEndOfDayShifts: vi.fn().mockResolvedValue(ok([])),
    getInvoiceList: vi.fn().mockResolvedValue(ok({ invoices: [], total: 0, page: 1 })),
    getMpesaTransactions: vi.fn().mockResolvedValue(ok([])),
    exportReportsCsv: vi.fn().mockResolvedValue(ok({ saved: false }))
  }
}

/**
 * Taps one card of the Reports tab (docs/phase-246-1) the way a person does, to open its section: `takings`, `z`, `checks`,
 * `detail` or `shifts`. Every section is mounted from the start, so a test that only reads can skip this; a test that is about
 * what a person sees in a section taps its card first.
 *
 * @param {HTMLElement} container the element the page is mounted in
 * @param {string} key the section
 * @returns {Promise<void>}
 */
export async function openSection(container: HTMLElement, key: 'takings' | 'z' | 'checks' | 'detail' | 'shifts'): Promise<void> {
  const card = container.querySelector<HTMLButtonElement>(`[data-testid="card-${key}"]`)
  if (!card) throw new Error(`No card "${key}"`)
  await act(async () => {
    card.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}
