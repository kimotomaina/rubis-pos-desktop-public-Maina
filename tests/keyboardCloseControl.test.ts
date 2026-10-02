/**
 * The `Close keyboard` control in the keyboard overlay's header, and the
 * Escape key (docs/phase-200).
 *
 * The real `VirtualKeyboardModal` is mounted, alone and beside the setup
 * screens, and driven with real DOM clicks and key events, the way
 * `keyboardEchoSubmit.test.ts` does. The control is a header button, not a
 * key: the Submit-key tripwires in that file and in `VirtualKeyboard.test.ts`
 * run unmodified and are not repeated here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, Fragment, useState } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import EtimsSetupGate from '../src/renderer/src/components/EtimsSetupGate.js'
import OnboardingScreen from '../src/renderer/src/components/OnboardingScreen.js'
import PaymentModal from '../src/renderer/src/components/PaymentModal.js'
import VirtualKeyboardModal from '../src/renderer/src/components/VirtualKeyboardModal.js'
import { useKeyboardStore, type KeyboardMode, type KeyboardRequest } from '../src/renderer/src/stores/keyboardStore.js'

let container: HTMLDivElement
let root: Root

const originalClose = useKeyboardStore.getState().close

const CLOSE_LABEL = 'Close keyboard'
const MODES: KeyboardMode[] = ['caps', 'text', 'numeric', 'decimal', 'ip']
const SHELLS: Array<[string, boolean]> = [
  ['modal', false],
  ['docked', true]
]

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

const buttons = (): HTMLButtonElement[] => Array.from(container.querySelectorAll('button'))

function key(label: string): HTMLButtonElement {
  const el = buttons().find((b) => b.textContent === label)
  if (!el) throw new Error(`No key "${label}"`)
  return el
}

const closeControls = (): HTMLButtonElement[] => buttons().filter((b) => b.textContent === CLOSE_LABEL)

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

/** Dispatches a key on the document, the way a physical keyboard's press reaches it. */
function press(keyName: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true })
  act(() => {
    document.body.dispatchEvent(event)
  })
  return event
}

