/**
 * The catalogue sync (docs/phase-253-1): products, prices and stock, and the automatic discounts, read from Shopify and
 * written into the till's copy in one transaction. Each part is replaced only when its own read completed; a part
 * whose read failed keeps its last good copy. Never runs while a cart is open, so a sync cannot change a sale in
 * progress, and never runs twice at once.
 */

import type { ServiceResult } from './shopify-types.js'
import type { ProductSummary } from '../../renderer/src/types/shopify.js'
import type { AutoDiscount, SkippedDiscount } from '../lib/autoDiscounts.js'

/** Why the Shopify reads were not made: a cart is open on this till. */
export const SYNC_CART_OPEN_MESSAGE = 'Not synced: a sale is in progress. Finish or clear the cart, then sync.'

/** Shopify answered with no products for this till; the copy is kept rather than emptied. */
export const SYNC_NO_PRODUCTS_MESSAGE = 'Products not refreshed: Shopify returned no products for this till. The last good copy is kept.'

/** What one sync did, and the copy the till now sells from. */
export interface CatalogSyncResult {
  /** The product copy after the sync, refreshed or not. */
  products: ProductSummary[]
  /** The discount copy after the sync, refreshed or not. */
  discounts: AutoDiscount[]
  /** Discounts in Shopify the till does not apply, from this sync's read; empty when discounts were not read. */
  skipped: SkippedDiscount[]
  productsRefreshed: boolean
  discountsRefreshed: boolean
  /** The reads were not made because a cart is open. */
  refused: boolean
  /** One line per part that was not refreshed, saying why. */
  messages: string[]
  /** When the products were last read in full, this sync or an earlier one. */
  lastSyncedAt: string | null
}

/** The slice of the database the sync uses. */
export interface CatalogSyncDb {
  getCartDraft(): unknown
  getCachedProducts(): ProductSummary[]
  getAutoDiscounts(): AutoDiscount[]
  getCatalogSyncedAt(): string | null
  replaceCatalogue(update: { products?: ProductSummary[]; discounts?: AutoDiscount[]; syncedAt?: string }): void
}

/** Dependencies of {@link createCatalogSync}; the two reads are Shopify, faked in tests. */
export interface CatalogSyncDeps {
  db: CatalogSyncDb
  readProducts: () => Promise<ServiceResult<ProductSummary[]>>
  readDiscounts: () => Promise<ServiceResult<{ discounts: AutoDiscount[]; skipped: SkippedDiscount[] }>>
  now: () => Date
}

/**
 * Runs a read that may throw (a bad store URL throws before any request) as a {@link ServiceResult}.
 *
 * @param {() => Promise<ServiceResult<T>>} read
 * @returns {Promise<ServiceResult<T>>}
 */
async function settle<T>(read: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
  try {
    return await read()
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'The Shopify read failed' }
  }
}

/**
 * @param {CatalogSyncDeps} deps
 * @returns {{ sync: () => Promise<ServiceResult<CatalogSyncResult>> }} a sync asked for while one runs joins it
 */
export function createCatalogSync(deps: CatalogSyncDeps): { sync: () => Promise<ServiceResult<CatalogSyncResult>> } {
  const { db } = deps
  let inFlight: Promise<ServiceResult<CatalogSyncResult>> | null = null

  /** The copy as it stands, with what this sync did. */
  const copy = (part: Pick<CatalogSyncResult, 'skipped' | 'productsRefreshed' | 'discountsRefreshed' | 'refused' | 'messages'>): CatalogSyncResult => ({
    products: db.getCachedProducts(),
    discounts: db.getAutoDiscounts(),
    lastSyncedAt: db.getCatalogSyncedAt(),
    ...part
  })

  const run = async (): Promise<ServiceResult<CatalogSyncResult>> => {
    if (db.getCartDraft()) {
      return {
        success: true,
        data: copy({ skipped: [], productsRefreshed: false, discountsRefreshed: false, refused: true, messages: [SYNC_CART_OPEN_MESSAGE] })
      }
    }

    const [productRead, discountRead] = await Promise.all([settle(deps.readProducts), settle(deps.readDiscounts)])
    const messages: string[] = []

    // An empty read is not a good read: it would empty the copy the till sells from (docs/phase-253-1, item 6).
    const products = productRead.success && productRead.data && productRead.data.length > 0 ? productRead.data : undefined
    if (!products) {
      messages.push(
        productRead.success ? SYNC_NO_PRODUCTS_MESSAGE : `Products not refreshed: ${productRead.error ?? 'the Shopify read failed'}. The last good copy is kept.`
      )
    }
    const discountData = discountRead.success ? discountRead.data : undefined
    if (!discountData) {
      const reason = discountRead.error ?? 'the Shopify read failed'
      // The owner's wording for a missing scope stands as it is; any other failure says the copy is kept.
      messages.push(reason.startsWith('Discounts not read') ? reason : `Discounts not read: ${reason}. The last good copy is kept.`)
    }

    db.replaceCatalogue({
      ...(products ? { products, syncedAt: deps.now().toISOString() } : {}),
      ...(discountData ? { discounts: discountData.discounts } : {})
    })

    return {
      success: true,
      data: copy({
        skipped: discountData?.skipped ?? [],
        productsRefreshed: products !== undefined,
        discountsRefreshed: discountData !== undefined,
        refused: false,
        messages
      })
    }
  }

  return {
    sync: () => {
      if (!inFlight) inFlight = run().finally(() => (inFlight = null))
      return inFlight
    }
  }
}
