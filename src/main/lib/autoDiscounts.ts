/**
 * Automatic discounts the till applies by itself (docs/phase-253). Shopify is the only place they are made; the till
 * keeps a read-only copy, replaced whole by each sync. Version 1 reads one kind: an automatic Buy X get Y whose two
 * sides name the same products, with a quantity on each side and an amount or percentage off each discounted unit.
 */

/** What a discounted unit loses: a fixed amount, or a fraction of its price (0.25 = 25 %). */
export type AutoDiscountEffect = { type: 'amount'; amount: number } | { type: 'percentage'; percentage: number }

/** One automatic Buy X get Y discount, as the till stores it. */
export interface AutoDiscount {
  /** The Shopify discount node id. */
  id: string
  title: string
  /** ISO date-time the discount starts. */
  startsAt: string
  /** ISO date-time it ends, or `null` when it has no end. */
  endsAt: string | null
  /** Units the customer buys at full price for each use. */
  buysQuantity: number
  /** Units the customer then gets at the discounted price for each use. */
  getsQuantity: number
  /** Variant ids named on both sides. */
  variantIds: string[]
  /** Product ids, numeric part only, named on both sides: every variant of these counts. */
  productIds: string[]
  effect: AutoDiscountEffect
  /** The most times it applies to one sale, or `null` for no limit. */
  usesPerOrderLimit: number | null
}

/** A Shopify discount the till does not apply, with the reason, for the sync result. */
export interface SkippedDiscount {
  title: string
  reason: string
}
