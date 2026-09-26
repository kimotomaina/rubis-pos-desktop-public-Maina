/**
 * `fiscalModeStore` tests (docs/phase-161, docs/phase-161-1).
 *
 * Fails closed (docs/phase-161-1): the store starts, and stays, at
 * `'unknown'` unless a read comes back and explicitly says `false`
 * (mock). `'unknown'` and `'live'` are both treated as "live" by every
 * consumer (`isFiscalModeLiveOrUnknown`) - only a confirmed `'mock'`
 * read is treated as "not live".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useFiscalModeStore, isFiscalModeLiveOrUnknown } from '../src/renderer/src/stores/fiscalModeStore.js'

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

beforeEach(() => {
  useFiscalModeStore.setState({ fiscalLive: 'unknown', initialized: false })
})

describe('fiscalModeStore.init', () => {
  it('starts as unknown before init resolves', () => {
    expect(useFiscalModeStore.getState().fiscalLive).toBe('unknown')
  })

  it('sets fiscalLive to live when the main process reports the real provider', async () => {
    window.api = { isFiscalLive: vi.fn().mockResolvedValue(ok(true)) } as unknown as typeof window.api

    await useFiscalModeStore.getState().init()

    expect(useFiscalModeStore.getState().fiscalLive).toBe('live')
  })

  it('sets fiscalLive to mock only on a successful read of false', async () => {
    window.api = { isFiscalLive: vi.fn().mockResolvedValue(ok(false)) } as unknown as typeof window.api

    await useFiscalModeStore.getState().init()

    expect(useFiscalModeStore.getState().fiscalLive).toBe('mock')
  })

  /**
   * DELIBERATE TEST CHANGE (docs/phase-161-1, item 1): renamed from
   * "keeps the false default rather than guessing when the read fails".
   *   Old assertion: `fiscalLive` is `false` (the old, permissive default).
   *   New assertion: `fiscalLive` is `'unknown'` (fails closed) — a
   *     failed read must never be treated as a confirmed mock provider.
   */
  it('stays unknown and treated as live when the read fails', async () => {
    window.api = {
      isFiscalLive: vi.fn().mockResolvedValue({ success: false, error: 'boom' })
    } as unknown as typeof window.api

    await useFiscalModeStore.getState().init()

    expect(useFiscalModeStore.getState().fiscalLive).toBe('unknown')
    expect(isFiscalModeLiveOrUnknown(useFiscalModeStore.getState().fiscalLive)).toBe(true)
  })

  /**
   * DELIBERATE TEST CHANGE (docs/phase-161-1, item 1): renamed from
   * "keeps the false default rather than guessing when the IPC call throws".
   *   Old assertion: `fiscalLive` is `false`.
   *   New assertion: `fiscalLive` is `'unknown'`, same reasoning as above.
   */
  it('stays unknown and treated as live when the IPC call throws', async () => {
    window.api = {
      isFiscalLive: vi.fn().mockRejectedValue(new Error('no IPC'))
    } as unknown as typeof window.api

    await useFiscalModeStore.getState().init()

    expect(useFiscalModeStore.getState().fiscalLive).toBe('unknown')
    expect(isFiscalModeLiveOrUnknown(useFiscalModeStore.getState().fiscalLive)).toBe(true)
  })

  it('is idempotent — a second call does not re-fetch', async () => {
    const isFiscalLive = vi.fn().mockResolvedValue(ok(true))
    window.api = { isFiscalLive } as unknown as typeof window.api

    await useFiscalModeStore.getState().init()
    await useFiscalModeStore.getState().init()

    expect(isFiscalLive).toHaveBeenCalledTimes(1)
  })
})

describe('isFiscalModeLiveOrUnknown', () => {
  it('is true for unknown and live, false only for mock', () => {
    expect(isFiscalModeLiveOrUnknown('unknown')).toBe(true)
    expect(isFiscalModeLiveOrUnknown('live')).toBe(true)
    expect(isFiscalModeLiveOrUnknown('mock')).toBe(false)
  })
})