const isOpen = (): boolean => useKeyboardStore.getState().request !== null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useKeyboardStore.setState({ request: null, close: originalClose })
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
  useKeyboardStore.setState({ request: null, close: originalClose })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe.each(SHELLS)('the Close keyboard control, %s shell', (_shell, docked) => {
  it.each(MODES)('is there in %s mode, once, with its words as its accessible name', async (mode) => {
    await open({ mode, docked })

    const controls = closeControls()
    expect(controls).toHaveLength(1)
    expect(controls[0].getAttribute('aria-label')).toBeNull()
    expect(controls[0].textContent).toBe('Close keyboard')
    expect(controls[0].querySelector('svg')).toBeNull()
  })

  it('sits in the header beside the label, not among the keys', async () => {
    await open({ mode: 'text', docked, label: 'Store URL' })

    const control = closeControls()[0]
    const label = container.querySelector('#virtual-keyboard-label') as HTMLElement
    expect(label.textContent).toBe('Store URL')
    expect(control.parentElement!.parentElement).toBe(label.parentElement)
    expect(control.closest('.grid, .flex-col')).toBeNull()
  })

  it.each(MODES)('leaves exactly one Submit key and no Done or Enter in %s mode', async (mode) => {
    await open({ mode, docked })

    expect(buttons().filter((b) => b.textContent === 'Submit')).toHaveLength(1)
    expect(buttons().filter((b) => b.textContent === 'Done')).toHaveLength(0)
    expect(buttons().filter((b) => b.textContent === 'Enter')).toHaveLength(0)
  })

  it('closes the overlay and leaves the field holding everything typed', async () => {
    let value = ''
    await open({
      mode: 'text',
      docked,
      onChange: (next) => {
        value = next
      }
    })

    typeKeys(['a', 'b', 'c'])
    tap(closeControls()[0])

    expect(isOpen()).toBe(false)
    expect(container.querySelector('[role="textbox"]')).toBeNull()
    expect(closeControls()).toHaveLength(0)
    expect(value).toBe('abc')
  })

  it('closes on Escape too, with the typed value kept', async () => {
    let value = ''
    await open({
      mode: 'numeric',
      docked,
      onChange: (next) => {
        value = next
      }
    })

    typeKeys(['4', '2'])
    const event = press('Escape')

    expect(isOpen()).toBe(false)
    expect(container.querySelector('[role="textbox"]')).toBeNull()
    expect(value).toBe('42')
    expect(event.defaultPrevented).toBe(true)
  })

  it('ignores every other key', async () => {
    await open({ mode: 'text', docked })

    for (const keyName of ['Enter', 'a', 'Tab', ' ', 'Backspace', 'Esc']) press(keyName)

    expect(isOpen()).toBe(true)
  })

  it('calls the store’s close with no argument, from the control and from Escape', async () => {
    const close = vi.fn()
    useKeyboardStore.setState({ close })
    await open({ mode: 'text', docked })

    tap(closeControls()[0])
    press('Escape')

    // Argument counts, not the arguments: a React click event is far too large for a failure message to print.
    expect(close.mock.calls.map((args) => args.length)).toEqual([0, 0])
  })

  it('does not move focus anywhere, so a field that opens the keyboard on focus cannot reopen it', async () => {
    let opens = 0
    function Host() {
      const [value, setValue] = useState('')
      return createElement('input', {
        id: 'host-field',
        readOnly: true,
        value,
        onFocus: () => {
          opens += 1
          useKeyboardStore.getState().open({ value, onChange: setValue, label: 'Host', mode: 'text', docked })
        }
      })
    }
    await mount(createElement(Host), createElement(VirtualKeyboardModal))
    act(() => input('host-field').focus())
    expect(opens).toBe(1)
    expect(isOpen()).toBe(true)

    const focus = vi.spyOn(HTMLElement.prototype, 'focus')
    tap(closeControls()[0])

    expect(focus).not.toHaveBeenCalled()
    expect(isOpen()).toBe(false)
    expect(opens).toBe(1)
  })

  it('keeps the echo unfocusable with the control beside the label', async () => {
    await open({ mode: 'text', docked })

    const echo = container.querySelector('[role="textbox"]') as HTMLElement
    expect(echo.getAttribute('aria-readonly')).toBe('true')
    expect(echo.hasAttribute('tabindex')).toBe(false)
    expect(echo.tagName).not.toBe('INPUT')
    expect(echo.contains(closeControls()[0])).toBe(false)
    act(() => echo.focus())
    expect(document.activeElement).not.toBe(echo)
  })
})

describe('Escape only acts while the keyboard is open', () => {
  it('stops at the keyboard, so another Escape handler does not also run', async () => {
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    try {
      await open({ mode: 'text' })

      press('Escape')

      expect(isOpen()).toBe(false)
      expect(onWindowKey).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', onWindowKey)
    }
  })

  it('leaves Escape alone once the keyboard is closed, and with it never opened', async () => {
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    try {
      await mount(createElement(VirtualKeyboardModal))
      expect(press('Escape').defaultPrevented).toBe(false)

      act(() => {
        useKeyboardStore.getState().open({ value: '', onChange: () => {}, label: 'Field', mode: 'text' })
      })
      tap(key('Submit'))
      onWindowKey.mockClear()

      expect(press('Escape').defaultPrevented).toBe(false)
      expect(onWindowKey).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', onWindowKey)
    }
  })

  it('removes its listener when the overlay unmounts while open', async () => {
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    try {
      await open({ mode: 'text' })
      act(() => root.render(createElement(Fragment)))

      expect(press('Escape').defaultPrevented).toBe(false)
      expect(onWindowKey).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', onWindowKey)
    }
  })
})

