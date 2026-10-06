/**
 * Reading Shopify's discounts (docs/phase-253-1). Version 1 applies one kind, an automatic Buy X get Y with the same
 * products on both sides (D1); every other live discount is listed by title with the reason, and an expired one is
 * left out. A missing `read_discounts` scope gives the owner's message. Shopify is faked: no request leaves the test.
 */

import { describe, it, expect, vi } from 'vitest'
import type { AxiosInstance } from 'axios'
import {
  fetchAutomaticDiscounts,
  mapDiscountNode,
  NO_DISCOUNT_SCOPE_MESSAGE,
  type WireDiscountNode
} from '../src/main/services/shopify-discounts.js'

const BREAD = 'gid://shopify/Product/10235718041703'

/** The owner's discount after step by step A: buy 1 loaf, get 1 loaf at Ksh 31 off. */
function pairsNode(over: Record<string, unknown> = {}): WireDiscountNode {
  const items = {
    __typename: 'DiscountProducts',
    products: { pageInfo: { hasNextPage: false }, nodes: [{ id: BREAD }] },
    productVariants: { pageInfo: { hasNextPage: false }, nodes: [] }
  }
  return {
    id: 'gid://shopify/DiscountAutomaticNode/1',
    discount: {
      __typename: 'DiscountAutomaticBxgy',
      title: 'Probakery Bread 2 @99/=',
      status: 'ACTIVE',
      startsAt: '2026-10-06T10:12:00Z',
      endsAt: null,
      usesPerOrderLimit: null,
      context: { __typename: 'DiscountBuyerSelectionAll' },
      customerBuys: { isOneTimePurchase: true, value: { __typename: 'DiscountQuantity', quantity: '1' }, items },
      customerGets: {
        appliesOnOneTimePurchase: true,
        value: {
          __typename: 'DiscountOnQuantity',
          quantity: { quantity: '1' },
          effect: { __typename: 'DiscountAmount', amount: { amount: '31.0' }, appliesOnEachItem: true }
        },
        items
      },
      ...over
    }
  }
}

function other(typename: string, title: string, status = 'ACTIVE'): WireDiscountNode {
  return { id: `gid://shopify/DiscountNode/${title}`, discount: { __typename: typename, title, status } }
}

