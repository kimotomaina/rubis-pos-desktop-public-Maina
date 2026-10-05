/**
 * Phase 230: the update screens show no path, folder, address or file name, in any state; a raw updater error is
 * replaced by a plain sentence; and the technical message, with any token removed, goes to `till.log` as
 * `update-failed`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import UpdatePrompt from '../src/renderer/src/components/UpdatePrompt.js'
import UpdateToast from '../src/renderer/src/components/UpdateToast.js'
import AdminScreen from '../src/renderer/src/components/AdminScreen.js'
import { useAuthStore } from '../src/renderer/src/stores/authStore.js'
import { useCartStore } from '../src/renderer/src/stores/cartStore.js'
import { useToastStore } from '../src/renderer/src/stores/toastStore.js'
import { useUpdateStatusStore } from '../src/renderer/src/stores/updateStatusStore.js'
import { useKeyboardStore } from '../src/renderer/src/stores/keyboardStore.js'
import { looksTechnical, plainUpdateText } from '../src/renderer/src/lib/updateMessages.js'
import {
  NO_UPDATE_READY_MESSAGE,
  UPDATE_CHECK_FAILED_MESSAGE,
  UPDATE_DOWNLOAD_FAILED_MESSAGE,
  createUpdateErrors,
  redactSecrets,
  updateFailureDetail,
  updateInstallFailedMessage
} from '../src/main/services/updateErrors.js'
import { STILL_SENDING_MESSAGE } from '../src/main/services/updateInstall.js'
import { createTillLog, formatTillLogLine } from '../src/main/services/tillLog.js'
import { tillEventSchema } from '../src/main/lib/ipcValidator.js'
import type { UpdateStatus } from '../src/main/services/updater.js'

/** One pattern over rendered text: a drive letter, a backslash, `http`, a slash path, a file name or an error code. */
const NO_PATHS = /[A-Za-z]:[\\/]|\\|https?:|file:|\/[A-Za-z][\w.-]*\/[A-Za-z][\w.-]*|\.(?:exe|sqlite|yml|blockmap|asar|log)\b|net::|\bERR_|\bENOENT\b/i

/** What electron-updater and the backup step really produce: paths, folders, feed addresses, a token. */
const RAW_ERROR =
  'Cannot download "https://github.com/Volcha-Enterprises/rubis-pos-releases/releases/download/v2.2.4/RUBIS-POS-Setup-2.2.4.exe", status 404: ' +
  'ENOENT: no such file or directory, open \'C:\\Users\\Till\\AppData\\Roaming\\rubis-pos-desktop\\backups\\pre-update-2.2.3-to-2.2.4.sqlite\' ' +
  'Authorization: token ghp_abcdefghijklmnopqrstuvwxyz0123456789'

let container: HTMLDivElement
let root: Root
let emitStatus: (status: UpdateStatus) => void
type Api = Record<string, ReturnType<typeof vi.fn>>
let api: Api
const ok = <T,>(data?: T) => ({ success: true as const, data })

