/**
 * When "Update now" is refused (docs/phase-219). Installing restarts the till, so it is
 * refused while anything on the screen would be cut off. Held sales do not block it: they
 * are stored and come back after the restart.
 */

/** What the till is doing at the moment "Update now" is pressed. */
export interface UpdateNowState {
  /** `checkoutStatus === 'submitting'`: COMPLETE SALE was pressed and the result has not come back. */
  saleBeingCompleted: boolean
  /** The phase 217 payment-in-progress signal. */
  paymentInProgress: boolean
  cartItemCount: number
}

export const UPDATE_REFUSED_SALE_BEING_COMPLETED = 'A sale is being completed. Wait for it to finish, then update.'
export const UPDATE_REFUSED_PAYMENT_IN_PROGRESS = 'A payment is in progress. Finish it, then update.'
export const UPDATE_REFUSED_CART_HAS_ITEMS =
  'There are items in the cart. Complete the sale or put it on hold, then update.'

/**
 * @param {UpdateNowState} state
 * @returns {string | null} the reason in plain words, or null when the update may go ahead
 */
export function updateNowRefusal(state: UpdateNowState): string | null {
  if (state.saleBeingCompleted) return UPDATE_REFUSED_SALE_BEING_COMPLETED
  if (state.paymentInProgress) return UPDATE_REFUSED_PAYMENT_IN_PROGRESS
  if (state.cartItemCount > 0) return UPDATE_REFUSED_CART_HAS_ITEMS
  return null
}
