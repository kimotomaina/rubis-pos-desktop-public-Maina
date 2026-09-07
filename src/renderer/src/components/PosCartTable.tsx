import type { CartItem } from '../types/shopify.js'
import { formatCurrency } from '../lib/currency.js'
import { calculateLineTotal } from '../lib/checkoutMath.js'
import { CartIcon, TrashIcon } from './icons.js'

interface PosCartTableProps {
  items: CartItem[]
  onUpdateQuantity: (id: string, qty: number) => void
  onRemove: (id: string) => void
  /** Variant id of the line most recently added via search/scan — briefly highlighted, then cleared by the caller. */
  flashId?: string | null
}

/**
 * Dense, scrollable cart table for the fast-checkout layout — replaces
 * the old card-per-item cart sidebar. Every action button is at least
 * 44×44px (`h-11 w-11`) for a reliable touch target, and rows
 * alternate background color (zebra striping) for scanability at a
 * glance on a long ticket.
 *
 * @param {PosCartTableProps} props
 * @returns {JSX.Element}
 */
export default function PosCartTable({ items, onUpdateQuantity, onRemove, flashId }: PosCartTableProps) {
  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-12 text-center text-slate-400">
        <CartIcon className="h-10 w-10" />
        <p className="text-lg font-medium">Cart is empty. Scan an item to begin.</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 z-10 bg-slate-100 text-sm font-semibold uppercase text-slate-500">
          <tr>
            <th className="px-4 py-2">Product</th>
            <th className="px-2 py-2 text-center">Qty</th>
            <th className="px-2 py-2 text-right">Price</th>
            <th className="px-2 py-2 text-right">Total</th>
            <th className="px-4 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
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
    </div>
  )
}
