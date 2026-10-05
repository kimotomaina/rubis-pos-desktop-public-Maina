/**
 * Phase 229: a sale with no shift belongs to the Day or Night window it was made in. Each case of the audit's
 * A3 table, the clamp that keeps an offer's period off the shifts beside it, the sale that sits inside a shift,
 * and the screens that show and chain the offers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { listUnattachedOffers } from '../src/main/services/past-shifts.js'
import { findOverlappingShift } from '../src/main/lib/pastShift.js'
import { shiftWindowOf } from '../src/main/lib/shiftWindows.js'
import type { UnattachedSaleRow } from '../src/main/services/database.js'
import ReportsPage from '../src/renderer/src/pages/ReportsPage.js'
import PastShiftForm from '../src/renderer/src/components/PastShiftForm.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import { nairobiMinuteText } from '../src/renderer/src/lib/pastShiftPeriod.js'
import type { PastShiftPreview, UnattachedDay } from '../src/main/services/past-shifts.js'

vi.mock('../src/renderer/src/components/ManagerPinModal.js', () => ({
  default: ({ onAuthorized }: { onAuthorized: (id: number, pin: string) => void }) =>
    createElement('button', { onClick: () => onAuthorized(2, '1234') }, 'Authorize as manager')
}))

/** A Nairobi wall-clock time as the UTC instant it is stored as. */
const N = (t: string): string => new Date(`${t}+03:00`).toISOString()
const sale = (id: number, t: string, total = 100): UnattachedSaleRow => ({
  local_id: id,
  created_at: N(t),
  total,
  payment_method: 'cash'
})
type ShiftWindowRow = { id: number; clock_in: string; clock_out: string | null }
const offers = (sales: UnattachedSaleRow[], shifts: ShiftWindowRow[] = []) =>
  listUnattachedOffers({ listUnattachedSales: () => sales, listShiftWindows: () => shifts })
const summary = (list: UnattachedDay[]) => list.map((o) => [o.localDay, o.shiftType, o.count, o.insideShiftId ?? null])

describe('shiftWindowOf: the bucket of one instant (A3 cases 1 to 4)', () => {
  const at = (t: string) => shiftWindowOf(N(t))

  it('case 1: 08:59:59 is the previous date\'s Night, 09:00:00 is Day, 17:30:59 is Day, 17:31:00 is Night', () => {
    expect(at('2026-10-05T08:59:59')).toEqual({ type: 'night', startDate: '2026-10-04' })
    expect(at('2026-10-05T09:00:00')).toEqual({ type: 'day', startDate: '2026-10-05' })
    expect(at('2026-10-05T17:30:59')).toEqual({ type: 'day', startDate: '2026-10-05' })
    expect(at('2026-10-05T17:31:00')).toEqual({ type: 'night', startDate: '2026-10-05' })
  })

  it('cases 2 and 3: 23:50, 00:10 and 08:30 are all the Night that began the evening before', () => {
    expect(at('2026-10-04T23:50:00').startDate).toBe('2026-10-04')
    expect(at('2026-10-05T00:10:00').startDate).toBe('2026-10-04')
    expect(at('2026-10-05T08:30:00').startDate).toBe('2026-10-04')
  })

  it('case 4: the conversion from UTC is applied: 20:59Z is 23:59 Nairobi, 21:00Z is 00:00 the next day', () => {
    expect(shiftWindowOf('2026-10-04T20:59:00.000Z')).toEqual({ type: 'night', startDate: '2026-10-04' })
    expect(shiftWindowOf('2026-10-04T21:00:00.000Z')).toEqual({ type: 'night', startDate: '2026-10-04' })
    expect(shiftWindowOf('2026-10-04T05:59:59.000Z')).toEqual({ type: 'night', startDate: '2026-10-03' }) // 08:59:59
    expect(shiftWindowOf('2026-10-04T06:00:00.000Z')).toEqual({ type: 'day', startDate: '2026-10-04' }) // 09:00:00
  })

  it('crosses a month and a year end', () => {
    expect(at('2026-11-01T02:00:00').startDate).toBe('2026-10-31')
    expect(at('2027-01-01T01:00:00').startDate).toBe('2026-12-31')
  })

  it('refuses an instant that is not a time, rather than guess a bucket', () => {
    expect(() => shiftWindowOf('not a time')).toThrow(RangeError)
  })
})

