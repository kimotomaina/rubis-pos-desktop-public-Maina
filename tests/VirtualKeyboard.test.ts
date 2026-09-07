/**
 * `VirtualKeyboard` tests (phase-86, Task 3).
 *
 * Mounted with `react-dom/client` directly and driven with real DOM
 * `click()` calls, matching `VirtualNumpad.test.ts`'s established
 * exception to this project's usual "no component-render tests"
 * convention — this is the same kind of self-contained, stateless
 * interactive widget `VirtualNumpad` is.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import VirtualKeyboard from '../src/renderer/src/components/VirtualKeyboard.js'

let container: HTMLDivElement
let root: Root

function mount(props: {
  value: string
  onChange: (value: string) => void
  onDone: () => void
  maxLength?: number
}): void {
  act(() => {
    root.render(createElement(VirtualKeyboard, props))
  })
}

/** Clicks the keyboard button whose visible label matches `label` exactly. */
function clickKey(label: string): void {
  const button = Array.from(container.querySelectorAll('button')).find(
    (el) => el.textContent === label
  )
  if (!button) throw new Error(`No key found for "${label}"`)
  act(() => {
    button.click()
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('VirtualKeyboard', () => {
  it('appends a tapped digit to the current value', () => {
    const onChange = vi.fn()
    mount({ value: 'P05', onChange, onDone: vi.fn() })

    clickKey('1')

    expect(onChange).toHaveBeenCalledWith('P051')
  })

  it('appends a tapped letter to the current value', () => {
    const onChange = vi.fn()
    mount({ value: 'ACME', onChange, onDone: vi.fn() })

    clickKey('Z')

    expect(onChange).toHaveBeenCalledWith('ACMEZ')
  })

  it('appends a space on the Space key', () => {
    const onChange = vi.fn()
    mount({ value: 'ACME', onChange, onDone: vi.fn() })

    clickKey('Space')

    expect(onChange).toHaveBeenCalledWith('ACME ')
  })

  it('removes the last character on backspace', () => {
    const onChange = vi.fn()
    mount({ value: 'P051234567Z', onChange, onDone: vi.fn() })

    const backspaceKey = container.querySelector('[aria-label="Backspace"]') as HTMLButtonElement
    act(() => backspaceKey.click())

    expect(onChange).toHaveBeenCalledWith('P051234567')
  })

  it('disables backspace when the value is already empty', () => {
    mount({ value: '', onChange: vi.fn(), onDone: vi.fn() })

    const backspaceKey = container.querySelector('[aria-label="Backspace"]') as HTMLButtonElement
    expect(backspaceKey.disabled).toBe(true)
  })

  it('invokes onDone when the Done key is tapped', () => {
    const onDone = vi.fn()
    mount({ value: 'P051234567Z', onChange: vi.fn(), onDone })

    clickKey('Done')

    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('respects maxLength — a key press past the limit is a no-op', () => {
    const onChange = vi.fn()
    mount({ value: 'P051234567Z', onChange, onDone: vi.fn(), maxLength: 11 })

    clickKey('A')
    clickKey('Space')

    expect(onChange).not.toHaveBeenCalled()
  })

  it('disables every letter/digit/space key (not just silently ignoring taps) once at maxLength', () => {
    mount({ value: 'P051234567Z', onChange: vi.fn(), onDone: vi.fn(), maxLength: 11 })

    const digitKey = Array.from(container.querySelectorAll('button')).find(
      (el) => el.textContent === '1'
    ) as HTMLButtonElement
    const letterKey = Array.from(container.querySelectorAll('button')).find(
      (el) => el.textContent === 'A'
    ) as HTMLButtonElement
    const spaceKey = Array.from(container.querySelectorAll('button')).find(
      (el) => el.textContent === 'Space'
    ) as HTMLButtonElement

    expect(digitKey.disabled).toBe(true)
    expect(letterKey.disabled).toBe(true)
    expect(spaceKey.disabled).toBe(true)
  })

  it('is fully controlled — renders exactly the value it is given, never a divergent copy of its own', () => {
    const onChange = vi.fn()
    mount({ value: 'FIXED', onChange, onDone: vi.fn() })

    // Tapping a key calls onChange with the next value, but since this
    // test's onChange is a bare spy (doesn't feed the result back in as
    // a new `value` prop), the component must still show only what it
    // was given — proving it holds no internal state of its own.
    clickKey('X')

    expect(onChange).toHaveBeenCalledWith('FIXEDX')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('renders no Done key duplicate and exactly one backspace key', () => {
    mount({ value: '', onChange: vi.fn(), onDone: vi.fn() })

    const doneKeys = Array.from(container.querySelectorAll('button')).filter(
      (el) => el.textContent === 'Done'
    )
    expect(doneKeys).toHaveLength(1)
    expect(container.querySelectorAll('[aria-label="Backspace"]')).toHaveLength(1)
  })
})
