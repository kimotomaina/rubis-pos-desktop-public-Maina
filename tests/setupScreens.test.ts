/**
 * Pre-login setup screens (phase-137): paired fields, no helper text, and
 * the on-screen keyboard or numpad on tap.
 *
 * Each screen is mounted together with the real `VirtualKeyboardModal`,
 * exactly as `main.tsx` mounts them side by side, and driven with real
 * clicks on the real keys, so the whole path is exercised:
 * field → `keyboardStore.open()` → overlay → key → relay → field state.
 * `window.api` is stubbed with only the calls each screen makes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, Fragment } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import EtimsSetupGate from '../src/renderer/src/components/EtimsSetupGate.js'
import OnboardingScreen from '../src/renderer/src/components/OnboardingScreen.js'
import VirtualKeyboardModal from '../src/renderer/src/components/VirtualKeyboardModal.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'

let container: HTMLDivElement
let root: Root

async function mount(screen: ReturnType<typeof createElement>): Promise<void> {
  await act(async () => {
    root.render(createElement(Fragment, null, screen, createElement(VirtualKeyboardModal)))
    await Promise.resolve()
  })
}

function input(id: string): HTMLInputElement {
  const el = container.querySelector(`#${id}`)
  if (!el) throw new Error(`No input #${id}`)
  return el as HTMLInputElement
}

function tap(el: HTMLElement): void {
  act(() => el.click())
}

function sheet(): HTMLElement | null {
  return container.querySelector('[role="dialog"]')
}

/** Taps each key in the open sheet in order, the way a person would. */
function typeKeys(keys: string[]): void {
  for (const label of keys) {
    const button = Array.from(sheet()?.querySelectorAll('button') ?? []).find(
      (el) => el.textContent === label
    )
    if (!button) throw new Error(`No key "${label}" in the open sheet`)
    act(() => button.click())
  }
}

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!el) throw new Error(`No button "${label}"`)
  return el as HTMLButtonElement
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useKeyboardStore.setState({ request: null })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('EtimsSetupGate', () => {
  const onComplete = vi.fn()

  beforeEach(() => {
    onComplete.mockReset()
    window.api = {
      saveEtimsConfig: vi.fn().mockResolvedValue({ success: true })
    } as unknown as typeof window.api
  })

  /** Fills every field through the on-screen keys. */
  function fill(ip: string[], port: string[], password: string[]): void {
    tap(input('etims-deviceIp'))
    typeKeys(ip)
    tap(input('etims-devicePort'))
    typeKeys(port)
    tap(input('etims-password'))
    typeKeys(password)
  }

  it('lays the four fields out two per row, in pairs', async () => {
    await mount(createElement(EtimsSetupGate, { onComplete }))

    const grid = container.querySelector('.grid-cols-2') as HTMLElement
    const cells = Array.from(grid.children)
    expect(cells).toHaveLength(4)
    expect(cells.map((cell) => cell.querySelector('input')?.id)).toEqual([
      'etims-baseUrl',
      'etims-deviceIp',
      'etims-devicePort',
      'etims-password'
    ])
  })

  it('renders no helper text under any field', async () => {
    await mount(createElement(EtimsSetupGate, { onComplete }))

    for (const cell of Array.from(container.querySelector('.grid-cols-2')!.children)) {
      expect(cell.querySelectorAll('p')).toHaveLength(0)
    }
    expect(container.textContent).not.toContain('Usually 8000')
    expect(container.textContent).not.toContain('stored securely')
  })

  it.each([
    ['etims-baseUrl', 'text'],
    ['etims-deviceIp', 'ip'],
    ['etims-devicePort', 'numeric'],
    ['etims-password', 'text']
  ])('tapping %s opens the %s key set, docked', async (id, mode) => {
    await mount(createElement(EtimsSetupGate, { onComplete }))

    tap(input(id))

    const request = useKeyboardStore.getState().request
    expect(request?.mode).toBe(mode)
    expect(request?.docked).toBe(true)
    expect(sheet()).not.toBeNull()
  })

  it('focusing a field (not only tapping it) opens its aid', async () => {
    await mount(createElement(EtimsSetupGate, { onComplete }))

    act(() => input('etims-devicePort').focus())

    expect(useKeyboardStore.getState().request?.mode).toBe('numeric')
  })

  it('shows the numpad for numbers: port has no decimal key, IP has one that repeats', async () => {
    await mount(createElement(EtimsSetupGate, { onComplete }))

    tap(input('etims-devicePort'))
    const portDecimal = sheet()!.querySelector('[aria-label="Decimal point"]') as HTMLButtonElement
    expect(portDecimal.disabled).toBe(true)
    expect(sheet()!.querySelector('[aria-label="Shift"]')).toBeNull()

    tap(input('etims-deviceIp'))
    typeKeys(['1', '0', '.', '0', '.', '0', '.', '5'])
    expect(input('etims-deviceIp').value).toBe('10.0.0.5')
  })

  it('REGRESSION: a multi-character value accumulates key by key, not one letter at a time', async () => {
    await mount(createElement(EtimsSetupGate, { onComplete }))

    tap(input('etims-password'))
    typeKeys(['p', 'a', 's', 's', '9'])

    expect(input('etims-password').value).toBe('pass9')
    expect(useKeyboardStore.getState().request?.value).toBe('pass9')
  })

  it('edits the pre-filled server address from its current value', async () => {
    await mount(createElement(EtimsSetupGate, { onComplete }))

    tap(input('etims-baseUrl'))
    const backspace = sheet()!.querySelector('[aria-label="Backspace"]') as HTMLButtonElement
    act(() => backspace.click())

    expect(input('etims-baseUrl').value).toBe('http://localhost:4444')
  })

  it('docks the keys below the form and reserves their height, so Save is never under them', async () => {
    await mount(createElement(EtimsSetupGate, { onComplete }))
    const gateRoot = container.firstElementChild as HTMLElement
    expect(gateRoot.className).not.toContain('pb-keyboard-sheet')

    tap(input('etims-deviceIp'))

    expect(sheet()!.className).toContain('h-keyboard-sheet')
    expect(sheet()!.className).toContain('bottom-0')
    expect(gateRoot.className).toContain('pb-keyboard-sheet')
    expect(gateRoot.className).toContain('items-start')
    expect(sheet()!.contains(button('Save & Continue'))).toBe(false)
    expect(container.querySelector('.bg-black\\/50')).toBeNull()
  })

  it('draws the sheet above the gate (z-110 over z-[100])', async () => {
    await mount(createElement(EtimsSetupGate, { onComplete }))

    tap(input('etims-deviceIp'))

    expect(sheet()!.className).toContain('z-110')
    expect((container.firstElementChild as HTMLElement).className).toContain('z-[100]')
  })

  it('still shows the validation error for a bad IP, in that field', async () => {
    await mount(createElement(EtimsSetupGate, { onComplete }))

    fill(['9', '9', '9'], ['8', '0', '0', '0'], ['p', 'w'])
    await act(async () => {
      button('Save & Continue').click()
      await Promise.resolve()
    })

    const ipCell = input('etims-deviceIp').parentElement!
    expect(ipCell.textContent).toContain('That does not look like an IP address')
    expect(window.api.saveEtimsConfig).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('saves valid input, closes the keyboard and lifts the gate', async () => {
    await mount(createElement(EtimsSetupGate, { onComplete }))

    fill(['1', '9', '2', '.', '1', '6', '8', '.', '1', '.', '5', '0'], ['8', '0', '0', '0'], ['p', 'w'])
    await act(async () => {
      button('Save & Continue').click()
      await Promise.resolve()
    })

    expect(window.api.saveEtimsConfig).toHaveBeenCalledWith({
      baseUrl: 'http://localhost:4444/',
      deviceIp: '192.168.1.50',
      devicePort: '8000',
      password: 'pw'
    })
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(useKeyboardStore.getState().request).toBeNull()
  })
})

describe('OnboardingScreen', () => {
  beforeEach(() => {
    window.api = {
      validateShopifyConfig: vi.fn().mockResolvedValue({
        success: true,
        data: { shopName: 'Enjoy', locations: [{ id: 'gid://shopify/Location/1', name: 'Westlands' }] }
      })
    } as unknown as typeof window.api
  })

  it('lays store URL and token out side by side in one row', async () => {
    await mount(createElement(OnboardingScreen))

    const cells = Array.from(container.querySelector('.grid-cols-2')!.children)
    expect(cells.map((cell) => cell.querySelector('input')?.id)).toEqual([
      'onboarding-store-url',
      'onboarding-token'
    ])
    for (const cell of cells) expect(cell.querySelectorAll('p')).toHaveLength(0)
  })

  it('both fields open the full text keyboard, docked', async () => {
    await mount(createElement(OnboardingScreen))

    for (const id of ['onboarding-store-url', 'onboarding-token']) {
      tap(input(id))
      expect(useKeyboardStore.getState().request).toMatchObject({ mode: 'text', docked: true })
      expect(sheet()!.querySelector('[aria-label="Shift"]')).not.toBeNull()
    }
  })

  it('REGRESSION: typing accumulates in each field independently', async () => {
    await mount(createElement(OnboardingScreen))

    tap(input('onboarding-store-url'))
    typeKeys(['a', '-', 'b', '.', 'c', 'o'])
    tap(input('onboarding-token'))
    typeKeys(['s', 'h', 'p', 'a', 't', '_', '1'])

    expect(input('onboarding-store-url').value).toBe('a-b.co')
    expect(input('onboarding-token').value).toBe('shpat_1')
  })

  it('still shows the validation error when a field is empty', async () => {
    await mount(createElement(OnboardingScreen))

    tap(input('onboarding-store-url'))
    typeKeys(['a'])
    await act(async () => {
      button('Connect & Verify').click()
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Enter both the store URL and the Admin API token')
    expect(window.api.validateShopifyConfig).not.toHaveBeenCalled()
  })

  it('Connect & Verify sends the typed values and closes the keyboard', async () => {
    await mount(createElement(OnboardingScreen))

    tap(input('onboarding-store-url'))
    typeKeys(['a', '.', 'c', 'o'])
    tap(input('onboarding-token'))
    typeKeys(['s', 'h', 'p'])
    await act(async () => {
      button('Connect & Verify').click()
      await Promise.resolve()
    })

    expect(window.api.validateShopifyConfig).toHaveBeenCalledWith('a.co', 'shp')
    expect(useKeyboardStore.getState().request).toBeNull()
  })
})
