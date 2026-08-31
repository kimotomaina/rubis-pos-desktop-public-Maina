/**
 * Zustand store for M-Pesa/fiscal-device/printer reachability.
 *
 * Mirrors `networkStore.ts`: `init()` reads the initial status over
 * IPC and then subscribes to the broadcasted checks, guarded so
 * multiple component mounts never double-subscribe.
 */

import { create } from 'zustand'
import type { ConnectivityStatusPayload } from '../components/ConnectivityBadges.js'

export interface ConnectivityState {
  /** Last reported reachability for every monitored integration, or `null` before the first read. */
  status: ConnectivityStatusPayload | null
  /** True once the initial IPC read has completed. */
  initialized: boolean
  /** Reads initial status and subscribes to updates (idempotent). */
  init: () => Promise<void>
}

export const useConnectivityStore = create<ConnectivityState>()((set, get) => ({
  status: null,
  initialized: false,

  init: async () => {
    if (get().initialized) return

    try {
      const status = await window.api.getConnectivityStatus()
      set({ status, initialized: true })
    } catch {
      set({ initialized: true })
    }

    try {
      window.api.onConnectivityStatus((status) => set({ status }))
    } catch {
      // event subscription unavailable (e.g. preload stripped in tests)
    }
  }
}))
