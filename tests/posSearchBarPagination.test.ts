/**
 * `PosSearchBar` dropdown result cap (docs/phase-166 Commit E4).
 *
 * `hasMoreMatches`/`getAutocompleteMatches` are already proven
 * generically in `tests/posSearch.test.ts` — this checks the
 * component's own wiring: the dropdown shows at most
 * `AUTOCOMPLETE_MAX_RESULTS` rows and hints "refine your search" when
 * there were more. Real mount, `react-dom/client`, same pattern this
 * phase's other pagination tests use.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import PosSearchBar from '../src/renderer/src/components/PosSearchBar.js'
import { AUTOCOMPLETE_MAX_RESULTS } from '../src/renderer/src/lib/posSearch.js'
import type { ProductSummary } from '../src/renderer/src/types/shopify.js'

function makeProduct(id: string): ProductSummary {
  return {
    id,
    title: `RUBIS Item ${id}`,
    handle: `rubis-item-${id}`,
    featuredImage: null,
    variants: [
      {
        id: `${id}-variant`,
        productId: id,
        title: 'Default',
        price: 10,
        availableForSale: true,
        inventoryQuantity: 5,
        image: null,
        barcode: null
      }
    ]
  }
}

let container: HTMLDivElement
let root: Root

afterEach(() => {
  if (root) act(() => root.unmount())
  container?.remove()
  vi.useRealTimers()
})

async function mountAndType(products: ProductSummary[], query: string): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root.render(
      createElement(PosSearchBar, {
        products,
        onAddVariant: vi.fn(),
        onOpenVariantPicker: vi.fn(),
        onNotFound: vi.fn()
      })
    )
  })

  const input = container.querySelector('input') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    // Clears the 100ms autocomplete debounce.
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
}

describe('PosSearchBar dropdown cap (docs/phase-166 Commit E4)', () => {
  it(`shows at most ${AUTOCOMPLETE_MAX_RESULTS} rows and no hint when matches fit`, async () => {
    const products = [makeProduct('1'), makeProduct('2')]
    await mountAndType(products, 'RUBIS')

    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2)
    expect(container.textContent).not.toContain('Refine your search')
  })

  it('caps the dropdown and shows "refine your search" when there are more matches', async () => {
    const products = Array.from({ length: AUTOCOMPLETE_MAX_RESULTS + 3 }, (_, i) => makeProduct(String(i)))
    await mountAndType(products, 'RUBIS')

    expect(container.querySelectorAll('[role="option"]')).toHaveLength(AUTOCOMPLETE_MAX_RESULTS)
    expect(container.textContent).toContain('Refine your search')
  })
})
