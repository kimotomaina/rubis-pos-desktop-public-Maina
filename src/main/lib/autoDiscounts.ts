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

/** The discount a sold line carries (docs/phase-253-2): which one, and what each unit of the line saved. */
export interface AppliedAutoDiscount {
  id: string
  title: string
  amountOffEach: number
}

/** The part of a cart line the pricing reads. `productId` is the numeric product id, as the cart holds it. */
export interface DiscountableLine {
  id: string
  productId: string
  price: number
  quantity: number
}

/** How one cart line is priced: some units at full price, some at the discounted price. */
export interface LinePricing {
  fullUnits: number
  discountedUnits: number
  /** The discounted units' price; the line's own price when none is discounted. */
  netUnitPrice: number
  discount: AppliedAutoDiscount | null
}

const cents = (amount: number): number => Math.round(amount * 100)

/**
 * @param {AutoDiscount} discount
 * @param {Date} now
 * @returns {boolean} whether it is in force at `now`: started, and not yet ended
 */
export function isDiscountLive(discount: AutoDiscount, now: Date): boolean {
  const at = now.getTime()
  return Date.parse(discount.startsAt) <= at && (discount.endsAt === null || at < Date.parse(discount.endsAt))
}

/**
 * @param {AutoDiscount} discount
 * @param {DiscountableLine} line
 * @returns {boolean} whether the discount names the line's variant or product
 */
export function discountNamesLine(discount: AutoDiscount, line: DiscountableLine): boolean {
  const productId = line.productId.split('/').pop() ?? line.productId
  return discount.variantIds.includes(line.id) || discount.productIds.includes(productId)
}

/**
 * What one discounted unit of a given price saves, in cents: the amount, or the percentage rounded half-up to the cent.
 *
 * @param {AutoDiscount} discount
 * @param {number} priceCents
 * @returns {number}
 */
function offEachCents(discount: AutoDiscount, priceCents: number): number {
  return discount.effect.type === 'amount'
    ? cents(discount.effect.amount)
    : Math.round(priceCents * discount.effect.percentage + 1e-6)
}

/** One discount's plan for the cart: the lines it takes, and per line how many units it discounts. */
interface DiscountPlan {
  discount: AutoDiscount
  takenLines: number[]
  discountedByLine: Map<number, number>
  savingCents: number
}

/**
 * The plan for one discount over the lines not yet taken, or `null` when it does not apply. Units are grouped buys +
 * gets at a time; the cheapest units are the ones discounted, as Shopify does; a plan that would bring any unit to 0
 * or below is not applied at all.
 */
function planFor(discount: AutoDiscount, lines: DiscountableLine[], taken: Set<number>): DiscountPlan | null {
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
 * Prices each line against the live discounts (docs/phase-253-2). Discounts are taken best saving first, ties to the
 * earliest start and then the id; each takes the lines it names, so no line is in two discounts.
 *
 * @param {DiscountableLine[]} lines
 * @param {AutoDiscount[]} discounts the copy
 * @param {Date} now the time the price is for
 * @returns {LinePricing[]} one per line, in order
 */
export function priceLines(lines: DiscountableLine[], discounts: AutoDiscount[], now: Date): LinePricing[] {
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

/** A sold line: the cart line, or the discounted part of it with the discount it carries. */
export type SoldLine<T> = T & { autoDiscount?: AppliedAutoDiscount }

/**
 * The cart priced for the sale (docs/phase-253-2): each discounted line becomes its full-price units and its
 * discounted units, as two lines (3 loaves: 2 × 65.00, then 1 × 34.00 carrying the discount). A line with nothing
 * discounted is passed through as the same object, so a sale with no discount is exactly what it was.
 *
 * @param {T[]} lines the cart's lines
 * @param {AutoDiscount[]} discounts the copy
 * @param {Date} now the time of payment
 * @returns {{ lines: SoldLine<T>[]; total: number; named: boolean }} the sold lines, their total, and whether any
 *   line is named by any discount in the copy, live or not
 */
export function applyAutoDiscounts<T extends DiscountableLine>(
  lines: T[],
  discounts: AutoDiscount[],
  now: Date
): { lines: SoldLine<T>[]; total: number; named: boolean } {
  const pricing = priceLines(lines, discounts, now)
  const sold: SoldLine<T>[] = []
  let totalCents = 0
  lines.forEach((line, index) => {
    const { fullUnits, discountedUnits, netUnitPrice, discount } = pricing[index]
    totalCents += fullUnits * cents(line.price) + discountedUnits * cents(netUnitPrice)
    if (!discount) {
      sold.push(line)
      return
    }
    if (fullUnits > 0) sold.push({ ...line, quantity: fullUnits })
    sold.push({ ...line, quantity: discountedUnits, price: netUnitPrice, autoDiscount: discount })
  })
  const named = lines.some((line) => discounts.some((discount) => discountNamesLine(discount, line)))
  return { lines: sold, total: totalCents / 100, named }
}
