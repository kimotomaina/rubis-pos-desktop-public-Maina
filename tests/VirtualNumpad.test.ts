/**
 * `VirtualNumpad` tests — touch UI overhaul.
 *
 * Mounted with `react-dom/client` directly and driven with real
 * DOM `click()` calls, matching this project's existing
 * "inject the real thing, mock only I/O" testing style (see
 * `useBarcodeScanner.test.ts`) — no @testing-library dependency added.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import VirtualNumpad from '../src/renderer/src/components/VirtualNumpad.js'

let container: HTMLDivElement
let root: Root

function mount(props: {
  value: string
  onChange: (value: string) => void
  onEnter?: () => void
  allowDecimal?: boolean
}): void {
  act(() => {
    root.render(createElement(VirtualNumpad, props))
  })
}

/** Clicks the numpad button whose visible label matches `label` exactly. */
function clickKey(label: string): void {
  const button = Array.from(container.querySelectorAll('button')).find(
    (el) => el.textContent === label
  )
  if (!button) throw new Error(`No numpad key found for "${label}"`)
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

describe('VirtualNumpad', () => {
  it('appends a tapped digit to the current value', () => {
    const onChange = vi.fn()
    mount({ value: '12', onChange })

    clickKey('3')

    expect(onChange).toHaveBeenCalledWith('123')
  })

  it('appends the decimal point once', () => {
    const onChange = vi.fn()
    mount({ value: '12', onChange })

    clickKey('.')

    expect(onChange).toHaveBeenCalledWith('12.')
  })

  it('ignores a second decimal point', () => {
    const onChange = vi.fn()
    mount({ value: '12.5', onChange })

    clickKey('.')

    expect(onChange).not.toHaveBeenCalled()
  })

  it('disables the decimal key when allowDecimal is false', () => {
    const onChange = vi.fn()
    mount({ value: '1234', onChange, allowDecimal: false })

    const decimalKey = container.querySelector('[aria-label="Decimal point"]') as HTMLButtonElement
    expect(decimalKey.disabled).toBe(true)

    act(() => decimalKey.click())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('removes the last character on backspace', () => {
    const onChange = vi.fn()
    mount({ value: '123', onChange })

    const backspaceKey = container.querySelector('[aria-label="Backspace"]') as HTMLButtonElement
    act(() => backspaceKey.click())

    expect(onChange).toHaveBeenCalledWith('12')
  })

  it('clears the entire value on Clear', () => {
    const onChange = vi.fn()
    mount({ value: '4999.50', onChange })

    clickKey('Clear')

    expect(onChange).toHaveBeenCalledWith('')
  })

  it('does not render an Enter key when onEnter is omitted', () => {
    mount({ value: '', onChange: vi.fn() })

    const enterKey = Array.from(container.querySelectorAll('button')).find(
      (el) => el.textContent === 'Enter'
    )
    expect(enterKey).toBeUndefined()
  })

  it('invokes onEnter when the Enter key is tapped', () => {
    const onEnter = vi.fn()
    mount({ value: '500', onChange: vi.fn(), onEnter })

    clickKey('Enter')

    expect(onEnter).toHaveBeenCalledTimes(1)
  })
})
