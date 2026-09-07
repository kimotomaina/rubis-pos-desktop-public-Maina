/**
 * `unfiledCountStore` tests (phase-95), mirroring `productStore.test.ts`'s
 * `window.api` stubbing and `connectivityMonitor.test.ts`'s fake-timer
 * convention for the background poll.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useUnfiledCountStore } from '../src/renderer/src/stores/unfiledCountStore.js'

describe('unfiledCountStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useUnfiledCountStore.setState({ count: null, initialized: false })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with no count read yet', () => {
    expect(useUnfiledCountStore.getState().count).toBeNull()
  })

  it('refresh() sets the count from getUnfiledSalesCount()', async () => {
    window.api = {
      getUnfiledSalesCount: vi.fn().mockResolvedValue({ success: true, data: 3 })
    } as unknown as typeof window.api

    await useUnfiledCountStore.getState().refresh()

    expect(useUnfiledCountStore.getState().count).toBe(3)
  })

  it('decreases after a resend that fiscalizes a sale', async () => {
    const getUnfiledSalesCount = vi
      .fn()
      .mockResolvedValueOnce({ success: true, data: 2 })
      .mockResolvedValueOnce({ success: true, data: 1 })
    window.api = { getUnfiledSalesCount } as unknown as typeof window.api

    await useUnfiledCountStore.getState().refresh()
    expect(useUnfiledCountStore.getState().count).toBe(2)

    // Simulates NeedsAttentionPage calling refresh() right after a resend.
    await useUnfiledCountStore.getState().refresh()
    expect(useUnfiledCountStore.getState().count).toBe(1)
  })

  it('keeps the last known count when a refresh fails, rather than flashing zero', async () => {
    const getUnfiledSalesCount = vi
      .fn()
      .mockResolvedValueOnce({ success: true, data: 4 })
      .mockRejectedValueOnce(new Error('IPC unavailable'))
    window.api = { getUnfiledSalesCount } as unknown as typeof window.api

    await useUnfiledCountStore.getState().refresh()
    expect(useUnfiledCountStore.getState().count).toBe(4)

    await useUnfiledCountStore.getState().refresh()
    expect(useUnfiledCountStore.getState().count).toBe(4)
  })

  it('init() reads once immediately and is idempotent across repeated calls', async () => {
    const getUnfiledSalesCount = vi.fn().mockResolvedValue({ success: true, data: 5 })
    window.api = { getUnfiledSalesCount } as unknown as typeof window.api

    await useUnfiledCountStore.getState().init()
    await useUnfiledCountStore.getState().init()

    expect(useUnfiledCountStore.getState().count).toBe(5)
    expect(getUnfiledSalesCount).toHaveBeenCalledTimes(1)
  })

  it('init() keeps polling on a light interval without a manual refresh', async () => {
    const getUnfiledSalesCount = vi
      .fn()
      .mockResolvedValueOnce({ success: true, data: 5 })
      .mockResolvedValueOnce({ success: true, data: 2 })
    window.api = { getUnfiledSalesCount } as unknown as typeof window.api

    await useUnfiledCountStore.getState().init()
    expect(useUnfiledCountStore.getState().count).toBe(5)

    await vi.advanceTimersByTimeAsync(30_000)

    expect(getUnfiledSalesCount).toHaveBeenCalledTimes(2)
    expect(useUnfiledCountStore.getState().count).toBe(2)
  })
})
