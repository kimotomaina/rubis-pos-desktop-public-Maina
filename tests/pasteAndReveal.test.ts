/**
 * Pasting into the setup and admin fields, and holding an icon to see a
 * secret.
 *
 * Those fields are read-only inputs that hand editing to the on-screen
 * keyboard, so paste has to go through the overlay; and a secret must only
 * be visible for exactly as long as the eye is held. The real
 * `VirtualKeyboardModal` and the real screens are mounted and driven with
 * DOM events, as in `keyboardEchoSubmit.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, Fragment } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import OnboardingScreen from '../src/renderer/src/components/OnboardingScreen.js'
import EtimsSetupGate from '../src/renderer/src/components/EtimsSetupGate.js'
import VirtualKeyboardModal from '../src/renderer/src/components/VirtualKeyboardModal.js'
import { useKeyboardStore, type KeyboardRequest } from '../src/renderer/src/stores/keyboardStore.js'
import { pasteIntoValue } from '../src/renderer/src/lib/pasteText.js'

describe('pasteIntoValue', () => {
  it('drops line breaks and trims the ends, keeping inner spaces', () => {
    expect(pasteIntoValue('', '  shpat_abc123\r\n', 'text')).toBe('shpat_abc123')
    expect(pasteIntoValue('', 'Acme\tTraders Ltd\n', 'text')).toBe('AcmeTraders Ltd')
  })

  it('adds to what is already there, as typing would', () => {
    expect(pasteIntoValue('shpat_', 'abc', 'text')).toBe('shpat_abc')
  })

  it('upper-cases for the caps keyboard, which cannot type lower case', () => {
    expect(pasteIntoValue('', 'p051234567a', 'caps')).toBe('P051234567A')
    expect(pasteIntoValue('', 'p051234567a', undefined)).toBe('P051234567A')
  })

  it('keeps only digits for a numeric field', () => {
    expect(pasteIntoValue('', '  8 000 x', 'numeric')).toBe('8000')
  })

  it('allows a single decimal point for a decimal field, counting one already typed', () => {
    expect(pasteIntoValue('', '1.2.3', 'decimal')).toBe('1.23')
    expect(pasteIntoValue('5.', '1.5', 'decimal')).toBe('5.15')
  })

  it('allows several points for an IP field and rejects everything else', () => {
    expect(pasteIntoValue('', ' 192.168.1.50 ', 'ip')).toBe('192.168.1.50')
    expect(pasteIntoValue('', 'ip: 10.0.0.1', 'ip')).toBe('10.0.0.1')
  })

  it('stops at maxLength, like a key press past it', () => {
    expect(pasteIntoValue('AB', 'CDEFG', 'caps', 4)).toBe('ABCD')
  })

  it('leaves the value alone when nothing usable was pasted', () => {
    expect(pasteIntoValue('12', 'abc', 'numeric')).toBe('12')
    expect(pasteIntoValue('12', '\r\n', 'text')).toBe('12')
  })
})

let container: HTMLDivElement
let root: Root

async function mount(...children: ReturnType<typeof createElement>[]): Promise<void> {
  await act(async () => {
    root.render(createElement(Fragment, null, ...children))
    await Promise.resolve()
  })
}

async function open(request: Partial<KeyboardRequest>): Promise<{ onChange: ReturnType<typeof vi.fn> }> {
  const onChange = vi.fn()
  await mount(createElement(VirtualKeyboardModal))
  act(() => {
    useKeyboardStore.getState().open({
      value: '',
      onChange,
      label: 'Field',
      ...request
    } as KeyboardRequest)
  })
  return { onChange }
}

function echo(): string {
  return (container.querySelector('[role="textbox"]') as HTMLElement).textContent ?? ''
}

function button(label: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label
  )
  if (!el) throw new Error(`No button "${label}"`)
  return el as HTMLButtonElement
}

function fire(el: Element, type: string, init: Record<string, unknown> = {}): void {
  act(() => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
  })
}

function press(el: Element): void {
  fire(el, 'pointerdown')
}

function release(el: Element): void {
  fire(el, 'pointerup')
}

function setClipboard(readText: () => Promise<string>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { readText }, configurable: true })
}

beforeEach(() => {
  useKeyboardStore.setState({ request: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the Paste key', () => {
  it('adds the clipboard text to the field, cleaned up for the keyboard in use', async () => {
    setClipboard(() => Promise.resolve('  shpat_abc123\r\n'))
    const { onChange } = await open({ mode: 'text', value: 'x' })

    await act(async () => {
      button('Paste').click()
      await Promise.resolve()
    })

    expect(onChange).toHaveBeenCalledWith('xshpat_abc123')
    expect(echo()).toBe('xshpat_abc123')
  })

  it('respects the field limit', async () => {
    setClipboard(() => Promise.resolve('ABCDEFGH'))
    const { onChange } = await open({ mode: 'caps', maxLength: 5 })

    await act(async () => {
      button('Paste').click()
      await Promise.resolve()
    })

    expect(onChange).toHaveBeenCalledWith('ABCDE')
  })

  it('says so, and changes nothing, when the clipboard cannot be read', async () => {
    setClipboard(() => Promise.reject(new Error('denied')))
    const { onChange } = await open({ mode: 'text', value: 'keep' })

    await act(async () => {
      button('Paste').click()
      await Promise.resolve()
    })

    expect(onChange).not.toHaveBeenCalled()
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Could not read the clipboard')
  })

  it('says so, and changes nothing, when the clipboard is empty', async () => {
    setClipboard(() => Promise.resolve('  \n'))
    const { onChange } = await open({ mode: 'text' })

    await act(async () => {
      button('Paste').click()
      await Promise.resolve()
    })

    expect(onChange).not.toHaveBeenCalled()
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Nothing to paste')
  })
})

describe('Ctrl+V while the keyboard is open', () => {
  function paste(text: string): Event {
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } })
    act(() => {
      document.dispatchEvent(event)
    })
    return event
  }

  it('adds the text and takes the event over from the read-only field', async () => {
    const { onChange } = await open({ mode: 'ip', value: '192.' })

    const event = paste(' 168.1.50\n')

    expect(onChange).toHaveBeenCalledWith('192.168.1.50')
    expect(event.defaultPrevented).toBe(true)
  })

  it('does nothing once the keyboard is closed', async () => {
    const { onChange } = await open({ mode: 'text' })
    act(() => useKeyboardStore.getState().close())

    paste('late')

    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('hold to show a secret', () => {
  it('shows the characters only while the eye is held, and dots otherwise', async () => {
    await open({ mode: 'text', value: 'hunter2', secret: true })
    const eye = button('Hold to show')
    expect(echo()).toBe('•••••••')

    press(eye)
    expect(echo()).toBe('hunter2')
    expect(eye.getAttribute('aria-pressed')).toBe('true')

    release(eye)
    expect(echo()).toBe('•••••••')
    expect(eye.getAttribute('aria-pressed')).toBe('false')
  })

  it.each([
    ['the pointer is cancelled', (el: Element) => fire(el, 'pointercancel')],
    ['pointer capture is lost', (el: Element) => fire(el, 'lostpointercapture')],
    ['focus leaves the icon', (el: Element) => act(() => (el as HTMLElement).dispatchEvent(new FocusEvent('focusout', { bubbles: true })))]
  ])('hides again when %s', async (_label, end) => {
    await open({ mode: 'text', value: 'hunter2', secret: true })
    const eye = button('Hold to show')
    press(eye)
    expect(echo()).toBe('hunter2')

    end(eye)

    expect(echo()).toBe('•••••••')
  })

  it('hides when the window loses focus mid-hold', async () => {
    await open({ mode: 'text', value: 'hunter2', secret: true })
    press(button('Hold to show'))

    act(() => {
      window.dispatchEvent(new Event('blur'))
    })

    expect(echo()).toBe('•••••••')
  })

  it('works from the keyboard too: Space held shows, released hides', async () => {
    await open({ mode: 'text', value: 'hunter2', secret: true })
    const eye = button('Hold to show')

    act(() => {
      eye.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    })
    expect(echo()).toBe('hunter2')
    act(() => {
      eye.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }))
    })
    expect(echo()).toBe('•••••••')
  })

  it('suppresses the long-press context menu, which would swallow the hold', async () => {
    await open({ mode: 'text', value: 'x', secret: true })
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })

    act(() => {
      button('Hold to show').dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
  })

  it('cannot leave the next secret revealed when the keyboard closes mid-hold', async () => {
    await open({ mode: 'text', value: 'first', secret: true })
    press(button('Hold to show'))
    act(() => useKeyboardStore.getState().close())

    act(() => {
      useKeyboardStore.getState().open({ value: 'second', onChange: () => {}, label: 'Next', mode: 'text', secret: true })
    })

    expect(echo()).toBe('••••••')
  })

  it('offers no eye on a field that is not secret', async () => {
    await open({ mode: 'text', value: 'plain' })

    expect(Array.from(container.querySelectorAll('button')).some((b) => b.getAttribute('aria-label') === 'Hold to show')).toBe(false)
    expect(echo()).toBe('plain')
  })
})

describe('the password inputs on the setup screens', () => {
  function inputById(id: string): HTMLInputElement {
    return container.querySelector(`#${id}`) as HTMLInputElement
  }

  it('the Shopify token input is masked, read-only, and shows only while its eye is held', async () => {
    await mount(createElement(OnboardingScreen))
    const input = inputById('onboarding-token')
    expect(input.type).toBe('password')
    expect(input.readOnly).toBe(true)
    const eye = input.parentElement!.querySelector('button[aria-label="Hold to show"]') as HTMLButtonElement

    press(eye)
    expect(inputById('onboarding-token').type).toBe('text')
    release(eye)
    expect(inputById('onboarding-token').type).toBe('password')
  })

  it('tapping the field still opens the keyboard with the secret flag', async () => {
    await mount(createElement(OnboardingScreen), createElement(VirtualKeyboardModal))

    act(() => inputById('onboarding-token').click())

    expect(useKeyboardStore.getState().request).toMatchObject({ label: 'Admin API Access Token', secret: true })
  })

  it('the fiscal device password has an eye and the address, IP and port do not', async () => {
    await mount(createElement(EtimsSetupGate, { onComplete: () => {} }))

    const withEye = (id: string): boolean =>
      inputById(id).parentElement!.querySelector('button[aria-label="Hold to show"]') !== null
    expect(withEye('etims-password')).toBe(true)
    expect(withEye('etims-baseUrl')).toBe(false)
    expect(withEye('etims-deviceIp')).toBe(false)
    expect(withEye('etims-devicePort')).toBe(false)
  })
})
