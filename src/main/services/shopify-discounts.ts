/**
 * Reading the store's automatic discounts (docs/phase-253-1). Read-only: needs the `read_discounts` scope. Every field
 * below is named as the 2026-07 Admin schema names it (introspection of the store, docs/phase-253-audit §1.5).
 */

import { AxiosError, type AxiosInstance } from 'axios'
import type { ServiceResult } from './shopify-types.js'
import type { AutoDiscount, AutoDiscountEffect, SkippedDiscount } from '../lib/autoDiscounts.js'
import { translateAxiosError } from './shopify.js'

/** Shown on the sync result when the token cannot read discounts (owner's wording, docs/phase-253-1). */
export const NO_DISCOUNT_SCOPE_MESSAGE = 'Discounts not read: the Shopify token has no read_discounts access'

/** Discounts per page. Small, because each Buy X get Y node asks for up to four lists of ids. */
const DISCOUNT_PAGE_SIZE = 5

/** Products or variants read per side; a longer list is skipped rather than read in part. */
const ITEM_LIST_SIZE = 20

/** Hard stop on the page loop, as for locations: a repeating cursor fails rather than spinning. */
const MAX_DISCOUNT_PAGES = 200

const ITEMS_SELECTION = `items {
          __typename
          ... on DiscountProducts {
            products(first: ${ITEM_LIST_SIZE}) { pageInfo { hasNextPage } nodes { id } }
            productVariants(first: ${ITEM_LIST_SIZE}) { pageInfo { hasNextPage } nodes { id } }
          }
        }`

/** Every discount, any kind: the kinds the till does not apply are still read for their title, to list them. */
export const AUTOMATIC_DISCOUNTS_QUERY = `
query AutomaticDiscounts($first: Int!, $after: String) {
  discountNodes(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      discount {
        __typename
        ... on DiscountAutomaticBasic { title status }
        ... on DiscountAutomaticFreeShipping { title status }
        ... on DiscountAutomaticApp { title status }
        ... on DiscountCodeBasic { title status }
        ... on DiscountCodeBxgy { title status }
        ... on DiscountCodeFreeShipping { title status }
        ... on DiscountCodeApp { title status }
        ... on DiscountAutomaticBxgy {
          title
          status
          startsAt
          endsAt
          usesPerOrderLimit
          context { __typename }
          customerBuys {
            isOneTimePurchase
            value { __typename ... on DiscountQuantity { quantity } }
            ${ITEMS_SELECTION}
          }
          customerGets {
            appliesOnOneTimePurchase
            value {
              __typename
              ... on DiscountOnQuantity {
                quantity { quantity }
                effect {
                  __typename
                  ... on DiscountAmount { amount { amount } appliesOnEachItem }
                  ... on DiscountPercentage { percentage }
                }
              }
            }
            ${ITEMS_SELECTION}
          }
        }
      }
    }
  }
}
`

interface IdList {
  pageInfo?: { hasNextPage?: boolean }
  nodes?: Array<{ id: string }>
}

interface WireItems {
  __typename?: string
  products?: IdList
  productVariants?: IdList
}

/** One `DiscountNode` as the query returns it; every field may be missing on a malformed reply. */
export interface WireDiscountNode {
  id: string
  discount?: {
    __typename?: string
    title?: string
    status?: string
    startsAt?: string
    endsAt?: string | null
    usesPerOrderLimit?: number | string | null
    context?: { __typename?: string }
    customerBuys?: {
      isOneTimePurchase?: boolean
      value?: { __typename?: string; quantity?: number | string }
      items?: WireItems
    }
    customerGets?: {
      appliesOnOneTimePurchase?: boolean
      value?: {
        __typename?: string
        quantity?: { quantity?: number | string }
        effect?: {
          __typename?: string
          amount?: { amount?: string | number }
          appliesOnEachItem?: boolean
          percentage?: number | string
        }
      }
      items?: WireItems
    }
  } | null
}

/** Why a kind other than an automatic Buy X get Y is not applied. */
const OTHER_KIND_REASONS: Record<string, string> = {
  DiscountAutomaticBasic: 'amount off products: not applied by the till in version 1',
  DiscountAutomaticFreeShipping: 'free shipping: not applied by the till',
  DiscountAutomaticApp: 'app discount: not applied by the till',
  DiscountCodeBasic: 'discount code: not applied by the till',
  DiscountCodeBxgy: 'discount code: not applied by the till',
  DiscountCodeFreeShipping: 'discount code: not applied by the till',
  DiscountCodeApp: 'discount code: not applied by the till'
}

/**
 * @param {string} gid e.g. `gid://shopify/Product/123`
 * @returns {string} `123`
 */
function numericId(gid: string): string {
  return gid.split('/').pop() ?? gid
}

/**
 * A positive whole number from Shopify's `Int` or `UnsignedInt64` (sent as a string), or `null`.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function positiveInteger(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
}

/**
 * The ids of one side, or `null` when the side is not a complete list of products or variants.
 *
 * @param {WireItems | undefined} items
 * @returns {{ productIds: string[]; variantIds: string[] } | null}
 */
function sideIds(items: WireItems | undefined): { productIds: string[]; variantIds: string[] } | null {
  if (items?.__typename !== 'DiscountProducts') return null
  if (items.products?.pageInfo?.hasNextPage || items.productVariants?.pageInfo?.hasNextPage) return null
  const productIds = (items.products?.nodes ?? []).map((node) => numericId(node.id)).sort()
  const variantIds = (items.productVariants?.nodes ?? []).map((node) => node.id).sort()
  if (productIds.length === 0 && variantIds.length === 0) return null
  return { productIds, variantIds }
}

