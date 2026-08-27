/**
 * Staff authentication tests.
 *
 * `hashPin`/`verifyPin` are pure crypto functions tested directly.
 * `authenticateStaff` is tested against a lightweight fake
 * implementing only the `RubisDatabase` methods it calls — no SQLite
 * connection, real or mocked, is needed.
 */

import { describe, it, expect, vi } from 'vitest'
import { hashPin, verifyPin, authenticateStaff } from '../src/main/services/auth.js'
import type { RubisDatabase, StaffRow } from '../src/main/services/database.js'

/** Builds a fake `RubisDatabase` exposing only what `authenticateStaff` uses. */
function fakeDb(staff: Record<number, StaffRow>) {
  return {
    getStaffById: vi.fn((id: number) => staff[id])
  } as unknown as RubisDatabase
}

describe('hashPin', () => {
  it('produces a different salt (and hash) on every call for the same PIN', () => {
    const first = hashPin('1234')
    const second = hashPin('1234')
    expect(first).not.toBe(second)
    expect(first.split(':')[0]).not.toBe(second.split(':')[0])
  })

  it('produces a "<saltHex>:<hashHex>" formatted string', () => {
    const hash = hashPin('1234')
    const [salt, digest] = hash.split(':')
    expect(salt).toMatch(/^[0-9a-f]{32}$/)
    expect(digest).toMatch(/^[0-9a-f]{128}$/)
  })
})

describe('verifyPin', () => {
  it('returns true for the correct PIN', () => {
    const hash = hashPin('1234')
    expect(verifyPin('1234', hash)).toBe(true)
  })

  it('returns false for an incorrect PIN', () => {
    const hash = hashPin('1234')
    expect(verifyPin('9999', hash)).toBe(false)
  })

  it('returns false (never throws) for a malformed stored hash', () => {
    expect(verifyPin('1234', 'not-a-valid-hash')).toBe(false)
    expect(verifyPin('1234', '')).toBe(false)
    expect(verifyPin('1234', 'zz:zz')).toBe(false)
  })

  it('returns false for a hash with a mismatched digest length', () => {
    const hash = hashPin('1234')
    const [salt] = hash.split(':')
    expect(verifyPin('1234', `${salt}:ab`)).toBe(false)
  })
})

describe('authenticateStaff', () => {
  it('succeeds for a correct PIN on an active staff member', () => {
    const pinHash = hashPin('1234')
    const db = fakeDb({
      1: { id: 1, name: 'Admin', pin_hash: pinHash, role: 'admin', is_active: 1 }
    })

    const result = authenticateStaff(db, 1, '1234')

    expect(result).toEqual({
      success: true,
      data: { id: 1, name: 'Admin', role: 'admin' }
    })
  })

  it('fails on a wrong PIN', () => {
    const db = fakeDb({
      1: { id: 1, name: 'Admin', pin_hash: hashPin('1234'), role: 'admin', is_active: 1 }
    })

    const result = authenticateStaff(db, 1, '0000')

    expect(result.success).toBe(false)
  })

  it('fails for an inactive staff member even with the correct PIN', () => {
    const db = fakeDb({
      1: { id: 1, name: 'Retired', pin_hash: hashPin('1234'), role: 'cashier', is_active: 0 }
    })

    const result = authenticateStaff(db, 1, '1234')

    expect(result.success).toBe(false)
  })

  it('fails for an unknown staff id', () => {
    const db = fakeDb({})

    const result = authenticateStaff(db, 999, '1234')

    expect(result.success).toBe(false)
  })

  it('gives the same generic error for a wrong PIN and an unknown staff id', () => {
    const db = fakeDb({
      1: { id: 1, name: 'Admin', pin_hash: hashPin('1234'), role: 'admin', is_active: 1 }
    })

    const wrongPin = authenticateStaff(db, 1, '0000')
    const unknownId = authenticateStaff(db, 999, '0000')

    expect(wrongPin.error).toBe(unknownId.error)
  })
})
