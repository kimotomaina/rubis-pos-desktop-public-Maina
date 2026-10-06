/**
 * The shared modal shell (docs/phase-246, R1): every window on the Reports page is usable at any length. The body
 * scrolls; the header and the bottom buttons stay in view. jsdom has no layout, so this pins the structure: which
 * parts are inside the scrolling body and which are outside it, and the classes that make the body scroll. Layout: not
 * checked by check:fit (owner's rule). For the owner to check on the till.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ModalShell, { ShellPanel } from '../src/renderer/src/components/ModalShell.js'
import ZReportModal from '../src/renderer/src/components/ZReportModal.js'
import WindowReportModal from '../src/renderer/src/components/WindowReportModal.js'
import ShiftCorrectionForm from '../src/renderer/src/components/ShiftCorrectionForm.js'
import MoveSaleForm from '../src/renderer/src/components/MoveSaleForm.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import type { ZReport } from '../src/main/services/reports.js'

vi.mock('../src/renderer/src/components/ManagerPinModal.js', () => ({
  default: ({ onAuthorized }: { onAuthorized: (id: number, pin: string) => void }) =>
    createElement('button', { onClick: () => onAuthorized(2, '1234') }, 'Authorize as admin')
}))

let container: HTMLDivElement
let root: Root

const render = async (element: ReturnType<typeof createElement>): Promise<void> => {
  await act(async () => {
    root.render(element)
    await Promise.resolve()
    await Promise.resolve()
  })
}
const body = (): HTMLElement => container.querySelector('[data-testid="shell-body"]') as HTMLElement
const footer = (): HTMLElement | null => container.querySelector('[data-testid="shell-footer"]')
const button = (label: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)

const report = (extra: Partial<ZReport> = {}): ZReport => ({
  shiftId: 3,
  staffName: 'admin',
  openedAt: '2026-10-05T06:14:00.000Z',
  closedAt: '2026-10-05T14:30:59.000Z',
  status: 'closed',
  startingCash: 0,
  totalsByMethod: { cash: 3790, mpesa: 19120.09, card: 280 },
  mpesaByMode: { manual: 19120.09, daraja: 0 },
  orderCount: 41,
  totalRevenue: 23190.09,
  vatIncluded: 0,
  vatRate: 0.16,
  expectedCash: 3790,
  endingCash: 3790,
  discrepancy: 0,
  ...extra
})

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

describe('the shell', () => {
  it('scrolls its body, keeps the header and the footer outside it, and is never taller than the screen', async () => {
    await render(createElement(ModalShell, { title: 'A long report', onClose: vi.fn(), footer: createElement('button', null, 'Print'), children: createElement('p', null, 'row') }))

    const dialog = container.querySelector('[role="dialog"]') as HTMLElement
    const box = dialog.firstElementChild as HTMLElement
    expect(body().className).toEqual(expect.stringContaining('overflow-y-auto'))
    expect(body().className).toEqual(expect.stringContaining('min-h-0'))
    expect(body().className).toEqual(expect.stringContaining('flex-1'))
    expect(body().className).toEqual(expect.stringContaining('touch-scrollbar'))
    expect(box.className).toEqual(expect.stringContaining('max-h-full'))
    expect(box.className).toEqual(expect.stringContaining('flex-col'))
    const heading = Array.from(container.querySelectorAll('h3')).find((h) => h.textContent === 'A long report')!
    expect(body().contains(heading)).toBe(false)
    expect(body().contains(button('Print')!)).toBe(false)
    expect(footer()!.contains(button('Print')!)).toBe(true)
    expect(Array.from(box.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid'))).toEqual(['shell-body', 'shell-footer'])
  })

  it('has the header and the footer shrink for nothing, so only the body gives way', async () => {
    await render(createElement(ShellPanel, { title: 'Panel', footer: createElement('span', null, 'foot'), children: createElement('p', null, 'x') }))

    const panel = container.firstElementChild as HTMLElement
    expect((panel.children[0] as HTMLElement).className).toEqual(expect.stringContaining('shrink-0'))
    expect(footer()!.className).toEqual(expect.stringContaining('shrink-0'))
  })

  it('has the one scroll class of the four windows, in the shell and nowhere else', () => {
    const read = (name: string): string => readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'components', name), 'utf8')

    expect(read('ModalShell.tsx').match(/overflow-y-auto/g)).toHaveLength(1)
    for (const name of ['ZReportModal.tsx', 'WindowReportModal.tsx', 'ShiftCorrectionForm.tsx', 'MoveSaleForm.tsx']) {
      expect(read(name)).not.toMatch(/overflow-(y-)?(auto|scroll)/)
      expect(read(name)).toMatch(/ModalShell|ShellPanel/)
    }
  })
})

describe('the four windows on the shell', () => {
  it('Z report: a report as long as the till can make keeps Print and Correct figures in the footer', async () => {
    window.api = {} as unknown as typeof window.api
    const long = report({
      adjustments: Array.from({ length: 12 }, (_, id) => ({
        id: id + 1,
        kind: 'reassign_in' as const,
        at: '2026-10-06T10:00:00.000Z',
        byName: 'Admin',
        reason: 'Merged shift #2 into shift #1: same',
        peerShiftId: 2,
        salesCount: 1,
        salesTotal: 60,
        cashTotal: 0,
        mpesaTotal: 60,
        cardTotal: 0,
        firstSaleAt: null,
        lastSaleAt: null,
        openingDrawerCash: null,
        startingCash: 0,
        endingCash: 3790,
        expectedCash: 3790,
        discrepancy: 0,
        mpesaOpeningBalance: null,
        mpesaClosingBalance: null,
        mpesaExpected: null,
        mpesaDifference: null
      }))
    })

    await render(createElement(ZReportModal, { report: long, onClose: vi.fn() }))

    expect(body().textContent).toContain('Shift #3')
    for (const label of ['Print Z-Report', 'Correct figures']) {
      expect(body().contains(button(label)!)).toBe(false)
      expect(footer()!.contains(button(label)!)).toBe(true)
    }
  })

  it('Z report: the print message is in the footer too, so it is never scrolled away', async () => {
    window.api = { printZReport: vi.fn().mockResolvedValue({ success: true, data: { mock: true } }) } as unknown as typeof window.api
    await render(createElement(ZReportModal, { report: report(), onClose: vi.fn() }))

    await act(async () => {
      button('Print Z-Report')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(footer()!.textContent).toContain('Z-report printed (mock mode)')
    expect(body().textContent).not.toContain('Z-report printed (mock mode)')
  })

  it('Window report: the title and Close are in the header, the table in the scrolling body', async () => {
    window.api = {
      getWindowReport: vi.fn().mockResolvedValue({
        success: true,
        data: {
          window: { name: 'Night shift, 5 Oct 2026' },
          shifts: [],
          totals: { orderCount: 0, totalRevenue: 0, byMethod: { cash: 0, mpesa: 0, card: 0 }, differenceSum: 0, notCountedShifts: 0 }
        }
      })
    } as unknown as typeof window.api

    await render(createElement(WindowReportModal, { type: 'night', startDate: '2026-10-05', onClose: vi.fn(), onOpenShift: vi.fn() }))

    const dialog = container.querySelector('[role="dialog"][aria-label="Window report"]') as HTMLElement
    expect(dialog).not.toBeNull()
    expect(body().textContent).toContain('Whole window')
    expect(body().contains(container.querySelector('[aria-label="Close"]'))).toBe(false)
    expect(Array.from(container.querySelectorAll('h3')).some((h) => h.textContent === 'Night shift, 5 Oct 2026')).toBe(true)
  })

  it('Correction form: Cancel, Record and the error are in the footer; the fields are in the body', async () => {
    window.api = { correctShift: vi.fn() } as unknown as typeof window.api
    await render(createElement(ShiftCorrectionForm, { report: report(), onCancel: vi.fn(), onCorrected: vi.fn() }))

    await act(async () => {
      button('Record correction')!.click()
      await Promise.resolve()
    })

    for (const label of ['Cancel', 'Record correction']) {
      expect(body().contains(button(label)!)).toBe(false)
      expect(footer()!.contains(button(label)!)).toBe(true)
    }
    expect(body().querySelector('input[aria-label="Ending cash (counted)"]')).not.toBeNull()
    expect(footer()!.querySelector('[role="alert"]')?.textContent).toBe('Say why the figures are being corrected')
  })

  it('Move a sale: Cancel is in the header, Move sale and the error in the footer, the fields in the body', async () => {
    window.api = { previewSaleMove: vi.fn(), moveSale: vi.fn() } as unknown as typeof window.api
    await render(createElement('section', { className: 'flex min-h-0 flex-1 flex-col' }, createElement(MoveSaleForm, { onCancel: vi.fn(), onMoved: vi.fn() })))

    await act(async () => {
      button('Move sale')!.click()
      await Promise.resolve()
    })

    expect(body().contains(button('Move sale')!)).toBe(false)
    expect(footer()!.contains(button('Move sale')!)).toBe(true)
    expect(body().contains(button('Cancel')!)).toBe(false)
    expect(footer()!.contains(button('Cancel')!)).toBe(false)
    expect(body().querySelector('input[aria-label="Order number"]')).not.toBeNull()
    expect(footer()!.querySelector('[role="alert"]')?.textContent).toBe('Check the move first')
  })
})
