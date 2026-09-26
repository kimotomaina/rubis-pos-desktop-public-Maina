/**
 * Zustand store for whether this till is running the real fiscal
 * provider (docs/phase-161, Commit 1 - an interim safeguard against
 * docs/phase-160's finding that a discount or price override is filed
 * with KRA and printed on the receipt against the raw, undiscounted
 * price, until that is fixed properly).
 *
 * Read once at startup (`init()`, mirroring `unfiledCountStore.ts`'s own
 * idempotent-init shape) rather than polled - the provider a till runs
 * is fixed for the lifetime of the process (`fiscal-provider-factory.ts`
 * resolves it once, before any window exists), so there is nothing to
 * refresh later.
 */

import { create } from 'zustand'

export interface FiscalModeState {
  /**
   * Defaults `false` (mock-mode behaviour: every discount/override
   * control stays visible) until the first successful read - the same
   * "fail toward the current default rather than guess" reasoning
   * `unfiledCountStore.ts` uses, since a wrong `true` here would hide a
   * cashier-facing control for no reason, while a wrong `false` only
   * delays this safeguard by the time one local IPC round-trip takes.
   */
  fiscalLive: boolean
  initialized: boolean
  /** Reads the flag once (idempotent - safe to call from every consumer's mount). */
  init: () => Promise<void>
}

export const useFiscalModeStore = create<FiscalModeState>()((set, get) => ({
  fiscalLive: false,
  initialized: false,

  init: async () => {
    if (get().initialized) return
    set({ initialized: true })
    try {
      const result = await window.api.isFiscalLive()
      if (result.success && result.data !== undefined) {
        set({ fiscalLive: result.data })
      }
    } catch {
      // Keep the default (mock-mode) value rather than guessing.
    }
  }
}))
