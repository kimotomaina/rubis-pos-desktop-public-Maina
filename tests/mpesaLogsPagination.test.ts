/**
 * `MpesaLogsPage` pagination tests (docs/phase-166 Commit E4).
 *
 * `paginate` itself is already proven generically in
 * `tests/paginate.test.ts` — this checks the component's own wiring
 * (page size, the Pager appearing/behaving). Mounted with
 * `react-dom/client`, the same pattern this phase's other pagination
 * tests already use.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import MpesaLogsPage, { MPESA_LOGS_PAGE_SIZE } from '../src/renderer/src/pages/MpesaLogsPage.js'
import type { MpesaTransactionRow } from '../src/main/services/database.js'

const makeTransaction = (id: number): MpesaTransactionRow => ({
  id,
  order_local_id: id,
  checkout_request_id: `req-${id}`,
  merchant_request_id: `merch-${id}`,
  phone_number: '254700000000',
  amount: 10,
  status: 'success',
  mpesa_receipt_number: `REC${id}`,
  created_at: '2026-01-01T10:00:00Z',
  updated_at: '2026-01-01T10:00:00Z'
})

let container: HTMLDivElement
let root: Root

afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove()
})

async function mount(transactions: MpesaTransactionRow[]): Promise<void> {
  window.api = {
    getMpesaTransactions: vi.fn().mockResolvedValue({ success: true, data: transactions })
  } as unknown as typeof window.api

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(MpesaLogsPage))
    await Promise.resolve()
  })
}

function orderCells(): string[] {
  return Array.from(container.querySelectorAll('tbody tr td:first-child')).map(
    (td) => td.textContent ?? ''
  )
}

describe('MpesaLogsPage pagination (docs/phase-166 Commit E4)', () => {
  it(`shows exactly ${MPESA_LOGS_PAGE_SIZE} transactions per page`, async () => {
    const transactions = Array.from({ length: MPESA_LOGS_PAGE_SIZE + 5 }, (_, i) => makeTransaction(i + 1))
    await mount(transactions)

    expect(orderCells()).toHaveLength(MPESA_LOGS_PAGE_SIZE)
    expect(container.textContent).toContain('Page 1 of 2')
  })

  it('shows no pager when everything fits on one page', async () => {
    await mount([makeTransaction(1)])
    expect(container.textContent).not.toContain('Page 1 of')
  })

  it('Next reveals the remaining transactions on page 2', async () => {
    const transactions = Array.from({ length: MPESA_LOGS_PAGE_SIZE + 2 }, (_, i) => makeTransaction(i + 1))
    await mount(transactions)

    const next = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Next')!
    await act(async () => {
      next.click()
    })

    expect(orderCells()).toEqual([`#${MPESA_LOGS_PAGE_SIZE + 1}`, `#${MPESA_LOGS_PAGE_SIZE + 2}`])
  })
})
