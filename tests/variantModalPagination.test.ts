/**
 * `VariantModal` pagination tests (docs/phase-167 Part B item 2).
 *
 * `paginate` itself is already proven generically in
 * `tests/paginate.test.ts` — this checks the component's own wiring:
 * page size, no pager when everything fits, and that a variant on a
 * later page is still selectable. Real mount, `react-dom/client`, same
 * pattern this project's other pagination tests already use.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import VariantModal from '../src/renderer/src/components/VariantModal.js'
import type { ProductSummary, VariantSummary } from '../src/renderer/src/types/shopify.js'

function makeProduct(variantCount: number): ProductSummary {
  return {
    id: 'gid://shopify/Product/1',
    title: 'Demo Product',
    handle: 'demo-product',
    featuredImage: null,
    variants: Array.from({ length: variantCount }, (_, i) => ({
      id: `variant-${i + 1}`,
      productId: 'gid://shopify/Product/1',
      title: `Variant ${i + 1}`,
      price: 100 + i,
      availableForSale: true,
      inventoryQuantity: 5,
      image: null,
      barcode: null
    }))
  }
}

let container: HTMLDivElement
let root: Root

afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove()
})

function mount(product: ProductSummary, onSelectVariant: (variant: VariantSummary) => void): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      createElement(VariantModal, { product, onSelectVariant, onClose: vi.fn() })
    )
  })
}

function variantButtons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button')).filter((b) =>
    b.textContent?.includes('Variant ')
  )
}

describe('VariantModal pagination (docs/phase-167 Part B item 2)', () => {
  it('shows at most 4 variants per page', () => {
    mount(makeProduct(6), vi.fn())
    expect(variantButtons()).toHaveLength(4)
    expect(container.textContent).toContain('Page 1 of 2')
  })

  it('shows no pager when every variant fits on one page', () => {
    mount(makeProduct(3), vi.fn())
    expect(variantButtons()).toHaveLength(3)
    expect(container.textContent).not.toContain('Page 1 of')
  })

  it('Next reveals the remaining variants, and one is still selectable', () => {
    const onSelectVariant = vi.fn()
    mount(makeProduct(6), onSelectVariant)

    const next = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Next')!
    act(() => next.click())

    const page2Buttons = variantButtons()
    expect(page2Buttons.map((b) => b.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('Variant 5'), expect.stringContaining('Variant 6')])
    )

    const variant5Button = page2Buttons.find((b) => b.textContent?.includes('Variant 5'))!
    act(() => variant5Button.click())
    expect(onSelectVariant).toHaveBeenCalledWith(expect.objectContaining({ id: 'variant-5' }))
  })
})