describe('mapDiscountNode', () => {
  it('maps the pairs discount', () => {
    expect(mapDiscountNode(pairsNode())).toEqual({
      discount: {
        id: 'gid://shopify/DiscountAutomaticNode/1',
        title: 'Probakery Bread 2 @99/=',
        startsAt: '2026-10-06T10:12:00Z',
        endsAt: null,
        buysQuantity: 1,
        getsQuantity: 1,
        variantIds: [],
        productIds: ['10235718041703'],
        effect: { type: 'amount', amount: 31 },
        usesPerOrderLimit: null
      }
    })
  })

  it('maps a percentage off each, and a cap per order', () => {
    const node = pairsNode({ usesPerOrderLimit: 2 })
    node.discount!.customerGets!.value!.effect = { __typename: 'DiscountPercentage', percentage: 0.5 }
    const mapped = mapDiscountNode(node)
    expect(mapped && 'discount' in mapped && mapped.discount.effect).toEqual({ type: 'percentage', percentage: 0.5 })
    expect(mapped && 'discount' in mapped && mapped.discount.usesPerOrderLimit).toBe(2)
  })

  it('leaves out an expired discount entirely', () => {
    expect(mapDiscountNode(pairsNode({ status: 'EXPIRED' }))).toBeNull()
    expect(mapDiscountNode(other('DiscountCodeBasic', 'SUMMER', 'EXPIRED'))).toBeNull()
  })

  it.each([
    ['DiscountAutomaticBasic', 'Probakery old'],
    ['DiscountAutomaticFreeShipping', 'Free delivery'],
    ['DiscountAutomaticApp', 'App deal'],
    ['DiscountCodeBasic', 'TENOFF'],
    ['DiscountCodeBxgy', 'BOGO-CODE'],
    ['DiscountCodeFreeShipping', 'SHIPFREE'],
    ['DiscountCodeApp', 'APPCODE']
  ])('skips %s, listed by its title', (typename, title) => {
    const mapped = mapDiscountNode(other(typename, title))
    expect(mapped && 'skipped' in mapped && mapped.skipped.title).toBe(title)
  })

  it.each<[string, (node: WireDiscountNode) => void, string]>([
    ['specific customers', (n) => (n.discount!.context = { __typename: 'DiscountCustomers' }), 'not for all customers'],
    ['subscriptions only', (n) => (n.discount!.customerBuys!.isOneTimePurchase = false), 'not for one-time purchases'],
    ['a minimum amount to spend', (n) => (n.discount!.customerBuys!.value = { __typename: 'DiscountPurchaseAmount' }), 'the customer must spend an amount, not buy a quantity'],
    ['collections', (n) => (n.discount!.customerGets!.items = { __typename: 'DiscountCollections' }), 'not a short list of specific products'],
    [
      'different products on each side',
      (n) =>
        (n.discount!.customerGets!.items = {
          __typename: 'DiscountProducts',
          products: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'gid://shopify/Product/2' }] },
          productVariants: { pageInfo: { hasNextPage: false }, nodes: [] }
        }),
      'the customer buys and gets different products'
    ],
    [
      'an amount split across the items',
      (n) =>
        (n.discount!.customerGets!.value!.effect = { __typename: 'DiscountAmount', amount: { amount: '31' }, appliesOnEachItem: false }),
      'not an amount or percentage off each item'
    ],
    [
      'a list longer than one page',
      (n) => (n.discount!.customerBuys!.items!.products!.pageInfo = { hasNextPage: true }),
      'not a short list of specific products'
    ]
  ])('skips a Buy X get Y for %s, with the reason', (_name, change, reason) => {
    const node = pairsNode()
    node.discount!.customerBuys = { ...node.discount!.customerBuys!, items: structuredClone(node.discount!.customerBuys!.items) }
    change(node)
    expect(mapDiscountNode(node)).toEqual({ skipped: { title: 'Probakery Bread 2 @99/=', reason } })
  })
})

describe('fetchAutomaticDiscounts', () => {
  const client = (post: ReturnType<typeof vi.fn>): AxiosInstance => ({ post }) as unknown as AxiosInstance
  const page = (nodes: WireDiscountNode[], hasNextPage: boolean, endCursor: string | null) => ({
    data: { data: { discountNodes: { pageInfo: { hasNextPage, endCursor }, nodes } } }
  })

  it('reads every page, applying the pairs discount and listing the rest by title', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(page([pairsNode(), other('DiscountAutomaticBasic', 'Probakery old')], true, 'c1'))
      .mockResolvedValueOnce(page([other('DiscountCodeBasic', 'TENOFF')], false, null))

    const result = await fetchAutomaticDiscounts(client(post))

    expect(result.success).toBe(true)
    expect(result.data?.discounts.map((d) => d.title)).toEqual(['Probakery Bread 2 @99/='])
    expect(result.data?.skipped.map((s) => s.title)).toEqual(['Probakery old', 'TENOFF'])
    expect(post.mock.calls[1][1].variables.after).toBe('c1')
  })

  it('a missing read_discounts scope gives the owner message', async () => {
    const post = vi.fn().mockResolvedValueOnce({
      data: {
        data: null,
        errors: [
          {
            message: 'Access denied for discountNodes field. Required access: Apps must have `read_discounts` access scope.',
            extensions: { code: 'ACCESS_DENIED' }
          }
        ]
      }
    })
    expect(await fetchAutomaticDiscounts(client(post))).toEqual({ success: false, error: NO_DISCOUNT_SCOPE_MESSAGE })
  })

  it('a later page that fails fails the whole read: no part of the list', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(page([pairsNode()], true, 'c1'))
      .mockResolvedValueOnce({ data: { errors: [{ message: 'Throttled' }] } })

    expect(await fetchAutomaticDiscounts(client(post))).toEqual({ success: false, error: 'Throttled' })
  })
})
