/**
 * Zustand store for the Rule-3 safety-net count (phase-95) — every
 * completed-but-unfiled sale, `waiting` or `needs_fixing`.
 *
 * There is no push channel for this the way `connectivityStore.ts` has
 * one (fiscal state changes happen deep inside `fiscal-engine.ts`'s
 * background retry queue, which this phase does not touch), so this
 * polls on a light interval instead — cheap, since it's a single
 * `COUNT(*)` — and callers can also call `refresh()` directly right
 * after an action that's likely to have changed it (a resend from
 * `NeedsAttentionPage`), so the badge doesn't wait out a full poll tick.
 */

import { create } from 'zustand'

/** Matches `connectivityMonitor`'s own polling cadence in `main/index.ts`. */
const POLL_INTERVAL_MS = 30_000

export interface UnfiledCountState {
  /** `null` before the first successful read. */
  count: number | null
  initialized: boolean
  /** Reads the count and starts the background poll (idempotent). */
  init: () => Promise<void>
  /** Re-reads the count immediately — call after a resend. */
  refresh: () => Promise<void>
}

export const useUnfiledCountStore = create<UnfiledCountState>()((set, get) => ({
  count: null,
  initialized: false,

  refresh: async () => {
    try {
      const result = await window.api.getUnfiledSalesCount()
      if (result.success && result.data !== undefined) {
        set({ count: result.data })
      }
      // A failed read leaves the last known count in place rather than
      // flashing a false "All sales filed" — Rule 3 is about visibility,
      // so an unreadable count should never silently look clean.
    } catch {
      // same reasoning as above: keep the last known value
    }
  },

  init: async () => {
    if (get().initialized) return
    set({ initialized: true })
    await get().refresh()
    setInterval(() => void get().refresh(), POLL_INTERVAL_MS)
  }
}))
