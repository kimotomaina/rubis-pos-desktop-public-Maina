/**
 * Background work finishes before an update installs (docs/phase-219).
 *
 * The real fiscal and Shopify engines are used with injected fakes behind them, so what is
 * proved is the engines' own pause and idle behaviour, not a stand-in for it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createFiscalEngine } from '../src/main/services/fiscal-engine.js'
import type { FiscalEngineDatabase } from '../src/main/services/fiscal-engine.js'
import { createSyncEngine } from '../src/main/services/sync-engine.js'
import type { SyncEngineDatabase } from '../src/main/services/sync-engine.js'
import { installUpdate } from '../src/main/services/updateBackup.js'
import { installWhenQuiet, STILL_SENDING_MESSAGE, BACKGROUND_WAIT_MS } from '../src/main/services/updateInstall.js'
import type { PausableEngine } from '../src/main/services/updateInstall.js'
import type { FiscalQueueItem, SyncQueueItem } from '../src/main/services/database.js'
import type { FiscalSubmitOutcome } from '../src/main/services/integrations/etims.js'

afterEach(() => {
  vi.useRealTimers()
})

const FILED: FiscalSubmitOutcome = {
  ok: true,
  data: { invoiceNumber: 'KRA-0001', qrCode: 'qr', fiscalizedAt: '2026-10-04T10:00:00.000Z' }
}

const fiscalItem = (id: number): FiscalQueueItem => ({
  id,
  entity_type: 'etims_invoice',
  entity_id: id + 100,
  action: 'fiscalizeInvoice',
  payload: { clientOrderUuid: `uuid-${id}`, items: [], total: 0, taxAmount: 0 },
  attempts: 0,
  last_error: null,
  created_at: '2026-10-04T10:00:00.000Z',
  next_attempt_at: 0
})

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function makeFiscal(submit?: () => Promise<FiscalSubmitOutcome>) {
  const db = {
    getPendingFiscalQueue: vi.fn(() => [fiscalItem(1)]),
    markFiscalQueueItemSynced: vi.fn(),
    recordFiscalQueueFailure: vi.fn(() => ({ exhausted: false })),
    removeFiscalQueueItem: vi.fn(),
    setOrderFiscalFailure: vi.fn(),
    getOrder: vi.fn(() => undefined)
  }
  const submitInvoice = vi.fn(submit ?? (async () => FILED))
  const engine = createFiscalEngine({
    db: db as unknown as FiscalEngineDatabase,
    submitInvoice: submitInvoice as never,
    logger: { log: () => {}, warn: () => {}, error: () => {} }
  })
  return { engine, submitInvoice }
}

function makeSync(push?: () => Promise<{ success: boolean; data?: { shopifyOrderId: string } }>) {
  const item = { id: 1, entity_type: 'order', entity_id: 7, payload: {}, attempts: 0 } as unknown as SyncQueueItem
  const db = {
    getPendingSyncQueue: vi.fn(() => [item]),
    recordPushStarted: vi.fn(),
    markQueueItemSynced: vi.fn(),
    recordQueueFailure: vi.fn(() => ({ exhausted: false }))
  }
  const pushOrder = vi.fn(push ?? (async () => ({ success: true, data: { shopifyOrderId: 'gid://1' } })))
  const engine = createSyncEngine({
    db: db as unknown as SyncEngineDatabase,
    isOnline: () => true,
    pushOrder: pushOrder as never
  })
  return { engine, pushOrder }
}

/** What both engines must do, written once: paused means no send from any trigger, resume means sending again. */
async function expectPauseHoldsEveryTrigger(
  engine: PausableEngine & { tick(): Promise<void>; onCheckoutMade(): void; notifyOnline(): void },
  sends: { mock: { calls: unknown[] } }
): Promise<void> {
  engine.pause()
  await engine.tick()
  engine.onCheckoutMade()
  engine.notifyOnline()
  await engine.whenIdle()
  expect(sends.mock.calls).toHaveLength(0)

  engine.resume()
  await engine.tick()
  expect(sends.mock.calls).toHaveLength(1)
}

describe('pausing an engine', () => {
  it('fiscal: starts no tick while paused, whoever asks (tick, checkout, reconnect), and again after resume', async () => {
    const { engine, submitInvoice } = makeFiscal()
    await expectPauseHoldsEveryTrigger(engine, submitInvoice)
  })

  it('Shopify sync: starts no tick while paused, whoever asks (tick, checkout, reconnect), and again after resume', async () => {
    const { engine, pushOrder } = makeSync()
    await expectPauseHoldsEveryTrigger(engine, pushOrder)
  })

  it('whenIdle resolves at once when no tick is running', async () => {
    await expect(makeFiscal().engine.whenIdle()).resolves.toBeUndefined()
    await expect(makeSync().engine.whenIdle()).resolves.toBeUndefined()
  })
})

