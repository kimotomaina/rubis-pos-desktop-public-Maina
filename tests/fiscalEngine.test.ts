/**
 * Fiscalization engine tests.
 *
 * Mirrors `syncEngine.test.ts`'s structure: the engine's collaborators
 * (database slice, `submitInvoice`) are injected fakes, and fake
 * timers drive the interval.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createFiscalEngine } from '../src/main/services/fiscal-engine.js'
import type { FiscalEngineDatabase } from '../src/main/services/fiscal-engine.js'
import type { FiscalQueueItem } from '../src/main/services/database.js'
import type { FiscalInvoiceRequest } from '../src/main/services/integrations/etims.js'

const makePayload = (uuid: string): FiscalInvoiceRequest => ({
  clientOrderUuid: uuid,
  items: [{ description: 'Bread', quantity: 1, unitPrice: 60, taxRate: 0.16 }],
  total: 69.6,
  taxAmount: 9.6
})

const makeItem = (id: number, uuid = `uuid-${id}`): FiscalQueueItem => ({
  id,
  entity_type: 'etims_invoice',
  entity_id: id + 100,
  action: 'fiscalizeInvoice',
  payload: makePayload(uuid),
  attempts: 0,
  last_error: null,
  created_at: '2026-08-24T10:00:00.000Z',
  next_attempt_at: 0
})

function makeEngine(overrides: {
  items?: FiscalQueueItem[]
  submit?: (
    request: FiscalInvoiceRequest
  ) => Promise<{
    success: boolean
    data?: { invoiceNumber: string; qrCode: string; fiscalizedAt: string }
    error?: string
  }>
  exhausted?: boolean
  intervalMs?: number
}) {
  const db = {
    getPendingFiscalQueue: vi.fn(() => overrides.items ?? []),
    markFiscalQueueItemSynced: vi.fn(),
    recordFiscalQueueFailure: vi.fn(() => ({ exhausted: overrides.exhausted ?? false }))
  }
  const submitInvoice = vi.fn(
    overrides.submit ??
      (async () => ({
        success: true,
        data: { invoiceNumber: 'KRA-0001', qrCode: 'base64qr', fiscalizedAt: '2026-08-24T10:00:00.000Z' }
      }))
  )

  const engine = createFiscalEngine({
    db: db as unknown as FiscalEngineDatabase,
    submitInvoice: submitInvoice as never,
    intervalMs: overrides.intervalMs ?? 30_000,
    now: () => 1_700_000_000_000
  })

  return { db, submitInvoice, engine }
}

describe('FiscalEngine.tick', () => {
  it('resubmits every due item and marks successes synced', async () => {
    const { db, submitInvoice, engine } = makeEngine({
      items: [makeItem(1), makeItem(2)]
    })

    await engine.tick()

    expect(db.getPendingFiscalQueue).toHaveBeenCalledWith(1_700_000_000_000)
    expect(submitInvoice).toHaveBeenCalledTimes(2)
    expect(db.markFiscalQueueItemSynced).toHaveBeenNthCalledWith(1, 1, 'KRA-0001', 'base64qr')
    expect(db.markFiscalQueueItemSynced).toHaveBeenNthCalledWith(2, 2, 'KRA-0001', 'base64qr')
    expect(db.recordFiscalQueueFailure).not.toHaveBeenCalled()
  })

  it('resends the same clientOrderUuid on every attempt (idempotency)', async () => {
    const { submitInvoice, engine } = makeEngine({ items: [makeItem(1, 'uuid-fixed')] })

    await engine.tick()

    expect(submitInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ clientOrderUuid: 'uuid-fixed' })
    )
  })

  it('records failures with the returned error message and does not delete the row itself', async () => {
    const { db, engine } = makeEngine({
      items: [makeItem(1)],
      submit: async () => ({ success: false, error: 'Fiscal device unreachable' })
    })

    await engine.tick()

    expect(db.recordFiscalQueueFailure).toHaveBeenCalledWith(1, 'Fiscal device unreachable')
    expect(db.markFiscalQueueItemSynced).not.toHaveBeenCalled()
  })

  it('uses a generic error when the result has no message', async () => {
    const { db, engine } = makeEngine({
      items: [makeItem(1)],
      submit: async () => ({ success: false })
    })

    await engine.tick()

    expect(db.recordFiscalQueueFailure).toHaveBeenCalledWith(1, 'Unknown fiscalization error')
  })

  it('continues past an item whose retries are exhausted', async () => {
    const { db, submitInvoice, engine } = makeEngine({
      items: [makeItem(1), makeItem(2)],
      exhausted: true,
      submit: async () => ({ success: false, error: 'always fails' })
    })

    await engine.tick()

    expect(db.recordFiscalQueueFailure).toHaveBeenNthCalledWith(1, 1, 'always fails')
    expect(db.recordFiscalQueueFailure).toHaveBeenNthCalledWith(2, 2, 'always fails')
    expect(submitInvoice).toHaveBeenCalledTimes(2)
  })

  it('never gates a pass on connectivity — no isOnline dependency exists', async () => {
    const { submitInvoice, engine } = makeEngine({ items: [makeItem(1)] })

    await engine.tick()

    expect(submitInvoice).toHaveBeenCalledTimes(1)
  })
})

describe('FiscalEngine re-entrancy', () => {
  it('coalesces concurrent ticks into a single pass', async () => {
    let release!: () => void
    const deferred = new Promise<void>((resolve) => {
      release = resolve
    })

    const submitInvoice = vi.fn(async () => {
      await deferred
      return {
        success: true,
        data: { invoiceNumber: 'KRA-0001', qrCode: '', fiscalizedAt: '2026-08-24T10:00:00.000Z' }
      }
    })

    const engine = createFiscalEngine({
      db: {
        getPendingFiscalQueue: vi.fn(() => [makeItem(1)]),
        markFiscalQueueItemSynced: vi.fn(),
        recordFiscalQueueFailure: vi.fn()
      },
      submitInvoice: submitInvoice as never
    })

    const first = engine.tick()
    const second = engine.tick()
    release()
    await Promise.all([first, second])

    expect(submitInvoice).toHaveBeenCalledTimes(1)
  })
})

describe('FiscalEngine lifecycle & triggers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('start() runs an immediate tick then ticks every interval', async () => {
    const { submitInvoice, engine } = makeEngine({
      items: [makeItem(1)],
      intervalMs: 30_000
    })

    engine.start()
    await Promise.resolve()
    expect(submitInvoice).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(submitInvoice).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(submitInvoice).toHaveBeenCalledTimes(3)
  })

  it('stop() cancels the interval timer', async () => {
    const { submitInvoice, engine } = makeEngine({
      items: [makeItem(1)],
      intervalMs: 30_000
    })

    engine.start()
    await Promise.resolve()
    engine.stop()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(submitInvoice).toHaveBeenCalledTimes(1)
  })

  it('start() is idempotent — double start keeps one timer', async () => {
    const { submitInvoice, engine } = makeEngine({
      items: [makeItem(1)],
      intervalMs: 30_000
    })

    engine.start()
    engine.start()
    await Promise.resolve()
    expect(submitInvoice).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(submitInvoice).toHaveBeenCalledTimes(2)
  })

  it('notifyOnline() performs an immediate retry pass (trigger c)', async () => {
    const { submitInvoice, engine } = makeEngine({ items: [makeItem(1)] })

    engine.notifyOnline()
    await Promise.resolve()

    expect(submitInvoice).toHaveBeenCalledTimes(1)
  })

  it('onCheckoutMade() performs an immediate retry pass (trigger a)', async () => {
    const { submitInvoice, engine } = makeEngine({ items: [makeItem(1)] })

    engine.onCheckoutMade()
    await Promise.resolve()

    expect(submitInvoice).toHaveBeenCalledTimes(1)
  })
})
