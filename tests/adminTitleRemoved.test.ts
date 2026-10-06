/**
 * The plain "Admin" title above the Admin screens is gone (docs/phase-220):
 * the header tab and the breadcrumb's Admin crumb are the only "Admin" left.
 * The removed element was `<h2 className="shrink-0 px-6 pt-6 pb-4 text-lg font-semibold text-slate-700">Admin</h2>`
 * in App.tsx's Admin branch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import AdminScreen from '../src/renderer/src/components/AdminScreen.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'

const APP_TSX = readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'App.tsx'), 'utf8')

let container: HTMLDivElement
let root: Root

const ok = <T,>(data?: T) => ({ success: true as const, data })

function stubApi(): void {
  const named: Record<string, unknown> = {
    platform: 'linux',
    getCurrentShift: vi.fn().mockResolvedValue(ok(null)),
    getAppVersion: vi.fn().mockResolvedValue('2.2.0'),
    onUpdateStatus: vi.fn(() => () => {})
  }
  window.api = new Proxy(named, {
    get: (target, name: string) => target[name] ?? (target[name] = vi.fn().mockResolvedValue(ok(undefined)))
  }) as unknown as typeof window.api
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(createElement(AdminScreen, { requestManagerPin: () => {} }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(label: string): Promise<void> {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!el) throw new Error(`No button "${label}"`)
  await act(async () => {
    el.click()
    await Promise.resolve()
  })
}

/** Any heading whose whole text is "Admin". */
const adminHeadings = (): Element[] =>
  Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6')).filter((h) => h.textContent?.trim() === 'Admin')

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useKeyboardStore.setState({ request: null })
  useAuthStore.setState({ currentStaff: { id: 1, name: 'Admin', role: 'admin' } })
  stubApi()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the plain "Admin" title is gone', () => {
  it('App.tsx renders no heading that reads Admin, and keeps the header tab', () => {
    expect(APP_TSX).not.toMatch(/<h[1-6][^>]*>\s*Admin\s*<\/h[1-6]>/)
    expect(APP_TSX).toMatch(/>\s*Admin\s*<\/button>/)
  })

  it('the Admin card grid shows no Admin heading', async () => {
    await mount()
    expect(adminHeadings()).toEqual([])
  })

  // CHANGED (docs/phase-246). OLD: 'End of Day' was a card of its own. NEW: it is a section of the Reports tab, so it is no longer listed.
  it.each(['Overview', 'Reports'])(
    '%s shows no Admin heading, and keeps the Admin crumb as the way back',
    async (section) => {
      await mount()
      await click(section)

      expect(adminHeadings()).toEqual([])
      const crumbs = Array.from(container.querySelectorAll('nav[aria-label="Breadcrumb"] button')).map(
        (b) => b.textContent
      )
      expect(crumbs[0]).toBe('Back to Admin')
    }
  )
})
