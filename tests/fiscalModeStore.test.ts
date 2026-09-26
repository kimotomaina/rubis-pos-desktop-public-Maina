/**
 * `fiscalModeStore` tests (docs/phase-161, Commit 1).
 *
 * Mirrors `unfiledCountStore.ts`'s own idempotent-init shape — `init()`
 * reads the flag once, tolerates a failed/unsuccessful read by keeping
 * the safe (mock-mode) default, and never re-fetches once initialized.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useFiscalModeStore } from '../src/renderer/src/stores/fiscalModeStore.js'

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}

beforeEach(() => {
  useFiscalModeStore.setState({ fiscalLive: false, initialized: false })
})

describe('fiscalModeStore.init', () => {
  it('sets fiscalLive to true when the main process reports the real provider', async () => {
    window.api = { isFiscalLive: vi.fn().mockResolvedValue(ok(true)) } as unknown as typeof window.api

    await useFiscalModeStore.getState().init()

    expect(useFiscalModeStore.getState().fiscalLive).toBe(true)
  })

  it('keeps the false default when the main process reports the mock provider', async () => {
    window.api = { isFiscalLive: vi.fn().mockResolvedValue(ok(false)) } as unknown as typeof window.api

    await useFiscalModeStore.getState().init()

    expect(useFiscalModeStore.getState().fiscalLive).toBe(false)
  })

  it('keeps the false default rather than guessing when the read fails', async () => {
    window.api = {
      isFiscalLive: vi.fn().mockResolvedValue({ success: false, error: 'boom' })
    } as unknown as typeof window.api

    await useFiscalModeStore.getState().init()

    expect(useFiscalModeStore.getState().fiscalLive).toBe(false)
  })

  it('keeps the false default rather than guessing when the IPC call throws', async () => {
    window.api = {
      isFiscalLive: vi.fn().mockRejectedValue(new Error('no IPC'))
    } as unknown as typeof window.api

    await useFiscalModeStore.getState().init()

    expect(useFiscalModeStore.getState().fiscalLive).toBe(false)
  })

  it('is idempotent — a second call does not re-fetch', async () => {
    const isFiscalLive = vi.fn().mockResolvedValue(ok(true))
    window.api = { isFiscalLive } as unknown as typeof window.api

    await useFiscalModeStore.getState().init()
    await useFiscalModeStore.getState().init()

    expect(isFiscalLive).toHaveBeenCalledTimes(1)
  })
})
