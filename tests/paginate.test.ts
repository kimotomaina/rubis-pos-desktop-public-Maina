/**
 * `paginate` / `pageOfIndex` (phase-141) — pure helpers, driven directly,
 * the way `checkoutMath.test.ts` and `posSearch.test.ts` are.
 */

import { describe, it, expect } from 'vitest'
import {
  LOCATIONS_PER_PAGE,
  pageOfIndex,
  paginate
} from '../src/renderer/src/lib/paginate.js'

/** 1-based labels, so a slice is readable in a failure message. */
function items(count: number): number[] {
  return Array.from({ length: count }, (_, i) => i + 1)
}

describe('paginate', () => {
  it('defaults to 9 per page', () => {
    expect(LOCATIONS_PER_PAGE).toBe(9)
    expect(paginate(items(20), 1).items).toHaveLength(9)
  })

  it('gives one empty page for an empty list, never "page 1 of 0"', () => {
    const result = paginate(items(0), 1)

    expect(result).toEqual({
      items: [],
      page: 1,
      pageCount: 1,
      hasPrev: false,
      hasNext: false
    })
  })

  it('puts one item on a single page with both ends reached', () => {
    const result = paginate(items(1), 1)

    expect(result.items).toEqual([1])
    expect(result.pageCount).toBe(1)
    expect(result.hasPrev).toBe(false)
    expect(result.hasNext).toBe(false)
  })

  it('fills exactly one page with 9 items, with no second page', () => {
    const result = paginate(items(9), 1)

    expect(result.items).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(result.pageCount).toBe(1)
    expect(result.hasNext).toBe(false)
  })

  it('spills the 10th item onto a second page', () => {
    expect(paginate(items(10), 1).pageCount).toBe(2)
    expect(paginate(items(10), 1).hasNext).toBe(true)
    expect(paginate(items(10), 2).items).toEqual([10])
    expect(paginate(items(10), 2).hasNext).toBe(false)
    expect(paginate(items(10), 2).hasPrev).toBe(true)
  })

  it('splits 27 items into exactly 3 full pages', () => {
    expect(paginate(items(27), 1).pageCount).toBe(3)
    expect(paginate(items(27), 2).items).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18])
    expect(paginate(items(27), 3).items).toEqual([19, 20, 21, 22, 23, 24, 25, 26, 27])
    expect(paginate(items(27), 3).hasNext).toBe(false)
  })

  it('splits 106 items into 12 pages, the last holding the remaining 7', () => {
    const first = paginate(items(106), 1)
    const last = paginate(items(106), 12)

    expect(first.pageCount).toBe(12)
    expect(first.items).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(first.hasPrev).toBe(false)
    expect(last.items).toEqual([100, 101, 102, 103, 104, 105, 106])
    expect(last.items).toHaveLength(7)
    expect(last.hasNext).toBe(false)
    expect(last.hasPrev).toBe(true)
  })

  it('clamps a page below 1 up to the first page', () => {
    for (const page of [0, -1, -999]) {
      expect(paginate(items(106), page).page).toBe(1)
      expect(paginate(items(106), page).items[0]).toBe(1)
    }
  })

  it('clamps a page past the end down to the last page', () => {
    expect(paginate(items(106), 13).page).toBe(12)
    expect(paginate(items(106), 999).items).toEqual([100, 101, 102, 103, 104, 105, 106])
  })

  it('clamps a non-finite page to the first page rather than returning nothing', () => {
    expect(paginate(items(20), Number.NaN).page).toBe(1)
    expect(paginate(items(20), Number.NaN).items).toHaveLength(9)
  })

  it('keeps the list order, and every item appears exactly once across the pages', () => {
    const all = items(106)
    const seen: number[] = []
    for (let page = 1; page <= 12; page += 1) seen.push(...paginate(all, page).items)

    expect(seen).toEqual(all)
  })

  it('honours a custom page size', () => {
    const result = paginate(items(10), 2, 4)

    expect(result.items).toEqual([5, 6, 7, 8])
    expect(result.pageCount).toBe(3)
  })

  it('never divides by a page size of zero or less', () => {
    expect(paginate(items(3), 1, 0).items).toEqual([1])
    expect(paginate(items(3), 1, -5).items).toEqual([1])
    expect(paginate(items(3), 1, 0).pageCount).toBe(3)
  })

  it('does not mutate the list it was given', () => {
    const all = items(10)
    paginate(all, 2)
    expect(all).toEqual(items(10))
  })
})

describe('pageOfIndex', () => {
  it('maps the first page of indexes to page 1', () => {
    for (const index of [0, 5, 8]) expect(pageOfIndex(index)).toBe(1)
  })

  it('maps index 9 to page 2, the first of the next page', () => {
    expect(pageOfIndex(9)).toBe(2)
    expect(pageOfIndex(17)).toBe(2)
    expect(pageOfIndex(18)).toBe(3)
  })

  it('finds the page of a location deep in a 106-long list', () => {
    expect(pageOfIndex(63)).toBe(8)
    expect(pageOfIndex(105)).toBe(12)
  })

  it('gives page 1 when nothing is selected (index -1)', () => {
    expect(pageOfIndex(-1)).toBe(1)
  })

  it('honours a custom page size', () => {
    expect(pageOfIndex(4, 4)).toBe(2)
  })
})
