/**
 * `VirtualNumpad`'s `size` prop (phase-146) — a new optional prop, not a
 * change to any existing behavior: `VirtualNumpad.test.ts` (the tripwire)
 * mounts the component with no `size` prop at all and keeps passing
 * unmodified, proving the default (`'default'`, `h-16` keys) renders
 * exactly as it always has. This file covers the new `'compact'` size
 * (`h-12`, used by `PosCheckoutPanel`'s Cash panel) separately, so the
 * tripwire file itself never needs to know the prop exists.
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
  size?: 'default' | 'compact'
  onEnter?: () => void
}): void {
  act(() => {
    root.render(createElement(VirtualNumpad, props))
  })
}

function key(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!el) throw new Error(`No numpad key found for "${label}"`)
  return el as HTMLButtonElement
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

describe('VirtualNumpad size="compact"', () => {
  it('defaults to the unchanged h-16 keys when size is omitted', () => {
    mount({ value: '', onChange: vi.fn() })
    expect(key('1').className).toContain('h-16')
    expect(key('Clear').className).toContain('h-16')
  })

  it('renders h-12 keys, and only the height class differs from default', () => {
    mount({ value: '', onChange: vi.fn(), size: 'compact' })
    const compactDigit = key('1').className
    expect(compactDigit).toContain('h-12')
    expect(compactDigit).not.toContain('h-16')
    expect(key('Clear').className).toContain('h-12')

    act(() => root.unmount())
    root = createRoot(container)
    mount({ value: '', onChange: vi.fn() })
    const defaultDigit = key('1').className

    // Same class list except the height token.
    expect(defaultDigit.replace('h-16', 'h-12')).toBe(compactDigit)
  })

  it('every key still types at compact size, identically to default', () => {
    const onChange = vi.fn()
    mount({ value: '12', onChange, size: 'compact' })

    act(() => key('3').click())
    expect(onChange).toHaveBeenCalledWith('123')

    act(() => key('Clear').click())
    expect(onChange).toHaveBeenCalledWith('')

    const backspaceKey = container.querySelector('[aria-label="Backspace"]') as HTMLButtonElement
    act(() => backspaceKey.click())
    expect(onChange).toHaveBeenLastCalledWith('1')
  })

  it('compact + onEnter still renders and fires Enter', () => {
    const onEnter = vi.fn()
    mount({ value: '', onChange: vi.fn(), size: 'compact', onEnter })
    const enterKey = Array.from(container.querySelectorAll('button')).find(
      (el) => el.textContent === 'Enter'
    ) as HTMLButtonElement
    expect(enterKey.className).toContain('h-12')
    act(() => enterKey.click())
    expect(onEnter).toHaveBeenCalledTimes(1)
  })
})