describe('the fiscal engine, with a tick running', () => {
  it('whenIdle waits for the running tick, and a pause does not interrupt it', async () => {
    const reply = deferred<FiscalSubmitOutcome>()
    const { engine, submitInvoice } = makeFiscal(() => reply.promise)
    const tick = engine.tick()
    let idle = false
    engine.pause()
    void engine.whenIdle().then(() => {
      idle = true
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(submitInvoice).toHaveBeenCalledTimes(1)
    expect(idle).toBe(false)

    reply.resolve(FILED)
    await tick
    await engine.whenIdle()
    expect(idle).toBe(true)
  })
})

describe('installWhenQuiet', () => {
  it('waits for a running fiscal tick and installs only after it ends', async () => {
    const reply = deferred<FiscalSubmitOutcome>()
    const { engine } = makeFiscal(() => reply.promise)
    const install = vi.fn(async () => ({ success: true }))
    const tick = engine.tick()

    const result = installWhenQuiet({ engines: [engine], install })
    await Promise.resolve()
    await Promise.resolve()
    expect(install).not.toHaveBeenCalled()

    reply.resolve(FILED)
    await tick

    await expect(result).resolves.toEqual({ success: true })
    expect(install).toHaveBeenCalledOnce()
  })

  it('does not call quitAndInstall until the running tick has ended (the backup and install path, composed)', async () => {
    const reply = deferred<FiscalSubmitOutcome>()
    const fiscal = makeFiscal(() => reply.promise)
    const sync = makeSync()
    const quitAndInstall = vi.fn()
    const db = {
      backup: vi.fn(async () => {}),
      setSetting: vi.fn(),
      getSetting: vi.fn(),
      deleteSetting: vi.fn(),
      getTotalOrderCount: () => 10,
      getUnpushedOrderCount: () => 0,
      getUnfiledOrderCount: () => 0,
      getMpesaPaymentCount: () => 0
    }
    const tick = fiscal.engine.tick()

    const result = installWhenQuiet({
      engines: [fiscal.engine, sync.engine],
      install: () =>
        installUpdate({
          db: db as never,
          backupsDir: 'backups',
          fromVersion: '2.1.9',
          toVersion: '2.2.0',
          ensureDir: () => {},
          listBackups: () => [],
          deleteBackup: () => {},
          quitAndInstall
        })
    })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(db.backup).not.toHaveBeenCalled()
    expect(quitAndInstall).not.toHaveBeenCalled()

    reply.resolve(FILED)
    await tick
    await result

    expect(db.backup).toHaveBeenCalledOnce()
    expect(quitAndInstall).toHaveBeenCalledOnce()
  })

  it('starts no new tick between pausing and installing, from either engine', async () => {
    const reply = deferred<FiscalSubmitOutcome>()
    const fiscal = makeFiscal(() => reply.promise)
    const sync = makeSync()
    const duringInstall: number[] = []
    const tick = fiscal.engine.tick()

    const result = installWhenQuiet({
      engines: [fiscal.engine, sync.engine],
      install: async () => {
        fiscal.engine.onCheckoutMade()
        sync.engine.onCheckoutMade()
        duringInstall.push(fiscal.submitInvoice.mock.calls.length, sync.pushOrder.mock.calls.length)
        return { success: true }
      }
    })
    fiscal.engine.notifyOnline()
    sync.engine.notifyOnline()
    reply.resolve(FILED)
    await tick
    await result

    expect(duringInstall).toEqual([1, 0])
    expect(sync.pushOrder).not.toHaveBeenCalled()
    expect(fiscal.submitInvoice).toHaveBeenCalledTimes(1)
  })

  it('cancels after the limit: nothing installs, the engines run again, and the message is returned', async () => {
    vi.useFakeTimers()
    const stuck: PausableEngine = {
      pause: vi.fn(),
      resume: vi.fn(),
      whenIdle: () => new Promise<void>(() => {})
    }
    const quiet: PausableEngine = { pause: vi.fn(), resume: vi.fn(), whenIdle: () => Promise.resolve() }
    const install = vi.fn(async () => ({ success: true }))

    const result = installWhenQuiet({ engines: [stuck, quiet], install })
    await vi.advanceTimersByTimeAsync(BACKGROUND_WAIT_MS - 1)
    expect(install).not.toHaveBeenCalled()
    expect(stuck.resume).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await expect(result).resolves.toEqual({ success: false, error: STILL_SENDING_MESSAGE })
    expect(STILL_SENDING_MESSAGE).toBe('A sale is still being sent to the tax device. Try again in a minute.')
    expect(install).not.toHaveBeenCalled()
    expect(stuck.resume).toHaveBeenCalledOnce()
    expect(quiet.resume).toHaveBeenCalledOnce()
  })

  it('waits at most 60 seconds', () => {
    expect(BACKGROUND_WAIT_MS).toBe(60_000)
  })

  it('resumes the engines when the install itself fails, and leaves them stopped when it succeeds', async () => {
    const engine: PausableEngine = { pause: vi.fn(), resume: vi.fn(), whenIdle: () => Promise.resolve() }

    await installWhenQuiet({ engines: [engine], install: async () => ({ success: false, error: 'Backup failed' }) })
    expect(engine.resume).toHaveBeenCalledOnce()

    await installWhenQuiet({ engines: [engine], install: async () => ({ success: true }) })
    expect(engine.resume).toHaveBeenCalledOnce()
  })
})

describe('the install handler', () => {
  const index = readFileSync(resolve(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
  const handler = index.slice(index.indexOf("ipcMain.handle('updater:install'"), index.indexOf("ipcMain.handle('updater:last-result'"))

  it('is the only caller of quitAndInstall, and goes through installWhenQuiet with both engines', () => {
    expect(index.match(/autoUpdater\.quitAndInstall\(/g)).toHaveLength(1)
    expect(handler).toContain('installWhenQuiet')
    expect(handler.indexOf('installWhenQuiet')).toBeLessThan(handler.indexOf('quitAndInstall'))
    expect(index).toContain('const backgroundEngines = [engine, fiscalEngine]')
  })
})
