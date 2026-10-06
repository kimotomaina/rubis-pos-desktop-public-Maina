/**
 * The fixed shift windows (docs/phase-199): day is 07:00:00 to 17:30:59
 * Nairobi time, night is everything else, decided on the whole minute. The
 * renderer's copy must agree with the main one on every input.
 *
 * CHANGED (docs/phase-237). OLD: Day began at 09:00 and Night ended at 08:59 (docs/phase-199 D1). NEW: Day begins at
 * 07:00 and Night ends at 06:59, the owner's correction; the rule, the labels and the boundary seconds move with it.
 */

import { describe, it, expect } from 'vitest'
import {
  DAY_SHIFT,
  NIGHT_SHIFT,
  SHIFT_TYPES,
  isPastShiftEnd,
  shiftEndClock,
  shiftName,
  shiftTypeForTime,
  shiftWindowLabel
} from '../src/main/lib/shiftWindows.js'
import type { ShiftType } from '../src/main/lib/shiftWindows.js'
import * as renderer from '../src/renderer/src/lib/shiftWindows.js'

/** An instant given as Nairobi wall-clock time (UTC+3), so the cases read the way the client states them. */
const nairobi = (time: string, date = '2026-10-02'): string =>
  new Date(`${date}T${time}+03:00`).toISOString()

describe('shiftTypeForTime, in Nairobi time', () => {
  const cases: Array<[string, ShiftType]> = [
    ['00:00:00', 'night'],
    ['06:59:00', 'night'],
    ['06:59:59', 'night'],
    ['07:00:00', 'day'],
    ['07:00:01', 'day'],
    ['07:01:00', 'day'],
    ['12:00:00', 'day'],
    ['17:29:00', 'day'],
    ['17:30:00', 'day'],
    ['17:30:59', 'day'],
    ['17:31:00', 'night'],
    ['17:31:01', 'night'],
    ['23:59:59', 'night']
  ]

  it.each(cases)('%s is %s', (time, expected) => {
    expect(shiftTypeForTime(nairobi(time))).toBe(expected)
  })

  it('puts 17:30:59 in the day shift and 17:31:00 in the night shift', () => {
    expect(shiftTypeForTime(nairobi('17:30:59'))).toBe('day')
    expect(shiftTypeForTime(nairobi('17:31:00'))).toBe('night')
  })

  it('reads the same on every date, including across a month and a year end', () => {
    for (const date of ['2026-01-01', '2026-02-28', '2026-12-31', '2028-02-29']) {
      expect(shiftTypeForTime(nairobi('07:00:00', date))).toBe('day')
      expect(shiftTypeForTime(nairobi('06:59:59', date))).toBe('night')
    }
  })
})

describe('shiftTypeForTime, given UTC instants (the offset is applied, not assumed)', () => {
  const cases: Array<[string, ShiftType, string]> = [
    ['2026-10-02T03:59:59.000Z', 'night', '06:59:59 Nairobi'],
    ['2026-10-02T04:00:00.000Z', 'day', '07:00:00 Nairobi'],
    ['2026-10-02T14:30:59.000Z', 'day', '17:30:59 Nairobi'],
    ['2026-10-02T14:31:00.000Z', 'night', '17:31:00 Nairobi'],
    ['2026-10-01T21:00:00.000Z', 'night', '00:00:00 Nairobi on the 2nd'],
    ['2026-10-02T20:59:59.000Z', 'night', '23:59:59 Nairobi']
  ]

  it.each(cases)('%s is %s (%s)', (iso, expected) => {
    expect(shiftTypeForTime(iso)).toBe(expected)
  })

  it('does not read the UTC clock: 06:00Z is day and 14:31Z is night', () => {
    // A UTC-naive version would call 06:00Z night (before 07:00) and 14:31Z day (before 17:30).
    expect(shiftTypeForTime('2026-10-02T06:00:00.000Z')).toBe('day')
    expect(shiftTypeForTime('2026-10-02T14:31:00.000Z')).toBe('night')
  })

  it('refuses an instant that is not a time', () => {
    expect(() => shiftTypeForTime('not a time')).toThrow(RangeError)
  })
})

