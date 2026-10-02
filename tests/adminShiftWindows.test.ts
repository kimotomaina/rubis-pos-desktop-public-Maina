/**
 * The Open Shift and Close Shift controls on the Admin screen (docs/phase-199):
 * the shift that matches the clock is preselected, both shifts stay visible and
 * can be switched, the chosen one is sent, and an open shift shows its window
 * with a note, never a block, once it has run past its end.
 *
 * Real mount, the same way `tests/adminScreen.test.ts` does it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AdminScreen from '../src/renderer/src/components/AdminScreen.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import type { ShiftRow } from '../src/main/services/database.js'

let container: HTMLDivElement
let root: Root

const ok = <T,>(data?: T) => ({ success: true as const, data })

/** An instant given as Nairobi wall-clock time, so the cases read the way the client states them. */
const nairobi = (time: string, date = '2026-10-02'): Date => new Date(`${date}T${time}+03:00`)

const openShiftRow = (overrides: Partial<ShiftRow> = {}): ShiftRow => ({
  id: 5,
  staff_id: 1,
  clock_in: nairobi('10:00:00').toISOString(),
  clock_out: null,
  starting_cash: 100,
  expected_cash: null,
  ending_cash: null,
  discrepancy: null,
  status: 'open',
  ...overrides
})

/** Every `window.api` method resolves an empty success unless a test names it; only the shift calls matter here. */
function stubApi(shift: ShiftRow | null): void {
  const named: Record<string, unknown> = {
    platform: 'linux',
    getCurrentShift: vi.fn().mockResolvedValue(ok(shift)),
    getAppVersion: vi.fn().mockResolvedValue('2.1.6'),
    onUpdateStatus: vi.fn(() => () => {}),
    openShift: vi.fn().mockResolvedValue(ok({ shiftId: 6 })),
    closeShift: vi.fn().mockResolvedValue(ok({ expectedCash: 100, discrepancy: 0 })),
    getZReport: vi.fn().mockResolvedValue(ok(null))
  }
  window.api = new Proxy(named, {
    get: (target, name: string) => target[name] ?? (target[name] = vi.fn().mockResolvedValue(ok(undefined)))
  }) as unknown as typeof window.api
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(AdminScreen, { requestManagerPin: () => {} }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!el) throw new Error(`No button "${label}"`)
  return el as HTMLButtonElement
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
    await Promise.resolve()
  })
}

const radios = (): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'))

const checkedRadio = (): string | undefined =>
  radios().find((r) => r.getAttribute('aria-checked') === 'true')?.textContent ?? undefined

const DAY_LABEL = 'Day shift (09:00 to 17:30)'
const NIGHT_LABEL = 'Night shift (17:31 to 08:59)'

