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
 *
 * FAILS CLOSED (docs/phase-161-1): the whole point of this store is to
 * hide a control that would otherwise let a cashier create data the
 * fiscal device is told nothing about. Starting from - or falling back
 * to - "we don't yet know" and treating that the same as "live" means a
 * slow, failed, or not-yet-resolved read can only ever be *too*
 * cautious (a control stays hidden a beat longer than it needs to), never
 * too permissive (a control shown when this till might in fact be live).
 * The previous version defaulted to `false` (mock-mode behaviour,
 * controls visible) until proven otherwise - exactly backwards for a
 * safeguard.
 */

import { create } from 'zustand'

/**
 * `'unknown'` - not yet read, or the read failed/threw. Treated
 * identically to `'live'` by every consumer (docs/phase-161-1, item 1).
 * `'live'` - the real fiscal provider; discount/override controls hidden.
 * `'mock'` - the only state that shows the controls, and only once a
 * read has actually confirmed it.
 */
export type FiscalMode = 'unknown' | 'live' | 'mock'

export interface FiscalModeState {
  fiscalLive: FiscalMode
  initialized: boolean
  /** Reads the flag once (idempotent - safe to call from every consumer's mount). */
  init: () => Promise<void>
}

export const useFiscalModeStore = create<FiscalModeState>()((set, get) => ({
  fiscalLive: 'unknown',
  initialized: false,

  init: async () => {
    if (get().initialized) return
    set({ initialized: true })
    try {
      const result = await window.api.isFiscalLive()
      if (result.success && result.data !== undefined) {
        set({ fiscalLive: result.data ? 'live' : 'mock' })
      }
      // A validation/service failure (`result.success === false`) leaves
      // the state at `'unknown'` - never set to `'mock'` from anything
      // short of an explicit `false` read.
    } catch {
      // Same reasoning - a thrown IPC call leaves `'unknown'` in place.
    }
  }
}))

/** Whether the discount/override controls should be hidden right now. */
export function isFiscalModeLiveOrUnknown(mode: FiscalMode): boolean {
  return mode !== 'mock'
}
