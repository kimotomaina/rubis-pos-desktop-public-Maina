import { useEffect, useState } from 'react'
import type { CartItem } from '../types/shopify.js'
import { formatCurrency } from '../lib/currency.js'
import { calculateLineTotal } from '../lib/checkoutMath.js'
import { CartIcon, TrashIcon } from './icons.js'
import { pageOfIndex, paginate } from '../lib/paginate.js'
import Pager from './Pager.js'

/** Cart lines per page (docs/phase-166 Commit E4) — replaces the table's old internal scroll. */
export const CART_LINES_PER_PAGE = 7

interface PosCartTableProps {
  items: CartItem[]
  onUpdateQuantity: (id: string, qty: number) => void
  onRemove: (id: string) => void
  /** Clears the whole cart; the caller asks for a manager first (docs/phase-197). Omitted, no button is shown. */
  onClear?: () => void
  /** Variant id of the line most recently added via search/scan — briefly highlighted, then cleared by the caller. */
  flashId?: string | null
  /** Parks the cart (docs/phase-217). Omitted, no Hold button is shown. */
  onHold?: () => void
  /** Why Hold is unavailable right now, or `null` when it is allowed; shown beside the disabled button. */
  holdBlockedReason?: string | null
  /** Lines per page; one fewer while the held-sales strip is showing, so the table keeps its height (docs/phase-217). */
  linesPerPage?: number
}

/**
 * Dense, paginated cart table for the fast-checkout layout — replaces
 * the old card-per-item cart sidebar. Every action button is at least
 * 44×44px (`h-11 w-11`) for a reliable touch target, and rows
 * alternate background color (zebra striping) for scanability at a
 * glance on a long ticket.
 *
 * Paginated at {@link CART_LINES_PER_PAGE} (docs/phase-166 Commit E4,
 * replacing the table's old internal scroll — Phase E's no-scroll
 * rule). Adding or scanning a line jumps to the page holding it;
 * removing the only line left on a page steps back a page automatically
 * (both via `paginate`'s own clamping, same as `LocationPicker`).
 *
 * @param {PosCartTableProps} props
 * @returns {JSX.Element}
 */
export default function PosCartTable({
  items,
  onUpdateQuantity,
  onRemove,
  onClear,
  flashId,
  onHold,
  holdBlockedReason = null,
  linesPerPage = CART_LINES_PER_PAGE
}: PosCartTableProps) {
  const [page, setPage] = useState(1)
  const pageResult = paginate(items, page, linesPerPage)

  /**
   * Jumps to the page holding the line most recently added/scanned
   * (docs/phase-166 Commit E4) — `items` is deliberately left out of the
   * dependency list: this should fire only when a NEW flash starts, not
   * on every incidental cart mutation (e.g. a quantity tweak) while a
   * flash from a moment ago is still technically active, which would
   * otherwise snap the cashier back to that line mid-navigation.
   */
  useEffect(() => {
    if (!flashId) return
    const index = items.findIndex((item) => item.id === flashId)
    if (index === -1) return
    setPage(pageOfIndex(index, linesPerPage))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flashId])

  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-12 text-center text-slate-400">
        <CartIcon className="h-10 w-10" />
        <p className="text-lg font-medium">Cart is empty. Scan an item to begin.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col">
      <table className="w-full border-collapse text-left">
        <thead className="bg-slate-100 text-sm font-semibold uppercase text-slate-500">
          <tr>
            <th className="px-4 py-2">Product</th>
            <th className="px-2 py-2 text-center">Qty</th>
            <th className="px-2 py-2 text-right">Price</th>
            <th className="px-2 py-2 text-right">Total</th>
            <th className="px-4 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {pageResult.items.map((item, index) => (
            <tr
              key={item.id}
              className={`border-b border-slate-100 transition-colors duration-700 ${
                item.id === flashId ? 'bg-emerald-100' : index % 2 === 1 ? 'bg-slate-50' : 'bg-white'
              }`}
            >
              <td className="max-w-0 px-4 py-3">
                <p className="truncate text-lg font-semibold uppercase text-slate-900">{item.title}</p>
                <p className="truncate text-sm text-slate-500">{item.variantTitle}</p>
              </td>
              <td className="px-2 py-3 text-center text-2xl font-bold tabular-nums text-slate-900">
                {item.quantity}
              </td>
              <td className="px-2 py-3 text-right text-base text-slate-600">
                {formatCurrency(item.price)}
              </td>
              <td className="px-2 py-3 text-right text-lg font-bold text-slate-900">
                {formatCurrency(calculateLineTotal(item))}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => onUpdateQuantity(item.id, item.quantity - 1)}
                    aria-label={`Decrease ${item.variantTitle} quantity`}
                    className="flex h-11 w-11 items-center justify-center rounded-lg bg-slate-100 text-2xl font-bold text-slate-700 hover:bg-slate-200 active:scale-90"
                  >
                    −
                  </button>
                  <button
                    type="button"
                    onClick={() => onUpdateQuantity(item.id, item.quantity + 1)}
                    aria-label={`Increase ${item.variantTitle} quantity`}
                    className="flex h-11 w-11 items-center justify-center rounded-lg bg-slate-100 text-2xl font-bold text-slate-700 hover:bg-slate-200 active:scale-90"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemove(item.id)}
                    aria-label={`Remove ${item.variantTitle}`}
                    className="flex h-11 w-11 items-center justify-center rounded-lg bg-rose-100 hover:bg-rose-200 active:scale-90"
                  >
                    <TrashIcon className="h-5 w-5 text-rose-600" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              className="h-9 shrink-0 rounded-lg border border-rose-200 px-3 text-sm font-medium text-rose-700 hover:bg-rose-50"
            >
              Clear cart
            </button>
          )}
          {onHold && (
            <button
              type="button"
              onClick={onHold}
              disabled={holdBlockedReason !== null}
              className="h-9 shrink-0 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Hold sale
            </button>
          )}
          {onHold && holdBlockedReason !== null && (
            <span className="min-w-0 truncate text-sm text-amber-800" title={holdBlockedReason}>
              {holdBlockedReason}
            </span>
          )}
        </div>
        <Pager page={pageResult.page} pageCount={pageResult.pageCount} onChange={setPage} />
      </div>
    </div>
  )
}
