/**
 * The overlay's echo of the typed value, and its single Submit key
 * (phase-139).
 *
 * The real `VirtualKeyboardModal` is mounted — beside a setup screen where
 * the whole field → store → keys → relay → field path matters, and alone
 * where only the overlay's own behaviour is under test — and driven with
 * real DOM clicks, matching `setupScreens.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, Fragment } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import EtimsSetupGate from '../src/renderer/src/components/EtimsSetupGate.js'
import OnboardingScreen from '../src/renderer/src/components/OnboardingScreen.js'
import VirtualKeyboardModal from '../src/renderer/src/components/VirtualKeyboardModal.js'
import { useKeyboardStore, type KeyboardRequest } from '../src/renderer/src/stores/keyboardStore.js'

let container: HTMLDivElement
let root: Root

async function mount(...children: ReturnType<typeof createElement>[]): Promise<void> {
  await act(async () => {
    root.render(createElement(Fragment, null, ...children))
    await Promise.resolve()
  })
}

/** Opens the overlay directly, for the cases that need no host screen. */
async function open(request: Partial<KeyboardRequest> & { value?: string }): Promise<void> {
  await mount(createElement(VirtualKeyboardModal))
  act(() => {
    useKeyboardStore.getState().open({
      value: '',
      onChange: () => {},
      label: 'Field',
      ...request
    } as KeyboardRequest)
  })
}

function echo(): HTMLElement {
  const el = container.querySelector('[role="textbox"]')
  if (!el) throw new Error('No echo element')
  return el as HTMLElement
}

function keys(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll('button'))
}

function key(label: string): HTMLButtonElement {
  const el = keys().find((b) => b.textContent === label)
  if (!el) throw new Error(`No key "${label}"`)
  return el
}

function typeKeys(labels: string[]): void {
  for (const label of labels) act(() => key(label).click())
}

function input(id: string): HTMLInputElement {
  const el = container.querySelector(`#${id}`)
  if (!el) throw new Error(`No input #${id}`)
  return el as HTMLInputElement
}

function tap(el: HTMLElement): void {
  act(() => el.click())
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useKeyboardStore.setState({ request: null })
  window.api = {
    saveEtimsConfig: vi.fn().mockResolvedValue({ success: true }),
    validateShopifyConfig: vi.fn().mockResolvedValue({
      success: true,
      data: { shopName: 'Enjoy', locations: [] }
    })
  } as unknown as typeof window.api
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the echo of the typed value', () => {
  it('shows nothing before a key is pressed, in a box that is already full height', async () => {
    await open({ mode: 'text' })

    expect(echo().textContent).toBe('')
    expect(echo().className).toContain('h-12')
  })

  it('accumulates every key on the keyboard', async () => {
    let value = ''
    await open({
      mode: 'text',
      onChange: (next) => {
        value = next
      }
    })

    typeKeys(['s', 'h', 'p', '-', '1'])

    expect(echo().textContent).toBe('shp-1')
    expect(value).toBe('shp-1')
  })

  it('accumulates every key on the numpad', async () => {
    await open({ mode: 'ip' })

    typeKeys(['1', '0', '.', '2'])

    expect(echo().textContent).toBe('10.2')
  })

  it('follows a backspace back down', async () => {
    await open({ mode: 'text' })

    typeKeys(['a', 'b'])
    act(() => (container.querySelector('[aria-label="Backspace"]') as HTMLButtonElement).click())

    expect(echo().textContent).toBe('a')
  })

  it('masks a secret request with one dot per character, never the characters', async () => {
    await open({ mode: 'text', secret: true })

    typeKeys(['s', 'h', 'p', 'a', 't'])

    expect(echo().textContent).toBe('•••••')
    expect(container.textContent).not.toContain('shpat')
  })

  it('shows a non-secret request in clear text', async () => {
    await open({ mode: 'text' })

    typeKeys(['a', 'b', 'c'])

    expect(echo().textContent).toBe('abc')
  })

  it('is read-only and not focusable, and typing at it changes nothing', async () => {
    const onChange = vi.fn()
    await open({ mode: 'text', onChange })

    typeKeys(['a'])
    const el = echo()
    expect(el.getAttribute('role')).toBe('textbox')
    expect(el.getAttribute('aria-readonly')).toBe('true')
    expect(el.hasAttribute('tabindex')).toBe(false)
    expect(el.tagName).not.toBe('INPUT')

    act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.focus()
    })

    expect(echo().textContent).toBe('a')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(document.activeElement).not.toBe(el)
  })

  it('appears in the docked shell as well as the modal one', async () => {
    await open({ mode: 'text', docked: true })
    expect(container.querySelector('[role="dialog"]')!.querySelector('[role="textbox"]')).not.toBeNull()

    act(() => useKeyboardStore.getState().close())
    await open({ mode: 'numeric' })
    expect(container.querySelector('[role="textbox"]')).not.toBeNull()
  })
})

