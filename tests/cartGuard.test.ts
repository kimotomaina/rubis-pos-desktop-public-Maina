/**
 * `needsManagerApproval` (docs/phase-197): every branch of the rule that
 * decides which cart changes need a manager.
 */

import { describe, it, expect } from 'vitest'
import { needsManagerApproval } from '../src/renderer/src/lib/cartGuard.js'

describe('needsManagerApproval', () => {
  it('needs approval to remove a line, whatever its quantity', () => {
    expect(needsManagerApproval({ kind: 'remove', from: 1 })).toBe(true)
    expect(needsManagerApproval({ kind: 'remove', from: 40 })).toBe(true)
  })

  it('needs approval to clear the cart', () => {
    expect(needsManagerApproval({ kind: 'clear', from: 3 })).toBe(true)
  })

  it('needs approval when a quantity goes down', () => {
    expect(needsManagerApproval({ kind: 'setQuantity', from: 3, to: 2 })).toBe(true)
  })

  it('needs approval when a quantity goes to zero', () => {
    expect(needsManagerApproval({ kind: 'setQuantity', from: 1, to: 0 })).toBe(true)
  })

  it('needs no approval when a quantity goes up', () => {
    expect(needsManagerApproval({ kind: 'setQuantity', from: 2, to: 3 })).toBe(false)
  })

  it('needs no approval when a quantity stays the same', () => {
    expect(needsManagerApproval({ kind: 'setQuantity', from: 2, to: 2 })).toBe(false)
  })

  it('treats a quantity change with no target as a reduction, so a malformed call cannot skip the manager', () => {
    expect(needsManagerApproval({ kind: 'setQuantity', from: 2 })).toBe(true)
  })
})