function installApi(overrides: Partial<Api> = {}): void {
  api = {
    startupUpdateCheck: vi.fn().mockResolvedValue(ok('2.2.4')),
    getAppVersion: vi.fn().mockResolvedValue('2.2.3'),
    downloadUpdate: vi.fn().mockResolvedValue(ok()),
    installUpdate: vi.fn().mockResolvedValue(ok()),
    checkForUpdates: vi.fn().mockResolvedValue(ok()),
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

async function click(label: string): Promise<void> {
  const el = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!el) throw new Error(`No button "${label}"`)
  await act(async () => {
    el.click()
  })
  await flush()
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useCartStore.getState().clearCart()
  useCartStore.setState({ checkoutStatus: 'idle' })
  useUpdateStatusStore.setState({ status: null, promptOpen: false })
  useToastStore.setState({ toasts: [] } as never)
  useKeyboardStore.setState({ request: null })
  useAuthStore.setState({ currentStaff: { id: 1, name: 'Admin', role: 'admin' } })
  installApi()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('the plain-text guard on screen', () => {
  it('knows a path, a folder, an address, a file name and an error code when it sees one', () => {
    for (const text of [
      'C:\\Users\\Till\\backups',
      'D:/data/x',
      '\\\\server\\share',
      'https://github.com/x/y',
      'file:///C:/x',
      '/home/till/updates/x',
      'RUBIS-POS-Setup-2.2.4.exe',
      'pre-update.sqlite',
      'latest.yml',
      'net::ERR_CONNECTION_RESET',
      'ENOENT: no such file'
    ]) {
      expect(looksTechnical(text), text).toBe(true)
    }
  })

  it('lets plain sentences through, including the ones the main process sends', () => {
    for (const text of [
      UPDATE_CHECK_FAILED_MESSAGE,
      UPDATE_DOWNLOAD_FAILED_MESSAGE,
      updateInstallFailedMessage('2.2.3'),
      STILL_SENDING_MESSAGE,
      NO_UPDATE_READY_MESSAGE,
      'Version 2.2.4 is available',
      'Up to date',
      'Manual / Daraja'
    ]) {
      expect(looksTechnical(text), text).toBe(false)
    }
  })

  it('replaces a technical message with the fallback, and an empty one too', () => {
    expect(plainUpdateText(RAW_ERROR, 'plain')).toBe('plain')
    expect(plainUpdateText('', 'plain')).toBe('plain')
    expect(plainUpdateText(undefined, 'plain')).toBe('plain')
    expect(plainUpdateText('Up to date', 'plain')).toBe('Up to date')
  })
})

describe('the App & Updates panel, in every state', () => {
  const mountAdmin = async (): Promise<void> => {
    await act(async () => {
      root.render(createElement(AdminScreen, { requestManagerPin: () => {} }))
      await Promise.resolve()
    })
    await flush()
  }
  const states: Array<[string, UpdateStatus]> = [
    ['checking', { kind: 'checking' }],
    ['up to date', { kind: 'not-available' }],
    ['available', { kind: 'available', version: '2.2.4' }],
    ['downloading', { kind: 'downloading', percent: 41 }],
    ['ready to install', { kind: 'downloaded', version: '2.2.4' }],
    ['error, with a raw path and address in the message', { kind: 'error', message: RAW_ERROR }]
  ]

  it.each(states)('shows no path, folder, address or file name when %s', async (_name, status) => {
    await mountAdmin()
    await act(async () => emitStatus(status))

    expect(container.textContent).toContain('Installed version')
    expect(container.textContent).not.toMatch(NO_PATHS)
  })

  it('says only the plain sentence for an error that arrives with a raw message', async () => {
    await mountAdmin()
    await act(async () => emitStatus({ kind: 'error', message: RAW_ERROR }))

    expect(container.textContent).toContain(UPDATE_CHECK_FAILED_MESSAGE)
    expect(container.textContent).not.toContain('github')
    expect(container.textContent).not.toContain('ghp_')
  })

  it('shows the carried-over line with no backup path, whatever the stored result holds', async () => {
    installApi({
      getLastUpdateResult: vi.fn().mockResolvedValue(
        ok({
          ok: true,
          fromVersion: '2.2.3',
          toVersion: '2.2.4',
          before: { orders: 10, unpushed: 0, unfiled: 0, mpesaPayments: 1 },
          after: { orders: 10, unpushed: 0, unfiled: 0, mpesaPayments: 1 },
          backupPath: 'C:\\Users\\Till\\AppData\\Roaming\\rubis-pos-desktop\\backups\\pre-update.sqlite',
          checkedAt: '2026-10-05T18:00:00.000Z'
        })
      )
    })
    await mountAdmin()

    expect(container.textContent).toContain('Updated 2.2.3 to 2.2.4')
    expect(container.textContent).toContain('Sales carried over: 10 of 10.')
    expect(container.textContent).not.toMatch(NO_PATHS)
    expect(container.textContent).not.toContain('Backup')
  })

  it('shows a failed download, check and install as plain sentences even when the call returns a raw message', async () => {
    installApi({
      downloadUpdate: vi.fn().mockResolvedValue({ success: false, error: RAW_ERROR }),
      checkForUpdates: vi.fn().mockResolvedValue({ success: false, error: RAW_ERROR }),
      installUpdate: vi.fn().mockResolvedValue({ success: false, error: RAW_ERROR })
    })
    await mountAdmin()

    await click('Check for Updates')
    expect(container.textContent).toContain(UPDATE_CHECK_FAILED_MESSAGE)
    expect(container.textContent).not.toMatch(NO_PATHS)

    await act(async () => emitStatus({ kind: 'available', version: '2.2.4' }))
    await click('Download update')
    expect(container.textContent).toContain(UPDATE_DOWNLOAD_FAILED_MESSAGE)
    expect(container.textContent).not.toMatch(NO_PATHS)

    await act(async () => emitStatus({ kind: 'downloaded', version: '2.2.4' }))
    await click('Install update and restart')
    expect(container.textContent).toContain('The update could not be installed.')
    expect(container.textContent).not.toMatch(NO_PATHS)
  })
})

describe('the update prompt, in every state', () => {
  const mountPrompt = async (): Promise<void> => {
    await act(async () => {
      root.render(createElement(UpdatePrompt))
    })
    await flush()
  }

  it('offer: version numbers only', async () => {
    await mountPrompt()

    expect(container.textContent).toContain('Update available: version 2.2.4')
    expect(container.textContent).toContain('Installed version 2.2.3')
    expect(container.textContent).not.toMatch(NO_PATHS)
  })

  it('downloading: progress only', async () => {
    let finish!: (value: unknown) => void
    installApi({ downloadUpdate: vi.fn(() => new Promise((resolve) => (finish = resolve))) })
    await mountPrompt()
    await click('Update now')
    await act(async () => emitStatus({ kind: 'downloading', percent: 37 }))

    expect(container.textContent).toContain('Downloading update… 37%')
    expect(container.textContent).not.toMatch(NO_PATHS)
    await act(async () => finish(ok()))
  })

  it('a failed download shows a plain sentence and the version the till is on, never the raw error', async () => {
    installApi({ downloadUpdate: vi.fn().mockResolvedValue({ success: false, error: RAW_ERROR }) })
    await mountPrompt()

    await click('Update now')

    expect(container.textContent).toContain(UPDATE_DOWNLOAD_FAILED_MESSAGE)
    expect(container.textContent).toContain('The till is still running version 2.2.3.')
    expect(container.textContent).not.toMatch(NO_PATHS)
  })

  it('a failed install (the backup step) shows a plain sentence, never the raw error', async () => {
    installApi({ installUpdate: vi.fn().mockResolvedValue({ success: false, error: RAW_ERROR }) })
    await mountPrompt()

    await click('Update now')

    expect(container.textContent).toContain('The update could not be installed.')
    expect(container.textContent).not.toMatch(NO_PATHS)
  })

  it('a message the main process already made plain is shown as it is', async () => {
    installApi({ installUpdate: vi.fn().mockResolvedValue({ success: false, error: STILL_SENDING_MESSAGE }) })
    await mountPrompt()

    await click('Update now')

    expect(container.textContent).toContain(STILL_SENDING_MESSAGE)
  })
})

describe('the toast', () => {
  it('shows a plain sentence for an install that failed with a raw message, and no path in any toast', async () => {
    installApi({ installUpdate: vi.fn().mockResolvedValue({ success: false, error: RAW_ERROR }) })
    await act(async () => {
      root.render(createElement(UpdateToast))
    })
    await act(async () => emitStatus({ kind: 'downloaded', version: '2.2.4' }))
    const [toast] = useToastStore.getState().toasts
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

    const messages = useToastStore.getState().toasts.map((t) => t.message)
    expect(messages.some((m) => m.startsWith('The update could not be installed.'))).toBe(true)
    for (const message of messages) expect(message).not.toMatch(NO_PATHS)
    act(() => holderRoot.unmount())
    holder.remove()
  })
})

describe('the main process: plain messages out, technical detail to till.log', () => {
  const setup = (): { errors: ReturnType<typeof createUpdateErrors>; lines: string[]; tick: (ms: number) => void } => {
    const lines: string[] = []
    let clock = 1_000_000
    const errors = createUpdateErrors((detail) => lines.push(detail), () => clock)
    return { errors, lines, tick: (ms) => (clock += ms) }
  }

  it('turns an error status into the plain sentence and logs the raw one once, secrets removed', () => {
    const { errors, lines } = setup()

    const status = errors.onStatus({ kind: 'error', message: RAW_ERROR })

    expect(status).toEqual({ kind: 'error', message: UPDATE_CHECK_FAILED_MESSAGE })
    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith('check: ')).toBe(true)
    expect(lines[0]).toContain('github.com')
    expect(lines[0]).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(lines[0]).toContain('[removed]')
  })

  it('says "download" once a download has started, from its progress or from beginDownload', () => {
    const a = setup()
    a.errors.onStatus({ kind: 'downloading', percent: 5 })
    expect(a.errors.onStatus({ kind: 'error', message: 'x' })).toEqual({ kind: 'error', message: UPDATE_DOWNLOAD_FAILED_MESSAGE })
    expect(a.lines[0].startsWith('download: ')).toBe(true)

    const b = setup()
    b.errors.beginDownload()
    b.errors.onStatus({ kind: 'error', message: 'y' })
    expect(b.lines[0].startsWith('download: ')).toBe(true)

    const c = setup()
    c.errors.onStatus({ kind: 'downloading', percent: 5 })
    c.errors.onStatus({ kind: 'checking' })
    c.errors.onStatus({ kind: 'error', message: 'z' })
    expect(c.lines[0].startsWith('check: ')).toBe(true)
  })

  it('passes every other status through untouched', () => {
    const { errors, lines } = setup()
    const others: UpdateStatus[] = [
      { kind: 'checking' },
      { kind: 'not-available' },
      { kind: 'available', version: '2.2.4' },
      { kind: 'downloading', percent: 9 },
      { kind: 'downloaded', version: '2.2.4' }
    ]

    for (const status of others) expect(errors.onStatus(status)).toEqual(status)
    expect(lines).toEqual([])
  })

  it('logs the same failure once when it arrives as an event and as a rejection, and again once the moment has passed', () => {
    const { errors, lines, tick } = setup()
    errors.beginDownload()

    errors.onStatus({ kind: 'error', message: 'socket hang up' })
    errors.download({ success: false, error: 'socket hang up' })
    expect(lines).toHaveLength(1)

    tick(5000)
    errors.download({ success: false, error: 'socket hang up' })
    expect(lines).toHaveLength(2)
  })

  it('turns a failed download into the plain sentence and logs it', () => {
    const { errors, lines } = setup()

    expect(errors.download({ success: false, error: RAW_ERROR })).toEqual({ success: false, error: UPDATE_DOWNLOAD_FAILED_MESSAGE })
    expect(lines[0].startsWith('download: ')).toBe(true)
    expect(errors.download({ success: true })).toEqual({ success: true })
  })

  it('turns a failed install (the backup step) into a plain sentence naming the version, and logs it', () => {
    const { errors, lines } = setup()

    const result = errors.install({ success: false, error: RAW_ERROR }, '2.2.3')

    expect(result).toEqual({ success: false, error: 'The update could not be installed. The till is still on version 2.2.3.' })
    expect(lines[0].startsWith('install: ')).toBe(true)
    expect(lines[0]).not.toContain('ghp_')
  })

  it('leaves the two messages that are already plain, and logs nothing for them', () => {
    const { errors, lines } = setup()

    expect(errors.install({ success: false, error: STILL_SENDING_MESSAGE }, '2.2.3').error).toBe(STILL_SENDING_MESSAGE)
    expect(errors.install({ success: false, error: NO_UPDATE_READY_MESSAGE }, '2.2.3').error).toBe(NO_UPDATE_READY_MESSAGE)
    expect(errors.install({ success: true }, '2.2.3')).toEqual({ success: true })
    expect(lines).toEqual([])
  })

  it('no message it gives a screen holds a path, an address or a file name', () => {
    for (const message of [UPDATE_CHECK_FAILED_MESSAGE, UPDATE_DOWNLOAD_FAILED_MESSAGE, updateInstallFailedMessage('2.2.3')]) {
      expect(message).not.toMatch(NO_PATHS)
    }
  })
})

describe('till.log gets the detail, and no token', () => {
  const tokens = [
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'gho_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz',
    'Bearer abcdefghijklmnop1234567890',
    'token abcdefghijklmnop1234567890',
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'https://user:s3cretpass@example.com/feed',
    'https://api.example.com/x?access_token=abc123def456&other=1',
    'https://api.example.com/x?sig=abc123def456'
  ]

  it.each(tokens)('removes %s', (secret) => {
    const redacted = redactSecrets(`Cannot download ${secret} status 401`)
    const pieces = secret.split(/[\s:@=]/).filter((part) => part.length > 8 && !/^https?$|^api\.example\.com|^Basic$|^Authorization$|^example/.test(part))

    expect(redacted).toContain('[removed]')
    for (const piece of pieces) {
      if (/^[A-Za-z0-9._~+/=-]+$/.test(piece) && !piece.startsWith('//') && !piece.includes('.com')) {
        expect(redacted, piece).not.toContain(piece)
      }
    }
  })

  it('keeps the paths and addresses support needs, and only the secret goes', () => {
    const detail = updateFailureDetail('download', new Error(RAW_ERROR))

    expect(detail).toContain('https://github.com/Volcha-Enterprises/rubis-pos-releases')
    expect(detail).toContain('backups')
    expect(detail).not.toContain('ghp_')
    expect(detail.startsWith('download: ')).toBe(true)
  })

  it('writes one `update-failed` line through the real log format, with no token in it', () => {
    const appended: string[] = []
    const log = createTillLog('C:/data/till.log', { appendFileSync: (_path, data) => appended.push(data) })

    log.record('update-failed', updateFailureDetail('install', new Error(RAW_ERROR)))

    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatch(/^\[[\d:.TZ-]+\] \[update-failed\] install: /)
    expect(appended[0]).not.toContain('ghp_')
    expect(appended[0].trimEnd().split('\n')).toHaveLength(1)
    expect(formatTillLogLine('update-failed', 'x')).toContain('[update-failed]')
  })

  it('cannot be written by the screen: log:till-event refuses the event', () => {
    expect(tillEventSchema.safeParse({ event: 'update-failed', detail: 'x' }).success).toBe(false)
  })

  it('a token near the cap cannot survive by being cut in half', () => {
    const padded = `${'x'.repeat(190)} Bearer abcdefghijklmnop1234567890`
    const line = formatTillLogLine('update-failed', updateFailureDetail('check', padded))

    expect(line).not.toContain('abcdefghijklmnop')
  })
})

describe('the wiring in main/index.ts', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')

  it('sends every updater status through the plain-message filter before it reaches a window', () => {
    expect(source).toContain('const status = updateErrors.onStatus(rawStatus)')
    expect(source).toContain("broadcast('updater:status', status)")
    expect(source).not.toContain("broadcast('updater:status', rawStatus)")
  })

  it('filters the download and install answers, and logs through the fixed event', () => {
    expect(source).toContain('updateErrors.download(await downloadUpdateNow(autoUpdater))')
    expect(source).toContain('return updateErrors.install(result, app.getVersion())')
    expect(source).toContain("tillLog.record('update-failed', detail)")
  })

  it('leaves the backup and install safety checks where they were', () => {
    expect(source).toContain('installWhenQuiet({')
    expect(source).toContain('installUpdate({')
    expect(source).toContain('quitAndInstall: () => autoUpdater.quitAndInstall()')
  })
})
