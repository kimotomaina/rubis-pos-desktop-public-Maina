/**
 * `NeedsAttentionPage` pagination tests (docs/phase-166 Commit E4).
 *
 * `paginate` itself is already proven generically in
 * `tests/paginate.test.ts` — this checks the component's own wiring
 * (page size, the Pager appearing/behaving). Mounted with
 * `react-dom/client`, the same pattern `posCartTable.test.ts`/
 * `orderHistoryPagination.test.ts` already use.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import NeedsAttentionPage, {
  NEEDS_ATTENTION_PAGE_SIZE
} from '../src/renderer/src/pages/NeedsAttentionPage.js'
import type { NeedsAttentionRow } from '../src/main/services/database.js'

const makeRow = (localId: number): NeedsAttentionRow => ({
  local_id: localId,
  created_at: '2026-01-01T10:00:00Z',
  total: 10,
  staff_name: 'Alex',
  fiscal_status: 'waiting',
  fiscal_error_reason: null,
  fiscal_error_kind: null,
  fiscal_data_issue: null
})

let container: HTMLDivElement
let root: Root

afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove()
})

async function mount(rows: NeedsAttentionRow[]): Promise<void> {
  window.api = {
    getSalesNeedingAttention: vi.fn().mockResolvedValue({ success: true, data: rows })
  } as unknown as typeof window.api

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(NeedsAttentionPage))
    await Promise.resolve()
  })
}

function orderNumbers(): string[] {
  return Array.from(container.querySelectorAll('span'))
    .map((el) => el.textContent ?? '')
    .filter((t) => t.startsWith('Order #'))
}

describe('NeedsAttentionPage pagination (docs/phase-166 Commit E4)', () => {
  it(`shows exactly ${NEEDS_ATTENTION_PAGE_SIZE} rows per page`, async () => {
    const rows = Array.from({ length: NEEDS_ATTENTION_PAGE_SIZE + 3 }, (_, i) => makeRow(i + 1))
    await mount(rows)

    expect(orderNumbers()).toHaveLength(NEEDS_ATTENTION_PAGE_SIZE)
    expect(container.textContent).toContain('Page 1 of 2')
  })

  it('shows no pager when everything fits on one page', async () => {
    await mount([makeRow(1)])
    expect(container.textContent).not.toContain('Page 1 of')
  })

  it('Next reveals the remaining rows on page 2', async () => {
    const rows = Array.from({ length: NEEDS_ATTENTION_PAGE_SIZE + 1 }, (_, i) => makeRow(i + 1))
    await mount(rows)

    const next = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Next')!
    await act(async () => {
      next.click()
    })

    expect(orderNumbers()).toEqual([`Order #${NEEDS_ATTENTION_PAGE_SIZE + 1}`])
  })
})
