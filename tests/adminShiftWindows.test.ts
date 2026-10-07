/**
 * The Open Shift and Close Shift controls on the Admin screen (docs/phase-199, changed in docs/phase-232): the window
 * of the clock is shown and never chosen, nothing about the type is sent, an open shift shows its window by its
 * `clock_in` (with a note when an older label differs), and from the last minute of the window the screen asks for the
 * drawer count and closes it; before then Close Shift is off and says when.
 *
 * CHANGED (docs/phase-232). OLD: the shift that matched the clock was preselected, both shifts stayed on screen and
 * could be switched, the chosen one was sent, and a note appeared from 17:31:00 ("due to close at 17:30"). NEW: see
 * above. The boundary results (day at 17:30:59 and 07:00:00, night at 17:31:00 and 06:59:59) are unchanged: they now
 * come from the main process's `getShiftWindowStatus`, which these tests run for real.
 *
 * Real mount, the same way `tests/adminScreen.test.ts` does it.
 *
 * CHANGED (docs/phase-237). OLD: Day began at 09:00 and Night ended at 08:59 (docs/phase-199 D1). NEW: Day begins at
 * 07:00 and Night ends at 06:59, the owner's correction; the rule, the labels and the boundary seconds move with it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AdminScreen from '../src/renderer/src/components/AdminScreen.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import type { ShiftRow } from '../src/main/services/database.js'
import { getShiftWindowStatus } from '../src/main/services/shift-window-status.js'
import { withWindow } from '../src/main/lib/shiftLabel.js'

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

/**
 * Every `window.api` method resolves an empty success unless a test names it. The window status is the main
 * process's own `getShiftWindowStatus`, run for real at the system time, over the shift given.
 */