describe('listUnattachedOffers: one offer per window (A3 cases 2, 3, 5 to 9, 12)', () => {
  it('case 2: a night across midnight is one offer, dated by the evening', () => {
    const list = offers([sale(1, '2026-10-04T23:50:00'), sale(2, '2026-10-05T00:10:00')])

    expect(summary(list)).toEqual([['2026-10-04', 'night', 2, null]])
  })

  it('case 3: 07:30 is last night\'s, not offered with the day\'s sales, and Day and Night are separate offers', () => {
    const list = offers([sale(1, '2026-10-05T07:30:00'), sale(2, '2026-10-05T10:00:00'), sale(3, '2026-10-05T20:00:00')])

    expect(summary(list)).toEqual([
      ['2026-10-04', 'night', 1, null],
      ['2026-10-05', 'day', 1, null],
      ['2026-10-05', 'night', 1, null]
    ])
  })

  it('an offer\'s type is its window\'s, not worked out from its start', () => {
    const list = offers([sale(1, '2026-10-05T17:30:30'), sale(2, '2026-10-05T17:31:30')])

    expect(list.map((o) => o.shiftType)).toEqual(['day', 'night'])
  })

  const SHIFT_1 = [{ id: 1, clock_in: N('2026-10-05T17:43:21'), clock_out: N('2026-10-05T17:43:36') }]

  it('case 5: shift #1 splits its window into two runs, and no run touches it', () => {
    const list = offers([sale(1, '2026-10-05T17:35:00'), sale(2, '2026-10-05T17:40:00'), sale(3, '2026-10-05T17:50:00')], SHIFT_1)

    expect(summary(list)).toEqual([
      ['2026-10-05', 'night', 2, null],
      ['2026-10-05', 'night', 1, null]
    ])
    for (const offer of list) {
      expect(findOverlappingShift(SHIFT_1, Date.parse(offer.periodStartIso!), Date.parse(offer.periodEndIso!))).toBeUndefined()
    }
  })

  it('case 5 clamp: a sale seconds from the shift gives a period held back to 1 ms from it, never a whole minute across it', () => {
    const list = offers([sale(1, '2026-10-05T17:43:05'), sale(2, '2026-10-05T17:43:40')], SHIFT_1)

    expect(list[0].periodStartIso).toBe(N('2026-10-05T17:43:00'))
    expect(list[0].periodEndIso).toBe(new Date(Date.parse(N('2026-10-05T17:43:21')) - 1).toISOString())
    expect(list[1].periodStartIso).toBe(new Date(Date.parse(N('2026-10-05T17:43:36')) + 1).toISOString())
    expect(list[1].periodEndIso).toBe(new Date(Date.parse(N('2026-10-05T17:43:59')) + 999).toISOString())
    for (const offer of list) {
      expect(findOverlappingShift(SHIFT_1, Date.parse(offer.periodStartIso!), Date.parse(offer.periodEndIso!))).toBeUndefined()
      expect(Date.parse(offer.periodStartIso!)).toBeLessThanOrEqual(Date.parse(offer.firstAt))
      expect(Date.parse(offer.periodEndIso!)).toBeGreaterThanOrEqual(Date.parse(offer.lastAt))
    }
  })

  it('without a neighbouring shift the period is the whole minutes the sales fall in', () => {
    const [offer] = offers([sale(1, '2026-10-05T10:00:05'), sale(2, '2026-10-05T10:07:40')])

    expect(offer.periodStartIso).toBe(N('2026-10-05T10:00:00'))
    expect(offer.periodEndIso).toBe(new Date(Date.parse(N('2026-10-05T10:07:59')) + 999).toISOString())
  })

  it('case 6: a shift that crosses windows (16:00 to 20:00) leaves a Day run before it and a Night run after it', () => {
    const shift = [{ id: 4, clock_in: N('2026-10-05T16:00:00'), clock_out: N('2026-10-05T20:00:00') }]
    const list = offers([sale(1, '2026-10-05T15:00:00'), sale(2, '2026-10-05T20:30:00'), sale(3, '2026-10-05T21:00:00')], shift)

    expect(summary(list)).toEqual([
      ['2026-10-05', 'day', 1, null],
      ['2026-10-05', 'night', 2, null]
    ])
  })

  it('case 7: with a shift open now, sales before it opened get an offer that ends before its clock_in', () => {
    const open = [{ id: 9, clock_in: N('2026-10-05T10:00:20'), clock_out: null }]
    const [offer] = offers([sale(1, '2026-10-05T10:00:05')], open)

    expect(Date.parse(offer.periodEndIso!)).toBe(Date.parse(N('2026-10-05T10:00:20')) - 1)
    expect(findOverlappingShift(open, Date.parse(offer.periodStartIso!), Date.parse(offer.periodEndIso!))).toBeUndefined()
  })

  it('case 8: a window with one sale is an offer whose period is that sale\'s minute', () => {
    const [offer] = offers([sale(1, '2026-10-05T12:00:30')])

    expect(offer.count).toBe(1)
    expect(offer.firstAt).toBe(offer.lastAt)
    expect(offer.periodStartIso).toBe(N('2026-10-05T12:00:00'))
  })

  it('case 9 and 12: voided sales never reach the list, so they make no offer and are not in the count', () => {
    const rows = [sale(1, '2026-10-05T12:00:00'), sale(2, '2026-10-06T12:00:00')]

    const list = offers(rows)

    expect(list.reduce((sum, o) => sum + o.count, 0)).toBe(rows.length)
  })

  it('case 12: the warning count (the sum of the offers) is every sale with no shift', () => {
    const rows = Array.from({ length: 11 }, (_, i) => sale(i + 1, `2026-10-0${1 + (i % 4)}T${String(9 + (i % 3) * 5).padStart(2, '0')}:10:00`))

    expect(offers(rows).reduce((sum, o) => sum + o.count, 0)).toBe(11)
  })

  it('case 14: many windows come out oldest first, each sale in exactly one offer', () => {
    const rows = [
      sale(1, '2026-10-01T10:00:00'),
      sale(2, '2026-10-01T20:00:00'),
      sale(3, '2026-10-02T10:00:00'),
      sale(4, '2026-10-02T20:00:00'),
      sale(5, '2026-10-03T10:00:00'),
      sale(6, '2026-10-03T20:00:00')
    ]

    const list = offers(rows)

    expect(list).toHaveLength(6)
    expect(list.map((o) => o.firstAt)).toEqual([...list.map((o) => o.firstAt)].sort())
  })
})

