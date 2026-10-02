/**
 * Saving the cart draft on a clean quit (docs/phase-197-1): the saver's
 * `flush`, the main-process coordinator that asks for it, and the two
 * together against a real in-memory database with fake timers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RubisDatabase } from '../src/main/services/database.js'
import { CART_FLUSH_TIMEOUT_MS, createCartFlushCoordinator } from '../src/main/services/cart-flush.js'
import { CART_DRAFT_DEBOUNCE_MS, createCartDraftSaver } from '../src/renderer/src/lib/cartDraft.js'
import type { CartItem } from '../src/renderer/src/types/shopify.js'

const line = (quantity: number): CartItem => ({
  id: 'v1',
  productId: 'p1',
  title: 'Mug',
  variantTitle: 'Small',
  price: 60,
  basePrice: 60,
  quantity,
  image: null
})

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createCartDraftSaver().flush', () => {
  it('writes the pending change at once, without waiting for the debounce', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const saver = createCartDraftSaver({ save, clear: vi.fn() })

    saver.update({ items: [line(2)], cartToken: 't' })
    await saver.flush()

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ items: [line(2)], cartToken: 't' })
  })

  it('does not write a second time when the debounce would have fired', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const saver = createCartDraftSaver({ save, clear: vi.fn() })

    saver.update({ items: [line(2)], cartToken: 't' })
    await saver.flush()
    await vi.advanceTimersByTimeAsync(CART_DRAFT_DEBOUNCE_MS * 3)

    expect(save).toHaveBeenCalledTimes(1)
  })

  it('writes only the last of several changes', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const saver = createCartDraftSaver({ save, clear: vi.fn() })

    saver.update({ items: [line(1)], cartToken: 't' })
    saver.update({ items: [line(2)], cartToken: 't' })
    saver.update({ items: [line(3)], cartToken: 't' })
    await saver.flush()

    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ items: [line(3)], cartToken: 't' })
  })

  it('deletes the draft when the pending change is an empty cart', async () => {
    const clear = vi.fn().mockResolvedValue(undefined)
    const saver = createCartDraftSaver({ save: vi.fn(), clear })

    saver.update({ items: [], cartToken: null })
    await saver.flush()

    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('does nothing, and resolves, when nothing is pending', async () => {
    const save = vi.fn()
    const clear = vi.fn()
    const saver = createCartDraftSaver({ save, clear })

    await expect(saver.flush()).resolves.toBeUndefined()

    expect(save).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
  })

  it('does nothing after the pending write was cancelled', async () => {
    const save = vi.fn()
    const saver = createCartDraftSaver({ save, clear: vi.fn() })

    saver.update({ items: [line(2)], cartToken: 't' })
    saver.cancel()
    await saver.flush()

    expect(save).not.toHaveBeenCalled()
  })

  it('resolves, rather than rejecting, when the write fails', async () => {
    const saver = createCartDraftSaver({ save: vi.fn().mockRejectedValue(new Error('disk full')), clear: vi.fn() })

    saver.update({ items: [line(2)], cartToken: 't' })

    await expect(saver.flush()).resolves.toBeUndefined()
  })

  it('waits for the write to complete before resolving', async () => {
    let finishWrite: () => void = () => undefined
    const save = vi.fn().mockReturnValue(new Promise<void>((resolve) => (finishWrite = resolve)))
    const saver = createCartDraftSaver({ save, clear: vi.fn() })
    saver.update({ items: [line(2)], cartToken: 't' })

    let flushed = false
    const flushing = saver.flush().then(() => (flushed = true))
    await Promise.resolve()
    expect(flushed).toBe(false)

    finishWrite()
    await flushing
    expect(flushed).toBe(true)
  })
})

describe('createCartFlushCoordinator', () => {
  it('resolves "flushed" when the renderer acknowledges', async () => {
    const send = vi.fn()
    const coordinator = createCartFlushCoordinator({ send })

    const request = coordinator.request()
    expect(send).toHaveBeenCalledTimes(1)
    coordinator.acknowledge()

    await expect(request).resolves.toBe('flushed')
  })

  it('gives up after 500 ms when the renderer never answers, so quitting is never held up', async () => {
    const coordinator = createCartFlushCoordinator({ send: vi.fn() })
    expect(CART_FLUSH_TIMEOUT_MS).toBe(500)

    const request = coordinator.request()
    let result: string | null = null
    void request.then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(499)
    expect(result).toBeNull()
    await vi.advanceTimersByTimeAsync(1)

    expect(result).toBe('timeout')
  })

  it('resolves "unavailable" at once when there is no renderer to ask', async () => {
    const coordinator = createCartFlushCoordinator({
      send: () => {
        throw new Error('no window')
      }
    })

    await expect(coordinator.request()).resolves.toBe('unavailable')
  })

  it('sends one request however many times it is asked while one is in flight', async () => {
    const send = vi.fn()
    const coordinator = createCartFlushCoordinator({ send })

    const first = coordinator.request()
    const second = coordinator.request()
    coordinator.acknowledge()

    expect(send).toHaveBeenCalledTimes(1)
    expect(await first).toBe('flushed')
    expect(await second).toBe('flushed')
  })

  it('ignores an acknowledgement nobody asked for, and can be asked again afterwards', async () => {
    const send = vi.fn()
    const coordinator = createCartFlushCoordinator({ send })

    coordinator.acknowledge()
    const request = coordinator.request()
    coordinator.acknowledge()
    await request
    const again = coordinator.request()
    coordinator.acknowledge()

    expect(await again).toBe('flushed')
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('a clean quit after a change (the draft row holds the change)', () => {
  function setup() {
    const db = new RubisDatabase({ dbPath: ':memory:' })
    db.init()
    // The renderer side: a saver whose save is the IPC into the main process's database.
    const saver = createCartDraftSaver({
      save: async (snapshot) => db.saveCartDraft(JSON.stringify(snapshot)),
      clear: async () => db.clearCartDraft()
    })
    // The main side asks; the renderer flushes, then acknowledges.
    const coordinator = createCartFlushCoordinator({
      send: () => {
        void saver.flush().finally(() => coordinator.acknowledge())
      }
    })
    return { db, saver, coordinator }
  }

  const savedQuantity = (db: RubisDatabase): number | null => {
    const draft = db.getCartDraft()
    return draft ? (JSON.parse(draft.payload_json) as { items: CartItem[] }).items[0].quantity : null
  }

  it('a change at t=0 and a quit at t=100 ms leave the change in the draft row', async () => {
    const { db, saver, coordinator } = setup()

    saver.update({ items: [line(5)], cartToken: 't' })
    await vi.advanceTimersByTimeAsync(100)
    expect(db.getCartDraft()).toBeUndefined()

    const result = await coordinator.request()

    expect(result).toBe('flushed')
    expect(savedQuantity(db)).toBe(5)
  })

  it('without the flush that same change is lost to a kill at t=100 ms (the limit this phase does not remove)', async () => {
    const { db, saver } = setup()

    saver.update({ items: [line(5)], cartToken: 't' })
    await vi.advanceTimersByTimeAsync(100)

    expect(db.getCartDraft()).toBeUndefined()
    saver.cancel()
    await vi.advanceTimersByTimeAsync(CART_DRAFT_DEBOUNCE_MS * 2)
    expect(db.getCartDraft()).toBeUndefined()
  })

  it('writes the change once only: the debounce does not repeat it after the flush', async () => {
    const { db, saver, coordinator } = setup()
    const spy = vi.spyOn(db, 'saveCartDraft')

    saver.update({ items: [line(5)], cartToken: 't' })
    await vi.advanceTimersByTimeAsync(100)
    await coordinator.request()
    await vi.advanceTimersByTimeAsync(CART_DRAFT_DEBOUNCE_MS * 3)

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('a quit with an empty cart leaves no draft row', async () => {
    const { db, saver, coordinator } = setup()
    db.saveCartDraft(JSON.stringify({ items: [line(1)], cartToken: 't' }))

    saver.update({ items: [], cartToken: null })
    await vi.advanceTimersByTimeAsync(100)
    await coordinator.request()

    expect(db.getCartDraft()).toBeUndefined()
  })
})
