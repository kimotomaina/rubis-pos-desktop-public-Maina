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
import type {
  FiscalInvoiceRequest,
  FiscalSubmitOutcome
} from '../src/main/services/integrations/etims.js'

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

/** Default successful outcome: a plain, unclassified success. */
const OK_OUTCOME: FiscalSubmitOutcome = {
  ok: true,
  data: { invoiceNumber: 'KRA-0001', qrCode: 'base64qr', fiscalizedAt: '2026-08-24T10:00:00.000Z' }
}

function makeEngine(overrides: {
  items?: FiscalQueueItem[]
  submit?: (request: FiscalInvoiceRequest) => Promise<FiscalSubmitOutcome>
  exhausted?: boolean
  intervalMs?: number
}) {
  const db = {
    getPendingFiscalQueue: vi.fn(() => overrides.items ?? []),
    markFiscalQueueItemSynced: vi.fn(),
    recordFiscalQueueFailure: vi.fn(() => ({ exhausted: overrides.exhausted ?? false })),
    removeFiscalQueueItem: vi.fn(),
    setOrderFiscalFailure: vi.fn(),
    // Not already fiscalized by default — attemptFiscalRetry (phase-75)
    // proceeds to resubmit, matching this suite's pre-existing behavior.
    getOrder: vi.fn(() => undefined)
  }
  const submitInvoice = vi.fn(overrides.submit ?? (async () => OK_OUTCOME))

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
    // docs/phase-163: a fourth arg (vatGroups) is now forwarded from the
    // outcome's data — undefined here, since this test's stub success
    // result carries none.
    expect(db.markFiscalQueueItemSynced).toHaveBeenNthCalledWith(1, 1, 'KRA-0001', 'base64qr', undefined)
    expect(db.markFiscalQueueItemSynced).toHaveBeenNthCalledWith(2, 2, 'KRA-0001', 'base64qr', undefined)
    expect(db.recordFiscalQueueFailure).not.toHaveBeenCalled()
  })

  it('resends the same clientOrderUuid on every attempt (idempotency)', async () => {
    const { submitInvoice, engine } = makeEngine({ items: [makeItem(1, 'uuid-fixed')] })

    await engine.tick()

    expect(submitInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ clientOrderUuid: 'uuid-fixed' })
    )
  })

  it('records failures with the returned reason and does not delete the row itself', async () => {
    const { db, engine } = makeEngine({
      items: [makeItem(1)],
      submit: async () => ({
        ok: false,
        reason: 'Fiscal device unreachable',
        kind: 'technical',
        retryable: true
      })
    })

    await engine.tick()

    expect(db.recordFiscalQueueFailure).toHaveBeenCalledWith(1, 'Fiscal device unreachable')
    expect(db.markFiscalQueueItemSynced).not.toHaveBeenCalled()
  })

  it('continues past an item whose retries are exhausted', async () => {
    const { db, submitInvoice, engine } = makeEngine({
      items: [makeItem(1), makeItem(2)],
      exhausted: true,
      submit: async () => ({ ok: false, reason: 'always fails', kind: 'technical', retryable: true })
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

describe('FiscalEngine.tick — retry safety (phase-75, Part B)', () => {
  it('tags every resubmission isRetry:true — every queued item is, by construction, a retry', async () => {
    const { submitInvoice, engine } = makeEngine({ items: [makeItem(1)] })

    await engine.tick()

    expect(submitInvoice).toHaveBeenCalledWith(expect.objectContaining({ isRetry: true }))
  })

  it('records a still-technical retry failure with backoff — does not remove the row, does not touch fiscal_status', async () => {
    const { db, engine } = makeEngine({
      items: [makeItem(1)],
      submit: async () => ({ ok: false, reason: 'device unreachable', kind: 'technical', retryable: true })
    })

    await engine.tick()

    expect(db.recordFiscalQueueFailure).toHaveBeenCalledWith(1, 'device unreachable')
    expect(db.removeFiscalQueueItem).not.toHaveBeenCalled()
    expect(db.setOrderFiscalFailure).not.toHaveBeenCalled()
  })

  it('makes NO device call and marks the queue item synced when the order was already fiscalized (race with a resend)', async () => {
    const db = {
      getPendingFiscalQueue: vi.fn(() => [makeItem(1)]),
      markFiscalQueueItemSynced: vi.fn(),
      recordFiscalQueueFailure: vi.fn(),
      getOrder: vi.fn(() => ({
        fiscal_status: 'fiscalized' as const,
        fiscal_invoice_number: 'KRA-WON-THE-RACE',
        fiscal_qr_code: 'base64qr',
        fiscal_fiscalized_at: '2026-01-01T00:00:00.000Z'
      }))
    }
    const submitInvoice = vi.fn()
    const engine = createFiscalEngine({
      db: db as unknown as FiscalEngineDatabase,
      submitInvoice: submitInvoice as never,
      now: () => 1_700_000_000_000
    })

    await engine.tick()

    expect(submitInvoice).not.toHaveBeenCalled()
    // docs/phase-163: the already-fiscalized race guard's stored outcome
    // carries no vatGroups (it never re-reads the device), so the
    // forwarded fourth arg is undefined.
    expect(db.markFiscalQueueItemSynced).toHaveBeenCalledWith(1, 'KRA-WON-THE-RACE', 'base64qr', undefined)
    expect(db.recordFiscalQueueFailure).not.toHaveBeenCalled()
  })
})

describe('FiscalEngine.tick — retry reclassification (phase-76, Part C)', () => {
  it.each([
    ['data', 'Wrong client PIN'],
    ['system', 'ZFPLabServer rejected the request format']
  ] as const)(
    'a queued (waiting) item whose retry comes back non-retryable (%s) becomes needs_fixing and is removed from the queue',
    async (kind, reason) => {
      const { db, submitInvoice, engine } = makeEngine({
        items: [makeItem(1)],
        submit: async () => ({ ok: false, reason, kind, retryable: false })
      })

      await engine.tick()

      expect(db.setOrderFiscalFailure).toHaveBeenCalledWith(101, 'needs_fixing', reason, kind, null)
      expect(db.removeFiscalQueueItem).toHaveBeenCalledWith(1)
      // Reclassification is a removal, not a backoff — the two are mutually exclusive.
      expect(db.recordFiscalQueueFailure).not.toHaveBeenCalled()
      expect(submitInvoice).toHaveBeenCalledTimes(1)
    }
  )

  it('persists the wrong-pin data-issue tag when a retry reveals it (phase-88/Step 4)', async () => {
    const { db, engine } = makeEngine({
      items: [makeItem(1)],
      submit: async () => ({
        ok: false,
        reason: 'Wrong client PIN',
        kind: 'data',
        retryable: false,
        dataIssue: 'wrong-pin'
      })
    })

    await engine.tick()

    expect(db.setOrderFiscalFailure).toHaveBeenCalledWith(
      101,
      'needs_fixing',
      'Wrong client PIN',
      'data',
      'wrong-pin'
    )
  })
})

describe('FiscalEngine.tick — logging (phase-80)', () => {
  function makeSpyLogger() {
    return { log: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }

  it('a queued retry that succeeds is quiet on warn/error, logging only an info line', async () => {
    const logger = makeSpyLogger()
    const db2 = {
      getPendingFiscalQueue: vi.fn(() => [makeItem(1)]),
      markFiscalQueueItemSynced: vi.fn(),
      recordFiscalQueueFailure: vi.fn(),
      removeFiscalQueueItem: vi.fn(),
      setOrderFiscalFailure: vi.fn(),
      getOrder: vi.fn(() => undefined)
    }
    const engine = createFiscalEngine({
      db: db2 as unknown as FiscalEngineDatabase,
      submitInvoice: (async () => OK_OUTCOME) as never,
      now: () => 1_700_000_000_000,
      logger
    })

    await engine.tick()

    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Sale 101'))
  })

  it('a data-kind reclassification to needs_fixing logs a warn including the localId', async () => {
    const logger = makeSpyLogger()
    const db2 = {
      getPendingFiscalQueue: vi.fn(() => [makeItem(1)]),
      markFiscalQueueItemSynced: vi.fn(),
      recordFiscalQueueFailure: vi.fn(),
      removeFiscalQueueItem: vi.fn(),
      setOrderFiscalFailure: vi.fn(),
      getOrder: vi.fn(() => undefined)
    }
    const engine = createFiscalEngine({
      db: db2 as unknown as FiscalEngineDatabase,
      submitInvoice: (async () => ({
        ok: false,
        reason: 'Wrong client PIN',
        kind: 'data',
        retryable: false
      })) as never,
      now: () => 1_700_000_000_000,
      logger
    })

    await engine.tick()

    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sale 101'))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Wrong client PIN'))
  })

  it('a system-kind reclassification to needs_fixing logs an error including the localId', async () => {
    const logger = makeSpyLogger()
    const db2 = {
      getPendingFiscalQueue: vi.fn(() => [makeItem(1)]),
      markFiscalQueueItemSynced: vi.fn(),
      recordFiscalQueueFailure: vi.fn(),
      removeFiscalQueueItem: vi.fn(),
      setOrderFiscalFailure: vi.fn(),
      getOrder: vi.fn(() => undefined)
    }
    const engine = createFiscalEngine({
      db: db2 as unknown as FiscalEngineDatabase,
      submitInvoice: (async () => ({
        ok: false,
        reason: 'ZFPLabServer rejected the request format',
        kind: 'system',
        retryable: false
      })) as never,
      now: () => 1_700_000_000_000,
      logger
    })

    await engine.tick()

    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Sale 101'))
  })

  it('a still-retrying (not yet exhausted) technical failure logs nothing at all', async () => {
    const logger = makeSpyLogger()
    const db2 = {
      getPendingFiscalQueue: vi.fn(() => [makeItem(1)]),
      markFiscalQueueItemSynced: vi.fn(),
      recordFiscalQueueFailure: vi.fn(() => ({ exhausted: false })),
      removeFiscalQueueItem: vi.fn(),
      setOrderFiscalFailure: vi.fn(),
      getOrder: vi.fn(() => undefined)
    }
    const engine = createFiscalEngine({
      db: db2 as unknown as FiscalEngineDatabase,
      submitInvoice: (async () => ({
        ok: false,
        reason: 'device unreachable',
        kind: 'technical',
        retryable: true
      })) as never,
      now: () => 1_700_000_000_000,
      logger
    })

    await engine.tick()

    expect(logger.log).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('an item abandoned after repeated failures logs a warn', async () => {
    const logger = makeSpyLogger()
    const db2 = {
      getPendingFiscalQueue: vi.fn(() => [makeItem(1)]),
      markFiscalQueueItemSynced: vi.fn(),
      recordFiscalQueueFailure: vi.fn(() => ({ exhausted: true })),
      removeFiscalQueueItem: vi.fn(),
      setOrderFiscalFailure: vi.fn(),
      getOrder: vi.fn(() => undefined)
    }
    const engine = createFiscalEngine({
      db: db2 as unknown as FiscalEngineDatabase,
      submitInvoice: (async () => ({
        ok: false,
        reason: 'device unreachable',
        kind: 'technical',
        retryable: true
      })) as never,
      now: () => 1_700_000_000_000,
      logger
    })

    await engine.tick()

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Sale 101'))
    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe('FiscalEngine re-entrancy', () => {
  it('coalesces concurrent ticks into a single pass', async () => {
    let release!: () => void
    const deferred = new Promise<void>((resolve) => {
      release = resolve
    })

    const submitInvoice = vi.fn(async (): Promise<FiscalSubmitOutcome> => {
      await deferred
      return {
        ok: true,
        data: { invoiceNumber: 'KRA-0001', qrCode: '', fiscalizedAt: '2026-08-24T10:00:00.000Z' }
      }
    })

    const engine = createFiscalEngine({
      db: {
        getPendingFiscalQueue: vi.fn(() => [makeItem(1)]),
        markFiscalQueueItemSynced: vi.fn(),
        recordFiscalQueueFailure: vi.fn(),
        removeFiscalQueueItem: vi.fn(),
        setOrderFiscalFailure: vi.fn(),
        getOrder: vi.fn(() => undefined)
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
