/**
 * Server-side belt-and-braces check (docs/phase-161-1): whether a
 * validated `orders:checkout` request carries a discount. A real fiscal
 * provider must refuse a discounted sale outright - docs/phase-160 found
 * the fiscal device is never told about a discount at all (it only ever
 * receives `item.price × quantity`), so filing one today would file the
 * wrong amount with KRA.
 *
 * This is a backstop behind the renderer's own safeguard
 * (`renderer/src/lib/checkoutMath.ts`'s `hasDiscountOrOverride`, gating
 * the UI controls that create a discount), not a replacement for it -
 * the main process has no session, so it cannot re-derive "was this
 * control hidden" the way the renderer does; it can only re-check the
 * one thing a request can actually prove: does it carry a discount.
 *
 * Deliberately does NOT check for a price override here (docs/phase-161-1,
 * item 2) - `basePrice` is present on the validated request
 * (`ipcValidator.ts`'s `cartItemSchema`), but it is entirely
 * renderer-supplied, exactly like `price` itself, so a request could
 * carry a `price` that differs from the till's real catalog value while
 * still setting `basePrice` to match it, defeating an
 * `item.price !== item.basePrice` check without needing to lie about
 * `discount`/`cartDiscount` at all. Trusting it here would be a false
 * sense of security, not a real check - recorded as a residual gap in
 * `docs/KNOWN_GAPS.md` rather than built on an unsound foundation.
 */

import type { Discount } from '../services/shopify-types.js'

/** The one shape this check needs from a validated `orders:checkout` request. */
export interface DiscountCheckRequest {
  items: Array<{ discount?: Discount }>
  cartDiscount?: Discount
}

/**
 * @param {DiscountCheckRequest} request
 * @returns {boolean} whether any line carries a discount, or a cart-level discount is set
 */
export function requestHasDiscount(request: DiscountCheckRequest): boolean {
  if (request.cartDiscount) return true
  return request.items.some((item) => Boolean(item.discount))
}

/**
 * The full `orders:checkout` decision this phase adds - exported
 * separately from the two facts it combines so the decision itself is
 * directly unit-testable without mounting the IPC handler (this
 * codebase has no test that mounts an `index.ts` handler at all; see
 * docs/phase-158-1's own audit of that gap). `index.ts` calls this with
 * exactly `fiscalizationProvider instanceof RealFiscalizationProvider`
 * as `isRealFiscalProvider` - never re-derived here.
 *
 * @param {boolean} isRealFiscalProvider
 * @param {DiscountCheckRequest} request
 * @returns {boolean} `true` when the checkout must be refused
 */
export function shouldRefuseCheckoutForDiscount(
  isRealFiscalProvider: boolean,
  request: DiscountCheckRequest
): boolean {
  return isRealFiscalProvider && requestHasDiscount(request)
}
