/**
 * Shift History on screen (docs/phase-245): it opens on page 1, shows ten shifts a page with Previous / Next and
 * "Page X of Y", and its rows scroll in their own area while the title, Move a sale and the pager stay outside it (the
 * End of Day pattern). jsdom has no layout, so the scroll area is pinned by its structure and classes. Layout: not
 * checked by check:fit (owner's rule). For the owner to check on the till.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ReportsPage from '../src/renderer/src/pages/ReportsPage.js'
import type { ShiftRow } from '../src/main/services/database.js'

let container: HTMLDivElement
let root: Root

const ok = <T,>(data?: T) => ({ success: true as const, data })

const shiftRow = (id: number): ShiftRow => ({
  id,
  staff_id: 2,
  clock_in: new Date(Date.UTC(2026, 8, 1, 5, 0, 0) + id * 86_400_000).toISOString(),
  clock_out: new Date(Date.UTC(2026, 8, 1, 14, 0, 0) + id * 86_400_000).toISOString(),
  starting_cash: 0,
  expected_cash: 0,
  ending_cash: 0,
  discrepancy: 0,
  status: 'closed',
  shift_type: 'day'
})

/** What the main process returns: shifts newest first, one page at a time, and the total. */
function stubApi(total: number, pageSize = 10): ReturnType<typeof vi.fn> {
  const getShiftsList = vi.fn().mockImplementation((page: number) => {
    const ids = Array.from({ length: total }, (_, index) => total - index)
    return Promise.resolve(ok({ shifts: ids.slice((page - 1) * pageSize, page * pageSize).map(shiftRow), total, page }))
  })
  window.api = {
    getStaffList: vi.fn().mockResolvedValue(ok([{ id: 2, name: 'manager mo', role: 'admin' }])),
    getShiftsList,
    autoAssignSales: vi.fn().mockResolvedValue(ok({ touched: [], waiting: 0 })),
    getZReport: vi.fn().mockResolvedValue(ok(undefined))
  } as unknown as typeof window.api
  return getShiftsList
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(label: string): Promise<void> {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!el) throw new Error(`No button "${label}"`)
  await act(async () => {
    el.click()
    await Promise.resolve()
  })
  await flush()
}

const button = (label: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
const scroller = (): HTMLElement => container.querySelector<HTMLElement>('[data-testid="shift-history-scroll"]') as HTMLElement
// The first cell starts "#" then the id, as two text nodes.
const rowIds = (): string[] => Array.from(scroller().querySelectorAll('tbody tr')).map((row) => row.querySelector('td')?.childNodes[1]?.textContent ?? '')

async function openHistory(total: number, pageSize?: number): Promise<ReturnType<typeof vi.fn>> {
  const getShiftsList = stubApi(total, pageSize)
  await act(async () => {
    root.render(createElement(ReportsPage))
    await Promise.resolve()
  })
  await click('Shift History')
  return getShiftsList
}

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

describe('Shift History pages', () => {
  it('opens on page 1 with ten shifts, newest first, and asks for that one page only', async () => {
    const getShiftsList = await openHistory(25)

    expect(getShiftsList).toHaveBeenCalledTimes(1)
    expect(getShiftsList).toHaveBeenCalledWith(1)
    expect(container.textContent).toContain('Page 1 of 3')
    expect(rowIds()).toEqual(['25', '24', '23', '22', '21', '20', '19', '18', '17', '16'])
  })

  it('goes forward and back a page at a time, and disables Previous on the first page and Next on the last', async () => {
    const getShiftsList = await openHistory(25)
    expect(button('Previous')!.disabled).toBe(true)

    await click('Next')
    expect(getShiftsList).toHaveBeenLastCalledWith(2)
    expect(container.textContent).toContain('Page 2 of 3')
    expect(rowIds()).toHaveLength(10)

    await click('Next')
    expect(container.textContent).toContain('Page 3 of 3')
    expect(rowIds()).toEqual(['5', '4', '3', '2', '1'])
    expect(button('Next')!.disabled).toBe(true)

    await click('Previous')
    expect(getShiftsList).toHaveBeenLastCalledWith(2)
    expect(container.textContent).toContain('Page 2 of 3')
    for (const call of getShiftsList.mock.calls) expect(call).toHaveLength(1)
  })

  it('opens on page 1 again when it is left and opened again', async () => {
    const getShiftsList = await openHistory(25)
    await click('Next')
    expect(container.textContent).toContain('Page 2 of 3')

    await click('Back to Reports')
    await click('Shift History')

    expect(getShiftsList).toHaveBeenLastCalledWith(1)
    expect(container.textContent).toContain('Page 1 of 3')
  })

  it('shows no pager for a single page', async () => {
    await openHistory(7)

    expect(rowIds()).toHaveLength(7)
    expect(button('Next')).toBeUndefined()
  })
})

describe('Shift History scroll area', () => {
  it('holds the rows and nothing else: the title, Move a sale and the pager sit outside it and stay fixed', async () => {
    await openHistory(25)
    const scroll = scroller()
    const section = scroll.parentElement as HTMLElement

    expect(scroll.querySelectorAll('tbody tr')).toHaveLength(10)
    for (const label of ['Move a sale', 'Previous', 'Next']) {
      expect(scroll.contains(button(label)!)).toBe(false)
      expect(section.contains(button(label)!)).toBe(true)
    }
    expect(scroll.contains(Array.from(container.querySelectorAll('h3')).find((h) => h.textContent === 'Shift History')!)).toBe(false)
    expect(scroll.textContent).not.toContain('Page 1 of 3')
  })

  it('scrolls on its own, with a visible scroll bar, inside a column that fills the height it is given', async () => {
    await openHistory(25)
    const scroll = scroller()
    const section = scroll.parentElement as HTMLElement

    expect(scroll.className).toEqual(expect.stringContaining('touch-scrollbar'))
    expect(scroll.className).toEqual(expect.stringContaining('overflow-auto'))
    expect(scroll.className).toEqual(expect.stringContaining('min-h-0'))
    expect(scroll.className).toEqual(expect.stringContaining('flex-1'))
    expect(section.className).toEqual(expect.stringContaining('flex min-h-0 flex-1 flex-col'))
    expect((section.parentElement as HTMLElement).className).toEqual(expect.stringContaining('flex min-h-0 flex-1 flex-col'))
  })

  it('keeps the buttons in the document and outside the scroll area when 200 rows are rendered', async () => {
    const getShiftsList = await openHistory(200, 200)

    expect(getShiftsList).toHaveBeenCalledTimes(1)
    expect(scroller().querySelectorAll('tbody tr')).toHaveLength(200)
    for (const label of ['Move a sale', 'Previous', 'Next']) {
      const el = button(label)!
      expect(document.body.contains(el)).toBe(true)
      expect(scroller().contains(el)).toBe(false)
    }
  })

  it('has the Admin screen give the Reports tab a column to fill, as End of Day has', () => {
    const admin = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'components', 'AdminScreen.tsx'), 'utf8')

    expect(admin).toContain("activeTab === 'endOfDay' || activeTab === 'reports' ? ' flex flex-col'")
  })
})
