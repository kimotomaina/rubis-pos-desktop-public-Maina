/**
 * Phase 227, the screens: the Z report window and Shift History, the cart's "No shift open" notice, store and dialog.
 *
 * CHANGED (docs/phase-232). OLD: this file also tested `PastShiftForm` (Cash not counted, D4), the next offer after a
 * shift was recorded (D2) and the "Record them" hand-over, and the dialog's "N sales have no shift" line. NEW: the
 * manual past-shift flow is retired (the till gives every sale to its shift by itself), so those are removed. The
 * dialog now shows the window instead of offering a choice, and says how many earlier sales will join the shift
 * (docs/phase-232, S6); see the dialog tests below. The Z report, correction form, notice and store tests are unchanged.
 *
 * Real mounts, as `tests/adminShiftWindows.test.ts` does them.
 *
 * CHANGED (docs/phase-237). OLD: Day began at 09:00 and Night ended at 08:59 (docs/phase-199 D1). NEW: Day begins at
 * 07:00 and Night ends at 06:59, the owner's correction; the rule, the labels and the boundary seconds move with it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ReportsPage from '../src/renderer/src/pages/ReportsPage.js'
import ZReportModal from '../src/renderer/src/components/ZReportModal.js'
import ShiftCorrectionForm from '../src/renderer/src/components/ShiftCorrectionForm.js'
import NoShiftNotice from '../src/renderer/src/components/NoShiftNotice.js'
import OpenShiftDialog from '../src/renderer/src/components/OpenShiftDialog.js'
import { shouldShowNoShiftNotice, useShiftStore } from '../src/renderer/src/stores/shiftStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import { getShiftWindowStatus } from '../src/main/services/shift-window-status.js'
import type { ZReport } from '../src/main/services/reports.js'

vi.mock('../src/renderer/src/components/ManagerPinModal.js', () => ({
  default: ({ onAuthorized }: { onAuthorized: (id: number, pin: string) => void }) =>
    createElement('button', { onClick: () => onAuthorized(2, '1234') }, 'Authorize as manager')
}))

let container: HTMLDivElement
let root: Root

const ok = <T,>(data?: T) => ({ success: true as const, data })

const PERIOD_START = '2026-10-03T07:00:00.000Z'
const PERIOD_END = '2026-10-03T14:59:59.999Z'

/** The window status the main process would give, run for real at the system time over the sales given. */
function windowStatus(sales: Array<{ total: number; method: 'cash' | 'mpesa' }> = []): unknown {
  return getShiftWindowStatus(
    {
      getOpenShift: () => undefined,
      listShiftWindows: () => [],
      listUnattachedSales: () =>
        sales.map((sale, index) => ({
          local_id: index + 1,
          created_at: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
          total: sale.total,
          payment_method: sale.method
        })),
      listAbsorbedShiftIds: () => [] // ADDED (docs/phase-242)
    },
    Date.now()
  )
}

