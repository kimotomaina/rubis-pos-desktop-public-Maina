/**
 * Server-side admin re-authorization tests (Phase 14 — Pre-Deployment
 * Security Patch).
 *
 * `requireAdminPin` is tested against a lightweight fake implementing
 * only the `RubisDatabase` method `authenticateStaff` uses — same
 * pattern as `auth.test.ts`, since this is a thin wrapper around it.
 */

import { describe, it, expect, vi } from 'vitest'
import { hashPin } from '../src/main/services/auth.js'
import { requireAdminPin } from '../src/main/lib/requireAdminPin.js'
import type { RubisDatabase, StaffRow } from '../src/main/services/database.js'

/** Builds a fake `RubisDatabase` exposing only what `authenticateStaff` uses. */
function fakeDb(staff: Record<number, StaffRow>) {
  return {
    getStaffById: vi.fn((id: number) => staff[id])
  } as unknown as RubisDatabase
}

describe('requireAdminPin', () => {
  it('succeeds for a correct PIN on an active admin account', () => {
    const db = fakeDb({
      1: { id: 1, name: 'Manager', pin_hash: hashPin('1234'), role: 'admin', is_active: 1 }
    })

    const result = requireAdminPin(db, 1, '1234')

    expect(result).toEqual({ success: true })
  })

  it('rejects a correct PIN belonging to a cashier account', () => {
    const db = fakeDb({
      2: { id: 2, name: 'Cashier', pin_hash: hashPin('1234'), role: 'cashier', is_active: 1 }
    })

    const result = requireAdminPin(db, 2, '1234')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Manager PIN required for this action')
  })

  it('rejects an unknown manager id', () => {
    const db = fakeDb({})

    const result = requireAdminPin(db, 999, '1234')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Manager PIN required for this action')
  })

  it('rejects a wrong PIN on a real admin account', () => {
    const db = fakeDb({
      1: { id: 1, name: 'Manager', pin_hash: hashPin('1234'), role: 'admin', is_active: 1 }
    })

    const result = requireAdminPin(db, 1, '0000')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Manager PIN required for this action')
  })

  it('rejects an inactive admin account even with the correct PIN', () => {
    const db = fakeDb({
      1: { id: 1, name: 'Former Manager', pin_hash: hashPin('1234'), role: 'admin', is_active: 0 }
    })

    const result = requireAdminPin(db, 1, '1234')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Manager PIN required for this action')
  })

  it('returns the generic error instead of throwing if authenticateStaff throws (Q2)', () => {
    const db = {
      getStaffById: vi.fn(() => {
        throw new Error('database connection lost')
      })
    } as unknown as RubisDatabase

    const result = requireAdminPin(db, 1, '1234')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Manager PIN required for this action')
  })

  it('gives the same generic error for every rejection reason', () => {
    const db = fakeDb({
      1: { id: 1, name: 'Manager', pin_hash: hashPin('1234'), role: 'admin', is_active: 1 },
      2: { id: 2, name: 'Cashier', pin_hash: hashPin('1234'), role: 'cashier', is_active: 1 }
    })

    const wrongPin = requireAdminPin(db, 1, '0000')
    const unknownId = requireAdminPin(db, 999, '0000')
    const cashierRole = requireAdminPin(db, 2, '1234')

    expect(wrongPin.error).toBe(unknownId.error)
    expect(unknownId.error).toBe(cashierRole.error)
  })
})