describe('case 11: a sale with no shift that sits inside an existing shift\'s window', () => {
  const SHIFT = [{ id: 7, clock_in: N('2026-10-05T09:30:00'), clock_out: N('2026-10-05T12:00:00') }]

  it('is reported with that shift\'s id, has no period, and is never offered', () => {
    const list = offers([sale(1, '2026-10-05T10:00:00')], SHIFT)

    expect(list).toHaveLength(1)
    expect(list[0].insideShiftId).toBe(7)
    expect(list[0].periodStartIso).toBeUndefined()
    expect(list[0].shiftType).toBeUndefined()
  })

  it('does not join a run, and the free sales either side of it stay offerable', () => {
    const list = offers([sale(1, '2026-10-05T09:10:00'), sale(2, '2026-10-05T10:00:00'), sale(3, '2026-10-05T13:00:00')], SHIFT)

    expect(summary(list)).toEqual([
      ['2026-10-05', 'day', 1, null],
      ['2026-10-05', undefined, 1, 7],
      ['2026-10-05', 'day', 1, null]
    ])
  })
})

describe('the screens', () => {
  let container: HTMLDivElement
  let root: Root
  const ok = <T,>(data?: T) => ({ success: true as const, data })

  const PREVIEW: PastShiftPreview = {
    startIso: N('2026-10-04T23:50:00'),
    endIso: N('2026-10-05T00:10:59'),
    sales: [{ id: 1, createdAt: N('2026-10-04T23:50:00'), method: 'cash', total: 100 }],
    count: 1,
    total: 100,
    totalsByMethod: { cash: 100, mpesa: 0, card: 0 },
    suggestedShiftType: 'day',
    problem: null
  }
  const offer = (over: Partial<UnattachedDay>): UnattachedDay => ({
    localDay: '2026-10-04',
    count: 1,
    total: 100,
    firstAt: N('2026-10-04T23:50:00'),
    lastAt: N('2026-10-04T23:50:00'),
    shiftType: 'night',
    periodStartIso: N('2026-10-04T23:50:00'),
    periodEndIso: new Date(Date.parse(N('2026-10-04T23:50:00')) + 59_999).toISOString(),
    ...over
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
  })

  const stub = (days: UnattachedDay[], extra: Record<string, unknown> = {}): void => {
    window.api = {
      getStaffList: vi.fn().mockResolvedValue(ok([])),
      getShiftsList: vi.fn().mockResolvedValue(ok({ shifts: [], total: 0, page: 1 })),
      getUnattachedDays: vi.fn().mockResolvedValue(ok(days)),
      previewPastShift: vi.fn().mockResolvedValue(ok(PREVIEW)),
      createPastShift: vi.fn().mockResolvedValue(ok({ shiftId: 9, attachedCount: 1 })),
      ...extra
    } as unknown as typeof window.api
  }
  const flush = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }
  const click = async (label: string): Promise<void> => {
    const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
    if (!el) throw new Error(`No button "${label}"`)
    await act(async () => {
      el.click()
      await Promise.resolve()
    })
  }

  it('shows each offer\'s window type beside its date, so two offers of one date can be told apart', async () => {
    stub([offer({}), offer({ shiftType: 'day', firstAt: N('2026-10-04T10:00:00') })])
    await act(async () => {
      root.render(createElement(ReportsPage, { initialAction: undefined }))
      await Promise.resolve()
    })
    await click('Shift History')
    await flush()
    await click('Sales with no shift: 2')

    const rows = Array.from(container.querySelectorAll('tbody tr')).map((r) => r.textContent)
    expect(rows[0]).toContain('2026-10-04Night')
    expect(rows[1]).toContain('2026-10-04Day')
  })

  it('shows a sale inside a shift as reported, with no button to record it', async () => {
    stub([offer({ insideShiftId: 7, shiftType: undefined, periodStartIso: undefined, periodEndIso: undefined })])
    await act(async () => {
      root.render(createElement(ReportsPage, { initialAction: undefined }))
      await Promise.resolve()
    })
    await click('Shift History')
    await flush()
    await click('Sales with no shift: 1')

    expect(container.textContent).toContain('Inside shift #7: not recorded')
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === 'Create shift for these')).toBe(false)
  })

  it('Record them skips a sale inside a shift and opens the first offer that can be recorded', async () => {
    stub([offer({ insideShiftId: 7, localDay: '2026-10-01' }), offer({ localDay: '2026-10-02', firstAt: N('2026-10-02T23:50:00') })])
    await act(async () => {
      root.render(createElement(ReportsPage, { initialAction: 'recordUnattached' }))
      await Promise.resolve()
    })
    await flush()

    expect(container.textContent).toContain('Record a shift for 2026-10-02')
  })

  it('opens nothing when only sales inside shifts are left', async () => {
    stub([offer({ insideShiftId: 7 })])
    await act(async () => {
      root.render(createElement(ReportsPage, { initialAction: 'recordUnattached' }))
      await Promise.resolve()
    })
    await flush()

    expect(container.textContent).not.toContain('Record a shift for')
  })

  it('case 14: the chain reads sensibly past three offers, each its own form with its own PIN', async () => {
    let remaining = [1, 2, 3, 4].map((n) => offer({ localDay: `2026-10-0${n}`, firstAt: N(`2026-10-0${n}T23:50:00`) }))
    const getUnattachedDays = vi.fn(async () => ok(remaining))
    const createPastShift = vi.fn(async () => {
      remaining = remaining.slice(1)
      return ok({ shiftId: 9, attachedCount: 1 })
    })
    stub([], { getUnattachedDays, createPastShift })
    await act(async () => {
      root.render(createElement(ReportsPage, { initialAction: 'recordUnattached' }))
      await Promise.resolve()
    })
    await flush()

    for (let n = 1; n <= 4; n++) {
      expect(container.textContent).toContain(`Record a shift for 2026-10-0${n}`)
      await click('Cash not counted')
      const reason = container.querySelector<HTMLInputElement>('input[aria-label="Reason"]')!
      act(() => reason.click())
      act(() => useKeyboardStore.getState().request?.onChange('Nobody counted'))
      await click('Record shift')
      expect(window.api.createPastShift).toHaveBeenCalledTimes(n - 1)
      await click('Authorize as manager')
      await flush()
      expect(window.api.createPastShift).toHaveBeenCalledTimes(n)
    }
    expect(container.textContent).not.toContain('Record a shift for')
  })

  it('the form sends the offer\'s exact period, not whole minutes, until a time is edited; its type is the window\'s', async () => {
    const clamped = offer({
      shiftType: 'night',
      periodStartIso: new Date(Date.parse(N('2026-10-05T17:43:36')) + 1).toISOString(),
      periodEndIso: new Date(Date.parse(N('2026-10-05T17:43:59')) + 999).toISOString(),
      firstAt: N('2026-10-05T17:43:40'),
      lastAt: N('2026-10-05T17:43:40')
    })
    stub([])
    await act(async () => {
      root.render(createElement(PastShiftForm, { day: clamped, onCancel: vi.fn(), onRecorded: vi.fn() }))
      await Promise.resolve()
    })
    await flush()

    expect(window.api.previewPastShift).toHaveBeenCalledWith(clamped.periodStartIso, clamped.periodEndIso)
    expect(nairobiMinuteText(clamped.periodStartIso!)).toBe('2026-10-05 17:43')
    const night = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((r) => r.getAttribute('aria-checked') === 'true')
    expect(night?.textContent).toContain('Night shift')
    expect(container.textContent).toContain('(Night)')

    // editing a time falls back to what was typed, in whole minutes
    const start = container.querySelector<HTMLInputElement>('input[aria-label="Period start"]')!
    act(() => start.click())
    act(() => useKeyboardStore.getState().request?.onChange('2026-10-05 17:42'))
    await flush()
    expect(vi.mocked(window.api.previewPastShift).mock.calls.at(-1)?.[0]).toBe(N('2026-10-05T17:42:00'))
  })
})