/**
 * @param {NonNullable<NonNullable<WireDiscountNode['discount']>['customerGets']>['value']} value
 * @returns {AutoDiscountEffect | null}
 */
function effectOf(
  value: NonNullable<NonNullable<NonNullable<WireDiscountNode['discount']>['customerGets']>['value']>
): AutoDiscountEffect | null {
  const effect = value.effect
  if (effect?.__typename === 'DiscountAmount') {
    const amount = Number(effect.amount?.amount)
    return effect.appliesOnEachItem === true && Number.isFinite(amount) && amount > 0 ? { type: 'amount', amount } : null
  }
  if (effect?.__typename === 'DiscountPercentage') {
    const percentage = Number(effect.percentage)
    return Number.isFinite(percentage) && percentage > 0 && percentage <= 1 ? { type: 'percentage', percentage } : null
  }
  return null
}

/**
 * Maps one discount node: an automatic Buy X get Y of the supported shape (docs/phase-253, D1) becomes an
 * {@link AutoDiscount}; any other live discount is skipped with its title and the reason. An expired discount is left
 * out of both, since it can never apply.
 *
 * @param {WireDiscountNode} node
 * @returns {{ discount: AutoDiscount } | { skipped: SkippedDiscount } | null}
 */
export function mapDiscountNode(node: WireDiscountNode): { discount: AutoDiscount } | { skipped: SkippedDiscount } | null {
  const d = node.discount
  if (!d || d.status === 'EXPIRED') return null
  const title = d.title?.trim() || '(untitled discount)'
  const skip = (reason: string): { skipped: SkippedDiscount } => ({ skipped: { title, reason } })

  if (d.__typename !== 'DiscountAutomaticBxgy') {
    return skip(OTHER_KIND_REASONS[d.__typename ?? ''] ?? 'a kind the till does not apply')
  }
  if (d.context?.__typename !== 'DiscountBuyerSelectionAll') return skip('not for all customers')
  if (d.customerBuys?.isOneTimePurchase !== true || d.customerGets?.appliesOnOneTimePurchase !== true) {
    return skip('not for one-time purchases')
  }
  if (d.customerBuys.value?.__typename !== 'DiscountQuantity') return skip('the customer must spend an amount, not buy a quantity')
  const buysQuantity = positiveInteger(d.customerBuys.value.quantity)
  const getsValue = d.customerGets.value
  if (getsValue?.__typename !== 'DiscountOnQuantity') return skip('the customer does not get a quantity of items')
  const getsQuantity = positiveInteger(getsValue.quantity?.quantity)
  if (buysQuantity === null || getsQuantity === null) return skip('no quantity to buy or to get')
  const effect = effectOf(getsValue)
  if (!effect) return skip('not an amount or percentage off each item')

  const buys = sideIds(d.customerBuys.items)
  const gets = sideIds(d.customerGets.items)
  if (!buys || !gets) return skip('not a short list of specific products')
  if (buys.productIds.join() !== gets.productIds.join() || buys.variantIds.join() !== gets.variantIds.join()) {
    return skip('the customer buys and gets different products')
  }
  if (!d.startsAt) return skip('no start date')

  return {
    discount: {
      id: node.id,
      title,
      startsAt: d.startsAt,
      endsAt: d.endsAt ?? null,
      buysQuantity,
      getsQuantity,
      variantIds: buys.variantIds,
      productIds: buys.productIds,
      effect,
      usesPerOrderLimit: positiveInteger(d.usesPerOrderLimit)
    }
  }
}

/**
 * Reads every discount, page by page, and maps each. Any failed page fails the whole read, so the caller never
 * replaces its copy with part of the list.
 *
 * @param {AxiosInstance} client
 * @returns {Promise<ServiceResult<{ discounts: AutoDiscount[]; skipped: SkippedDiscount[] }>>}
 */
export async function fetchAutomaticDiscounts(
  client: AxiosInstance
): Promise<ServiceResult<{ discounts: AutoDiscount[]; skipped: SkippedDiscount[] }>> {
  const discounts: AutoDiscount[] = []
  const skipped: SkippedDiscount[] = []
  let cursor: string | null = null
  let hasNextPage = true
  let pages = 0

  try {
    while (hasNextPage) {
      if (pages >= MAX_DISCOUNT_PAGES) {
        return { success: false, error: 'Shopify kept returning more discounts; stopped rather than keep part of the list' }
      }
      pages += 1
      const response = await client.post('', { query: AUTOMATIC_DISCOUNTS_QUERY, variables: { first: DISCOUNT_PAGE_SIZE, after: cursor } })

      const errors = response.data?.errors as Array<{ message?: string; extensions?: { code?: string } }> | undefined
      if (errors && errors.length > 0) {
        const noScope = errors.some((e) => e.extensions?.code === 'ACCESS_DENIED' && (e.message ?? '').includes('read_discounts'))
        return { success: false, error: noScope ? NO_DISCOUNT_SCOPE_MESSAGE : errors.map((e) => e.message).join('; ') }
      }
      const connection = response.data?.data?.discountNodes as
        | { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: WireDiscountNode[] }
        | undefined
      if (!connection) return { success: false, error: 'Shopify returned no discounts list' }

      for (const node of connection.nodes ?? []) {
        const mapped = mapDiscountNode(node)
        if (mapped && 'discount' in mapped) discounts.push(mapped.discount)
        else if (mapped) skipped.push(mapped.skipped)
      }
      hasNextPage = connection.pageInfo?.hasNextPage ?? false
      cursor = connection.pageInfo?.endCursor ?? null
    }
    return { success: true, data: { discounts, skipped } }
  } catch (err) {
    if (err instanceof AxiosError) return { success: false, error: translateAxiosError(err) }
    return { success: false, error: err instanceof Error ? err.message : 'Could not read discounts' }
  }
}
