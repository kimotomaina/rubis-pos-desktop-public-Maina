/**
 * The cart's remove, reduce and clear actions, behind a manager PIN
 * (docs/phase-197).
 *
 * The order is the point: ask for the PIN, record the approved change
 * through the main process (which re-verifies the PIN), and only then
 * change the cart. Cancelling the PIN prompt leaves the cart exactly as it
 * was, and a failed record leaves it as it was too, so no removal can
 * happen unrecorded. Increasing a quantity never asks.
 */

import type { ServiceResult } from '../../../main/services/shopify-types.js'
import type { CartItem, CartRemovalRequest } from '../types/shopify.js'
import { needsManagerApproval } from './cartGuard.js'

/** What the guarded actions need from their surroundings. */
export interface GuardedCartDeps {
  getItems: () => CartItem[]
  getCartToken: () => string | null
  /** The cashier signed in, or `null` when nobody is. */
  getStaffId: () => number | null
  requestManagerPin: (
    title: string,
    onAuthorized: (managerId: number, managerPin: string) => void
  ) => void
  recordRemovals: (request: CartRemovalRequest) => Promise<ServiceResult<void>>
  /** The unguarded cart changes. */
  apply: {
    setQuantity: (id: string, qty: number) => void
    remove: (id: string) => void
    clear: () => void
  }
  /** Shows the cashier why a change did not happen. */
  notify: (message: string) => void
}

/** The cart actions the table calls. */
export interface GuardedCartActions {
  updateQuantity: (id: string, qty: number) => void
  remove: (id: string) => void
  clear: () => void
}

const COULD_NOT_RECORD = 'The change was not made because it could not be recorded.'

/**
 * @param {GuardedCartDeps} deps
 * @returns {GuardedCartActions}
 */
export function createGuardedCartActions(deps: GuardedCartDeps): GuardedCartActions {
  /**
   * Asks for a manager, records `changes`, then runs `apply`.
   *
   * @param {string} title
   * @param {CartRemovalRequest['changes']} changes
   * @param {() => void} apply
   */
  const approve = (title: string, changes: CartRemovalRequest['changes'], apply: () => void): void => {
    deps.requestManagerPin(title, (managerId, managerPin) => {
      const cartToken = deps.getCartToken()
      const staffId = deps.getStaffId()
      if (!cartToken || staffId === null) {
        deps.notify(COULD_NOT_RECORD)
        return
      }
      void deps
        .recordRemovals({ cartToken, staffId, managerId, managerPin, changes })
        .then((result) => {
          if (result.success) apply()
          else deps.notify(result.error ?? COULD_NOT_RECORD)
        })
        .catch(() => deps.notify(COULD_NOT_RECORD))
    })
  }

  const find = (id: string): CartItem | undefined => deps.getItems().find((item) => item.id === id)

  return {
    updateQuantity: (id, qty) => {
      const item = find(id)
      if (!item) return
      if (!needsManagerApproval({ kind: 'setQuantity', from: item.quantity, to: qty })) {
        deps.apply.setQuantity(id, qty)
        return
      }
      approve(
        `Reduce ${item.title}`,
        [{ variantId: id, qtyBefore: item.quantity, qtyAfter: Math.max(qty, 0) }],
        () => deps.apply.setQuantity(id, qty)
      )
    },

    remove: (id) => {
      const item = find(id)
      if (!item) return
      if (!needsManagerApproval({ kind: 'remove', from: item.quantity })) {
        deps.apply.remove(id)
        return
      }
      approve(`Remove ${item.title}`, [{ variantId: id, qtyBefore: item.quantity, qtyAfter: 0 }], () =>
        deps.apply.remove(id)
      )
    },

    clear: () => {
      const items = deps.getItems()
      if (items.length === 0) return
      if (!needsManagerApproval({ kind: 'clear', from: items.length })) {
        deps.apply.clear()
        return
      }
      approve(
        'Clear the whole cart',
        items.map((item) => ({ variantId: item.id, qtyBefore: item.quantity, qtyAfter: 0 })),
        () => deps.apply.clear()
      )
    }
  }
}
