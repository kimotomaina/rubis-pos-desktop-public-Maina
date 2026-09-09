/**
 * `parseFiscalTimestamp` tests (phase-96, Finding 2 from the go-live
 * readiness audit) — pure, tested directly, matching this project's
 * convention.
 */

import { describe, it, expect } from 'vitest'
import { parseFiscalTimestamp } from '../src/renderer/src/lib/fiscalDate.js'

describe('parseFiscalTimestamp', () => {
  it('parses the device format (dd-MM-yyyy HH:mm:ss) as day-first — the exact regression the audit found', () => {
    const date = parseFiscalTimestamp('05-09-2026 14:30:00')
    expect(date).not.toBeNull()
    expect(date!.getFullYear()).toBe(2026)
    // getMonth() is 0-indexed: 8 === September, NOT April (which a
    // wrong US-style MM-dd-yyyy read of "05-09" would have produced —
    // getMonth() 4 for month "05").
    expect(date!.getMonth()).toBe(8)
    expect(date!.getDate()).toBe(5)
    expect(date!.getHours()).toBe(14)
    expect(date!.getMinutes()).toBe(30)
    expect(date!.getSeconds()).toBe(0)
  })

  it('does NOT read the device format as 9 May (the bug being fixed)', () => {
    const date = parseFiscalTimestamp('05-09-2026 14:30:00')!
    expect(date.getMonth()).not.toBe(4) // 4 === May
  })

  it('still parses ISO-8601 correctly — the path that already works today must not regress', () => {
    const date = parseFiscalTimestamp('2026-09-07T05:35:00.062Z')
    expect(date).not.toBeNull()
    expect(date!.toISOString()).toBe('2026-09-07T05:35:00.062Z')
  })

  it('returns null, not an Invalid Date, for an empty value', () => {
    expect(parseFiscalTimestamp('')).toBeNull()
    expect(parseFiscalTimestamp(null)).toBeNull()
    expect(parseFiscalTimestamp(undefined)).toBeNull()
  })

  it('returns null, not an Invalid Date or a throw, for garbage input', () => {
    expect(parseFiscalTimestamp('not a date')).toBeNull()
    expect(parseFiscalTimestamp('99-99-9999 99:99:99')).toBeNull()
  })
})
