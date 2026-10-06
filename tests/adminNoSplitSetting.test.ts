/**
 * Admin has no split-payments toggle (docs/phase-252-2, B3): the setting of phase 252 is gone. Real mount, the same way
 * `tests/adminPeripheralsUpdates.test.ts` does it, with an old `split_payments_enabled` row served to show it is ignored.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AdminScreen from '../src/renderer/src/components/AdminScreen.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'

let container: HTMLDivElement
let root: Root

const ok = <T,>(data?: T) => ({ success: true as const, data })

beforeEach(() => {
  const named: Record<string, unknown> = {
    platform: 'linux',
    getCurrentShift: vi.fn().mockResolvedValue(ok(null)),
    getAppVersion: vi.fn().mockResolvedValue('2.2.10'),
    onUpdateStatus: vi.fn(() => () => {}),
    getAllConfigs: vi.fn().mockResolvedValue(ok({ split_payments_enabled: 'true', mock_mpesa_enabled: 'false' }))
  }
  window.api = new Proxy(named, {
    get: (target, name: string) => target[name] ?? (target[name] = vi.fn().mockResolvedValue(ok(undefined)))
  }) as unknown as typeof window.api
  useAuthStore.setState({ currentStaff: { id: 1, name: 'Admin', role: 'admin' } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAuthStore.setState({ currentStaff: null })
})

describe('Admin', () => {
  it('has no split payments toggle on the System tab, or anywhere it opens to', async () => {
    await act(async () => {
      root.render(createElement(AdminScreen, { requestManagerPin: () => {} }))
      await Promise.resolve()
    })
    expect(container.textContent).not.toMatch(/split/i)

    const system = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('System'))
    if (!system) throw new Error('No System button')
    await act(async () => {
      system.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Startup Configuration')
    expect(container.textContent).not.toMatch(/split/i)
    expect(container.querySelector('[aria-label="Allow split payments"]')).toBeNull()
  })
})