function stubApi(shift: ShiftRow | null, holder: ShiftRow | null = null): void {
  const known = shift ?? holder
  const status = getShiftWindowStatus(
    {
      getOpenShift: () => (shift && shift.status === 'open' ? shift : undefined),
      listShiftWindows: () => (known ? [{ id: known.id, clock_in: known.clock_in, clock_out: known.clock_out }] : []),
      listUnattachedSales: () => [],
      listAbsorbedShiftIds: () => [], // ADDED (docs/phase-242): the window's shift is one that was not merged into another
      paymentLegsFor: () => new Map() // ADDED (docs/phase-250): the window status reads how sales were paid from their legs; this stub has no sales.
    },
    Date.now()
  )
  const named: Record<string, unknown> = {
    platform: 'linux',
    getCurrentShift: vi.fn().mockResolvedValue(ok(shift ? withWindow(shift) : null)),
    getShiftWindowStatus: vi.fn().mockResolvedValue(ok(status)),
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

const DAY_LABEL = 'Day shift (07:00 to 17:30)'
const NIGHT_LABEL = 'Night shift (17:31 to 06:59)'

/** Opens the Overview tab with no shift open at the given Nairobi time, and presses Open Shift. */
async function openFormAt(time: string, holder: ShiftRow | null = null): Promise<void> {
  vi.setSystemTime(nairobi(time))
  stubApi(null, holder)
  await mount()
  await click('Overview')
  await click('Open Shift')
}

const windowText = (): string | null => container.querySelector('[data-testid="open-shift-window"]')?.textContent ?? null

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

describe('Open Shift: the window is shown, never chosen', () => {
  it('shows the day window at a day time, with no buttons to choose between them', async () => {
    await openFormAt('10:30:00')

    expect(windowText()).toBe(DAY_LABEL)
    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(0)
    expect(container.textContent).not.toContain(NIGHT_LABEL)
  })

  it('shows the night window at a night time', async () => {
    await openFormAt('22:15:00')

    expect(windowText()).toBe(NIGHT_LABEL)
    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(0)
  })

  it('follows the boundary: day at 17:30:59 and 07:00:00, night at 17:31:00 and 06:59:59', async () => {
    const cases: Array<[string, string]> = [
      ['17:30:59', DAY_LABEL],
      ['17:31:00', NIGHT_LABEL],
      ['06:59:59', NIGHT_LABEL],
      ['07:00:00', DAY_LABEL]
    ]
    for (const [time, label] of cases) {
      await openFormAt(time)
      expect(windowText()).toBe(label)
      act(() => root.unmount())
      root = createRoot(container)
    }
  })

  it('sends no shift type: the type is worked out in the main process', async () => {
    await openFormAt('22:15:00')
    act(() => container.querySelector('input')!.click())
    act(() => useKeyboardStore.getState().request?.onChange('250'))
    await click('Confirm')

    const call = vi.mocked(window.api.openShift).mock.calls[0]
    // CHANGED (docs/phase-246, R4): `[1, 250, 0]`, the field starting at 0. CHANGED again (docs/phase-246-2): it starts blank, so `undefined`.
    expect(call.slice(0, 3)).toEqual([1, 250, undefined])
    expect(JSON.stringify(call)).not.toMatch(/"(day|night)"/)
  })

  it('says so, and will not confirm, when the window already has its shift', async () => {
    const closed = openShiftRow({
      id: 1,
      clock_in: nairobi('17:43:21').toISOString(),
      clock_out: nairobi('17:43:36').toISOString(),
      status: 'closed'
    })

    await openFormAt('21:00:00', closed)

    expect(container.textContent).toContain('Night shift, 2 Oct 2026 already has shift #1. A window has one shift.')
    expect(button('Confirm').disabled).toBe(true)
  })
})

describe('an open shift: its window and the close note', () => {
  const mountOpen = async (shift: ShiftRow, now: string, date = '2026-10-02'): Promise<void> => {
    vi.setSystemTime(nairobi(now, date))
    stubApi(shift)
    await mount()
    await click('Overview')
  }

  it('shows the shift and its window, and when it can be closed, while inside the window', async () => {
    await mountOpen(openShiftRow({ shift_type: 'day' }), '12:00:00')

    expect(container.textContent).toContain(DAY_LABEL)
    expect(container.textContent).toContain('Day shift can be closed from 17:30')
    expect(container.querySelector('[data-testid="close-banner"]')).toBeNull()
    // CHANGED (docs/phase-255). OLD: Close Shift was off until the window's end. NEW: this screen is an admin's, and an
    // admin may close early, so it is on and the note says so.
    expect(container.querySelector('[data-testid="close-not-yet"]')?.textContent).toContain('An admin may close it early.')
    expect(button('Close Shift').disabled).toBe(false)
  })

  it('asks for the drawer count from 17:30:00, the first second of the day window\'s last minute', async () => {
    await mountOpen(openShiftRow({ shift_type: 'day' }), '17:30:00')

    expect(container.querySelector('[data-testid="close-banner"]')?.textContent).toBe(
      'Day window ended at 17:30. Count the drawer and close shift #5.'
    )
    expect(button('Close Shift').disabled).toBe(false)
  })

  // CHANGED (docs/phase-255). OLD: "does not ask at 17:29:59 and keeps Close Shift off". NEW: Close Shift stays on for an admin.
  it('does not ask at 17:29:59, and leaves Close Shift on for an admin', async () => {
    await mountOpen(openShiftRow({ shift_type: 'day' }), '17:29:59')

    expect(container.querySelector('[data-testid="close-banner"]')).toBeNull()
    expect(button('Close Shift').disabled).toBe(false)
  })

  it('asks from 06:59:00 for a night shift opened the evening before, and not at 06:58:59', async () => {
    const shift = openShiftRow({ shift_type: 'night', clock_in: nairobi('18:30:00').toISOString() })

    await mountOpen(shift, '06:58:59', '2026-10-03')
    expect(container.querySelector('[data-testid="close-banner"]')).toBeNull()
    act(() => root.unmount())
    root = createRoot(container)

    await mountOpen(shift, '06:59:00', '2026-10-03')
    expect(container.querySelector('[data-testid="close-banner"]')?.textContent).toBe(
      'Night window ended at 06:59. Count the drawer and close shift #5.'
    )
  })

  it('shows an older shift by its window, with a note of the label it was given', async () => {
    // Opened 17:43 and labelled Day, as shift #1 on the live till was.
    const shift = openShiftRow({ shift_type: 'day', clock_in: nairobi('17:43:21').toISOString() })

    await mountOpen(shift, '20:00:00')

    expect(container.textContent).toContain(NIGHT_LABEL)
    expect(container.textContent).toContain('Labelled Day when opened')
  })

  it('shows the window of a shift opened before shift types existed, with no "labelled" note', async () => {
    // CHANGED (docs/phase-232). OLD: nothing about a window for a shift with no label. NEW: every shift has a window.
    await mountOpen(openShiftRow({ shift_type: null }), '23:00:00')

    expect(container.textContent).toContain(DAY_LABEL)
    expect(container.textContent).not.toContain('Labelled')
    expect(container.textContent).toContain('Shift #5 open')
  })

  it('still closes a shift that is past its window', async () => {
    await mountOpen(openShiftRow({ shift_type: 'day' }), '19:00:00')
    expect(container.querySelector('[data-testid="close-banner"]')).not.toBeNull()

    await click('Close Shift')
    act(() => container.querySelector('input')!.click())
    act(() => useKeyboardStore.getState().request?.onChange('180'))
    await click('Confirm')

    expect(window.api.closeShift).toHaveBeenCalledWith(5, 180)
  })

  it('keeps the window and the banner on screen while the close form is open', async () => {
    await mountOpen(openShiftRow({ shift_type: 'day' }), '19:00:00')

    await click('Close Shift')

    expect(container.textContent).toContain('Ending Cash (counted)')
    expect(container.textContent).toContain(DAY_LABEL)
    expect(container.textContent).toContain('Day window ended at 17:30')
  })
})
