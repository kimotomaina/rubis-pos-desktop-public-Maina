/**
 * Pure pagination helpers — kept framework-free (no React import) so
 * they can be unit tested without mounting the component tree, the same
 * way `checkoutMath.ts` and `posSearch.ts` are.
 *
 * Written for the location picker, which shows 9 cards (3 × 3) per page
 * out of a list that can run past 100 entries, but there is nothing
 * location-specific here.
 */

/** Locations per page in the picker: a 3-column grid, 3 rows deep. */
export const LOCATIONS_PER_PAGE = 9

/** One page of a list, plus everything the page controls need to render. */
export interface PaginatedResult<T> {
  items: T[]
  /** The page actually shown — the requested page clamped into range. */
  page: number
  /** Always at least 1, so an empty list still reads "Page 1 of 1" rather than "of 0". */
  pageCount: number
  hasPrev: boolean
  hasNext: boolean
}

/**
 * Slices `items` into the requested page.
 *
 * The requested page is clamped rather than rejected: a page below 1, a
 * page past the end, and a non-finite page all resolve to a real page, so
 * a caller holding a stale page number after the list shrinks still
 * renders something instead of an empty grid.
 *
 * @param {T[]} items
 * @param {number} page — 1-based
 * @param {number} [pageSize = LOCATIONS_PER_PAGE]
 * @returns {PaginatedResult<T>}
 */
export function paginate<T>(
  items: T[],
  page: number,
  pageSize: number = LOCATIONS_PER_PAGE
): PaginatedResult<T> {
  const size = Math.max(1, Math.floor(pageSize) || 1)
  const pageCount = Math.max(1, Math.ceil(items.length / size))
  const requested = Math.floor(page) || 1
  const current = Math.min(Math.max(requested, 1), pageCount)
  const start = (current - 1) * size

  return {
    items: items.slice(start, start + size),
    page: current,
    pageCount,
    hasPrev: current > 1,
    hasNext: current < pageCount
  }
}

/**
 * Which page holds the item at `index`. Used to open the picker on the
 * page of the already-selected location instead of always on page 1 —
 * with 106 locations, page 1 would hide the current choice.
 *
 * An index of -1 (nothing selected, or a selection absent from the list)
 * gives page 1.
 *
 * @param {number} index
 * @param {number} [pageSize = LOCATIONS_PER_PAGE]
 * @returns {number} 1-based page
 */
export function pageOfIndex(index: number, pageSize: number = LOCATIONS_PER_PAGE): number {
  const size = Math.max(1, Math.floor(pageSize) || 1)
  return index < 0 ? 1 : Math.floor(index / size) + 1
}