describe('the Submit key', () => {
  it.each([
    ['text', 'text'],
    ['caps', 'caps'],
    ['numeric', 'numeric'],
    ['ip', 'ip']
  ])('is the only closing key in %s mode, named Submit', async (_name, mode) => {
    await open({ mode: mode as KeyboardRequest['mode'] })

    const submits = keys().filter((b) => b.textContent === 'Submit')
    expect(submits).toHaveLength(1)
    expect(submits[0].getAttribute('aria-label')).toBe('Submit')
    expect(keys().filter((b) => b.textContent === 'Done')).toHaveLength(0)
    expect(keys().filter((b) => b.textContent === 'Enter')).toHaveLength(0)
  })

  it('closes the overlay with the typed value kept in the field', async () => {
    let value = ''
    await open({
      mode: 'text',
      onChange: (next) => {
        value = next
      }
    })

    typeKeys(['a', 'b', 'c'])
    tap(key('Submit'))

    expect(useKeyboardStore.getState().request).toBeNull()
    expect(container.querySelector('[role="textbox"]')).toBeNull()
    expect(value).toBe('abc')
  })

  it('does not fire the fiscal gate’s Save, and leaves the gate standing', async () => {
    const onComplete = vi.fn()
    await mount(
      createElement(EtimsSetupGate, { onComplete }),
      createElement(VirtualKeyboardModal)
    )

    tap(input('etims-deviceIp'))
    typeKeys(['1', '.', '2'])
    tap(key('Submit'))

    expect(useKeyboardStore.getState().request).toBeNull()
    expect(input('etims-deviceIp').value).toBe('1.2')
    expect(window.api.saveEtimsConfig).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
    expect(key('Save & Continue')).toBeDefined()
  })

  it('does not fire Onboarding’s Connect & Verify', async () => {
    await mount(createElement(OnboardingScreen), createElement(VirtualKeyboardModal))

    tap(input('onboarding-store-url'))
    typeKeys(['a', '.', 'c', 'o'])
    tap(key('Submit'))

    expect(useKeyboardStore.getState().request).toBeNull()
    expect(input('onboarding-store-url').value).toBe('a.co')
    expect(window.api.validateShopifyConfig).not.toHaveBeenCalled()
  })
})

describe('which setup fields mask their echo', () => {
  it('the fiscal gate masks only the device password', async () => {
    await mount(createElement(EtimsSetupGate, { onComplete: vi.fn() }), createElement(VirtualKeyboardModal))

    const masked: Record<string, boolean | undefined> = {}
    for (const field of ['baseUrl', 'deviceIp', 'devicePort', 'password']) {
      tap(input(`etims-${field}`))
      masked[field] = useKeyboardStore.getState().request?.secret
    }

    expect(masked).toEqual({
      baseUrl: false,
      deviceIp: false,
      devicePort: false,
      password: true
    })
  })

  it('Onboarding masks only the API token', async () => {
    await mount(createElement(OnboardingScreen), createElement(VirtualKeyboardModal))

    tap(input('onboarding-store-url'))
    expect(useKeyboardStore.getState().request?.secret).toBe(false)

    tap(input('onboarding-token'))
    expect(useKeyboardStore.getState().request?.secret).toBe(true)
  })

  it('a password field never puts its characters on screen', async () => {
    await mount(createElement(EtimsSetupGate, { onComplete: vi.fn() }), createElement(VirtualKeyboardModal))

    tap(input('etims-password'))
    typeKeys(['s', 'e', 'c', 'r', 'e', 't'])

    expect(echo().textContent).toBe('••••••')
    expect(container.textContent).not.toContain('secret')
    expect(input('etims-password').value).toBe('secret')
    expect(input('etims-password').type).toBe('password')
  })
})

/**
 * `'decimal'` mode (docs/phase-156) — `VirtualNumpad` with one decimal
 * point allowed, unlike `'numeric'` (no decimal point) and distinct from
 * `'ip'` (many decimal points). Covers the mode itself, in isolation from
 * any one field that requests it (`AdminScreen`'s cash fields,
 * `CartLineItem`/`PosCheckoutPanel`'s price/discount fields,
 * `StockTakePage`'s threshold field all request it — see their own
 * component tests for that wiring).
 */
describe('decimal mode', () => {
  it('renders the numpad (not the alphanumeric keyboard)', async () => {
    await open({ mode: 'decimal' })

    expect(key('Submit')).toBeDefined()
    expect(container.querySelector('[aria-label="Decimal point"]')).not.toBeNull()
    expect(keys().find((b) => b.textContent === 'Q')).toBeUndefined()
  })

  it('accepts one decimal point', async () => {
    await open({ mode: 'decimal' })

    typeKeys(['4', '9', '.', '5'])

    expect(echo().textContent).toBe('49.5')
  })

  it('ignores a second decimal point, same as numeric', async () => {
    let value = ''
    await open({ mode: 'decimal', value: '4.5', onChange: (next) => { value = next } })

    tap(container.querySelector('[aria-label="Decimal point"]') as HTMLButtonElement)

    expect(value).toBe('')
    expect(echo().textContent).toBe('4.5')
  })

  it('does not let the decimal key be pressed more than once, unlike ip', async () => {
    await open({ mode: 'decimal', value: '1.2' })

    tap(container.querySelector('[aria-label="Decimal point"]') as HTMLButtonElement)

    expect(echo().textContent).toBe('1.2')
  })
})

describe('numeric and ip modes are unaffected by adding decimal', () => {
  it('numeric still has no decimal key at all', async () => {
    await open({ mode: 'numeric' })

    const decimalKey = container.querySelector('[aria-label="Decimal point"]') as HTMLButtonElement
    expect(decimalKey.disabled).toBe(true)
  })

  it('ip still allows the decimal key more than once', async () => {
    await open({ mode: 'ip', value: '192.168' })

    typeKeys(['.'])

    expect(echo().textContent).toBe('192.168.')
  })
})
