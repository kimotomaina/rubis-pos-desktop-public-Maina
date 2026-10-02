/**
 * Saving the cart so it survives a restart, and putting it back
 * (docs/phase-197).
 *
 * The saved cart is a draft on this till and nothing more: lines only, no
 * payment state, never pushed anywhere. Shopify stays the only stock ledger.
 */

import type { CartItem, ProductSummary } from '../types/shopify.js'
import { buildCartItem } from './cartItem.js'

/** How long to wait after the last cart change before saving, so a fast scan does not write per key. */
export const CART_DRAFT_DEBOUNCE_MS = 300

/** The cart as it is saved. */
export interface CartDraftSnapshot {
  items: CartItem[]
  cartToken: string
}

/** Where the saver writes. */
export interface CartDraftSaverDeps {
  save: (snapshot: CartDraftSnapshot) => Promise<unknown>
  clear: () => Promise<unknown>
  delayMs?: number
}

/** Handle returned by {@link createCartDraftSaver}. */
export interface CartDraftSaver {
  /** Schedules a save (or a delete, for an empty cart) after the debounce, replacing any pending one. */
  update: (snapshot: { items: CartItem[]; cartToken: string | null }) => void
  /** Drops the pending write without making it. */
  cancel: () => void
}

/**
 * Debounced writer for the cart draft. An empty cart deletes the draft
 * rather than saving an empty one. A failed write is swallowed: the draft
 * is a convenience and must never get in the way of a sale.
 *
 * @param {CartDraftSaverDeps} deps
 * @returns {CartDraftSaver}
 */
export function createCartDraftSaver(deps: CartDraftSaverDeps): CartDraftSaver {
  const delayMs = deps.delayMs ?? CART_DRAFT_DEBOUNCE_MS
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  return {
    cancel,
    update: (snapshot) => {
      cancel()
      timer = setTimeout(() => {
        timer = null
        const write =
          snapshot.items.length === 0 || !snapshot.cartToken
            ? deps.clear()
            : deps.save({ items: snapshot.items, cartToken: snapshot.cartToken })
        void Promise.resolve(write).catch(() => undefined)
      }, delayMs)
    }
  }
}

/** The outcome of rebuilding a saved cart against the current catalogue. */
export interface RestoredCart {
  items: CartItem[]
  cartToken: string
  /** Saved lines whose variant is no longer in the catalogue. */
  droppedLines: number
  /** Restored lines that had a price override or discount, now removed. */
  overridesRemoved: number
}

/**
 * Rebuilds a saved cart from the current catalogue, so prices are today's
 * and not last week's. A variant that is no longer in the catalogue (the
 * catalogue holds only Shopify's active products) is dropped. A manager's
 * price override or discount was approved against the old price, so it is
 * removed, never carried over.
 *
 * @param {string} payloadJson what `cart:load-draft` returned
 * @param {ProductSummary[]} catalogue
 * @returns {RestoredCart | null} `null` when the draft is unreadable
 */
export function restoreCartDraft(payloadJson: string, catalogue: ProductSummary[]): RestoredCart | null {
  let saved: { cartToken?: unknown; items?: unknown }
  try {
    saved = JSON.parse(payloadJson) as { cartToken?: unknown; items?: unknown }
  } catch {
    return null
  }
  if (typeof saved.cartToken !== 'string' || !saved.cartToken || !Array.isArray(saved.items)) return null

  const variants = new Map<string, { product: ProductSummary; variantIndex: number }>()
  for (const product of catalogue) {
    product.variants.forEach((variant, variantIndex) => variants.set(variant.id, { product, variantIndex }))
  }

  const items: CartItem[] = []
  let droppedLines = 0
  let overridesRemoved = 0
  for (const line of saved.items as CartItem[]) {
    const found = variants.get(line.id)
    if (!found || !Number.isInteger(line.quantity) || line.quantity <= 0) {
      droppedLines++
      continue
    }
    const fresh = buildCartItem(found.product, found.product.variants[found.variantIndex])
    if (line.discount || (line.basePrice !== undefined && line.price !== line.basePrice)) overridesRemoved++
    items.push({ ...fresh, quantity: line.quantity, basePrice: fresh.price })
  }
  return { items, cartToken: saved.cartToken, droppedLines, overridesRemoved }
}

/**
 * @param {RestoredCart} restored
 * @returns {string} the one toast shown after a restore
 */
export function restoreToastMessage(restored: RestoredCart): string {
  if (restored.items.length === 0) {
    return `The cart from before the restart was not restored: ${restored.droppedLines} line${restored.droppedLines === 1 ? '' : 's'} no longer in the catalogue.`
  }
  const units = restored.items.reduce((sum, item) => sum + item.quantity, 0)
  let message = `Restored the cart from before the restart. ${units} item${units === 1 ? '' : 's'}.`
  if (restored.droppedLines > 0) {
    message += ` ${restored.droppedLines} line${restored.droppedLines === 1 ? '' : 's'} no longer in the catalogue ${restored.droppedLines === 1 ? 'was' : 'were'} dropped.`
  }
  if (restored.overridesRemoved > 0) {
    message += ' Price overrides and discounts were removed; a manager can apply them again.'
  }
  return message
}
