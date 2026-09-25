/**
 * `LocationPicker` card grid and paging (phase-141) — mounted with
 * `react-dom/client` and driven with real DOM clicks, matching
 * `setupScreens.test.ts`.
 *
 * The component is controlled: the parent owns `selectedLocationId`, so
 * these tests re-render with the new selection exactly as the real
 * screens do, and assert paging is presentation only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import LocationPicker, {
  type ShopifyLocationOption
} from '../src/renderer/src/components/LocationPicker.js'

let container: HTMLDivElement
let root: Root

/** `count` locations, every fifth one without an address. */
function locations(count: number): ShopifyLocationOption[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `gid://shopify/Location/${i + 1}`,
    name: `Rubis Station ${i + 1}`,
    address: (i + 1) % 5 === 0 ? undefined : `${i + 1} Mombasa Road, Nairobi`
  }))
}

function mount(props: Partial<Parameters<typeof LocationPicker>[0]> = {}): {
  onSelect: ReturnType<typeof vi.fn>
  onConfirm: ReturnType<typeof vi.fn>
} {
  const onSelect = vi.fn()
  const onConfirm = vi.fn()
  act(() => {
    root.render(
      createElement(LocationPicker, {
        shopName: 'Rubis Kenya',
        locations: locations(106),
        selectedLocationId: '',
        onSelect,
        onConfirm,
        confirming: false,
        confirmError: null,
        confirmLabel: 'Confirm Location',
        ...props
      })
    )
  })
  return { onSelect, onConfirm }
}

/** The location cards on the current page, in render order. */
function cards(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('[aria-pressed]')) as HTMLButtonElement[]
}

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!el) throw new Error(`No button "${label}"`)
  return el as HTMLButtonElement
}

function pageLabel(): string {
  return container.textContent?.match(/Page \d+ of \d+/)?.[0] ?? ''
}

function tap(el: HTMLElement): void {
  act(() => el.click())
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

describe('LocationPicker with 106 locations', () => {
  it('shows 9 cards in a 3-column grid on page 1 of 12, with Previous disabled', () => {
    mount()

    expect(cards()).toHaveLength(9)
    expect(pageLabel()).toBe('Page 1 of 12')
    expect(button('Previous').disabled).toBe(true)
    expect(button('Next').disabled).toBe(false)
    expect(container.querySelector('.grid-cols-3')).not.toBeNull()
  })

  it('shows each card’s name, and its address only when it has one', () => {
    mount()

    expect(cards()[0].textContent).toContain('Rubis Station 1')
    expect(cards()[0].textContent).toContain('1 Mombasa Road, Nairobi')
    expect(cards()[4].textContent).toContain('Rubis Station 5')
    expect(cards()[4].textContent).not.toContain('Mombasa Road')
  })

  it('Next moves to page 2 and Previous comes back', () => {
    mount()

    tap(button('Next'))
    expect(pageLabel()).toBe('Page 2 of 12')
    expect(cards()).toHaveLength(9)
    expect(cards()[0].textContent).toContain('Rubis Station 10')
    expect(button('Previous').disabled).toBe(false)

    tap(button('Previous'))
    expect(pageLabel()).toBe('Page 1 of 12')
    expect(cards()[0].textContent).toContain('Rubis Station 1')
  })

  it('shows the remaining 7 on the last page, with Next disabled', () => {
    mount()

    for (let i = 0; i < 11; i += 1) tap(button('Next'))

    expect(pageLabel()).toBe('Page 12 of 12')
    expect(cards()).toHaveLength(7)
    expect(cards()[6].textContent).toContain('Rubis Station 106')
    expect(button('Next').disabled).toBe(true)
    expect(button('Previous').disabled).toBe(false)
  })

  it('reaches every location exactly once across all 12 pages, in order', () => {
    mount()
    const seen: string[] = []

    for (let page = 1; page <= 12; page += 1) {
      seen.push(...cards().map((card) => card.firstElementChild?.textContent ?? ''))
      if (page < 12) tap(button('Next'))
    }

    expect(seen).toEqual(locations(106).map((location) => location.name))
    expect(new Set(seen).size).toBe(106)
  })

  it('calls onSelect with the location tapped on a later page', () => {
    const { onSelect } = mount()

    for (let i = 0; i < 4; i += 1) tap(button('Next'))
    expect(pageLabel()).toBe('Page 5 of 12')

    tap(cards()[2])

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('gid://shopify/Location/39')
  })

  it('keeps the selection marked after paging away and back', () => {
    const selectedLocationId = 'gid://shopify/Location/3'
    mount({ selectedLocationId })

    expect(cards()[2].getAttribute('aria-pressed')).toBe('true')
    expect(cards()[0].getAttribute('aria-pressed')).toBe('false')

    tap(button('Next'))
    expect(cards().every((card) => card.getAttribute('aria-pressed') === 'false')).toBe(true)

    tap(button('Previous'))
    expect(cards()[2].getAttribute('aria-pressed')).toBe('true')
  })

  it('opens on the page holding the already-selected location', () => {
    mount({ selectedLocationId: 'gid://shopify/Location/64' })

    expect(pageLabel()).toBe('Page 8 of 12')
    expect(cards()[0].textContent).toContain('Rubis Station 64')
    expect(cards()[0].getAttribute('aria-pressed')).toBe('true')
  })

  it('opens on page 1 when the saved location is not in the list at all', () => {
    mount({ selectedLocationId: 'gid://shopify/Location/9999' })

    expect(pageLabel()).toBe('Page 1 of 12')
    expect(cards().every((card) => card.getAttribute('aria-pressed') === 'false')).toBe(true)
  })

  it('leaves Confirm disabled until something is selected, then calls it', () => {
    mount()
    expect(button('Confirm Location').disabled).toBe(true)

    const { onConfirm } = mount({ selectedLocationId: 'gid://shopify/Location/1' })
    const confirm = button('Confirm Location')
    expect(confirm.disabled).toBe(false)
    tap(confirm)

    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('keeps the page controls big enough to tap', () => {
    mount()

    expect(button('Previous').className).toContain('h-11')
    expect(button('Next').className).toContain('h-11')
  })
})

describe('LocationPicker with a short list', () => {
  it('shows 5 locations on one page with both buttons disabled', () => {
    mount({ locations: locations(5) })

    expect(cards()).toHaveLength(5)
    expect(pageLabel()).toBe('Page 1 of 1')
    expect(button('Previous').disabled).toBe(true)
    expect(button('Next').disabled).toBe(true)
  })

  it('keeps the existing single-location message instead of one lone card', () => {
    mount({ locations: locations(1), selectedLocationId: 'gid://shopify/Location/1' })

    expect(cards()).toHaveLength(0)
    expect(container.textContent).toContain('Only one location exists')
    expect(container.textContent).toContain('Rubis Station 1')
  })

  it('still renders the shop name and a confirm error', () => {
    mount({ locations: locations(5), confirmError: 'Failed to save location' })

    expect(container.textContent).toContain('Connected to Rubis Kenya')
    expect(container.textContent).toContain('Failed to save location')
  })
})
