/**
 * `PosCartTable` pagination tests (docs/phase-166 Commit E4).
 *
 * `paginate`/`pageOfIndex` themselves are already proven generically in
 * `tests/paginate.test.ts` — this file checks the component's own
 * wiring: page size, jump-to-scanned-line, and the step-back-on-remove
 * behaviour, which only show up once real DOM re-renders are involved.
 * Mounted with `react-dom/client`, the same pattern
 * `screensFitDesignBox.test.ts` already uses for a real component mount.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import PosCartTable, { CART_LINES_PER_PAGE } from '../src/renderer/src/components/PosCartTable.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const makeItem = (id: string): CartItem => ({
  id,
  productId: `product-${id}`,
  title: `Item ${id}`,
  variantTitle: 'Default',
  price: 10,
  quantity: 1,
  image: null
})

const makeItems = (count: number): CartItem[] =>
  Array.from({ length: count }, (_, i) => makeItem(String(i + 1)))

let container: HTMLDivElement
let root: Root

afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove()
})

function mount(props: {
  items: CartItem[]
  flashId?: string | null
  onUpdateQuantity?: (id: string, qty: number) => void
  onRemove?: (id: string) => void
}): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      createElement(PosCartTable, {
        items: props.items,
        flashId: props.flashId ?? null,
        onUpdateQuantity: props.onUpdateQuantity ?? vi.fn(),
        onRemove: props.onRemove ?? vi.fn()
      })
    )
  })
}

function rerender(props: {
  items: CartItem[]
  flashId?: string | null
  onUpdateQuantity?: (id: string, qty: number) => void
  onRemove?: (id: string) => void
}): void {
  act(() => {
    root.render(
      createElement(PosCartTable, {
        items: props.items,
        flashId: props.flashId ?? null,
        onUpdateQuantity: props.onUpdateQuantity ?? vi.fn(),
        onRemove: props.onRemove ?? vi.fn()
      })
    )
  })
}

function rowTitles(): string[] {
  return Array.from(container.querySelectorAll('tbody tr')).map(
    (tr) => tr.querySelector('td p')?.textContent ?? ''
  )
}

describe('PosCartTable pagination (docs/phase-166 Commit E4)', () => {
  it(`shows exactly ${CART_LINES_PER_PAGE} lines per page`, () => {
    mount({ items: makeItems(CART_LINES_PER_PAGE + 3) })
    expect(rowTitles()).toHaveLength(CART_LINES_PER_PAGE)
    expect(container.textContent).toContain(`Page 1 of 2`)
  })

  it('shows no pager at all when everything fits on one page', () => {
    mount({ items: makeItems(CART_LINES_PER_PAGE) })
    expect(container.textContent).not.toContain('Page 1 of')
  })

  it('Next shows the remaining lines on page 2', () => {
    mount({ items: makeItems(CART_LINES_PER_PAGE + 2) })
    const next = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Next'
    )!
    act(() => next.click())
    expect(rowTitles()).toEqual(['Item 8', 'Item 9'])
  })

  it('adding/scanning a line (flashId set) jumps to the page holding it', () => {
    const items = makeItems(CART_LINES_PER_PAGE + 2)
    mount({ items })
    // Starts on page 1 — line 9 is not visible yet.
    expect(rowTitles()).not.toContain('Item 9')

    rerender({ items, flashId: '9' })
    expect(rowTitles()).toContain('Item 9')
    expect(container.textContent).toContain('Page 2 of 2')
  })

  it('removing the only line left on a page steps back a page automatically', () => {
    const items = makeItems(CART_LINES_PER_PAGE + 1)
    mount({ items })
    const next = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Next'
    )!
    act(() => next.click())
    expect(rowTitles()).toEqual(['Item 8'])

    // The caller removes the line (cartStore.removeItem) — simulate the
    // resulting prop update, page 2 no longer exists.
    rerender({ items: items.slice(0, CART_LINES_PER_PAGE) })
    expect(container.textContent).not.toContain('Page 2 of')
    expect(rowTitles()).toHaveLength(CART_LINES_PER_PAGE)
  })
})
