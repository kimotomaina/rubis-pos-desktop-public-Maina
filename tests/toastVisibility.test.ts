/**
 * `visibleToasts` tests (docs/phase-166 Commit E4).
 *
 * Pure derivation, tested directly without mounting `ToastStack` — same
 * convention as `paginate.ts`'s own tests.
 */

import { describe, it, expect } from 'vitest'
import { visibleToasts, MAX_VISIBLE_TOASTS } from '../src/renderer/src/lib/toastVisibility.js'

interface FakeToast {
  id: string
  pinned?: boolean
}

const toast = (id: string, pinned = false): FakeToast => ({ id, pinned })

describe('visibleToasts', () => {
  it('shows everything when there are 3 or fewer toasts', () => {
    const toasts = [toast('a'), toast('b')]
    expect(visibleToasts(toasts).map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('caps at MAX_VISIBLE_TOASTS (3) routine toasts, dropping the oldest first', () => {
    const toasts = [toast('a'), toast('b'), toast('c'), toast('d')]
    expect(visibleToasts(toasts).map((t) => t.id)).toEqual(['b', 'c', 'd'])
  })

  it('never drops a pinned toast, even when it is the oldest and the stack is at the cap', () => {
    const toasts = [toast('fiscal', true), toast('b'), toast('c')]
    expect(visibleToasts(toasts).map((t) => t.id)).toEqual(['fiscal', 'b', 'c'])
  })

  it('drops the oldest ROUTINE toast to make room, keeping the pinned one, when over the cap', () => {
    const toasts = [toast('a'), toast('fiscal', true), toast('b'), toast('c'), toast('d')]
    // 4 routine (a, b, c, d) + 1 pinned = 5 total, cap 3 → 2 routine slots left, keep the newest 2.
    expect(visibleToasts(toasts).map((t) => t.id)).toEqual(['fiscal', 'c', 'd'])
  })

  it('preserves original stacking order among whatever remains visible', () => {
    const toasts = [toast('a'), toast('fiscal', true), toast('b')]
    expect(visibleToasts(toasts).map((t) => t.id)).toEqual(['a', 'fiscal', 'b'])
  })

  it('respects a custom max', () => {
    const toasts = [toast('a'), toast('b'), toast('c')]
    expect(visibleToasts(toasts, 1).map((t) => t.id)).toEqual(['c'])
  })

  it('MAX_VISIBLE_TOASTS is 3', () => {
    expect(MAX_VISIBLE_TOASTS).toBe(3)
  })
})
