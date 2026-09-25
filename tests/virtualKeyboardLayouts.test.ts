/**
 * The opt-in key sets added in phase-137: `VirtualKeyboard`'s `text`
 * layout and `VirtualNumpad`'s `multipleDecimals`. Their defaults stay
 * covered, unmodified, by `VirtualKeyboard.test.ts` and
 * `VirtualNumpad.test.ts`; this file only covers the new options and
 * proves the defaults did not pick them up.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import VirtualKeyboard from '../src/renderer/src/components/VirtualKeyboard.js'
import VirtualNumpad from '../src/renderer/src/components/VirtualNumpad.js'

let container: HTMLDivElement
let root: Root

function render(element: ReturnType<typeof createElement>): void {
  act(() => root.render(element))
}

function key(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((el) => el.textContent === label)
}

function click(label: string): void {
  const button = key(label)
  if (!button) throw new Error(`No key found for "${label}"`)
  act(() => button.click())
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

describe('VirtualKeyboard text layout', () => {
  it('types lower case by default', () => {
    const onChange = vi.fn()
    render(createElement(VirtualKeyboard, { value: 'shp', onChange, onDone: vi.fn(), layout: 'text' }))

    click('a')

    expect(onChange).toHaveBeenCalledWith('shpa')
    expect(key('A')).toBeUndefined()
  })

  it('Shift toggles upper case on and off', () => {
    const onChange = vi.fn()
    render(createElement(VirtualKeyboard, { value: '', onChange, onDone: vi.fn(), layout: 'text' }))
    const shift = container.querySelector('[aria-label="Shift"]') as HTMLButtonElement

    act(() => shift.click())
    expect(shift.getAttribute('aria-pressed')).toBe('true')
    click('Q')
    expect(onChange).toHaveBeenLastCalledWith('Q')

    act(() => shift.click())
    click('q')
    expect(onChange).toHaveBeenLastCalledWith('q')
  })

  it('types the symbols a URL and a Shopify token need', () => {
    for (const symbol of ['-', '_', '.', ':', '/', '@']) {
      const onChange = vi.fn()
      render(createElement(VirtualKeyboard, { value: 'x', onChange, onDone: vi.fn(), layout: 'text' }))
      click(symbol)
      expect(onChange).toHaveBeenCalledWith(`x${symbol}`)
    }
  })

  it('the default caps layout has no Shift key and no symbol row', () => {
    render(createElement(VirtualKeyboard, { value: '', onChange: vi.fn(), onDone: vi.fn() }))

    expect(container.querySelector('[aria-label="Shift"]')).toBeNull()
    expect(key('_')).toBeUndefined()
    expect(key('A')).toBeDefined()
  })
})

describe('VirtualNumpad multipleDecimals', () => {
  it('lets the decimal key be pressed again, for an IP address', () => {
    const onChange = vi.fn()
    render(createElement(VirtualNumpad, { value: '192.168', onChange, multipleDecimals: true }))

    click('.')

    expect(onChange).toHaveBeenCalledWith('192.168.')
  })

  it('stays off by default: a second decimal point is still ignored', () => {
    const onChange = vi.fn()
    render(createElement(VirtualNumpad, { value: '12.5', onChange }))

    click('.')

    expect(onChange).not.toHaveBeenCalled()
  })

  it('never overrides allowDecimal={false}', () => {
    const onChange = vi.fn()
    render(createElement(VirtualNumpad, { value: '80', onChange, allowDecimal: false, multipleDecimals: true }))

    click('.')

    expect(onChange).not.toHaveBeenCalled()
  })
})
