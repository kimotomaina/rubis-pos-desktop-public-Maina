/**
 * Holding a sale and serving the next customer (docs/phase-217): the owner's
 * numbers, the ageing, and the rules for when a hold or a resume is allowed.
 *
 * Pure, so every branch is directly testable.
 */

import type { CartItem, Discount } from '../types/shopify.js'
import type { HeldCartContents } from '../stores/cartStore.js'

/**
 * The owner's numbers. They are the owner's to change, here and nowhere else:
 * `MAX_HELD_SALES` also lives in `src/main/lib/heldSaleRules.ts`, where the main
 * process enforces it (the renderer cannot import values from `main/`);
 * `tests/heldSales.test.ts` fails if the two differ.
 */
export const MAX_HELD_SALES = 3
/** A held sale turns amber after this long: a wait this long may mean something has gone wrong. */
export const HELD_AMBER_AFTER_MS = 5 * 60_000
/** A held sale turns red after this long. */
export const HELD_RED_AFTER_MS = 15 * 60_000
/** How often the strip recomputes ages. */
export const HELD_AGE_REFRESH_MS = 15_000

/** How urgent a held sale looks. */
export type HeldAgeTone = 'normal' | 'amber' | 'red'

/**
 * @param {string} heldAtIso
 * @param {number} nowMs
 * @returns {HeldAgeTone}
 */
export function heldAgeTone(heldAtIso: string, nowMs: number): HeldAgeTone {
  const age = nowMs - new Date(heldAtIso).getTime()
  if (age >= HELD_RED_AFTER_MS) return 'red'
  if (age >= HELD_AMBER_AFTER_MS) return 'amber'
  return 'normal'
}

/**
 * How long a sale has been held, in words a cashier reads at a glance.
 *
 * @param {string} heldAtIso
 * @param {number} nowMs
 * @returns {string} for example `just now`, `4 min`, `1 h 05`
 */
export function formatHeldAge(heldAtIso: string, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - new Date(heldAtIso).getTime()) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

/** Why a hold or a resume was refused, or that it is allowed. */
export type HeldDecision = { allowed: true } | { allowed: false; reason: string }

export const HOLD_EMPTY_CART_REASON = 'The cart is empty.'
export const HOLD_PAYMENT_REASON = 'Finish or cancel the payment in progress before holding this sale.'
export const HOLD_LIMIT_REASON = `This till already holds ${MAX_HELD_SALES} sales. Complete or discard one first.`
export const RESUME_CART_NOT_EMPTY_REASON = 'The current cart is not empty. Hold it first, then resume.'

/**
 * Rule: a payment in progress, a full till, or an empty cart refuses a hold. A cart
 * that came from a held sale is already counted, so it may always be held again.
 *
 * @param {{ itemCount: number; paymentInProgress: boolean; openHeldCount: number; cartIsResumedSale: boolean }} input
 * @returns {HeldDecision}
 */
export function decideHold(input: {
  itemCount: number
  paymentInProgress: boolean
  openHeldCount: number
  cartIsResumedSale: boolean
}): HeldDecision {
  if (input.itemCount === 0) return { allowed: false, reason: HOLD_EMPTY_CART_REASON }
  if (input.paymentInProgress) return { allowed: false, reason: HOLD_PAYMENT_REASON }
  if (!input.cartIsResumedSale && input.openHeldCount >= MAX_HELD_SALES) {
    return { allowed: false, reason: HOLD_LIMIT_REASON }
  }
  return { allowed: true }
}

/**
 * Rule: a held sale is only resumed onto an empty cart, so two carts are never merged by accident.
 *
 * @param {number} currentItemCount
 * @returns {HeldDecision}
 */
export function decideResume(currentItemCount: number): HeldDecision {
  return currentItemCount === 0 ? { allowed: true } : { allowed: false, reason: RESUME_CART_NOT_EMPTY_REASON }
}

/**
 * Reads a held sale's stored cart back, exactly as it was held.
 *
 * @param {string} payloadJson
 * @returns {HeldCartContents | null} `null` when it is unreadable
 */
export function parseHeldPayload(payloadJson: string): HeldCartContents | null {
  let saved: { items?: unknown; cartDiscount?: unknown; customerPin?: unknown; companyName?: unknown }
  try {
    saved = JSON.parse(payloadJson) as typeof saved
  } catch {
    return null
  }
  if (!Array.isArray(saved.items) || saved.items.length === 0) return null
  const items = saved.items as CartItem[]
  const valid = items.every(
    (item) =>
      typeof item.id === 'string' &&
      typeof item.price === 'number' &&
      Number.isInteger(item.quantity) &&
      item.quantity > 0
  )
  if (!valid) return null
  const discount = saved.cartDiscount as Discount | undefined
  return {
    items,
    cartDiscount: discount && typeof discount.value === 'number' ? discount : null,
    customerPin: typeof saved.customerPin === 'string' ? saved.customerPin : '',
    companyName: typeof saved.companyName === 'string' ? saved.companyName : ''
  }
}

/**
 * Why a shift cannot be closed while sales are held or resumed (docs/phase-217): a held
 * sale left at shift end is the forgotten sale.
 *
 * @param {Array<{ label: string; total: number }>} sales
 * @returns {string | null} the message, or `null` when nothing is held
 */
export function closeShiftBlockedMessage(sales: Array<{ label: string; total: number }>): string | null {
  if (sales.length === 0) return null
  const list = sales.map((sale) => `${sale.label} (${sale.total.toFixed(2)})`).join(', ')
  return `${sales.length === 1 ? '1 sale is' : `${sales.length} sales are`} on hold: ${list}. Complete or discard ${sales.length === 1 ? 'it' : 'them'} before closing the shift.`
}