describe('it never reaches the host screen', () => {
  it.each(SHELLS)('does not fire the fiscal gate’s Save, %s', async (_shell) => {
    const onComplete = vi.fn()
    await mount(createElement(EtimsSetupGate, { onComplete }), createElement(VirtualKeyboardModal))

    tap(input('etims-deviceIp'))
    typeKeys(['1', '.', '2'])
    tap(closeControls()[0])

    expect(isOpen()).toBe(false)
    expect(input('etims-deviceIp').value).toBe('1.2')
    expect(window.api.saveEtimsConfig).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
    expect(key('Save & Continue')).toBeDefined()
  })

  it('does not fire the fiscal gate’s Save on Escape either', async () => {
    const onComplete = vi.fn()
    await mount(createElement(EtimsSetupGate, { onComplete }), createElement(VirtualKeyboardModal))

    tap(input('etims-deviceIp'))
    typeKeys(['1', '.', '2'])
    press('Escape')

    expect(isOpen()).toBe(false)
    expect(input('etims-deviceIp').value).toBe('1.2')
    expect(window.api.saveEtimsConfig).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('does not fire Onboarding’s Connect & Verify, from the control or from Escape', async () => {
    await mount(createElement(OnboardingScreen), createElement(VirtualKeyboardModal))

    tap(input('onboarding-store-url'))
    typeKeys(['a', '.', 'c', 'o'])
    tap(closeControls()[0])
    expect(isOpen()).toBe(false)
    expect(input('onboarding-store-url').value).toBe('a.co')

    tap(input('onboarding-store-url'))
    press('Escape')
    expect(isOpen()).toBe(false)

    expect(window.api.validateShopifyConfig).not.toHaveBeenCalled()
  })
})

describe('closing the keyboard from the payment panel', () => {
  /**
   * The Daraja panel offers no field while it waits, so the keyboard is opened over the waiting
   * panel through the store; what is under test is that closing it touches nothing of the payment.
   */
  it.each(['the control', 'Escape'])(
    'leaves an M-Pesa payment waiting and polling when closed with %s',
    async (how) => {
      vi.useFakeTimers()
      const queryMpesaStatus = vi.fn().mockResolvedValue({ success: true, data: { status: 'pending' } })
      const onPaid = vi.fn()
      const onCancel = vi.fn()
      window.api = {
        getMpesaCapabilities: vi.fn().mockResolvedValue({
          success: true,
          data: { manualCodeSupported: false, manualEntryEnabled: false, mode: 'daraja' }
        }),
        initiateMpesaStkPush: vi.fn().mockResolvedValue({
          success: true,
          data: { checkoutRequestId: 'ws_1', merchantRequestId: 'mr_1' }
        }),
        logMpesaTransaction: vi.fn().mockResolvedValue({ success: true }),
        queryMpesaStatus
      } as unknown as typeof window.api
      await mount(createElement(PaymentModal, { total: 100, onPaid, onCancel }), createElement(VirtualKeyboardModal))

      tap(container.querySelector('[aria-label="Phone Number"]') as HTMLElement)
      act(() => useKeyboardStore.getState().request?.onChange('0712345678'))
      await act(async () => {
        key('Send Request').click()
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(container.textContent).toContain('Waiting for M-Pesa Confirmation')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(queryMpesaStatus).toHaveBeenCalledTimes(1)

      act(() => {
        useKeyboardStore.getState().open({ value: '', onChange: () => {}, label: 'Field', mode: 'numeric', docked: true })
      })
      if (how === 'Escape') press('Escape')
      else tap(closeControls()[0])

      expect(isOpen()).toBe(false)
      expect(container.textContent).toContain('Waiting for M-Pesa Confirmation')
      expect(onCancel).not.toHaveBeenCalled()
      expect(onPaid).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(queryMpesaStatus).toHaveBeenCalledTimes(2)
      expect(container.textContent).toContain('Waiting for M-Pesa Confirmation')
    }
  )
})

describe('the header budget of the docked sheet', () => {
  it('keeps a 40px target that takes 32px of the label row, so the text keyboard still fits the sheet', async () => {
    await open({ mode: 'text', docked: true })

    const control = closeControls()[0]
    expect(control.className).toContain('h-10')
    expect(control.className).toContain('-my-1')
  })
})
