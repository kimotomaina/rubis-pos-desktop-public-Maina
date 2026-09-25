/**
 * Phase E2(b) and E2(g): confirming, not fixing.
 *
 * phase-142 found only four things overflowing the corrected 1366x772
 * design box at scale 1: the header, the docked keyboard sheet, Admin,
 * and (under the old, wrong 1366x688 reference) the checkout stack —
 * which the review corrected by setting the reference to the checkout
 * stack's own natural height (772 = 80 header + 692 panel), so it now
 * fits exactly, with zero slack, unchanged (review change 1: "the
 * checkout stack is NOT restyled"). ManagerPinModal, LoginScreen and
 * LocationConfirmScreen were not on phase-142's overflow list at all.
 *
 * jsdom has no layout engine, so "fits 1366x772" can't be asserted as a
 * pixel measurement here — that is exactly what E3's committed
 * `npm run check:fit` CDP script is for, against the real built app.
 * What a unit test *can* confirm, cheaply and permanently, is the thing
 * that would silently break the fit: a hardcoded pixel dimension wide or
 * tall enough to blow the box regardless of zoom. This guards that, and
 * smoke-mounts LoginScreen and LocationConfirmScreen to confirm they
 * still render with no crash (ManagerPinModal: source inspection only,
 * see below).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import LoginScreen from '../src/renderer/src/components/LoginScreen.js'
import LocationConfirmScreen from '../src/renderer/src/components/LocationConfirmScreen.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'

/**
 * ManagerPinModal is checked by source inspection only, not a mount:
 * it imports the tripwire `VirtualNumpad` without a `.js` extension, and
 * `tests/**` compiles under `tsconfig.node.json`'s NodeNext resolution
 * (unlike Vite's bundler resolution the app itself runs under), which
 * requires one. Mounting it here would force either adding that
 * extension to a tripwire file — forbidden, it must stay byte-identical
 * — or leave `npm run typecheck` broken.
 */

/** Files this check covers: the three E2(g) screens, plus the checkout stack E2(b) leaves untouched. */
const FILES = [
  join('src', 'renderer', 'src', 'components', 'ManagerPinModal.tsx'),
  join('src', 'renderer', 'src', 'components', 'LoginScreen.tsx'),
  join('src', 'renderer', 'src', 'components', 'LocationConfirmScreen.tsx'),
  join('src', 'renderer', 'src', 'components', 'PosCheckoutPanel.tsx')
]

/** An arbitrary Tailwind pixel value, e.g. `h-[900px]` or `w-[1400px]`. */
const ARBITRARY_PX = /\b[hw]-\[(\d+)px\]/g

describe('E2(b)/(g): no hardcoded dimension could blow the 1366x772 box', () => {
  it.each(FILES)('%s declares no arbitrary px height/width at all', (path) => {
    const contents = readFileSync(join(process.cwd(), path), 'utf8')
    const matches = [...contents.matchAll(ARBITRARY_PX)]
    expect(matches).toEqual([])
  })
})

describe('E2(g): LoginScreen and LocationConfirmScreen still mount cleanly', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    if (root) act(() => root.unmount())
    container?.remove()
    useAuthStore.setState({ currentStaff: null, staffList: [] })
  })

  function mount(el: ReturnType<typeof createElement>): void {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(el))
  }

  it('LoginScreen mounts with a stubbed staff list, without throwing', async () => {
    window.api = { getStaffList: vi.fn().mockResolvedValue({ success: true, data: [] }) } as unknown as typeof window.api
    mount(createElement(LoginScreen))
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.textContent).toContain("Who's working?")
  })

  it('LocationConfirmScreen mounts while locations are loading, without throwing', () => {
    window.api = {
      listLocations: vi.fn(() => new Promise(() => {}))
    } as unknown as typeof window.api
    expect(() =>
      mount(
        createElement(LocationConfirmScreen, {
          currentLocationId: null,
          requestManagerPin: vi.fn(),
          onConfirmed: vi.fn()
        })
      )
    ).not.toThrow()
    expect(container.textContent).toContain('Confirm this till')
  })
})
