/**
 * Pure checkout math for staff auth and the checkout flow.
 *
 * Kept dependency-free and directly testable, independent of
 * `CheckoutModal`'s React state, mirroring how the barcode timing
 * logic and `computeBackoffMs` are pure exported functions elsewhere
 * in this codebase.
 */

import type { PaymentMethod } from '../../../main/services/database.js'
import type { CartItem, Discount } from '../types/shopify.js'

/** Discount percentage above which applying it requires Manager PIN authorization. */
export const MANAGER_PIN_DISCOUNT_THRESHOLD_PERCENT = 10

/**
 * Maximum percentage a manual price override may exceed a line's
 * original catalog price by — guards against a
 * cashier typo like `10000` instead of `1000` slipping past the
 * Manager PIN gate, which only authorizes *that* an override happens,
 * not that its magnitude is sane.
 */
export const PRICE_OVERRIDE_MAX_MARKUP_PERCENT = 50

/** Result of {@link validatePriceOverride}. */
export interface PriceOverrideValidation {
  valid: boolean
  /** User-facing reason, set only when `valid` is false. */
  reason?: string
}

/**
 * Computes change due for a cash payment. Never negative — an
 * insufficient tender returns 0 (the caller gates submission with
 * {@link canCompleteSale} instead).
 *
 * @param {number} total
 * @param {number} tendered
 * @returns {number}
 */
export function calculateChange(total: number, tendered: number): number {
  const change = tendered - total
  return change > 0 ? round2(change) : 0
}

/**
 * Decides whether "Complete Sale" may be pressed for the given
 * payment method and current input state.
 *
 * - `cash`: the tendered amount must cover the total.
 * - `card`: a non-blank reference number is required — the reference is
 *   the cashier's record of a payment the card terminal already took, so
 *   there is nothing for this till to confirm.
 * - `mpesa`: **never**. An M-Pesa sale completes only through a
 *   confirmed payment, which arrives by way of `PaymentModal`'s `onPaid`
 *   rather than through this button. A typed reference is not evidence
 *   that anyone paid, and treating it as sufficient here is what would
 *   let a cashier complete a sale for a payment that never happened.
 *   `runCheckout` refuses such a sale regardless; this keeps the screen
 *   from offering it in the first place.
 *
 * @param {PaymentMethod} method
 * @param {number} total
 * @param {number} tendered
 * @param {string} [referenceNumber]
 * @returns {boolean}
 */
export function canCompleteSale(
  method: PaymentMethod,
  total: number,
  tendered: number,
  referenceNumber?: string
): boolean {
  if (method === 'cash') {
    return tendered >= total
  }
  if (method === 'mpesa') {
    return false
  }
  return (referenceNumber ?? '').trim().length > 0
}

/**
 * Rounds a currency value to 2 decimal places, avoiding common
 * floating-point artifacts (e.g. `0.1 + 0.2`).
 *
 * @param {number} value
 * @returns {number}
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Applies a discount to a base amount, clamped so the result never
 * goes below zero (a discount can never "owe" the customer).
 *
 * @param {number} amount
 * @param {Discount} [discount]
 * @returns {number}
 */
export function applyDiscount(amount: number, discount?: Discount | null): number {
  if (!discount || !(discount.value > 0)) {
    return round2(Math.max(amount, 0))
  }
  const reduction = discount.type === 'percent' ? amount * (discount.value / 100) : discount.value
  return round2(Math.max(amount - reduction, 0))
}

/**
 * The subtotal of one cart line after its own line-level discount.
 *
 * @param {CartItem} item
 * @returns {number}
 */
export function calculateLineTotal(item: CartItem): number {
  return applyDiscount(item.price * item.quantity, item.discount)
}

/**
 * Sum of every line's discounted total — the base the cart-level
 * discount is then applied against.
 *
 * @param {CartItem[]} items
 * @returns {number}
 */
export function calculateSubtotal(items: CartItem[]): number {
  return round2(items.reduce((sum, item) => sum + calculateLineTotal(item), 0))
}

/**
 * The final cart total: line-level discounts applied first, then the
 * cart-level discount applied on top of that subtotal. Never negative.
 *
 * @param {CartItem[]} items
 * @param {Discount} [cartDiscount]
 * @returns {number}
 */
export function calculateCartTotal(items: CartItem[], cartDiscount?: Discount | null): number {
  return applyDiscount(calculateSubtotal(items), cartDiscount)
}

/**
 * Expresses a discount as a percentage of the base amount it's applied
 * against — used to decide whether Manager PIN authorization is
 * required (a `fixed` discount is converted to an equivalent percent).
 *
 * @param {Discount} discount
 * @param {number} baseAmount
 * @returns {number}
 */
export function discountPercentOf(discount: Discount, baseAmount: number): number {
  if (!(baseAmount > 0)) return 0
  const amountOff =
    discount.type === 'percent' ? baseAmount * (discount.value / 100) : discount.value
  return (amountOff / baseAmount) * 100
}

/**
 * Whether applying `discount` against `baseAmount` requires Manager
 * PIN authorization — anything exceeding
 * {@link MANAGER_PIN_DISCOUNT_THRESHOLD_PERCENT}.
 *
 * @param {Discount} discount
 * @param {number} baseAmount
 * @returns {boolean}
 */
export function requiresManagerPinForDiscount(discount: Discount, baseAmount: number): boolean {
  return discountPercentOf(discount, baseAmount) > MANAGER_PIN_DISCOUNT_THRESHOLD_PERCENT
}

/**
 * Validates a manual price override against the line's original
 * catalog price:
 *   - `0` or negative is rejected outright (a "free item" should go
 *     through a 100% discount instead, which is already Manager
 *     PIN-gated — see `requiresManagerPinForDiscount`).
 *   - Anything more than {@link PRICE_OVERRIDE_MAX_MARKUP_PERCENT}%
 *     above `basePrice` is rejected as a likely typo.
 *
 * `basePrice` is the item's original catalog price, captured once
 * when it's added to the cart (`CartItem.basePrice`) — checking
 * against it rather than the item's current (possibly already
 * overridden) price prevents a second override from compounding past
 * the ceiling a first one already approached.
 *
 * @param {number} newPrice
 * @param {number} basePrice
 * @returns {PriceOverrideValidation}
 */
export function validatePriceOverride(
  newPrice: number,
  basePrice: number
): PriceOverrideValidation {
  if (!Number.isFinite(newPrice) || newPrice <= 0) {
    return { valid: false, reason: 'Price must be greater than zero.' }
  }
  if (basePrice > 0) {
    const ceiling = basePrice * (1 + PRICE_OVERRIDE_MAX_MARKUP_PERCENT / 100)
    if (newPrice > ceiling) {
      return {
        valid: false,
        reason: 'Price exceeds maximum allowed override. Contact Admin.'
      }
    }
  }
  return { valid: true }
}
