/**
 * Zustand store for the logged-in staff session.
 *
 * Deliberately **not** persisted — every app launch requires PIN
 * re-entry, matching typical till/POS security practice (whoever is
 * physically at the terminal must authenticate each session).
 */

import { create } from 'zustand'
import type { StaffSummary } from '../../../main/services/database.js'

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
  /** Verifies a PIN for the given staff id; sets `currentStaff` on success. */
  login: (staffId: number, pin: string) => Promise<boolean>
  /**
   * Clears the session. It does not close the shift: `auth:logout` in the main process
   * does nothing, and a shift closes only from the Admin screen's Close Shift.
   */
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
      const result = await window.api.login(staffId, pin)
      if (result.success && result.data) {
        set({ currentStaff: result.data, loggingIn: false, loginError: null })
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
