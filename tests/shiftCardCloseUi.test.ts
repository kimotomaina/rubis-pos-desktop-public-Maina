/**
 * The card settlement on the screens (docs/phase-246, R5): the Z report window shows the three card lines, and the
 * correction form takes the figure. Layout: not checked by check:fit (owner's rule). For the owner to check on the till.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ZReportModal from '../src/renderer/src/components/ZReportModal.js'
import ShiftCorrectionForm from '../src/renderer/src/components/ShiftCorrectionForm.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import type { ZReport } from '../src/main/services/reports.js'

vi.mock('../src/renderer/src/components/ManagerPinModal.js', () => ({
  default: ({ onAuthorized }: { onAuthorized: (id: number, pin: string) => void }) =>
    createElement('button', { onClick: () => onAuthorized(2, '1234') }, 'Authorize as admin')
}))

let container: HTMLDivElement
let root: Root

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

const render = async (element: ReturnType<typeof createElement>): Promise<void> => {
  await act(async () => {
    root.render(element)
    await Promise.resolve()
    await Promise.resolve()
  })
}
const plain = (text: string | null | undefined): string => (text ?? '').replace(/ /g, ' ')
const button = (label: string): HTMLButtonElement | undefined => Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)

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

describe('the Z report window', () => {
  it('shows the three card lines, "Not recorded" for a shift nobody counted card for', async () => {
    window.api = {} as unknown as typeof window.api
    await render(createElement(ZReportModal, { report: report(), onClose: vi.fn() }))

    const text = plain(container.textContent)

    expect(text).toContain('Card expected')
    expect(text).toMatch(/Card expected\s*Not recorded/)
    expect(text).toMatch(/Card counted\s*Not recorded/)
    expect(text).toMatch(/Check against the PDQ settlement\s*Not recorded/)
  })

  it('shows what was counted and the difference when it was', async () => {
    window.api = {} as unknown as typeof window.api
    await render(createElement(ZReportModal, { report: report({ cardClosingBalance: 250, cardExpected: 280, cardDifference: -30 }), onClose: vi.fn() }))

    const text = plain(container.textContent)

    expect(text).toMatch(/Card expected\s*Ksh 280\.00/)
    expect(text).toMatch(/Card counted\s*Ksh 250\.00/)
    expect(text).toMatch(/Check against the PDQ settlement\s*-Ksh 30\.00/)
  })
})

describe('the correction form', () => {
  const mount = async (shown: ZReport, correctShift = vi.fn().mockResolvedValue({ success: true, data: {} })): Promise<ReturnType<typeof vi.fn>> => {
    window.api = { correctShift } as unknown as typeof window.api
    await render(createElement(ShiftCorrectionForm, { report: shown, onCancel: vi.fn(), onCorrected: vi.fn() }))
    return correctShift
  }
  const submit = async (): Promise<void> => {
    await act(async () => {
      button('Record correction')!.click()
      await Promise.resolve()
    })
    await act(async () => {
      button('Authorize as admin')!.click()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('has the card field, empty and "Not recorded" for a shift without one, and sends nothing about card when it stays blank', async () => {
    const correctShift = await mount(report())
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Card settlement at end (optional)"]')!
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('Not recorded')

    typeInto('Ending cash (counted)', '3800')
    typeInto('Reason', 'Recount')
    await submit()

    expect(Object.keys(correctShift.mock.calls[0][0])).not.toContain('cardClosingBalance')
  })

  it('starts from the shift\'s card figure and the latest correction\'s, and sends a typed figure, 0 included', async () => {
    const withCard = report({ cardClosingBalance: 250, cardExpected: 280, cardDifference: -30 })
    const correctShift = await mount(withCard)
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Card settlement at end (optional)"]')!.value).toBe('250')

    typeInto('Card settlement at end (optional)', '0')
    typeInto('Reason', 'The slip said 0')
    await submit()

    expect(correctShift.mock.calls[0][0]).toMatchObject({ shiftId: 3, cardClosingBalance: 0, reason: 'The slip said 0' })
  })

  it('refuses a bad figure before the PIN, and says so', async () => {
    const correctShift = await mount(report())

    typeInto('Card settlement at end (optional)', 'abc')
    typeInto('Reason', 'Recount')
    await act(async () => {
      button('Record correction')!.click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Enter a valid card settlement amount, or leave it blank')
    expect(button('Authorize as admin')).toBeUndefined()
    expect(correctShift).not.toHaveBeenCalled()
  })
})
