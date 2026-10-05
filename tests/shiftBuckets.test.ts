/**
 * Phase 229: a sale with no shift belongs to the Day or Night window it was made in. The audit's A3 cases 1 to 4: the
 * bucket of one instant, at the window edges, across midnight, across the UTC day, a month and a year end.
 *
 * CHANGED (docs/phase-231). OLD: this file also tested `listUnattachedOffers` (one offer per window, the period clamp,
 * the sale inside a shift, cases 5 to 14), the Shift History screens that listed and chained the offers, and
 * `PastShiftForm`. NEW: the manual past-shift offers are retired, so those are removed; the same questions are answered
 * by the automatic assignment, in tests/oneShiftPerWindow.test.ts (the clamp, the sale inside a shift, voided sales
 * and oldest-first order). `shiftWindowOf` is unchanged and is what both use.
 */

import { describe, it, expect } from 'vitest'
import { shiftWindowOf } from '../src/main/lib/shiftWindows.js'

/** A Nairobi wall-clock time as the UTC instant it is stored as. */
const N = (t: string): string => new Date(`${t}+03:00`).toISOString()

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
