/**
 * `toastStore` tests (phase-84, Task 2).
 *
 * Drives the real Zustand store directly (`useToastStore.getState()`),
 * same pattern `cartStore.test.ts`/`cartCheckout.test.ts` already use —
 * no component rendering.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useToastStore } from '../src/renderer/src/stores/toastStore.js'
import type { ToastInput } from '../src/renderer/src/stores/toastStore.js'

function makeInput(overrides: Partial<ToastInput> = {}): ToastInput {
  return {
    id: 'a',
    message: 'Hello',
    tone: 'info',
    timeoutMs: 5000,
    onDismiss: vi.fn(),
    ...overrides
  }
}

describe('toastStore', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] })
  })

  it('show() appends a new entry for a new id', () => {
    useToastStore.getState().show(makeInput({ id: 'a' }))

    const { toasts } = useToastStore.getState()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].id).toBe('a')
  })

  it('show() with an id already in the stack replaces it in place, not a duplicate', () => {
    useToastStore.getState().show(makeInput({ id: 'a', message: 'first' }))
    useToastStore.getState().show(makeInput({ id: 'b', message: 'other' }))
    useToastStore.getState().show(makeInput({ id: 'a', message: 'second' }))

    const { toasts } = useToastStore.getState()
    expect(toasts).toHaveLength(2)
    // Replaced in place — still at index 0, not moved to the end.
    expect(toasts[0].id).toBe('a')
    expect(toasts[0].message).toBe('second')
    expect(toasts[1].id).toBe('b')
  })

  it('stamps a fresh updatedAt on every show() call, even a replace with otherwise-identical fields', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(1000)
    useToastStore.getState().show(makeInput({ id: 'a' }))
    expect(useToastStore.getState().toasts[0].updatedAt).toBe(1000)

    now.mockReturnValueOnce(2000)
    useToastStore.getState().show(makeInput({ id: 'a' }))
    expect(useToastStore.getState().toasts[0].updatedAt).toBe(2000)

    now.mockRestore()
  })

  it('dismiss() removes the matching entry and leaves the others untouched', () => {
    useToastStore.getState().show(makeInput({ id: 'a' }))
    useToastStore.getState().show(makeInput({ id: 'b' }))

    useToastStore.getState().dismiss('a')

    const { toasts } = useToastStore.getState()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].id).toBe('b')
  })

  it('dismiss() of an id that is not present is a harmless no-op', () => {
    useToastStore.getState().show(makeInput({ id: 'a' }))

    useToastStore.getState().dismiss('does-not-exist')

    expect(useToastStore.getState().toasts).toHaveLength(1)
  })

  it('appends new entries at the end, preserving arrival order (newest at the bottom of the column)', () => {
    useToastStore.getState().show(makeInput({ id: 'a' }))
    useToastStore.getState().show(makeInput({ id: 'b' }))
    useToastStore.getState().show(makeInput({ id: 'c' }))

    expect(useToastStore.getState().toasts.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('a null timeoutMs is stored as-is (the one case ToastShell never schedules a dismissal for)', () => {
    useToastStore.getState().show(makeInput({ id: 'a', timeoutMs: null }))

    expect(useToastStore.getState().toasts[0].timeoutMs).toBeNull()
  })
})