function stubApi(overrides: Record<string, unknown> = {}): void {
  window.api = {
    getStaffList: vi.fn().mockResolvedValue(ok([])),
    getShiftsList: vi.fn().mockResolvedValue(ok({ shifts: [], total: 0, page: 1 })),
    autoAssignSales: vi.fn().mockResolvedValue(ok({ touched: [], waiting: 0 })),
    getShiftWindowStatus: vi.fn().mockImplementation(async () => ok(windowStatus())),
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

describe('Shift History (D4)', () => {
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
      getShiftsList: vi.fn().mockResolvedValue(
        ok({
          shifts: [
            { id: 9, staff_id: 2, clock_in: PERIOD_START, clock_out: PERIOD_END, starting_cash: 0, expected_cash: null, ending_cash: null, discrepancy: null, status: 'closed', kind: 'retrospective', cash_not_counted: 1 },
            { id: 8, staff_id: 2, clock_in: PERIOD_START, clock_out: PERIOD_END, starting_cash: 1, expected_cash: 1, ending_cash: 1, discrepancy: 0, status: 'closed' }
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
})

describe('Z report window (D4, "Opened by")', () => {
  const base: ZReport = {
    shiftId: 9,
    staffName: 'manager mo',
    openedAt: PERIOD_START,
    closedAt: PERIOD_END,
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
    await show({ ...base, startingCash: 0, expectedCash: 0, endingCash: null, discrepancy: null, cashNotCounted: true, kind: 'retrospective', createdAt: PERIOD_END, createdByName: 'Manager Mo', reason: 'x' })

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
      openedAt: PERIOD_START,
      closedAt: PERIOD_END,
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
    // CHANGED (docs/phase-232). OLD: the cart dropped a line while the notice showed: `(shouldShowNoShiftNotice(shiftPresence) ? 1 : 0)`.
    // NEW: it drops the same one line while the window-end banner shows, which takes the same strip (the two never show together).
    expect(source).toContain('(shouldShowNoShiftNotice(shiftPresence) || showWindowEndBanner ? 1 : 0)')
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

describe('the cart dialog (D5, S6)', () => {
  const NIGHT = 'Night shift (17:31 to 06:59)'
  const DAY_LABEL = 'Day shift (07:00 to 17:30)'
  const mountDialog = async (
    staff: { id: number; role: string },
    extra: Partial<{ requestManagerPin: ReturnType<typeof vi.fn>; onOpened: () => void }> = {}
  ): Promise<{ requestManagerPin: ReturnType<typeof vi.fn> }> => {
    const requestManagerPin = extra.requestManagerPin ?? vi.fn()
    await act(async () => {
      root.render(
        createElement(OpenShiftDialog, {
          staff,
          requestManagerPin,
          onClose: vi.fn(),
          onOpened: extra.onOpened ?? vi.fn()
        })
      )
      await Promise.resolve()
    })
    await flush()
    return { requestManagerPin }
  }
  const typeCash = (value: string): void => {
    const input = container.querySelector<HTMLInputElement>('input[readonly]')!
    act(() => input.click())
    act(() => useKeyboardStore.getState().request?.onChange(value))
  }
  const typeMpesa = (value: string): void => {
    const input = container.querySelectorAll<HTMLInputElement>('input[readonly]')[1]!
    act(() => input.click())
    act(() => useKeyboardStore.getState().request?.onChange(value))
  }
  const confirm = (): HTMLButtonElement =>
    Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Confirm') as HTMLButtonElement
  const NO_EARLIER = { count: 0, cash: 0, mpesa: 0 }
  /** Currency text carries non-breaking spaces; compare it as plain spaces. */
  const textOf = (element: Element | null | undefined): string => (element?.textContent ?? '').replace(/ /g, ' ')

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the window of the clock, never a choice: Night at 17:43 Nairobi, Day at 10:30', async () => {
    // CHANGED (docs/phase-232). OLD: "suggests the shift from the time ... and either can be changed" (two radio buttons).
    // NEW: the window is shown as text, and there is nothing to change.
    stubApi()
    vi.setSystemTime(new Date('2026-10-05T17:43:00+03:00'))
    await mountDialog({ id: 1, role: 'admin' })
    expect(container.querySelector('[data-testid="open-shift-window"]')?.textContent).toBe(NIGHT)
    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(0)

    act(() => root.unmount())
    root = createRoot(container)
    vi.setSystemTime(new Date('2026-10-05T10:30:00+03:00'))
    await mountDialog({ id: 1, role: 'admin' })
    expect(container.querySelector('[data-testid="open-shift-window"]')?.textContent).toBe(DAY_LABEL)
  })

  it('opens the shift for an admin as themselves, with what was typed, and no PIN', async () => {
    stubApi({ openShift: vi.fn().mockResolvedValue(ok({ shiftId: 6 })) })
    vi.setSystemTime(new Date('2026-10-05T17:43:00+03:00'))
    const onOpened = vi.fn()
    const { requestManagerPin } = await mountDialog({ id: 1, role: 'admin' }, { onOpened })
    typeCash('250')

    await click('Confirm')
    await flush()

    // CHANGED (docs/phase-232). OLD: openShift(1, 250, 'night'). NEW: no type is sent; the options carry what the form showed.
    // CHANGED (docs/phase-246, R4). OLD: the third argument was `undefined` (M-Pesa blank). NEW: the field starts at 0, so it is 0.
    expect(window.api.openShift).toHaveBeenCalledWith(1, 250, 0, { earlierShown: NO_EARLIER, startAtZero: undefined })
    expect(requestManagerPin).not.toHaveBeenCalled()
    expect(onOpened).toHaveBeenCalledTimes(1)
  })

  it('asks a cashier for a manager PIN, then opens the shift under that manager, and never as the cashier', async () => {
    stubApi({ openShift: vi.fn(), openShiftAsManager: vi.fn().mockResolvedValue(ok({ shiftId: 6 })) })
    vi.setSystemTime(new Date('2026-10-05T17:43:00+03:00'))
    const onOpened = vi.fn()
    const requestManagerPin = vi.fn((_title: string, cb: (id: number, pin: string) => void) => cb(2, '2222'))
    await mountDialog({ id: 3, role: 'cashier' }, { requestManagerPin, onOpened })
    typeCash('250')

    await click('Confirm')
    await flush()

    expect(requestManagerPin).toHaveBeenCalledTimes(1)
    // CHANGED (docs/phase-246, R4). OLD: `undefined` for the M-Pesa balance. NEW: 0, the pre-filled figure.
    expect(window.api.openShiftAsManager).toHaveBeenCalledWith(2, '2222', 250, 0, {
      earlierShown: NO_EARLIER,
      startAtZero: undefined
    })
    expect(window.api.openShift).not.toHaveBeenCalled()
    expect(onOpened).toHaveBeenCalledTimes(1)
  })

  it('opens nothing while the manager PIN has not been given', async () => {
    stubApi({ openShift: vi.fn(), openShiftAsManager: vi.fn() })
    await mountDialog({ id: 3, role: 'cashier' })
    typeCash('250')

    await click('Confirm')

    expect(window.api.openShift).not.toHaveBeenCalled()
    expect(window.api.openShiftAsManager).not.toHaveBeenCalled()
  })

  it('refuses a missing or invalid starting cash, and says so', async () => {
    stubApi({ openShift: vi.fn() })
    await mountDialog({ id: 1, role: 'admin' })
    // CHANGED (docs/phase-246, R4). OLD: the cash field started blank. NEW: it starts at 0, so it is cleared to be "missing".
    typeCash('')

    await click('Confirm')

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Enter a valid starting cash amount')
    expect(window.api.openShift).not.toHaveBeenCalled()
  })

  it('shows the refusal the main process gave', async () => {
    stubApi({ openShift: vi.fn().mockResolvedValue({ success: false, error: 'A shift is already open' }) })
    const onOpened = vi.fn()
    await mountDialog({ id: 1, role: 'admin' }, { onOpened })
    typeCash('250')

    await click('Confirm')
    await flush()

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('A shift is already open')
    expect(onOpened).not.toHaveBeenCalled()
  })

  describe('earlier sales in this window (S6)', () => {
    const withEarlier = (): void => {
      vi.setSystemTime(new Date('2026-10-05T17:43:00+03:00'))
      stubApi({
        openShift: vi.fn().mockResolvedValue(ok({ shiftId: 6 })),
        getShiftWindowStatus: vi.fn().mockImplementation(async () =>
          ok(windowStatus([{ total: 700, method: 'cash' }, { total: 500, method: 'cash' }, { total: 300, method: 'mpesa' }]))
        )
      })
    }

    it('says how many will join, asks for the cash in the drawer now, and shows the starting cash it will record', async () => {
      withEarlier()
      await mountDialog({ id: 1, role: 'admin' })

      expect(textOf(container.querySelector('[data-testid="earlier-sales"]'))).toBe(
        '3 earlier sales in this window (cash Ksh 1,200.00) will join this shift.'
      )
      expect(container.textContent).toContain('Cash in the drawer now')
      typeCash('4500')
      expect(textOf(container.querySelector('[data-testid="float-line"]'))).toContain(
        'Starting cash will be recorded as Ksh 3,300.00 (drawer Ksh 4,500.00 less earlier cash sales Ksh 1,200.00).'
      )
    })

    it('sends the drawer count and what it showed, so the main process can refuse stale figures', async () => {
      withEarlier()
      await mountDialog({ id: 1, role: 'admin' })
      typeCash('4500')
      typeMpesa('')

      await click('Confirm')
      await flush()

      // CHANGED (docs/phase-246, R4). OLD: `undefined` (M-Pesa blank). NEW: the M-Pesa field starts at 0, below the 300 of earlier M-Pesa
      // sales, so it is cleared here; see "a pre-filled M-Pesa 0 holds Confirm" below for what 0 does.
      expect(window.api.openShift).toHaveBeenCalledWith(1, 4500, undefined, {
        earlierShown: { count: 3, cash: 1200, mpesa: 300 },
        startAtZero: undefined
      })
    })

    // ADDED (docs/phase-246, R4): the pre-filled figures.
    it('starts the drawer and the M-Pesa balance at 0, editable', async () => {
      stubApi({ openShift: vi.fn() })
      await mountDialog({ id: 1, role: 'admin' })

      const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[readonly]'))

      expect(inputs.map((input) => input.value)).toEqual(['0', '0'])
      typeCash('250')
      expect(container.querySelectorAll<HTMLInputElement>('input[readonly]')[0].value).toBe('250')
    })

    it('holds Confirm while a pre-filled M-Pesa 0 is below the earlier M-Pesa sales, until it is counted or cleared', async () => {
      withEarlier()
      await mountDialog({ id: 1, role: 'admin' })
      typeCash('4500')

      expect(confirm().disabled).toBe(true)
      typeMpesa('500')
      expect(confirm().disabled).toBe(false)
      typeMpesa('')
      expect(confirm().disabled).toBe(false)
    })

    it('will not confirm a drawer below the earlier cash, and tells a cashier to count again', async () => {
      withEarlier()
      await mountDialog({ id: 3, role: 'cashier' })
      typeCash('800')

      expect(textOf(container.querySelector('[data-testid="drawer-below"]'))).toContain(
        'The drawer (Ksh 800.00) holds less than the cash sales already made in this window (Ksh 1,200.00). Count the drawer again.'
      )
      expect(container.querySelector('input[type="checkbox"]')).toBeNull()
      expect(confirm().disabled).toBe(true)
    })

    it('lets an admin start at 0 with a tick, and sends the choice', async () => {
      withEarlier()
      await mountDialog({ id: 1, role: 'admin' })
      typeCash('800')
      typeMpesa('') // CHANGED (docs/phase-246, R4): the M-Pesa 0 is cleared, or it would hold Confirm on its own.
      expect(confirm().disabled).toBe(true)

      const tick = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
      expect(textOf(tick.parentElement)).toContain('Start at 0. The Ksh 400.00 missing will show as a shortage when the shift closes.')
      await act(async () => {
        tick.click()
        await Promise.resolve()
      })
      expect(confirm().disabled).toBe(false)

      await click('Confirm')
      await flush()

      expect(window.api.openShift).toHaveBeenCalledWith(1, 800, undefined, {
        earlierShown: { count: 3, cash: 1200, mpesa: 300 },
        startAtZero: true
      })
    })
  })
})

describe('selling with no shift open is not refused', () => {
  it('leaves checkout alone: the shift is read, not required', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'services', 'checkout.ts'), 'utf8')

    expect(source).toContain('const openShift = db.getOpenShift()')
    expect(source).toContain('shiftId: openShift?.id')
  })
})
