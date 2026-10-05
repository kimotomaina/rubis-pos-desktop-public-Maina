/**
 * Whether a shift is open on this till (docs/phase-227), for the cart's "No shift open" notice.
 *
 * Only the Admin screen read the shift before. Loaded at sign-in, after each sale, when the cart is shown again and
 * after the notice's dialog opens a shift. A shift that cannot be read leaves the state `unknown`, and the notice
 * stays hidden: a notice built on a guess would be worse than none.
 */

import { create } from 'zustand'

export type ShiftPresence = 'unknown' | 'open' | 'none'

/**
 * Whether the cart shows "No shift open": only when the till could read the shift and found none.
 *
 * @param {ShiftPresence} presence
 * @returns {boolean}
 */
export function shouldShowNoShiftNotice(presence: ShiftPresence): boolean {
  return presence === 'none'
}

interface ShiftState {
  presence: ShiftPresence
  /** Reads the current shift from the till's database. */
  load: () => Promise<void>
}

export const useShiftStore = create<ShiftState>()((set) => ({
  presence: 'unknown',

  load: async () => {
    try {
      const result = await window.api.getCurrentShift()
      if (result.success) {
        set({ presence: result.data ? 'open' : 'none' })
        return
      }
      console.error('[rubis-pos] could not read the current shift:', result.error)
    } catch (err) {
      console.error('[rubis-pos] could not read the current shift:', err)
    }
    set({ presence: 'unknown' })
  }
}))
