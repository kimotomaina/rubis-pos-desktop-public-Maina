/**
 * Phase 227, the screens: "Cash not counted" on the past-shift form, the Z report window and Shift History; the next
 * offer after a shift is recorded (D2); the cart's "No shift open" notice, store and dialog (D5).
 *
 * Real mounts, as `tests/pastShiftForm.test.ts` does them. The Admin screen's warnings (D3) are in
 * `tests/shiftCaptureAdmin.test.ts`, which stubs the Reports page.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ReportsPage from '../src/renderer/src/pages/ReportsPage.js'
import PastShiftForm from '../src/renderer/src/components/PastShiftForm.js'
import ZReportModal from '../src/renderer/src/components/ZReportModal.js'
import ShiftCorrectionForm from '../src/renderer/src/components/ShiftCorrectionForm.js'
import NoShiftNotice from '../src/renderer/src/components/NoShiftNotice.js'
import OpenShiftDialog from '../src/renderer/src/components/OpenShiftDialog.js'
import { shouldShowNoShiftNotice, useShiftStore } from '../src/renderer/src/stores/shiftStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import type { PastShiftPreview, UnattachedDay } from '../src/main/services/past-shifts.js'
import type { ZReport } from '../src/main/services/reports.js'

vi.mock('../src/renderer/src/components/ManagerPinModal.js', () => ({
  default: ({ onAuthorized }: { onAuthorized: (id: number, pin: string) => void }) =>
    createElement('button', { onClick: () => onAuthorized(2, '1234') }, 'Authorize as manager')
}))

let container: HTMLDivElement
let root: Root

const ok = <T,>(data?: T) => ({ success: true as const, data })

const DAY: UnattachedDay = {
  localDay: '2026-10-03',
  count: 3,
  total: 950,
  firstAt: '2026-10-03T07:00:42.000Z',
  lastAt: '2026-10-03T14:30:10.000Z'
}
const NEXT_DAY: UnattachedDay = {
  localDay: '2026-10-04',
  count: 2,
  total: 400,
  firstAt: '2026-10-04T07:00:00.000Z',
  lastAt: '2026-10-04T09:00:00.000Z'
}

const PREVIEW: PastShiftPreview = {
  startIso: '2026-10-03T07:00:00.000Z',
  endIso: '2026-10-03T14:30:59.999Z',
  sales: [
    { id: 11, createdAt: '2026-10-03T08:00:00.000Z', method: 'cash', total: 500 },
    { id: 12, createdAt: '2026-10-03T09:00:00.000Z', method: 'mpesa', total: 300 },
    { id: 13, createdAt: '2026-10-03T10:00:00.000Z', method: 'card', total: 150 }
  ],
  count: 3,
  total: 950,
  totalsByMethod: { cash: 500, mpesa: 300, card: 150 },
  suggestedShiftType: 'day',
  problem: null
}

function stubApi(overrides: Record<string, unknown> = {}): void {
  window.api = {
    getStaffList: vi.fn().mockResolvedValue(ok([])),
    getShiftsList: vi.fn().mockResolvedValue(ok({ shifts: [], total: 0, page: 1 })),
    getUnattachedDays: vi.fn().mockResolvedValue(ok([DAY])),
    previewPastShift: vi.fn().mockResolvedValue(ok(PREVIEW)),
    createPastShift: vi.fn().mockResolvedValue(ok({ shiftId: 9, attachedCount: 3 })),
    ...overrides
  } as unknown as typeof window.api
}

const flush = async (): Promise<void> => {
  await act(async () => {
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
}

function type(label: string, value: string): void {
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

describe('PastShiftForm: Cash not counted (D4)', () => {
  const mount = async (onRecorded = vi.fn()): Promise<void> => {
    await act(async () => {
      root.render(createElement(PastShiftForm, { day: DAY, onCancel: vi.fn(), onRecorded }))
      await Promise.resolve()
    })
    await flush()
  }
  const toggle = (): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>('[role="checkbox"]') as HTMLButtonElement

  it('is offered here, off to begin with, and the cash fields are the ones they were', async () => {
    stubApi()
    await mount()

    expect(toggle().textContent).toBe('Cash not counted')
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Starting cash"]')!.placeholder).toBe('')
  })

  it('still asks for both cash figures when it is off', async () => {
    stubApi()
    await mount()
    type('Reason', 'Till used without opening a shift')

    await click('Record shift')

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Enter the starting cash and the counted ending cash')
    expect(window.api.createPastShift).not.toHaveBeenCalled()
  })

  it('turns the cash fields off, still asks for a reason, then the PIN, and sends the flag with no figures', async () => {
    stubApi()
    await mount()
    await click('Cash not counted')

    expect(toggle().getAttribute('aria-checked')).toBe('true')
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Starting cash"]')!.placeholder).toBe('Not counted')
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Ending cash (counted)"]')!.placeholder).toBe('Not counted')

    await click('Record shift')
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Say why this shift is being recorded after the fact')
    expect(window.api.createPastShift).not.toHaveBeenCalled()

    type('Reason', 'Nobody counted the drawer that day')
    await click('Record shift')
    expect(window.api.createPastShift).not.toHaveBeenCalled()
    await click('Authorize as manager')

    expect(window.api.createPastShift).toHaveBeenCalledTimes(1)
    const request = vi.mocked(window.api.createPastShift).mock.calls[0][0] as unknown as Record<string, unknown>
    expect(request.cashNotCounted).toBe(true)
    expect('startingCash' in request).toBe(false)
    expect('endingCash' in request).toBe(false)
    expect(request.managerId).toBe(2)
    expect(request.orderIds).toEqual([11, 12, 13])
  })
})

describe('Shift History (D2, D4)', () => {
  const openHistory = async (): Promise<void> => {
    await act(async () => {
      root.render(createElement(ReportsPage))
      await Promise.resolve()
    })
    await click('Shift History')
    await flush()
  }

  it('tags a shift whose cash was not counted, beside "Recorded later"', async () => {
    stubApi({
      getUnattachedDays: vi.fn().mockResolvedValue(ok([])),
      getShiftsList: vi.fn().mockResolvedValue(
        ok({
          shifts: [
            { id: 9, staff_id: 2, clock_in: PREVIEW.startIso, clock_out: PREVIEW.endIso, starting_cash: 0, expected_cash: null, ending_cash: null, discrepancy: null, status: 'closed', kind: 'retrospective', cash_not_counted: 1 },
            { id: 8, staff_id: 2, clock_in: PREVIEW.startIso, clock_out: PREVIEW.endIso, starting_cash: 1, expected_cash: 1, ending_cash: 1, discrepancy: 0, status: 'closed' }
          ],
          total: 2,
          page: 1
        })
      )
    })
    await openHistory()

    expect(container.textContent?.match(/Cash not counted/g)).toHaveLength(1)
    expect(container.textContent).toContain('Recorded later')
  })

  it('after a shift is recorded, offers the next period that still has sales with no shift, and Cancel stops', async () => {
    const getUnattachedDays = vi
      .fn()
      .mockResolvedValueOnce(ok([DAY, NEXT_DAY])) // on opening Shift History
      .mockResolvedValue(ok([NEXT_DAY])) // after the first is recorded
    stubApi({ getUnattachedDays })
    await openHistory()
    await click('Sales with no shift: 5')
    await click('Create shift for these')
    await flush()
    await click('Cash not counted')
    type('Reason', 'Nobody counted')
    await click('Record shift')
    await click('Authorize as manager')
    await flush()

    // Straight into the next offer, with the result above it and its own form (and so its own PIN).
    expect(container.textContent).toContain('Record a shift for 2026-10-04')
    expect(container.textContent).toContain('Shift #9 recorded for 3 sales.')
    expect(container.textContent).toContain('One more period has sales with no shift')

    await click('Cancel')
    expect(container.textContent).not.toContain('Record a shift for')
  })

  it('asks for the PIN again for the next offer: nothing is attached until it is given', async () => {
    const getUnattachedDays = vi.fn().mockResolvedValueOnce(ok([DAY, NEXT_DAY])).mockResolvedValue(ok([NEXT_DAY]))
    stubApi({ getUnattachedDays })
    await openHistory()
    await click('Sales with no shift: 5')
    await click('Create shift for these')
    await flush()
    await click('Cash not counted')
    type('Reason', 'Nobody counted')
    await click('Record shift')
    await click('Authorize as manager')
    await flush()
    expect(window.api.createPastShift).toHaveBeenCalledTimes(1)

    await click('Cash not counted')
    type('Reason', 'Nobody counted either')
    await click('Record shift')

    expect(window.api.createPastShift).toHaveBeenCalledTimes(1)
  })

  it('opens on the first offer at once when it is asked to (Record them)', async () => {
    stubApi()
    await act(async () => {
      root.render(createElement(ReportsPage, { initialAction: 'recordUnattached' }))
      await Promise.resolve()
    })
    await flush()

    expect(container.textContent).toContain('Record a shift for 2026-10-03')
  })

  it('does not open anything on its own when it is not asked to', async () => {
    stubApi()
    await act(async () => {
      root.render(createElement(ReportsPage))
      await Promise.resolve()
    })
    await flush()

    expect(container.textContent).not.toContain('Record a shift for')
  })
})

describe('Z report window (D4, "Opened by")', () => {
  const base: ZReport = {
    shiftId: 9,
    staffName: 'manager mo',
    openedAt: PREVIEW.startIso,
    closedAt: PREVIEW.endIso,
    status: 'closed',
    startingCash: 100,
    totalsByMethod: { cash: 500, mpesa: 300, card: 0 },
    mpesaByMode: { manual: 300, daraja: 0 },
    orderCount: 2,
    totalRevenue: 800,
    vatIncluded: 110,
    vatRate: 0.16,
    expectedCash: 600,
    endingCash: 600,
    discrepancy: 0
  }
  const show = async (report: ZReport): Promise<void> => {
    stubApi({ getZReport: vi.fn().mockResolvedValue(ok(report)) })
    await act(async () => {
      root.render(createElement(ZReportModal, { report, onClose: vi.fn() }))
      await Promise.resolve()
    })
  }

  it('says "Opened by" where it said "Cashier"', async () => {
    await show(base)

    expect(container.textContent).toContain('Opened by: Manager Mo')
    expect(container.textContent).not.toContain('Cashier:')
  })

  it('shows the figures as it always did for a shift whose cash was counted', async () => {
    await show(base)

    expect(container.textContent).toContain('Starting Cash')
    expect(container.textContent).toContain('Expected Cash')
    expect(container.textContent).toContain('Discrepancy')
    expect(container.textContent).not.toContain('Cash not counted')
  })

  it('shows "Cash not counted" with the cash sales, and no starting, expected or counted cash, difference or "Pending"', async () => {
    await show({ ...base, startingCash: 0, expectedCash: 0, endingCash: null, discrepancy: null, cashNotCounted: true, kind: 'retrospective', createdAt: PREVIEW.endIso, createdByName: 'Manager Mo', reason: 'x' })

    expect(container.querySelector('[data-testid="cash-not-counted"]')?.textContent).toContain('Cash not counted')
    expect(container.textContent).toContain('Cash Sales')
    expect(container.textContent).not.toContain('Starting Cash')
    expect(container.textContent).not.toContain('Expected Cash')
    expect(container.textContent).not.toContain('Counted Cash')
    expect(container.textContent).not.toContain('Discrepancy')
    expect(container.textContent).not.toContain('Pending')
  })
})

describe('ShiftCorrectionForm on a shift whose cash was not counted (D4)', () => {
  it('starts with both cash fields blank, not 0', async () => {
    stubApi()
    const report = {
      shiftId: 9,
      staffName: 'm',
      openedAt: PREVIEW.startIso,
      closedAt: PREVIEW.endIso,
      status: 'closed',
      startingCash: 0,
      totalsByMethod: { cash: 500, mpesa: 0, card: 0 },
      mpesaByMode: { manual: 0, daraja: 0 },
      orderCount: 1,
      totalRevenue: 500,
      vatIncluded: 0,
      vatRate: 0.16,
      expectedCash: 0,
      endingCash: null,
      discrepancy: null,
      cashNotCounted: true
    } as unknown as ZReport
    await act(async () => {
      root.render(createElement(ShiftCorrectionForm, { report, onCancel: vi.fn(), onCorrected: vi.fn() }))
      await Promise.resolve()
    })

    const values = Array.from(container.querySelectorAll<HTMLInputElement>('input[readonly]')).map((i) => i.value)
    expect(values.slice(0, 2)).toEqual(['', ''])
  })
})

describe('the cart notice (D5)', () => {
  it('shows only when the till read its shift and found none', () => {
    expect(shouldShowNoShiftNotice('none')).toBe(true)
    expect(shouldShowNoShiftNotice('open')).toBe(false)
    expect(shouldShowNoShiftNotice('unknown')).toBe(false)
  })

  it('is decided by that rule on the cart page', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'), 'utf8')

    expect(source).toContain('{shouldShowNoShiftNotice(shiftPresence) && (')
    expect(source).toMatch(/<NoShiftNotice[\s\S]{0,200}isPaymentInProgress\(paymentActive\)/)
  })

  it('goes between the catalogue badge and the held sales, and the cart drops a line while it shows', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'), 'utf8')

    const badge = source.indexOf('Cached catalog (offline)')
    const notice = source.indexOf('<NoShiftNotice')
    const strip = source.indexOf('<HeldSalesStrip')
    expect(badge).toBeGreaterThan(-1)
    expect(notice).toBeGreaterThan(badge)
    expect(strip).toBeGreaterThan(notice)
    expect(source).toContain('(shouldShowNoShiftNotice(shiftPresence) ? 1 : 0)')
  })

  it('has a button that is off, with the reason, while a payment is in progress, and on otherwise', async () => {
    const open = vi.fn()
    await act(async () => {
      root.render(createElement(NoShiftNotice, { blockedReason: 'Finish or cancel the payment in progress before holding this sale.', onOpenShift: open }))
    })
    const off = container.querySelector<HTMLButtonElement>('button')!
    expect(off.disabled).toBe(true)
    expect(off.title).toContain('payment in progress')
    off.click()
    expect(open).not.toHaveBeenCalled()

    await act(async () => {
      root.render(createElement(NoShiftNotice, { blockedReason: null, onOpenShift: open }))
    })
    const on = container.querySelector<HTMLButtonElement>('button')!
    expect(on.disabled).toBe(false)
    expect(container.textContent).toContain('No shift open')
    on.click()
    expect(open).toHaveBeenCalledTimes(1)
  })
})

describe('the shift store (D5)', () => {
  it('reads open, none and, on a failure, unknown, and logs the failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    window.api = { getCurrentShift: vi.fn().mockResolvedValue(ok({ id: 5 })) } as unknown as typeof window.api
    await useShiftStore.getState().load()
    expect(useShiftStore.getState().presence).toBe('open')

    window.api = { getCurrentShift: vi.fn().mockResolvedValue(ok(null)) } as unknown as typeof window.api
    await useShiftStore.getState().load()
    expect(useShiftStore.getState().presence).toBe('none')
    expect(error).not.toHaveBeenCalled()

    window.api = { getCurrentShift: vi.fn().mockResolvedValue({ success: false, error: 'boom' }) } as unknown as typeof window.api
    await useShiftStore.getState().load()
    expect(useShiftStore.getState().presence).toBe('unknown')
    expect(error).toHaveBeenCalledTimes(1)

    window.api = { getCurrentShift: vi.fn().mockRejectedValue(new Error('down')) } as unknown as typeof window.api
    await useShiftStore.getState().load()
    expect(useShiftStore.getState().presence).toBe('unknown')
    expect(error).toHaveBeenCalledTimes(2)
  })
})

describe('the cart dialog (D5, D3)', () => {
  const NIGHT = 'Night shift (17:31 to 08:59)'
  const DAY_LABEL = 'Day shift (09:00 to 17:30)'
  const mountDialog = async (
    staff: { id: number; role: string },
    extra: Partial<{ requestManagerPin: ReturnType<typeof vi.fn>; onOpened: () => void; onRecordThem: () => void }> = {}
  ): Promise<{ requestManagerPin: ReturnType<typeof vi.fn> }> => {
    const requestManagerPin = extra.requestManagerPin ?? vi.fn()
    await act(async () => {
      root.render(
        createElement(OpenShiftDialog, {
          staff,
          requestManagerPin,
          onClose: vi.fn(),
          onOpened: extra.onOpened ?? vi.fn(),
          onRecordThem: extra.onRecordThem ?? vi.fn()
        })
      )
      await Promise.resolve()
    })
    await flush()
    return { requestManagerPin }
  }
  const checked = (): string | undefined =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((r) => r.getAttribute('aria-checked') === 'true')?.textContent ?? undefined
  const typeCash = (value: string): void => {
    const input = container.querySelector<HTMLInputElement>('input[readonly]')!
    act(() => input.click())
    act(() => useKeyboardStore.getState().request?.onChange(value))
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('suggests the shift from the time: Night at 17:43 Nairobi, Day at 10:30, and either can be changed', async () => {
    stubApi({ getUnattachedDays: vi.fn().mockResolvedValue(ok([])) })
    vi.setSystemTime(new Date('2026-10-05T17:43:00+03:00'))
    await mountDialog({ id: 1, role: 'admin' })
    expect(checked()).toBe(NIGHT)
    await click(DAY_LABEL)
    expect(checked()).toBe(DAY_LABEL)

    act(() => root.unmount())
    root = createRoot(container)
    vi.setSystemTime(new Date('2026-10-05T10:30:00+03:00'))
    await mountDialog({ id: 1, role: 'admin' })
    expect(checked()).toBe(DAY_LABEL)
  })

  it('opens the shift for an admin as themselves, with what was typed, and no PIN', async () => {
    stubApi({ openShift: vi.fn().mockResolvedValue(ok({ shiftId: 6 })), getUnattachedDays: vi.fn().mockResolvedValue(ok([])) })
    vi.setSystemTime(new Date('2026-10-05T17:43:00+03:00'))
    const onOpened = vi.fn()
    const { requestManagerPin } = await mountDialog({ id: 1, role: 'admin' }, { onOpened })
    typeCash('250')

    await click('Confirm')
    await flush()

    expect(window.api.openShift).toHaveBeenCalledWith(1, 250, 'night')
    expect(requestManagerPin).not.toHaveBeenCalled()
    expect(onOpened).toHaveBeenCalledTimes(1)
  })

  it('asks a cashier for a manager PIN, then opens the shift under that manager, and never as the cashier', async () => {
    stubApi({
      openShift: vi.fn(),
      openShiftAsManager: vi.fn().mockResolvedValue(ok({ shiftId: 6 })),
      getUnattachedDays: vi.fn().mockResolvedValue(ok([]))
    })
    vi.setSystemTime(new Date('2026-10-05T17:43:00+03:00'))
    const onOpened = vi.fn()
    const requestManagerPin = vi.fn((_title: string, cb: (id: number, pin: string) => void) => cb(2, '2222'))
    await mountDialog({ id: 3, role: 'cashier' }, { requestManagerPin, onOpened })
    typeCash('250')

    await click('Confirm')
    await flush()

    expect(requestManagerPin).toHaveBeenCalledTimes(1)
    expect(window.api.openShiftAsManager).toHaveBeenCalledWith(2, '2222', 250, 'night', undefined)
    expect(window.api.openShift).not.toHaveBeenCalled()
    expect(onOpened).toHaveBeenCalledTimes(1)
  })

  it('opens nothing while the manager PIN has not been given', async () => {
    stubApi({ openShift: vi.fn(), openShiftAsManager: vi.fn(), getUnattachedDays: vi.fn().mockResolvedValue(ok([])) })
    await mountDialog({ id: 3, role: 'cashier' })
    typeCash('250')

    await click('Confirm')

    expect(window.api.openShift).not.toHaveBeenCalled()
    expect(window.api.openShiftAsManager).not.toHaveBeenCalled()
  })

  it('refuses a missing or invalid starting cash, and says so', async () => {
    stubApi({ openShift: vi.fn(), getUnattachedDays: vi.fn().mockResolvedValue(ok([])) })
    await mountDialog({ id: 1, role: 'admin' })

    await click('Confirm')

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Enter a valid starting cash amount')
    expect(window.api.openShift).not.toHaveBeenCalled()
  })

  it('shows the refusal the main process gave', async () => {
    stubApi({ openShift: vi.fn().mockResolvedValue({ success: false, error: 'A shift is already open' }), getUnattachedDays: vi.fn().mockResolvedValue(ok([])) })
    const onOpened = vi.fn()
    await mountDialog({ id: 1, role: 'admin' }, { onOpened })
    typeCash('250')

    await click('Confirm')
    await flush()

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('A shift is already open')
    expect(onOpened).not.toHaveBeenCalled()
  })

  it('tells an admin how many sales have no shift, with a Record them button that hands over', async () => {
    stubApi({ getUnattachedDays: vi.fn().mockResolvedValue(ok([DAY, NEXT_DAY])) })
    const onRecordThem = vi.fn()
    await mountDialog({ id: 1, role: 'admin' }, { onRecordThem })

    expect(container.querySelector('[data-testid="dialog-no-shift-sales"]')?.textContent).toContain('5 sales have no shift.')
    await click('Record them')
    expect(onRecordThem).toHaveBeenCalledTimes(1)
  })

  it('tells a cashier the same, in words only: no button', async () => {
    stubApi({ getUnattachedDays: vi.fn().mockResolvedValue(ok([DAY, NEXT_DAY])) })
    await mountDialog({ id: 3, role: 'cashier' })

    const line = container.querySelector('[data-testid="dialog-no-shift-sales"]')!
    expect(line.textContent).toContain('5 sales have no shift.')
    expect(line.textContent).toContain('A manager can record these in Shift History.')
    expect(line.querySelector('button')).toBeNull()
  })

  it('says nothing about it when every sale has a shift', async () => {
    stubApi({ getUnattachedDays: vi.fn().mockResolvedValue(ok([])) })
    await mountDialog({ id: 1, role: 'admin' })

    expect(container.querySelector('[data-testid="dialog-no-shift-sales"]')).toBeNull()
  })
})

describe('selling with no shift open is not refused', () => {
  it('leaves checkout alone: the shift is read, not required', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'services', 'checkout.ts'), 'utf8')

    expect(source).toContain('const openShift = db.getOpenShift()')
    expect(source).toContain('shiftId: openShift?.id')
  })
})
