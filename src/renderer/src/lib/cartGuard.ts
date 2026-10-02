/**
 * Which cart changes need a manager (docs/phase-197).
 *
 * Taking something out of a cart, or taking quantity off a line, is what a
 * till thief or a careless cashier does; adding or increasing is not. Pure,
 * so every branch is directly testable.
 */

/** A change a cashier is about to make to the cart. */
export interface CartChange {
  kind: 'remove' | 'setQuantity' | 'clear'
  /** The quantity before the change. */
  from: number
  /** The quantity after the change; only meaningful for `setQuantity`. */
  to?: number
}

/**
 * A removal and a clear always need approval. A quantity change needs it
 * when the quantity goes down; a `setQuantity` with no target is treated as
 * a reduction, so a malformed call can never skip the manager.
 *
 * @param {CartChange} change
 * @returns {boolean}
 */
export function needsManagerApproval(change: CartChange): boolean {
  if (change.kind !== 'setQuantity') return true
  return change.to === undefined || change.to < change.from
}
