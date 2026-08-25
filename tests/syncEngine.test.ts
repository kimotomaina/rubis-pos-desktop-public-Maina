/**
 * Sync engine tests (Phase 3).
 *
 * The engine's collaborators (database slice, connectivity probe, push
 * function) are all injected fakes; fake timers drive the interval.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSyncEngine } from '../src/main/services/sync-engine.js'
import type { SyncEngineDatabase } from '../src/main/services/sync-engine.js'
import type { SyncQueueItem } from '../src/main/services/database.js'
import type { OfflineOrderPayload } from '../src/main/services/shopify-types.js'

const makePayload = (uuid: string): OfflineOrderPayload => ({
  clientOrderUuid: uuid,
  total: 25,
  createdAt: '2026-08-24T10:00:00.000Z',
  staffId: 1,
  staffName: 'Admin',
  paymentMethod: 'cash',
  tenderedAmount: 30,
  changeDue: 5,
  lineItems: [
    {
      variantId: 'gid://shopify/ProductVariant/201',
      title: 'RUBIS Mug',
      variantTitle: 'Small',
      quantity: 2,
      unitPrice: 12.5
    }
  ]
})

const makeItem = (id: number, uuid = `uuid-${id}`): SyncQueueItem => ({
  id,
  entity_type: 'order',
  entity_id: id + 100,
  action: 'orderCreate',
  payload: makePayload(uuid),
  attempts: 0,
  last_error: null,
  created_at: '2026-08-24T10:00:00.000Z',
  next_attempt_at: 0
})

function makeEngine(overrides: {
  items?: SyncQueueItem[]
  online?: boolean
  push?: (payload: OfflineOrderPayload) => Promise<{
    success: boolean
    data?: { shopifyOrderId: string; orderName: string | null }
    error?: string
  }>
  exhausted?: boolean
  intervalMs?: number
}) {
  const db = {
    getPendingSyncQueue: vi.fn(() => overrides.items ?? []),
    markQueueItemSynced: vi.fn(),
    recordQueueFailure: vi.fn(() => ({
      exhausted: overrides.exhausted ?? false,
      attempts: 1
    }))
  }
  const isOnline = vi.fn(() => overrides.online ?? true)
  const pushOrder = vi.fn(
    overrides.push ??
      (async () => ({
        success: true,
        data: { shopifyOrderId: 'gid://shopify/Order/1', orderName: '#1001' }
      }))
  )

  const engine = createSyncEngine({
    db: db as unknown as SyncEngineDatabase,
    isOnline,
    pushOrder: pushOrder as never,
    intervalMs: overrides.intervalMs ?? 30_000,
    now: () => 1_700_000_000_000
  })

  return { db, isOnline, pushOrder, engine }
}

describe('SyncEngine.tick', () => {
  it('pushes every due item and marks successes synced', async () => {
    const { db, pushOrder, engine } = makeEngine({
      items: [makeItem(1), makeItem(2)]
    })

    await engine.tick()

    expect(db.getPendingSyncQueue).toHaveBeenCalledWith(1_700_000_000_000)
    expect(pushOrder).toHaveBeenCalledTimes(2)
    expect(db.markQueueItemSynced).toHaveBeenNthCalledWith(
      1,
      1,
      'gid://shopify/Order/1'
    )
    expect(db.markQueueItemSynced).toHaveBeenNthCalledWith(
      2,
      2,
      'gid://shopify/Order/1'
    )
    expect(db.recordQueueFailure).not.toHaveBeenCalled()
  })

  it('records failures with the returned error message', async () => {
    const { db, engine } = makeEngine({
      items: [makeItem(1)],
      push: async () => ({ success: false, error: 'HTTP 429 limit' })
    })

    await engine.tick()

    expect(db.recordQueueFailure).toHaveBeenCalledWith(1, 'HTTP 429 limit')
    expect(db.markQueueItemSynced).not.toHaveBeenCalled()
  })

  it('uses a generic error when the push result has no message', async () => {
    const { db, engine } = makeEngine({
      items: [makeItem(1)],
      push: async () => ({ success: false })
    })

    await engine.tick()

    expect(db.recordQueueFailure).toHaveBeenCalledWith(1, 'Unknown sync error')
  })

  it('does nothing while offline', async () => {
    const { db, pushOrder, engine } = makeEngine({
      items: [makeItem(1)],
      online: false
    })

    await engine.tick()

    expect(db.getPendingSyncQueue).not.toHaveBeenCalled()
    expect(pushOrder).not.toHaveBeenCalled()
  })

  it('stops pushing when connectivity drops mid-batch', async () => {
    let online = true
    const { db, pushOrder } = makeEngine({ items: [makeItem(1), makeItem(2)] })
    pushOrder.mockImplementation(async () => {
      online = false
      return {
        success: true,
        data: { shopifyOrderId: 'gid://shopify/Order/1', orderName: null }
      }
    })

    const engine = createSyncEngine({
      db: db as unknown as SyncEngineDatabase,
      isOnline: () => online,
      pushOrder: pushOrder as never,
      intervalMs: 30_000
    })

    await engine.tick()

    expect(pushOrder).toHaveBeenCalledTimes(1)
    expect(db.markQueueItemSynced).toHaveBeenCalledTimes(1)
  })

  it('continues past an item whose retries are exhausted', async () => {
    const { db, pushOrder, engine } = makeEngine({
      items: [makeItem(1), makeItem(2)],
      exhausted: true,
      push: async () => ({ success: false, error: 'always fails' })
    })

    await engine.tick()

    // Item 1 exhausts; the engine must still proceed to item 2.
    expect(db.recordQueueFailure).toHaveBeenNthCalledWith(
      1,
      1,
      'always fails'
    )
    expect(db.recordQueueFailure).toHaveBeenNthCalledWith(
      2,
      2,
      'always fails'
    )
    expect(pushOrder).toHaveBeenCalledTimes(2)
  })
})

describe('SyncEngine re-entrancy', () => {
  it('coalesces concurrent ticks into a single pass', async () => {
    let release!: () => void
    const deferred = new Promise<void>((resolve) => {
      release = resolve
    })

    const pushOrder = vi.fn(async () => {
      await deferred
      return {
        success: true,
        data: { shopifyOrderId: 'gid://shopify/Order/1', orderName: null }
      }
    })

    const { db, isOnline } = makeEngine({ items: [makeItem(1)] })
    const engine = createSyncEngine({
      db: db as unknown as SyncEngineDatabase,
      isOnline,
      pushOrder: pushOrder as never
    })

    const first = engine.tick()
    const second = engine.tick()
    release()
    await Promise.all([first, second])

    expect(pushOrder).toHaveBeenCalledTimes(1)
  })
})

describe('SyncEngine lifecycle & triggers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('start() runs an immediate tick then ticks every interval', async () => {
    const { pushOrder, engine } = makeEngine({
      items: [makeItem(1)],
      intervalMs: 30_000
    })

    engine.start()
    await Promise.resolve()
    expect(pushOrder).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(pushOrder).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(pushOrder).toHaveBeenCalledTimes(3)
  })

  it('stop() cancels the interval timer', async () => {
    const { pushOrder, engine } = makeEngine({
      items: [makeItem(1)],
      intervalMs: 30_000
    })

    engine.start()
    await Promise.resolve()
    engine.stop()

    await vi.advanceTimersByTimeAsync(120_000)
    expect(pushOrder).toHaveBeenCalledTimes(1)
  })

  it('start() is idempotent — double start keeps one timer', async () => {
    const { pushOrder, engine } = makeEngine({
      items: [makeItem(1)],
      intervalMs: 30_000
    })

    engine.start()
    engine.start()
    await Promise.resolve()
    expect(pushOrder).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(pushOrder).toHaveBeenCalledTimes(2)
  })

  it('notifyOnline() performs an immediate sync pass (trigger c)', async () => {
    const { pushOrder, engine } = makeEngine({ items: [makeItem(1)] })

    engine.notifyOnline()
    await Promise.resolve()

    expect(pushOrder).toHaveBeenCalledTimes(1)
  })

  it('onCheckoutMade() performs an immediate sync pass (trigger a)', async () => {
    const { pushOrder, engine } = makeEngine({ items: [makeItem(1)] })

    engine.onCheckoutMade()
    await Promise.resolve()

    expect(pushOrder).toHaveBeenCalledTimes(1)
  })
})

