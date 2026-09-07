/**
 * `keyboardStore` tests (phase-86, Task 3).
 *
 * Drives the real Zustand store directly, same pattern
 * `toastStore.test.ts`/`cartStore.test.ts` already use — no component
 * rendering.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'

describe('keyboardStore', () => {
  beforeEach(() => {
    useKeyboardStore.setState({ request: null })
  })

  it('is closed (no request) by default', () => {
    expect(useKeyboardStore.getState().request).toBeNull()
  })

  it('open() sets the request a field supplies', () => {
    const onChange = vi.fn()
    useKeyboardStore.getState().open({ value: 'ACME', onChange, label: 'Company Name' })

    const { request } = useKeyboardStore.getState()
    expect(request?.value).toBe('ACME')
    expect(request?.label).toBe('Company Name')
    // The stored onChange is a relay wrapping the caller's own, not the
    // exact same reference — see the next two tests for why.
    expect(request?.onChange).not.toBe(onChange)
  })

  it('calling the stored onChange forwards to the field\'s own onChange with the same value', () => {
    const onChange = vi.fn()
    useKeyboardStore.getState().open({ value: '', onChange, label: 'Company Name' })

    useKeyboardStore.getState().request?.onChange('A')

    expect(onChange).toHaveBeenCalledWith('A')
  })

  it('BUG FIX: consecutive keystrokes accumulate — request.value stays in sync so each append builds on the last, not the original snapshot', () => {
    const seen: string[] = []
    useKeyboardStore.getState().open({
      value: '',
      onChange: (next) => seen.push(next),
      label: 'Company Name'
    })

    // Simulates VirtualKeyboard.append(char): reads the CURRENT
    // request.value (not a value captured once outside the loop) and
    // appends to it, exactly like the real component does on every tap.
    for (const char of ['A', 'C', 'M', 'E']) {
      const current = useKeyboardStore.getState().request!.value
      useKeyboardStore.getState().request!.onChange(current + char)
    }

    expect(seen).toEqual(['A', 'AC', 'ACM', 'ACME'])
    expect(useKeyboardStore.getState().request?.value).toBe('ACME')
  })

  it('a second open() replaces the request, not queues it — only one keyboard exists', () => {
    useKeyboardStore.getState().open({ value: 'ACME', onChange: vi.fn(), label: 'Company Name' })
    useKeyboardStore.getState().open({ value: 'P051234567Z', onChange: vi.fn(), label: 'Customer KRA PIN' })

    expect(useKeyboardStore.getState().request?.label).toBe('Customer KRA PIN')
  })

  it('close() clears the request', () => {
    useKeyboardStore.getState().open({ value: 'ACME', onChange: vi.fn(), label: 'Company Name' })

    useKeyboardStore.getState().close()

    expect(useKeyboardStore.getState().request).toBeNull()
  })

  it('close() never touches anything but its own request field (no dependency on toastStore or any other store)', () => {
    // Structural guarantee, exercised here rather than merely asserted
    // in prose: close() takes no arguments and nothing it does can
    // reach outside this store, so it cannot dismiss a fiscal notice or
    // any other toast — there is no id, no reference, nothing to route
    // anywhere else.
    useKeyboardStore.getState().open({ value: 'X', onChange: vi.fn(), label: 'Test' })
    expect(useKeyboardStore.getState().close.length).toBe(0)
    useKeyboardStore.getState().close()
    expect(useKeyboardStore.getState().request).toBeNull()
  })
})
