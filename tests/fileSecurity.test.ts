/**
 * Database file permission hardening tests (Phase 12, Task 4).
 *
 * `node:fs`'s `chmodSync` is injected as a recording fake — never
 * touches the real filesystem.
 */

import { describe, it, expect, vi } from 'vitest'
import { restrictToOwnerOnly, OWNER_ONLY_MODE } from '../src/main/lib/fileSecurity.js'

describe('restrictToOwnerOnly', () => {
  it('chmods the given path to owner-only (0600) and returns true', () => {
    const chmod = vi.fn()

    const result = restrictToOwnerOnly(chmod, '/data/rubis-pos.db')

    expect(result).toBe(true)
    expect(chmod).toHaveBeenCalledWith('/data/rubis-pos.db', OWNER_ONLY_MODE)
  })

  it('returns false and does not throw when chmod fails', () => {
    const chmod = vi.fn(() => {
      throw new Error('EPERM')
    })

    expect(() => restrictToOwnerOnly(chmod, '/data/rubis-pos.db')).not.toThrow()
    expect(restrictToOwnerOnly(chmod, '/data/rubis-pos.db')).toBe(false)
  })
})
