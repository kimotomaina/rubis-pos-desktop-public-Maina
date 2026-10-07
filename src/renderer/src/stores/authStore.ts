/**
 * Zustand store for the logged-in staff session.
 *
 * Deliberately **not** persisted — every app launch requires PIN
 * re-entry, matching typical till/POS security practice (whoever is
 * physically at the terminal must authenticate each session).
 */

import { create } from 'zustand'
import type { StaffSummary } from '../../../main/services/database.js'
import { useProductStore } from './productStore.js'
import { useUiStore } from './uiStore.js'

export interface AuthState {
  /** The currently authenticated staff member, or null when logged out. */
  currentStaff: StaffSummary | null
  /** Active staff accounts fetched for the login picker. */
  staffList: StaffSummary[]
  /** Error message from the last failed login attempt. */
  loginError: string | null
  /** True while a login request is in flight. */
  loggingIn: boolean
  /** Loads the active staff list for the login picker. */
  fetchStaffList: () => Promise<void>
  /**
   * Verifies a PIN for the given staff id; sets `currentStaff` on success and signs them in in the main process too
   * (docs/phase-254). A cashier always lands on the catalogue; an admin lands where the screen was.
   */
  login: (staffId: number, pin: string) => Promise<boolean>
  /** Clears the session, here and in the main process. It does not close the shift. */
  logout: () => Promise<void>
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  currentStaff: null,
  staffList: [],
  loginError: null,
  loggingIn: false,

  fetchStaffList: async () => {
    if (!window.api) {
      set({ loginError: 'App bridge unavailable — please restart RUBIS POS.' })
      return
    }
    const result = await window.api.getStaffList()
    if (result.success && result.data) {
      set({ staffList: result.data })
    }
  },

  login: async (staffId, pin) => {
    set({ loggingIn: true, loginError: null })
    try {
      const result = await window.api.login(staffId, pin, { session: true })
      if (result.success && result.data) {
        // docs/phase-254, C4: set before `currentStaff`, so the first screen a cashier sees is the catalogue. An admin
        // stays where the screen was, unless that is a cashier's own page, which admins have no tab for.
        const ui = useUiStore.getState()
        if (result.data.role !== 'admin' || ui.activeView === 'mine') ui.setActiveView('catalog')
        set({ currentStaff: result.data, loggingIn: false, loginError: null })
        // docs/phase-253-1: a sync after every login, never awaited, so login never waits on Shopify.
        void useProductStore.getState().sync()
        return true
      }
      set({ loggingIn: false, loginError: result.error ?? 'Incorrect PIN' })
      return false
    } catch (err) {
      set({
        loggingIn: false,
        loginError: err instanceof Error ? err.message : 'Login failed'
      })
      return false
    }
  },

  logout: async () => {
    const staffId = get().currentStaff?.id
    set({ currentStaff: null })
    if (staffId) {
      try {
        await window.api.logout(staffId)
      } catch (err) {
        console.error('[rubis-pos] logout failed:', err)
      }
    }
  }
}))
