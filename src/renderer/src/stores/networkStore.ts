/**
 * Zustand store for main-process connectivity state.
 *
 * `init()` reads the initial status over IPC and then subscribes to the
 * broadcasted transitions guarded so multiple component mounts never
 * double-subscribe.
 */

import { create } from 'zustand'

export interface NetworkState {
  /** Last reported connectivity state (optimistically true). */
  online: boolean
  /** True once the initial IPC read has completed. */
  initialized: boolean
  /** Reads initial status and subscribes to transitions (idempotent). */
  init: () => Promise<void>
}

export const useNetworkStore = create<NetworkState>()((set, get) => ({
  online: true,
  initialized: false,

  init: async () => {
    if (get().initialized) return

    try {
      const status = await window.api.getNetworkStatus()
      set({ online: status.online, initialized: true })
    } catch {
      set({ initialized: true })
    }

    try {
      window.api.onNetworkStatus((status) => set({ online: status.online }))
    } catch {
      // event subscription unavailable (e.g. preload stripped in tests)
    }
  }
}))
