/**
 * The screen's copy of the automatic-discount pricing (docs/phase-253-2), for display only: the main process works the
 * price out again at payment from its own copy and refuses a sale whose total differs. Mirrors `priceLines` in
 * `main/lib/autoDiscounts.ts` line for line, as `splitPayments.ts` mirrors the split rules; `autoDiscountsMirror.test.ts`
 * runs both on the same cases.
 */

import type { AutoDiscount, LinePricing } from '../../../main/lib/autoDiscounts.js'
import type { CartItem, Discount } from '../types/shopify.js'

const cents = (amount: number): number => Math.round(amount * 100)

function isDiscountLive(discount: AutoDiscount, now: Date): boolean {
  const at = now.getTime()
  return Date.parse(discount.startsAt) <= at && (discount.endsAt === null || at < Date.parse(discount.endsAt))
}

function discountNamesLine(discount: AutoDiscount, line: CartItem): boolean {
  const productId = line.productId.split('/').pop() ?? line.productId
  return discount.variantIds.includes(line.id) || discount.productIds.includes(productId)
}

function offEachCents(discount: AutoDiscount, priceCents: number): number {
  return discount.effect.type === 'amount'
    ? cents(discount.effect.amount)
    : Math.round(priceCents * discount.effect.percentage + 1e-6)
}

interface DiscountPlan {
  discount: AutoDiscount
  takenLines: number[]
  discountedByLine: Map<number, number>
  savingCents: number
}

function planFor(discount: AutoDiscount, lines: CartItem[], taken: Set<number>): DiscountPlan | null {
  const takenLines = lines.map((_line, index) => index).filter((index) => !taken.has(index) && discountNamesLine(discount, lines[index]))
  const units = takenLines.reduce((sum, index) => sum + lines[index].quantity, 0)
  let uses = Math.floor(units / (discount.buysQuantity + discount.getsQuantity))
  if (discount.usesPerOrderLimit !== null) uses = Math.min(uses, discount.usesPerOrderLimit)
  let toDiscount = uses * discount.getsQuantity
  if (toDiscount === 0) return null

  const discountedByLine = new Map<number, number>()
  let savingCents = 0
  const cheapestFirst = [...takenLines].sort((a, b) => cents(lines[a].price) - cents(lines[b].price) || a - b)
  for (const index of cheapestFirst) {
    if (toDiscount === 0) break
    const count = Math.min(lines[index].quantity, toDiscount)
    const priceCents = cents(lines[index].price)
    const off = offEachCents(discount, priceCents)
    if (priceCents - off <= 0) return null
    discountedByLine.set(index, count)
    savingCents += off * count
    toDiscount -= count
  }
  return { discount, takenLines, discountedByLine, savingCents }
}

/**
 * @param {CartItem[]} lines
 * @param {AutoDiscount[]} discounts
 * @param {Date} now
 * @returns {LinePricing[]} one per cart line, in order
 */
export function priceCartLines(lines: CartItem[], discounts: AutoDiscount[], now: Date): LinePricing[] {
  const pricing: LinePricing[] = lines.map((line) => ({ fullUnits: line.quantity, discountedUnits: 0, netUnitPrice: line.price, discount: null }))
  const taken = new Set<number>()
  const remaining = discounts.filter((discount) => isDiscountLive(discount, now))

  for (;;) {
    let best: DiscountPlan | null = null
    for (const discount of remaining) {
      const plan = planFor(discount, lines, taken)
      if (!plan) continue
      if (
        !best ||
        plan.savingCents > best.savingCents ||
        (plan.savingCents === best.savingCents &&
          (Date.parse(plan.discount.startsAt) < Date.parse(best.discount.startsAt) ||
            (Date.parse(plan.discount.startsAt) === Date.parse(best.discount.startsAt) && plan.discount.id < best.discount.id)))
      ) {
        best = plan
      }
    }
    if (!best) return pricing

    for (const [index, count] of best.discountedByLine) {
      const priceCents = cents(lines[index].price)
      const off = offEachCents(best.discount, priceCents)
      pricing[index] = {
        fullUnits: lines[index].quantity - count,
        discountedUnits: count,
        netUnitPrice: (priceCents - off) / 100,
        discount: { id: best.discount.id, title: best.discount.title, amountOffEach: off / 100 }
      }
    }
    best.takenLines.forEach((index) => taken.add(index))
    remaining.splice(remaining.indexOf(best.discount), 1)
  }
}

/**
 * Whether the cart carries a manual line or cart discount. Those exist only in mock mode (a live till refuses them,
 * docs/phase-161-1), and such a cart is priced exactly as before, with no automatic discount.
 *
 * @param {CartItem[]} items
 * @param {Discount | null} cartDiscount
 * @returns {boolean}
 */
export function hasManualDiscount(items: CartItem[], cartDiscount: Discount | null | undefined): boolean {
  return Boolean(cartDiscount) || items.some((item) => Boolean(item.discount))
}

/**
 * @param {LinePricing} pricing
 * @param {number} price the line's normal unit price
 * @returns {number} the line's total after its discount
 */
export function pricedLineTotal(pricing: LinePricing, price: number): number {
  return (pricing.fullUnits * cents(price) + pricing.discountedUnits * cents(pricing.netUnitPrice)) / 100
}

/**
 * The cart's total with its automatic discounts, in whole cents.
 *
 * @param {CartItem[]} items
 * @param {AutoDiscount[]} discounts
 * @param {Date} now
 * @returns {number}
 */
export function autoPricedTotal(items: CartItem[], discounts: AutoDiscount[], now: Date): number {
  const pricing = priceCartLines(items, discounts, now)
  return items.reduce((sum, item, index) => sum + cents(pricedLineTotal(pricing[index], item.price)), 0) / 100
}
