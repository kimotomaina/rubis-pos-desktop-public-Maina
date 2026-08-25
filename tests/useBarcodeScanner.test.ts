/**
 * Barcode scanner hook tests (Phase 5).
 *
 * No @testing-library dependency is added — the hook is mounted with
 * `react-dom/client` directly and driven with real `KeyboardEvent`s
 * dispatched on `window`, matching this project's existing
 * "inject the real thing, mock only I/O" testing style. Vitest's fake
 * timers control `Date.now()` so keystroke deltas are deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  useBarcodeScanner,
  DEFAULT_SCAN_MAX_INTERVAL_MS,
  DEFAULT_SCAN_MIN_LENGTH,
  DEFAULT_DUPLICATE_SUPPRESS_MS
} from '../src/renderer/src/hooks/useBarcodeScanner.js'
import type { UseBarcodeScannerOptions } from '../src/renderer/src/hooks/useBarcodeScanner.js'

let container: HTMLDivElement
let root: Root
let unmounted = false

function TestHarness({
  onScan,
  options
}: {
  onScan: (barcode: string) => void
  options?: UseBarcodeScannerOptions
}) {
  useBarcodeScanner(onScan, options)
  return null
}

function mount(onScan: (barcode: string) => void, options?: UseBarcodeScannerOptions): void {
  act(() => {
    root.render(createElement(TestHarness, { onScan, options }))
  })
}

/** Dispatches a keydown for a single character key on `window`. */
function pressKey(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key }))
  })
}

/** Types a string as individual keydowns, advancing fake time `stepMs` between each. */
function typeString(text: string, stepMs: number): void {
  for (const char of text) {
    pressKey(char)
    vi.advanceTimersByTime(stepMs)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  unmounted = false
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  if (!unmounted) {
    act(() => root.unmount())
  }
  container.remove()
  vi.useRealTimers()
})

describe('useBarcodeScanner', () => {
  it('treats fast keystrokes ending in Enter as a scan', () => {
    const onScan = vi.fn()
    mount(onScan)

    typeString('012345678905', 5)
    pressKey('Enter')

    expect(onScan).toHaveBeenCalledTimes(1)
    expect(onScan).toHaveBeenCalledWith('012345678905')
  })

  it('ignores slow, human-paced typing followed by Enter', () => {
    const onScan = vi.fn()
    mount(onScan)

    typeString('hello', 200)
    pressKey('Enter')

    expect(onScan).not.toHaveBeenCalled()
  })

  it('rejects a fast-but-too-short sequence (default minLength)', () => {
    const onScan = vi.fn()
    mount(onScan)

    typeString('12', 5)
    pressKey('Enter')

    expect(onScan).not.toHaveBeenCalled()
  })

  it('only counts the trailing fast segment after a mid-sequence gap', () => {
    const onScan = vi.fn()
    mount(onScan)

    typeString('abc', 200)
    typeString('999888777', 5)
    pressKey('Enter')

    expect(onScan).toHaveBeenCalledTimes(1)
    expect(onScan).toHaveBeenCalledWith('999888777')
  })

  it('respects a custom maxIntervalMs/minLength configuration', () => {
    const onScan = vi.fn()
    mount(onScan, { maxIntervalMs: 10, minLength: 4 })

    typeString('55555', 8)
    pressKey('Enter')

    expect(onScan).toHaveBeenCalledWith('55555')
  })

  it('does not fire onScan when disabled', () => {
    const onScan = vi.fn()
    mount(onScan, { enabled: false })

    typeString('012345678905', 5)
    pressKey('Enter')

    expect(onScan).not.toHaveBeenCalled()
  })

  it('stops listening after unmount', () => {
    const onScan = vi.fn()
    mount(onScan)

    act(() => root.unmount())
    unmounted = true

    typeString('012345678905', 5)
    pressKey('Enter')

    expect(onScan).not.toHaveBeenCalled()
  })

  it('exposes its default timing constants', () => {
    expect(DEFAULT_SCAN_MAX_INTERVAL_MS).toBe(50)
    expect(DEFAULT_SCAN_MIN_LENGTH).toBe(3)
    expect(DEFAULT_DUPLICATE_SUPPRESS_MS).toBe(1000)
  })

  it('ignores the exact same barcode scanned twice within the suppression window', () => {
    const onScan = vi.fn()
    mount(onScan)

    typeString('012345678905', 5)
    pressKey('Enter')

    vi.advanceTimersByTime(500)

    typeString('012345678905', 5)
    pressKey('Enter')

    expect(onScan).toHaveBeenCalledTimes(1)
    expect(onScan).toHaveBeenCalledWith('012345678905')
  })

  it('accepts the same barcode again once the suppression window has elapsed', () => {
    const onScan = vi.fn()
    mount(onScan)

    typeString('012345678905', 5)
    pressKey('Enter')

    vi.advanceTimersByTime(DEFAULT_DUPLICATE_SUPPRESS_MS)

    typeString('012345678905', 5)
    pressKey('Enter')

    expect(onScan).toHaveBeenCalledTimes(2)
  })

  it('does not suppress a different barcode scanned right after another', () => {
    const onScan = vi.fn()
    mount(onScan)

    typeString('012345678905', 5)
    pressKey('Enter')

    typeString('111222333444', 5)
    pressKey('Enter')

    expect(onScan).toHaveBeenCalledTimes(2)
    expect(onScan).toHaveBeenNthCalledWith(1, '012345678905')
    expect(onScan).toHaveBeenNthCalledWith(2, '111222333444')
  })
})
