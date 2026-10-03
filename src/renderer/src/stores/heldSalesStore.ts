/**
 * The sales held on this till (docs/phase-217).
 *
 * A held sale is not a sale: holding and resuming touch only this screen and the
 * till's own database. Nothing here files with the tax device, queues for Shopify,
 * moves stock or takes a trader invoice number.
 */

import { create } from 'zustand'
import type { HeldSaleSummary } from '../../../main/services/database.js'
import { decideHold, decideResume, parseHeldPayload } from '../lib/heldSale.js'
import { useCartStore } from './cartStore.js'
import { isPaymentInProgress, usePaymentActivityStore } from './paymentActivityStore.js'

/** The outcome of a held-sale action, for the screen to show. */
export type HeldActionResult = { ok: true } | { ok: false; error: string }

const COULD_NOT_READ = 'The held sale could not be read. Restart the till to bring it back to the held list.'

interface HeldSalesState {
  /** Every sale held or resumed on this till, oldest first. */
  sales: HeldSaleSummary[]
  /** Bumped after a hold or resume, so the checkout panel resets its payment method and tendered amount. */
  resetEpoch: number
  /** Reads the held sales from the till's database. */
  load: () => Promise<void>
  /** Parks the cart on screen and leaves a fresh empty one. */
  hold: (staffId: number) => Promise<HeldActionResult>
  /** Puts a held sale back on screen, onto an empty cart only. */
  resume: (id: number) => Promise<HeldActionResult>
  rename: (id: number, label: string) => Promise<HeldActionResult>
  /** Discards a held sale. The main process re-verifies the manager PIN. */
  discard: (request: {
    id: number
    staffId: number
    managerId: number
    managerPin: string
    reason: string
  }) => Promise<HeldActionResult>
}

export const useHeldSalesStore = create<HeldSalesState>()((set, get) => ({
  sales: [],
  resetEpoch: 0,

  load: async () => {
    try {
      const result = await window.api.listHeldSales()
      if (result.success && result.data) set({ sales: result.data })
    } catch {
      // Unreadable list: keep what is on screen; the next load tries again.
    }
  },

  hold: async (staffId) => {
    const cart = useCartStore.getState()
    const decision = decideHold({
      itemCount: cart.items.length,
      paymentInProgress: isPaymentInProgress(usePaymentActivityStore.getState().active),
      openHeldCount: get().sales.length,
      cartIsResumedSale: cart.resumedHeld !== null
    })
    if (!decision.allowed) return { ok: false, error: decision.reason }
    if (!cart.cartToken) return { ok: false, error: 'The cart could not be held.' }

    const result = await window.api.holdSale({
      cartToken: cart.cartToken,
      staffId,
      total: cart.getTotal(),
      items: cart.items,
      cartDiscount: cart.cartDiscount ?? undefined,
      customerPin: cart.customerPin.trim() || undefined,
      companyName: cart.companyName.trim() || undefined
    })
    if (!result.success) return { ok: false, error: result.error ?? 'The sale could not be held.' }

    useCartStore.getState().clearCart()
    set((state) => ({ resetEpoch: state.resetEpoch + 1 }))
    await get().load()
    return { ok: true }
  },

  resume: async (id) => {
    const decision = decideResume(useCartStore.getState().items.length)
    if (!decision.allowed) return { ok: false, error: decision.reason }

    const result = await window.api.resumeHeldSale(id)
    if (!result.success || !result.data) return { ok: false, error: result.error ?? 'The sale could not be resumed.' }

    const contents = parseHeldPayload(result.data.payloadJson)
    if (!contents) return { ok: false, error: COULD_NOT_READ }

    const { summary } = result.data
    useCartStore.getState().resumeHeldSale(contents, summary.cartToken, { id: summary.id, label: summary.label })
    set((state) => ({ resetEpoch: state.resetEpoch + 1 }))
    await get().load()
    return { ok: true }
  },

  rename: async (id, label) => {
    const result = await window.api.renameHeldSale(id, label)
    if (!result.success) return { ok: false, error: result.error ?? 'The sale could not be renamed.' }
    await get().load()
    return { ok: true }
  },

  discard: async (request) => {
    const result = await window.api.discardHeldSale(request)
    if (!result.success) return { ok: false, error: result.error ?? 'The sale could not be discarded.' }
    await get().load()
    return { ok: true }
  }
}))
