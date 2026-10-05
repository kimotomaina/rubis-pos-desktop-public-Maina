/**
 * Phase 227, D3: Open Shift and Close Shift on the Admin screen warn about sales that have no shift and offer to
 * record them. A warning, never a block; nothing is attached without the manager's confirmation in Shift History.
 *
 * Real mount, as `tests/adminShiftWindows.test.ts` does it. The Reports page is stubbed to show what it was handed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AdminScreen from '../src/renderer/src/components/AdminScreen.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import type { ShiftRow } from '../src/main/services/database.js'

vi.mock('../src/renderer/src/pages/ReportsPage.js', () => ({
  default: ({ initialAction }: { initialAction?: string }) =>
    createElement('div', { 'data-testid': 'reports-page', 'data-action': initialAction ?? '' }, 'Reports page')
}))

let container: HTMLDivElement
let root: Root

const ok = <T,>(data?: T) => ({ success: true as const, data })

const days = (count: number) => [
  { localDay: '2026-10-05', count, total: 1000, firstAt: '2026-10-05T05:00:00.000Z', lastAt: '2026-10-05T11:00:00.000Z' }
]

const openShiftRow = (): ShiftRow => ({
  id: 5,
  staff_id: 1,
  clock_in: new Date('2026-10-05T10:00:00+03:00').toISOString(),
  clock_out: null,
  starting_cash: 100,
  expected_cash: null,
  ending_cash: null,
  discrepancy: null,
  status: 'open'
})

function stubApi(shift: ShiftRow | null, unattached: unknown): void {
  const named: Record<string, unknown> = {
    platform: 'linux',
    getCurrentShift: vi.fn().mockResolvedValue(ok(shift)),
    getAppVersion: vi.fn().mockResolvedValue('2.2.2'),
    onUpdateStatus: vi.fn(() => () => {}),
    openShift: vi.fn().mockResolvedValue(ok({ shiftId: 6 })),
    closeShift: vi.fn().mockResolvedValue(ok({ expectedCash: 100, discrepancy: 0 })),
    getZReport: vi.fn().mockResolvedValue(ok(null)),
    getUnattachedDays: vi.fn().mockResolvedValue(ok(unattached)),
    createPastShift: vi.fn()
  }
  window.api = new Proxy(named, {
    get: (target, name: string) => target[name] ?? (target[name] = vi.fn().mockResolvedValue(ok(undefined)))
  }) as unknown as typeof window.api
}

async function mountOverview(): Promise<void> {
  await act(async () => {
    root.render(createElement(AdminScreen, { requestManagerPin: () => {} }))
    await Promise.resolve()
    await Promise.resolve()
  })
  await click('Overview')
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement | undefined
}

async function click(label: string): Promise<void> {
  const el = button(label)
  if (!el) throw new Error(`No button "${label}"`)
  await act(async () => {
    el.click()
    await Promise.resolve()
  })
}

const prompt = (): HTMLElement | null => container.querySelector('[data-testid="no-shift-sales-prompt"]')
const radios = (): HTMLButtonElement[] => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]'))

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useKeyboardStore.setState({ request: null })
  useAuthStore.setState({ currentStaff: { id: 1, name: 'Admin', role: 'admin' } })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('Open Shift with sales that have no shift', () => {
  it('says how many, in a question, and offers both buttons, before the form', async () => {
    stubApi(null, days(85))
    await mountOverview()

    await click('Open Shift')

    expect(prompt()?.textContent).toContain('85 sales have no shift. Record them now?')
    expect(button('Record them')).toBeDefined()
    expect(button('Carry on without')).toBeDefined()
    expect(radios()).toHaveLength(0)
    expect(window.api.openShift).not.toHaveBeenCalled()
  })

  it('says "sale has" for one', async () => {
    stubApi(null, days(1))
    await mountOverview()

    await click('Open Shift')

    expect(prompt()?.textContent).toContain('1 sale has no shift. Record them now?')
  })

  it('carries on without recording: the Open Shift form follows, and nothing is attached', async () => {
    stubApi(null, days(85))
    await mountOverview()
    await click('Open Shift')

    await click('Carry on without')

    expect(prompt()).toBeNull()
    expect(radios()).toHaveLength(2)
    expect(window.api.createPastShift).not.toHaveBeenCalled()
  })

  it('does not stand in the way when every sale has a shift: the form comes straight up', async () => {
    stubApi(null, [])
    await mountOverview()

    await click('Open Shift')

    expect(prompt()).toBeNull()
    expect(radios()).toHaveLength(2)
  })

  it('does not stand in the way when the count cannot be read', async () => {
    stubApi(null, [])
    window.api.getUnattachedDays = vi.fn().mockRejectedValue(new Error('down'))
    await mountOverview()

    await click('Open Shift')

    expect(prompt()).toBeNull()
    expect(radios()).toHaveLength(2)
  })

  it('"Record them" opens Reports on the first period offered, and attaches nothing itself', async () => {
    stubApi(null, days(85))
    await mountOverview()
    await click('Open Shift')

    await click('Record them')

    const reports = container.querySelector('[data-testid="reports-page"]')
    expect(reports?.getAttribute('data-action')).toBe('recordUnattached')
    expect(window.api.createPastShift).not.toHaveBeenCalled()
  })
})

describe('Close Shift with sales that have no shift', () => {
  it('asks the same before the counted figure is asked for', async () => {
    stubApi(openShiftRow(), days(85))
    await mountOverview()

    await click('Close Shift')

    expect(prompt()?.textContent).toContain('85 sales have no shift. Record them now?')
    expect(container.textContent).not.toContain('Ending Cash (counted)')
    expect(window.api.closeShift).not.toHaveBeenCalled()
  })

  it('carries on without recording, to the counted figure, which is still required', async () => {
    stubApi(openShiftRow(), days(85))
    await mountOverview()
    await click('Close Shift')

    await click('Carry on without')
    expect(container.textContent).toContain('Ending Cash (counted)')

    await click('Confirm')
    expect(container.textContent).toContain('Enter a valid ending cash amount')
    expect(window.api.closeShift).not.toHaveBeenCalled()
  })

  it('goes straight to the counted figure when every sale has a shift', async () => {
    stubApi(openShiftRow(), [])
    await mountOverview()

    await click('Close Shift')

    expect(prompt()).toBeNull()
    expect(container.textContent).toContain('Ending Cash (counted)')
  })
})
