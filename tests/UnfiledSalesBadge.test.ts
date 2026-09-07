/**
 * `UnfiledSalesBadge` tests (phase-95) — mounted with `react-dom/client`
 * and driven with a real DOM `.click()`, matching `VirtualKeyboard
 * .test.ts`'s stated exception for a self-contained, stateless
 * interactive widget (this one is fully controlled by its `count` prop,
 * same shape as `VirtualNumpad`/`VirtualKeyboard`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import UnfiledSalesBadge from '../src/renderer/src/components/UnfiledSalesBadge.js'

let container: HTMLDivElement
let root: Root

function mount(props: { count: number | null; onClick: () => void }): void {
  act(() => {
    root.render(createElement(UnfiledSalesBadge, props))
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

describe('UnfiledSalesBadge', () => {
  it('renders nothing before the first count is read', () => {
    mount({ count: null, onClick: vi.fn() })
    expect(container.querySelector('button')).toBeNull()
  })

  it('reads quiet and clean at zero', () => {
    mount({ count: 0, onClick: vi.fn() })
    expect(container.textContent).toBe('All sales filed')
  })

  it('shows a plain count once there are unfiled sales', () => {
    mount({ count: 3, onClick: vi.fn() })
    expect(container.textContent).toBe('3 sales not filed')
  })

  it('calls onClick when tapped', () => {
    const onClick = vi.fn()
    mount({ count: 2, onClick })

    act(() => {
      container.querySelector('button')!.click()
    })

    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
