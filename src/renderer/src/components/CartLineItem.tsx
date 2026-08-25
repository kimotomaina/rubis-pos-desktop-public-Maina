import { useState } from 'react'
import type { CartItem, Discount } from '../types/shopify'
import { formatCurrency } from '../lib/currency'
import {
  calculateLineTotal,
  requiresManagerPinForDiscount,
  validatePriceOverride
} from '../lib/checkoutMath'

interface CartLineItemProps {
  item: CartItem
  onUpdateQuantity: (id: string, qty: number) => void
  onRemove: (id: string) => void
  onSetPrice: (id: string, price: number) => void
  onSetDiscount: (id: string, discount: Discount | null) => void
  /** Opens the Manager PIN gate; calls `onAuthorized` once verified. */
  requestManagerPin: (title: string, onAuthorized: () => void) => void
  /** Shows a transient toast (e.g. a rejected price override — Phase 11). */
  showToast: (toast: { kind: 'success' | 'error'; message: string }) => void
}

/** Which inline editor, if any, is open for this line. */
type EditorState = 'none' | 'price' | 'discount'

/**
 * A single line in the cart sidebar — shows a thumbnail, title,
 * variant label, per-unit price, a `− / +` quantity control, the
 * (possibly discounted) line subtotal, and a remove affordance.
 *
 * Phase 10 adds two manager-gated editors: "Edit Price" (a raw
 * per-unit price override, always PIN-gated) and "Discount" (a
 * percent/fixed markdown, PIN-gated only above the 10% threshold —
 * see {@link requiresManagerPinForDiscount}).
 *
 * @param {CartLineItemProps} props
 * @returns {JSX.Element}
 */
export default function CartLineItem({
  item,
  onUpdateQuantity,
  onRemove,
  onSetPrice,
  onSetDiscount,
  requestManagerPin,
  showToast
}: CartLineItemProps) {
  const lineTotal = calculateLineTotal(item)
  const lineBase = item.price * item.quantity
  const discounted = lineTotal < lineBase

  const [editor, setEditor] = useState<EditorState>('none')
  const [priceInput, setPriceInput] = useState(String(item.price))
  const [discountType, setDiscountType] = useState<Discount['type']>('percent')
  const [discountValue, setDiscountValue] = useState('')

  const openPriceEditor = () => {
    setPriceInput(String(item.price))
    requestManagerPin(`Override price for ${item.title}`, () => setEditor('price'))
  }

  const savePrice = () => {
    const price = parseFloat(priceInput)
    const validation = validatePriceOverride(price, item.basePrice ?? item.price)
    if (!validation.valid) {
      showToast({ kind: 'error', message: validation.reason ?? 'Invalid price' })
      return
    }
    onSetPrice(item.id, price)
    setEditor('none')
  }

  const openDiscountEditor = () => {
    setDiscountValue(item.discount ? String(item.discount.value) : '')
    setDiscountType(item.discount?.type ?? 'percent')
    setEditor('discount')
  }

  const applyDiscountEdit = () => {
    const value = parseFloat(discountValue)
    if (!Number.isFinite(value) || value <= 0) {
      onSetDiscount(item.id, null)
      setEditor('none')
      return
    }
    const discount: Discount = { type: discountType, value }
    const apply = () => {
      onSetDiscount(item.id, discount)
      setEditor('none')
    }
    if (requiresManagerPinForDiscount(discount, lineBase)) {
      requestManagerPin(`Discount over 10% for ${item.title}`, apply)
    } else {
      apply()
    }
  }

  return (
    <div className="pb-3 last:border-0 last:pb-0">
      <div className="flex items-center gap-3">
        <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg bg-slate-100">
          {item.image ? (
            <img
              src={item.image}
              alt={item.variantTitle}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-slate-200">
              <span className="text-sm font-bold text-slate-500">
                {item.variantTitle.slice(0, 2).toUpperCase()}
              </span>
            </div>
          )}
        </div>

        <div className="flex-1">
          <p className="text-sm font-medium text-slate-900 line-clamp-1">
            {item.title}
          </p>
          <p className="text-xs text-slate-500">{item.variantTitle}</p>
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              onClick={openPriceEditor}
              className="text-xs font-medium text-slate-400 hover:text-rose-600"
            >
              Edit Price
            </button>
            <button
              type="button"
              onClick={openDiscountEditor}
              className="text-xs font-medium text-slate-400 hover:text-rose-600"
            >
              Discount
            </button>
          </div>
        </div>

        <div className="flex flex-col items-end gap-1">
          <span className="text-xs text-slate-500">
            {formatCurrency(item.price)} × {item.quantity}
          </span>
          <span
            className={`text-sm font-semibold ${discounted ? 'text-emerald-600' : 'text-slate-900'}`}
          >
            {formatCurrency(lineTotal)}
          </span>
          {discounted && (
            <span className="text-[10px] text-slate-400 line-through">
              {formatCurrency(lineBase)}
            </span>
          )}
        </div>

        <div className="flex flex-col items-center">
          <button
            type="button"
            onClick={() => onUpdateQuantity(item.id, item.quantity - 1)}
            className="rounded-t-lg border border-slate-200 px-2 py-1 text-sm font-semibold text-slate-700 hover:bg-slate-100 active:scale-90"
            aria-label={`Decrease ${item.variantTitle} quantity`}
          >
            −
          </button>
          <span className="px-2 text-sm font-medium text-slate-900">
            {item.quantity}
          </span>
          <button
            type="button"
            onClick={() => onUpdateQuantity(item.id, item.quantity + 1)}
            className="rounded-b-lg border border-t-0 border-slate-200 px-2 py-1 text-sm font-semibold text-slate-700 hover:bg-slate-100 active:scale-90"
            aria-label={`Increase ${item.variantTitle} quantity`}
          >
            +
          </button>
        </div>

        <button
          type="button"
          onClick={() => onRemove(item.id)}
          className="text-xs text-slate-400 hover:text-rose-600"
          aria-label={`Remove ${item.variantTitle}`}
        >
          ✕
        </button>
      </div>

      {editor === 'price' && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-slate-50 p-2">
          <input
            type="number"
            min="0"
            step="0.01"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            autoFocus
            className="w-24 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-rose-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={savePrice}
            className="text-xs font-medium text-rose-600 hover:text-rose-700"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditor('none')}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            Cancel
          </button>
        </div>
      )}

      {editor === 'discount' && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-slate-50 p-2">
          <select
            value={discountType}
            onChange={(e) => setDiscountType(e.target.value as Discount['type'])}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-rose-400 focus:outline-none"
          >
            <option value="percent">%</option>
            <option value="fixed">Ksh</option>
          </select>
          <input
            type="number"
            min="0"
            step="0.01"
            value={discountValue}
            onChange={(e) => setDiscountValue(e.target.value)}
            autoFocus
            className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-rose-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={applyDiscountEdit}
            className="text-xs font-medium text-rose-600 hover:text-rose-700"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => setEditor('none')}
            className="text-xs text-slate-500 hover:text-slate-700"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
