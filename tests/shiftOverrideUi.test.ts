/**
 * The screens of the admin override (docs/phase-244): Move a sale and Correct figures show the refusal as before, and
 * an admin's tick ("Override: this shift is closed and not the latest") is what lets Confirm go on to the PIN. The main
 * process re-checks everything; these tests only pin what the screens send. Layout: not checked by check:fit (owner's
 * rule). For the owner to check on the till.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import MoveSaleForm from '../src/renderer/src/components/MoveSaleForm.js'
import ShiftCorrectionForm from '../src/renderer/src/components/ShiftCorrectionForm.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import type { ZReport } from '../src/main/services/reports.js'
import type { SaleMovePreview } from '../src/main/services/database.js'

vi.mock('../src/renderer/src/components/ManagerPinModal.js', () => ({
  default: ({ onAuthorized }: { onAuthorized: (id: number, pin: string) => void }) =>
    createElement('button', { onClick: () => onAuthorized(2, '1234') }, 'Authorize as admin')
}))

let container: HTMLDivElement
let root: Root

const ok = <T,>(data?: T) => ({ success: true as const, data })
const TICK = 'Override: this shift is closed and not the latest'

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(label: string): Promise<void> {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label || b.textContent?.startsWith(label))
  if (!el) throw new Error(`No button "${label}"`)
  await act(async () => {
    el.click()
    await Promise.resolve()
  })
}

function typeInto(label: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  if (!input) throw new Error(`No field "${label}"`)
  act(() => input.click())
  act(() => useKeyboardStore.getState().request?.onChange(value))
}

const tick = (): HTMLInputElement | null => {
  const label = Array.from(container.querySelectorAll('label')).find((l) => l.textContent?.includes(TICK))
  return label?.querySelector('input[type="checkbox"]') ?? null
}

async function clickTick(): Promise<void> {
  await act(async () => {
    tick()!.click()
    await Promise.resolve()
    await Promise.resolve()
  })
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

describe('Move a sale, with a closed shift in the way', () => {
  const REFUSED: SaleMovePreview = {
    orderId: 85,
    total: 60,
    paymentMethod: 'mpesa',
    createdAt: '2026-10-05T14:34:57.000Z',
    fromShiftId: 1,
    toShiftId: 3,
    differentWindow: false,
    from: null,
    to: null,
    problem: 'Shift #1 is closed. A sale cannot be taken out of a closed shift.',
    overridable: true,
    overridden: false
  }
  const LIFTED: SaleMovePreview = {
    ...REFUSED,
    differentWindow: true,
    from: { expectedCash: 10, discrepancy: 1, mpesaExpected: null, mpesaDifference: null },
    to: { expectedCash: 20, discrepancy: 2, mpesaExpected: null, mpesaDifference: null },
    problem: null,
    overridable: false,
    overridden: true
  }
  const mount = async (previewSaleMove: ReturnType<typeof vi.fn>, moveSale = vi.fn()): Promise<ReturnType<typeof vi.fn>> => {
    window.api = { previewSaleMove, moveSale } as unknown as typeof window.api
    const onMoved = vi.fn()
    await act(async () => {
      root.render(createElement(MoveSaleForm, { onCancel: vi.fn(), onMoved }))
      await Promise.resolve()
    })
    typeInto('Order number', '85')
    typeInto('Shift number', '3')
    await click('Check')
    await flush()
    return onMoved
  }

  it('shows the refusal as today plus the tick, and offers no move until it is ticked', async () => {
    const moveSale = vi.fn()
    await mount(vi.fn().mockResolvedValue(ok(REFUSED)), moveSale)
    typeInto('Reason', 'Belongs to the day shift of 5 Oct')

    expect(container.textContent).toContain('Shift #1 is closed. A sale cannot be taken out of a closed shift.')
    expect(tick()).not.toBeNull()
    expect(tick()!.checked).toBe(false)
    await click('Move sale')
    expect(container.textContent).not.toContain('Authorize as admin')
    expect(moveSale).not.toHaveBeenCalled()
  })

  it('asks the main process for the preview with the rules lifted when ticked, then sends override with the PIN', async () => {
    const previewSaleMove = vi.fn().mockImplementation((_o: number, _s: number, override?: boolean) => Promise.resolve(ok(override ? LIFTED : REFUSED)))
    const moveSale = vi.fn().mockResolvedValue(ok({ fromShiftId: 1, toShiftId: 3 }))
    const onMoved = await mount(previewSaleMove, moveSale)

    await clickTick()

    expect(previewSaleMove).toHaveBeenLastCalledWith(85, 3, true)
    expect(container.querySelector('[data-testid="move-preview"]')).not.toBeNull()
    expect(container.textContent).not.toContain('A sale cannot be taken out of a closed shift')
    typeInto('Reason', 'Belongs to the day shift of 5 Oct')
    await act(async () => {
      container.querySelector<HTMLInputElement>('[data-testid="move-preview"] input[type="checkbox"]')!.click()
      await Promise.resolve()
    })
    await click('Move sale')
    await click('Authorize as admin')
    await flush()

    expect(moveSale).toHaveBeenCalledWith({
      managerId: 2,
      managerPin: '1234',
      orderId: 85,
      toShiftId: 3,
      reason: 'Belongs to the day shift of 5 Oct',
      acknowledgeDifferentWindow: true,
      override: true
    })
    expect(onMoved).toHaveBeenCalledWith('Order #85 moved from shift #1 to shift #3.')
  })

  it('goes back to the refusal when the tick is removed', async () => {
    const previewSaleMove = vi.fn().mockImplementation((_o: number, _s: number, override?: boolean) => Promise.resolve(ok(override ? LIFTED : REFUSED)))
    await mount(previewSaleMove)
    await clickTick()

    await clickTick()

    expect(container.textContent).toContain('Shift #1 is closed')
    expect(tick()!.checked).toBe(false)
  })

  it('shows no tick for an ordinary move or a refusal an override cannot lift', async () => {
    await mount(vi.fn().mockResolvedValue(ok({ ...REFUSED, problem: 'Order #85 was voided', overridable: false })))

    expect(container.textContent).toContain('Order #85 was voided')
    expect(tick()).toBeNull()
  })
})

describe('Correct figures, on a shift that is closed and not the latest', () => {
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
  const FROZEN = 'Shift #3 is closed and is not the latest closed shift (#1). Only the latest closed shift can be corrected or be given sales.'
  const mount = async (shown: ZReport, correctShift = vi.fn()): Promise<ReturnType<typeof vi.fn>> => {
    window.api = { correctShift } as unknown as typeof window.api
    await act(async () => {
      root.render(createElement(ShiftCorrectionForm, { report: shown, onCancel: vi.fn(), onCorrected: vi.fn() }))
      await Promise.resolve()
    })
    return correctShift
  }

  it('shows why, offers the tick, and will not go on to the PIN without it', async () => {
    const correctShift = await mount(report({ frozen: true, frozenMessage: FROZEN }))
    typeInto('Reason', 'Counted figures of the day shift')

    expect(container.textContent).toContain(FROZEN)
    expect(tick()!.checked).toBe(false)
    const record = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Record correction')!
    expect(record.disabled).toBe(true)
    expect(container.textContent).not.toContain('Authorize as admin')
    expect(correctShift).not.toHaveBeenCalled()
  })

  it('sends override with the correction once ticked and the PIN is given', async () => {
    const correctShift = await mount(report({ frozen: true, frozenMessage: FROZEN }), vi.fn().mockResolvedValue(ok({})))
    typeInto('Ending cash (counted)', '3790')
    typeInto('M-Pesa balance at start (optional)', '0')
    typeInto('M-Pesa balance at end (optional)', '19180.09')
    typeInto('Reason', 'Counted figures of the day shift')

    await clickTick()
    await click('Record correction')
    await click('Authorize as admin')
    await flush()

    expect(correctShift).toHaveBeenCalledWith({
      managerId: 2,
      managerPin: '1234',
      shiftId: 3,
      startingCash: 0,
      endingCash: 3790,
      mpesaOpeningBalance: 0,
      mpesaClosingBalance: 19180.09,
      reason: 'Counted figures of the day shift',
      override: true
    })
  })

  it('shows no tick and sends no override on the latest closed shift', async () => {
    const correctShift = await mount(report(), vi.fn().mockResolvedValue(ok({})))
    typeInto('Ending cash (counted)', '3800')
    typeInto('Reason', 'Recount')

    expect(tick()).toBeNull()
    await click('Record correction')
    await click('Authorize as admin')
    await flush()

    expect(Object.keys(correctShift.mock.calls[0][0])).not.toContain('override')
  })
})
