/**
 * The update prompt at startup (docs/phase-219): asked once per app start on the sale screen,
 * "Later" stores nothing, "Update now" is refused for three reasons and otherwise downloads
 * and then installs.
 *
 * Real mounts; `window.api` is a recording stub standing in for the main process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import UpdatePrompt from '../src/renderer/src/components/UpdatePrompt.js'
import UpdateToast from '../src/renderer/src/components/UpdateToast.js'
import AdminScreen from '../src/renderer/src/components/AdminScreen.js'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import { useHeldSalesStore } from '../src/renderer/src/stores/heldSalesStore.js'
import { usePaymentActivityStore } from '../src/renderer/src/stores/paymentActivityStore.js'
import { useUpdateStatusStore } from '../src/renderer/src/stores/updateStatusStore.js'
import { useToastStore } from '../src/renderer/src/stores/toastStore.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import {
  UPDATE_REFUSED_CART_HAS_ITEMS,
  UPDATE_REFUSED_PAYMENT_IN_PROGRESS,
  UPDATE_REFUSED_SALE_BEING_COMPLETED
} from '../src/renderer/src/lib/updateNow.js'
import type { UpdateStatus } from '../src/main/services/updater.js'

let container: HTMLDivElement
let root: Root
let emitStatus: (status: UpdateStatus) => void

type Api = Record<string, ReturnType<typeof vi.fn>>
let api: Api

const ok = <T,>(data?: T) => ({ success: true as const, data })

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function installApi(overrides: Partial<Api> = {}): void {
  api = {
    startupUpdateCheck: vi.fn().mockResolvedValue(ok('2.2.0')),
    getAppVersion: vi.fn().mockResolvedValue('2.1.9'),
    downloadUpdate: vi.fn().mockResolvedValue(ok()),
    installUpdate: vi.fn().mockResolvedValue(ok()),
    onUpdateStatus: vi.fn((callback: (status: UpdateStatus) => void) => {
      emitStatus = callback
      return () => {}
    }),
    getLastUpdateResult: vi.fn().mockResolvedValue(ok(null)),
    getCurrentShift: vi.fn().mockResolvedValue(ok(null)),
    ...overrides
  }
  window.api = new Proxy(api, {
    get: (target, name: string) => target[name] ?? (target[name] = vi.fn().mockResolvedValue(ok(undefined)))
  }) as unknown as typeof window.api
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve()
  })
}

async function mountPrompt(): Promise<void> {
  await act(async () => {
    root.render(createElement(UpdatePrompt))
  })
  await flush()
}

const buttons = (): string[] => Array.from(container.querySelectorAll('button')).map((b) => b.textContent ?? '')

async function click(label: string): Promise<void> {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!el) throw new Error(`No button "${label}"`)
  await act(async () => {
    el.click()
  })
  await flush()
}

const putItemInCart = (): void =>
  useCartStore.setState({ items: [{ variantId: 'v1', title: 'Mug', unitPrice: 100, quantity: 1 } as never] })

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useCartStore.getState().clearCart()
  useCartStore.setState({ checkoutStatus: 'idle' })
  useHeldSalesStore.setState({ sales: [], resetEpoch: 0 })
  usePaymentActivityStore.setState({ active: {} })
  useUpdateStatusStore.setState({ status: null, promptOpen: false })
  useToastStore.setState({ toasts: [] } as never)
  useKeyboardStore.setState({ request: null })
  window.localStorage.clear()
  installApi()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the prompt at startup', () => {
  it('asks once, showing the installed version and the new one, with Update now and Later', async () => {
    await mountPrompt()

    expect(container.textContent).toContain('Update available: version 2.2.0')
    expect(container.textContent).toContain('Installed version 2.1.9')
    expect(container.textContent).toContain('new version 2.2.0')
    expect(container.textContent).toContain('The till will restart to install it.')
    expect(buttons()).toEqual(['Later', 'Update now'])
    expect(api.startupUpdateCheck).toHaveBeenCalledTimes(1)
  })

  it('shows nothing when there is no update', async () => {
    installApi({ startupUpdateCheck: vi.fn().mockResolvedValue(ok(null)) })
    await mountPrompt()

    expect(container.textContent).toBe('')
  })

  it('shows nothing when the check failed: an error result, or a call that throws', async () => {
    installApi({ startupUpdateCheck: vi.fn().mockResolvedValue({ success: false, error: 'offline' }) })
    await mountPrompt()
    expect(container.textContent).toBe('')

    act(() => root.unmount())
    root = createRoot(container)
    installApi({ startupUpdateCheck: vi.fn().mockRejectedValue(new Error('ipc closed')) })
    await mountPrompt()
    expect(container.textContent).toBe('')
  })

  it('does not ask again in the same session when it is rendered again', async () => {
    await mountPrompt()
    await click('Later')
    await act(async () => {
      root.render(createElement(UpdatePrompt))
    })
    await flush()

    expect(container.textContent).toBe('')
    expect(api.startupUpdateCheck).toHaveBeenCalledTimes(1)
  })
})

describe('Later', () => {
  it('closes the dialog, starts no download, installs nothing, and stores nothing', async () => {
    await mountPrompt()
    const before = JSON.stringify(window.localStorage)

    await click('Later')

    expect(container.textContent).toBe('')
    expect(api.downloadUpdate).not.toHaveBeenCalled()
    expect(api.installUpdate).not.toHaveBeenCalled()
    const database = Object.keys(api).filter((name) => /^(set|save|update|record|write)/i.test(name))
    expect(database).toEqual([])
    expect(JSON.stringify(window.localStorage)).toBe(before)
    expect(useUpdateStatusStore.getState().status).toEqual({ kind: 'available', version: '2.2.0' })
  })

  it('asks again at the next start: a fresh mount after Later shows the prompt again', async () => {
    await mountPrompt()
    await click('Later')
    expect(container.textContent).toBe('')

    act(() => root.unmount())
    root = createRoot(container)
    installApi()
    await mountPrompt()

    expect(container.textContent).toContain('Update available: version 2.2.0')
  })

  it('leaves the update showing in the App & Updates panel, with a Download update button', async () => {
    await mountPrompt()
    await click('Later')
    act(() => root.unmount())
    root = createRoot(container)
    useAuthStore.setState({ currentStaff: { id: 1, name: 'Admin', role: 'admin' } })

    await act(async () => {
      root.render(createElement(AdminScreen, { requestManagerPin: () => {} }))
    })
    await flush()

    expect(container.textContent).toContain('Version 2.2.0 is available')
    expect(buttons()).toContain('Download update')
    await click('Download update')
    expect(api.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(api.installUpdate).not.toHaveBeenCalled()
  })
})

describe('Update now is refused, with its reason, and no download starts', () => {
  const refusedWith = async (reason: string): Promise<void> => {
    await mountPrompt()
    await click('Update now')

    expect(container.textContent).toContain(reason)
    expect(api.downloadUpdate).not.toHaveBeenCalled()
    expect(api.installUpdate).not.toHaveBeenCalled()
    expect(buttons()).toEqual(['Later', 'Update now'])
  }

  it('while the cart has items', async () => {
    putItemInCart()
    await refusedWith(UPDATE_REFUSED_CART_HAS_ITEMS)
  })

  it('while a payment is in progress', async () => {
    usePaymentActivityStore.getState().setActive('PaymentModal', true)
    await refusedWith(UPDATE_REFUSED_PAYMENT_IN_PROGRESS)
  })

  it('while a sale is being completed (checkoutStatus submitting), even with the cart already empty', async () => {
    useCartStore.setState({ checkoutStatus: 'submitting' })
    await refusedWith(UPDATE_REFUSED_SALE_BEING_COMPLETED)
  })

  it('gives each reason in plain words', () => {
    expect(UPDATE_REFUSED_CART_HAS_ITEMS).toBe('There are items in the cart. Complete the sale or put it on hold, then update.')
    expect(UPDATE_REFUSED_PAYMENT_IN_PROGRESS).toBe('A payment is in progress. Finish it, then update.')
    expect(UPDATE_REFUSED_SALE_BEING_COMPLETED).toBe('A sale is being completed. Wait for it to finish, then update.')
  })

  it('and goes ahead once the reason has gone', async () => {
    putItemInCart()
    await mountPrompt()
    await click('Update now')
    expect(api.downloadUpdate).not.toHaveBeenCalled()

    useCartStore.getState().clearCart()
    await click('Update now')

    expect(api.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(api.installUpdate).toHaveBeenCalledTimes(1)
  })
})

describe('Update now on an empty cart', () => {
  it('downloads with progress shown, and installs only after the download has finished', async () => {
    const download = deferred<{ success: true }>()
    installApi({ downloadUpdate: vi.fn(() => download.promise) })
    await mountPrompt()

    await click('Update now')
    await act(async () => emitStatus({ kind: 'downloading', percent: 42.4 }))

    expect(container.textContent).toContain('Downloading update… 42%')
    expect(api.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(api.installUpdate).not.toHaveBeenCalled()
    expect(container.querySelectorAll('button')[0].disabled).toBe(true)

    download.resolve({ success: true })
    await flush()

    expect(api.installUpdate).toHaveBeenCalledTimes(1)
    expect(api.downloadUpdate.mock.invocationCallOrder[0]).toBeLessThan(api.installUpdate.mock.invocationCallOrder[0])
    expect(container.textContent).toContain('Restarting…')
  })

  it('is not blocked by held sales: they survive a restart', async () => {
    useHeldSalesStore.setState({ sales: [{ id: 1, label: 'Customer 1', status: 'held', total: 100 } as never] })
    await mountPrompt()

    await click('Update now')

    expect(api.installUpdate).toHaveBeenCalledTimes(1)
  })

  it('refuses at the end of the download if the cart has meanwhile filled, and does not install', async () => {
    const download = deferred<{ success: true }>()
    installApi({ downloadUpdate: vi.fn(() => download.promise) })
    await mountPrompt()
    await click('Update now')

    putItemInCart()
    download.resolve({ success: true })
    await flush()

    expect(container.textContent).toContain(UPDATE_REFUSED_CART_HAS_ITEMS)
    expect(api.installUpdate).not.toHaveBeenCalled()

    useCartStore.getState().clearCart()
    await click('Update now')
    expect(api.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(api.installUpdate).toHaveBeenCalledTimes(1)
  })

  it('says so in plain words when the download fails, installs nothing, and leaves the till running', async () => {
    installApi({ downloadUpdate: vi.fn().mockResolvedValue({ success: false, error: 'net::ERR_CONNECTION_RESET' }) })
    await mountPrompt()

    await click('Update now')

    // docs/phase-230: old, the raw error was shown (`The update could not be downloaded: net::ERR_CONNECTION_RESET.`).
    // New: a plain sentence; the raw error never reaches the screen.
    expect(container.textContent).toContain('The update could not be downloaded. Check the internet connection and try again.')
    expect(container.textContent).not.toContain('net::')
    expect(container.textContent).toContain('The till is still running version 2.1.9.')
    expect(api.installUpdate).not.toHaveBeenCalled()
    expect(buttons()).toEqual(['Later', 'Update now'])
  })

  it('shows the reason when the install is cancelled (a sale is still being sent) and stays open', async () => {
    const message = 'A sale is still being sent to the tax device. Try again in a minute.'
    installApi({ installUpdate: vi.fn().mockResolvedValue({ success: false, error: message }) })
    await mountPrompt()

    await click('Update now')

    expect(container.textContent).toContain(message)
    expect(buttons()).toEqual(['Later', 'Update now'])
  })
})

describe('the toast and the sale-screen placement', () => {
  it('the toast stays quiet while the prompt is open, because the prompt shows the progress itself', async () => {
    useUpdateStatusStore.setState({ promptOpen: true })
    await act(async () => {
      root.render(createElement(UpdateToast))
    })

    await act(async () => emitStatus({ kind: 'downloading', percent: 10 }))

    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('the toast shows an install that was cancelled, instead of staying on Restarting…', async () => {
    installApi({ installUpdate: vi.fn().mockResolvedValue({ success: false, error: 'A sale is still being sent to the tax device. Try again in a minute.' }) })
    await act(async () => {
      root.render(createElement(UpdateToast))
    })
    await act(async () => emitStatus({ kind: 'downloaded', version: '2.2.0' }))
    const [toast] = useToastStore.getState().toasts
    expect(toast.message).toBe('Update ready - v2.2.0')

    const holder = document.createElement('div')
    document.body.appendChild(holder)
    const holderRoot = createRoot(holder)
    await act(async () => {
      holderRoot.render(toast.actions as never)
    })
    await act(async () => {
      holder.querySelector('button')!.click()
    })
    await flush()

    expect(api.installUpdate).toHaveBeenCalledTimes(1)
    expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
      'A sale is still being sent to the tax device. Try again in a minute.'
    )
    act(() => holderRoot.unmount())
    holder.remove()
  })

  const read = (...path: string[]): string => readFileSync(join(process.cwd(), ...path), 'utf8')

  it('is mounted in App.tsx only after login, the location gate and the fiscal setup gate, so no earlier screen is interrupted', () => {
    const app = read('src', 'renderer', 'src', 'App.tsx')
    const mounted = app.indexOf('<UpdatePrompt />')
    const lastGate = app.indexOf('if (!etimsComplete) {')
    const login = app.indexOf('if (!currentStaff) {')
    const location = app.indexOf('if (!demoMode && !locationConfirmed) {')

    expect(app.match(/<UpdatePrompt \/>/g)).toHaveLength(1)
    expect(mounted).toBeGreaterThan(lastGate)
    expect(lastGate).toBeGreaterThan(location)
    expect(location).toBeGreaterThan(login)
  })

  it('is the only thing in the renderer that makes the startup check', () => {
    const dir = resolve(process.cwd(), 'src', 'renderer', 'src')
    const walk = (path: string): string[] =>
      readdirSync(path).flatMap((name) => {
        const full = join(path, name)
        return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : []
      })
    const callers = walk(dir).filter((file) => readFileSync(file, 'utf8').includes('startupUpdateCheck'))

    expect(callers.map((file) => file.split(/[\\/]/).pop())).toEqual(['UpdatePrompt.tsx'])
  })
})