/** Opens the Overview tab with no shift open at the given Nairobi time, and presses Open Shift. */
async function openFormAt(time: string): Promise<void> {
  vi.setSystemTime(nairobi(time))
  stubApi(null)
  await mount()
  await click('Overview')
  await click('Open Shift')
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useKeyboardStore.setState({ request: null })
  useAuthStore.setState({ currentStaff: { id: 1, name: 'Admin', role: 'admin' } })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('Open Shift: the suggested shift', () => {
  it('preselects the day shift at a day time and shows both shifts with their full labels', async () => {
    await openFormAt('10:30:00')

    expect(radios().map((r) => r.textContent)).toEqual([DAY_LABEL, NIGHT_LABEL])
    expect(checkedRadio()).toBe(DAY_LABEL)
  })

  it('preselects the night shift at a night time', async () => {
    await openFormAt('22:15:00')

    expect(radios().map((r) => r.textContent)).toEqual([DAY_LABEL, NIGHT_LABEL])
    expect(checkedRadio()).toBe(NIGHT_LABEL)
  })

  it('follows the boundary: day at 17:30:59 and 09:00:00, night at 17:31:00 and 08:59:59', async () => {
    await openFormAt('17:30:59')
    expect(checkedRadio()).toBe(DAY_LABEL)
    act(() => root.unmount())
    root = createRoot(container)

    await openFormAt('17:31:00')
    expect(checkedRadio()).toBe(NIGHT_LABEL)
    act(() => root.unmount())
    root = createRoot(container)

    await openFormAt('08:59:59')
    expect(checkedRadio()).toBe(NIGHT_LABEL)
    act(() => root.unmount())
    root = createRoot(container)

    await openFormAt('09:00:00')
    expect(checkedRadio()).toBe(DAY_LABEL)
  })

  it('lets the operator switch, in both directions, with both options still on screen', async () => {
    await openFormAt('10:30:00')

    await click(NIGHT_LABEL)
    expect(checkedRadio()).toBe(NIGHT_LABEL)
    expect(radios()).toHaveLength(2)

    await click(DAY_LABEL)
    expect(checkedRadio()).toBe(DAY_LABEL)
    expect(radios()).toHaveLength(2)
  })

  it('sends the suggested shift when the operator changes nothing', async () => {
    await openFormAt('22:15:00')
    act(() => container.querySelector('input')!.click())
    act(() => useKeyboardStore.getState().request?.onChange('250'))
    await click('Confirm')

    expect(window.api.openShift).toHaveBeenCalledWith(1, 250, 'night')
  })

  it('sends the shift the operator chose instead of the suggested one', async () => {
    await openFormAt('10:30:00')
    await click(NIGHT_LABEL)
    act(() => container.querySelector('input')!.click())
    act(() => useKeyboardStore.getState().request?.onChange('250'))
    await click('Confirm')

    expect(window.api.openShift).toHaveBeenCalledWith(1, 250, 'night')
  })

  it('suggests afresh each time the form is opened', async () => {
    await openFormAt('10:30:00')
    await click(NIGHT_LABEL)
    await click('Cancel')

    vi.setSystemTime(nairobi('10:45:00'))
    await click('Open Shift')

    expect(checkedRadio()).toBe(DAY_LABEL)
  })
})

describe('an open shift: its window and the due-to-close note', () => {
  const mountOpen = async (shift: ShiftRow, now: string, date = '2026-10-02'): Promise<void> => {
    vi.setSystemTime(nairobi(now, date))
    stubApi(shift)
    await mount()
    await click('Overview')
  }

  it('shows the shift and its window in the status line, with no note while inside the window', async () => {
    await mountOpen(openShiftRow({ shift_type: 'day' }), '12:00:00')

    expect(container.textContent).toContain(DAY_LABEL)
    expect(container.textContent).not.toContain('due to close')
  })

  it('adds "Day shift, due to close at 17:30" once the clock is past the end of the window', async () => {
    await mountOpen(openShiftRow({ shift_type: 'day' }), '17:31:00')

    expect(container.textContent).toContain('Day shift, due to close at 17:30')
  })

  it('does not add the note at 17:30:59, the last second of the day shift', async () => {
    await mountOpen(openShiftRow({ shift_type: 'day' }), '17:30:59')

    expect(container.textContent).not.toContain('due to close')
  })

  it('adds "Night shift, due to close at 08:59" for a night shift opened at 02:00 once it is 09:00', async () => {
    const shift = openShiftRow({ shift_type: 'night', clock_in: nairobi('02:00:00').toISOString() })

    await mountOpen(shift, '09:00:00')

    expect(container.textContent).toContain(NIGHT_LABEL)
    expect(container.textContent).toContain('Night shift, due to close at 08:59')
  })

  it('shows no note for a night shift opened the evening before, before 09:00 the next morning', async () => {
    const shift = openShiftRow({ shift_type: 'night', clock_in: nairobi('18:30:00').toISOString() })

    await mountOpen(shift, '08:59:00', '2026-10-03')

    expect(container.textContent).not.toContain('due to close')
  })

  it('shows nothing about a window for a shift opened before shift types existed', async () => {
    await mountOpen(openShiftRow({ shift_type: null }), '23:00:00')
    expect(container.textContent).not.toContain('Day shift')
    expect(container.textContent).not.toContain('Night shift')
    expect(container.textContent).toContain('Shift #5 open')

    act(() => root.unmount())
    root = createRoot(container)
    await mountOpen(openShiftRow(), '23:00:00')
    expect(container.textContent).not.toContain('Night shift')
  })

  it('still closes a shift that is past its window: the note blocks nothing', async () => {
    await mountOpen(openShiftRow({ shift_type: 'day' }), '19:00:00')
    expect(container.textContent).toContain('due to close')

    await click('Close Shift')
    act(() => container.querySelector('input')!.click())
    act(() => useKeyboardStore.getState().request?.onChange('180'))
    await click('Confirm')

    expect(window.api.closeShift).toHaveBeenCalledWith(5, 180)
  })

  it('keeps the window and the note on screen while the close form is open', async () => {
    await mountOpen(openShiftRow({ shift_type: 'day' }), '19:00:00')

    await click('Close Shift')

    expect(container.textContent).toContain('Ending Cash (counted)')
    expect(container.textContent).toContain(DAY_LABEL)
    expect(container.textContent).toContain('Day shift, due to close at 17:30')
  })
})
