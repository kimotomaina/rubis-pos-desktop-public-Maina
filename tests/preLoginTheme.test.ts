/**
 * Pre-login screens mount on the shared `app-theme` root (phase-136).
 *
 * Mounted with `react-dom/client` and plain DOM queries, the same way
 * `VirtualNumpad.test.ts` and `NeedsAttentionPage.test.ts` do; `window.api`
 * is stubbed with just the calls each screen makes on mount.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import OnboardingScreen from '../src/renderer/src/components/OnboardingScreen.js'
import LoginScreen from '../src/renderer/src/components/LoginScreen.js'
import LocationConfirmScreen from '../src/renderer/src/components/LocationConfirmScreen.js'
import LocationPendingScreen from '../src/renderer/src/components/LocationPendingScreen.js'
import EtimsSetupGate from '../src/renderer/src/components/EtimsSetupGate.js'

let container: HTMLDivElement
let root: Root

async function mount(element: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(element)
    await Promise.resolve()
  })
}

function rootClasses(): string[] {
  return Array.from(container.firstElementChild?.classList ?? [])
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  window.api = {
    getStaffList: vi.fn().mockResolvedValue({ success: true, data: [] }),
    listLocations: vi.fn().mockResolvedValue({
      success: true,
      data: { shopName: 'Enjoy', locations: [{ id: 'gid://shopify/Location/1', name: 'Westlands' }] }
    })
  } as unknown as typeof window.api
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('pre-login screens use the shared theme', () => {
  it('OnboardingScreen', async () => {
    await mount(createElement(OnboardingScreen))
    expect(rootClasses()).toContain('app-theme')
  })

  it('LoginScreen', async () => {
    await mount(createElement(LoginScreen))
    expect(rootClasses()).toContain('app-theme')
  })

  it('LocationConfirmScreen', async () => {
    await mount(
      createElement(LocationConfirmScreen, {
        currentLocationId: null,
        requestManagerPin: vi.fn(),
        onConfirmed: vi.fn()
      })
    )
    expect(rootClasses()).toContain('app-theme')
  })

  it('LocationPendingScreen', async () => {
    await mount(createElement(LocationPendingScreen, { onLogout: vi.fn() }))
    expect(rootClasses()).toContain('app-theme')
  })

  it('EtimsSetupGate', async () => {
    await mount(createElement(EtimsSetupGate, { onComplete: vi.fn() }))
    expect(rootClasses()).toContain('app-theme')
  })
})
