/**
 * Whether a payment is in progress on the till's screen (docs/phase-217).
 *
 * `PaymentModal` and `CardEntryPanel` set their own entry while a Daraja push is
 * waiting, a push request is in flight, or a code or card reference is typed,
 * and clear it when they unmount. Hold is refused while any entry is set: a
 * confirmation that arrives for a cart no longer on screen could complete the
 * wrong sale.
 */

import { create } from 'zustand'

interface PaymentActivityState {
  /** The panels that currently have a payment in progress, by name. */
  active: Record<string, true>
  setActive: (source: string, active: boolean) => void
}

export const usePaymentActivityStore = create<PaymentActivityState>()((set) => ({
  active: {},
  setActive: (source, active) =>
    set((state) => {
      if (active === (source in state.active)) return state
      const next = { ...state.active }
      if (active) next[source] = true
      else delete next[source]
      return { active: next }
    })
}))

/**
 * @param {Record<string, true>} active
 * @returns {boolean} true while any panel has a payment in progress
 */
export function isPaymentInProgress(active: Record<string, true>): boolean {
  return Object.keys(active).length > 0
}