describe('labels and windows', () => {
  it('labels the day shift', () => {
    expect(shiftWindowLabel('day')).toBe('Day shift (07:00 to 17:30)')
  })

  it('labels the night shift', () => {
    expect(shiftWindowLabel('night')).toBe('Night shift (17:31 to 06:59)')
  })

  it('names the shifts and gives the last minute of each window', () => {
    expect(shiftName('day')).toBe('Day shift')
    expect(shiftName('night')).toBe('Night shift')
    expect(shiftEndClock('day')).toBe('17:30')
    expect(shiftEndClock('night')).toBe('06:59')
  })

  it('lists both shift types and keeps the window constants', () => {
    expect([...SHIFT_TYPES]).toEqual(['day', 'night'])
    expect(DAY_SHIFT).toEqual({ type: 'day', startMinutes: 420, endMinutes: 1050 })
    expect(NIGHT_SHIFT).toEqual({ type: 'night', startMinutes: 1051, endMinutes: 419 })
  })
})

describe('isPastShiftEnd: the next time the window ends after the shift opened', () => {
  it('a night shift opened at 02:00 is due at 07:00 the same morning', () => {
    const opened = nairobi('02:00:00')
    expect(isPastShiftEnd('night', opened, nairobi('06:59:59'))).toBe(false)
    expect(isPastShiftEnd('night', opened, nairobi('07:00:00'))).toBe(true)
  })

  it('a night shift opened at 18:00 is due at 07:00 the next morning, not the same evening', () => {
    const opened = nairobi('18:00:00')
    expect(isPastShiftEnd('night', opened, nairobi('23:59:00'))).toBe(false)
    expect(isPastShiftEnd('night', opened, nairobi('06:59:59', '2026-10-03'))).toBe(false)
    expect(isPastShiftEnd('night', opened, nairobi('07:00:00', '2026-10-03'))).toBe(true)
  })

  it('a day shift opened at 10:00 is due once the clock reaches 17:31', () => {
    const opened = nairobi('10:00:00')
    expect(isPastShiftEnd('day', opened, nairobi('17:30:59'))).toBe(false)
    expect(isPastShiftEnd('day', opened, nairobi('17:31:00'))).toBe(true)
  })

  it('a day shift opened late, in the evening, is due the next day', () => {
    const opened = nairobi('18:00:00')
    expect(isPastShiftEnd('day', opened, nairobi('23:00:00'))).toBe(false)
    expect(isPastShiftEnd('day', opened, nairobi('17:31:00', '2026-10-03'))).toBe(true)
  })

  it('is not past its end the moment it opens', () => {
    for (const type of SHIFT_TYPES) {
      const opened = nairobi('12:00:00')
      expect(isPastShiftEnd(type, opened, opened)).toBe(false)
    }
  })
})

describe('the renderer twin agrees with the main file', () => {
  const instants: string[] = []
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const h = String(Math.floor(minute / 60)).padStart(2, '0')
    const m = String(minute % 60).padStart(2, '0')
    instants.push(nairobi(`${h}:${m}:00`), nairobi(`${h}:${m}:59`))
  }

  it('returns the same shift for every minute of the day, at the start and end of each minute', () => {
    for (const iso of instants) {
      expect(renderer.shiftTypeForTime(iso)).toBe(shiftTypeForTime(iso))
    }
  })

  it('has the same labels, names, end clocks, windows and shift list', () => {
    for (const type of SHIFT_TYPES) {
      expect(renderer.shiftWindowLabel(type)).toBe(shiftWindowLabel(type))
      expect(renderer.shiftName(type)).toBe(shiftName(type))
      expect(renderer.shiftEndClock(type)).toBe(shiftEndClock(type))
    }
    expect(renderer.DAY_SHIFT).toEqual(DAY_SHIFT)
    expect(renderer.NIGHT_SHIFT).toEqual(NIGHT_SHIFT)
    expect([...renderer.SHIFT_TYPES]).toEqual([...SHIFT_TYPES])
  })

  it('agrees on isPastShiftEnd for every opening and checking time on a grid', () => {
    const times = ['00:00:00', '02:00:00', '06:59:59', '07:00:00', '10:00:00', '17:30:59', '17:31:00', '18:00:00', '23:59:59']
    for (const type of SHIFT_TYPES) {
      for (const open of times) {
        for (const dayOffset of ['2026-10-02', '2026-10-03']) {
          for (const check of times) {
            const opened = nairobi(open)
            const now = nairobi(check, dayOffset)
            expect(renderer.isPastShiftEnd(type, opened, now)).toBe(isPastShiftEnd(type, opened, now))
          }
        }
      }
    }
  })

  it('refuses an invalid instant in the same way', () => {
    expect(() => renderer.shiftTypeForTime('not a time')).toThrow(RangeError)
  })
})
