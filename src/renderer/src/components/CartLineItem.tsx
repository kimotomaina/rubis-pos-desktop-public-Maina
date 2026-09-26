import { useState } from 'react'
import type { CartItem, Discount } from '../types/shopify.js'
import { formatCurrency } from '../lib/currency.js'
import {
  calculateLineTotal,
  requiresManagerPinForDiscount,
  validatePriceOverride
} from '../lib/checkoutMath.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'
import { useFiscalModeStore } from '../stores/fiscalModeStore.js'
import { TrashIcon } from './icons.js'

interface CartLineItemProps {
  item: CartItem
  onUpdateQuantity: (id: string, qty: number) => void
  onRemove: (id: string) => void
  onSetPrice: (id: string, price: number) => void
  onSetDiscount: (id: string, discount: Discount | null) => void
  /** Opens the Manager PIN gate; calls `onAuthorized` once verified. */
  requestManagerPin: (
    title: string,
    onAuthorized: (managerId: number, managerPin: string) => void
  ) => void
  /** Shows a transient toast (e.g. a rejected price override). */
  showToast: (toast: { kind: 'success' | 'error'; message: string }) => void
}

/** Which inline editor, if any, is open for this line. */
type EditorState = 'none' | 'price' | 'discount'

/**
 * A single line in the cart sidebar — shows a thumbnail, title,
 * variant label, per-unit price, a `− / +` quantity control, the
 * (possibly discounted) line subtotal, and a remove affordance.
 *
 * Includes two manager-gated editors: "Edit Price" (a raw per-unit
 * price override, always PIN-gated) and "Discount" (a percent/fixed
 * markdown, PIN-gated only above the 10% threshold — see
 * {@link requiresManagerPinForDiscount}).
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
  /**
   * Interim safeguard (docs/phase-160/161): the fiscal device and both
   * receipt renderers are told the raw, undiscounted price, so a new
   * price override or line discount would be filed and printed wrong
   * once this till is live. Hides the controls that create one; an
   * override/discount already on the cart when this flips true is
   * blocked from checkout by `PosCheckoutPanel`, not silently dropped.
   */
  const fiscalLive = useFiscalModeStore((state) => state.fiscalLive)

  const [editor, setEditor] = useState<EditorState>('none')
  const [priceInput, setPriceInput] = useState(String(item.price))
  const [discountType, setDiscountType] = useState<Discount['type']>('percent')
  const [discountValue, setDiscountValue] = useState('')

  const openPriceEditor = () => {
    setPriceInput(String(item.price))
    requestManagerPin(`Override price for ${item.title}`, () => setEditor('price'))
  }

  /** Opens the shared on-screen keyboard for the price override, decimal mode (a currency amount). */
  const openPriceKeyboard = () =>
    useKeyboardStore.getState().open({ value: priceInput, onChange: setPriceInput, label: 'New price', mode: 'decimal' })

  /** Opens the shared on-screen keyboard for the discount value, decimal mode (a percent or a KES amount, both possibly fractional). */
  const openDiscountKeyboard = () =>
    useKeyboardStore
      .getState()
      .open({ value: discountValue, onChange: setDiscountValue, label: 'Discount amount', mode: 'decimal' })

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
    <div className="flex flex-col border-b border-slate-100 py-3 last:border-0">
      <div className="flex">
        <div className="h-16 w-16 shrink-0 overflow-hidden rounded bg-slate-50">
          {item.image ? (
            <img
              src={item.image}
              alt={item.variantTitle}
              className="h-full w-full object-contain"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-slate-200">
              <span className="text-base font-bold text-slate-500">
                {item.variantTitle.slice(0, 2).toUpperCase()}
              </span>
            </div>
          )}
        </div>

        <div className="ml-3 flex min-w-0 flex-1 flex-col">
          <p className="line-clamp-2 text-base font-semibold text-slate-900">
            {item.title}
          </p>
          <p className="mt-0.5 text-sm text-slate-600">{item.variantTitle}</p>
          <p className="mt-0.5 text-sm text-slate-500">{formatCurrency(item.price)} each</p>
          {!fiscalLive && (
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={openPriceEditor}
                className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-200"
              >
                Edit Price
              </button>
              <button
                type="button"
                onClick={openDiscountEditor}
                className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-200"
              >
                Discount
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center">
        <div className="flex flex-1 flex-col">
          <span
            className={`text-lg font-bold ${discounted ? 'text-emerald-600' : 'text-slate-900'}`}
          >
            {formatCurrency(lineTotal)}
          </span>
          {discounted && (
            <span className="text-xs text-slate-400 line-through">
              {formatCurrency(lineBase)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onUpdateQuantity(item.id, item.quantity - 1)}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-xl font-bold text-slate-700 hover:bg-slate-200 active:scale-90"
            aria-label={`Decrease ${item.variantTitle} quantity`}
          >
            −
          </button>
          <span className="w-8 text-center text-lg font-bold text-slate-900">
            {item.quantity}
          </span>
          <button
            type="button"
            onClick={() => onUpdateQuantity(item.id, item.quantity + 1)}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-xl font-bold text-slate-700 hover:bg-slate-200 active:scale-90"
            aria-label={`Increase ${item.variantTitle} quantity`}
          >
            +
          </button>
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            className="ml-2 flex h-10 w-10 items-center justify-center rounded-full bg-red-100 hover:bg-red-200"
            aria-label={`Remove ${item.variantTitle}`}
          >
            <TrashIcon className="h-5 w-5 text-red-600" />
          </button>
        </div>
      </div>

      {editor === 'price' && (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-slate-50 p-2">
          <input
            type="text"
            readOnly
            value={priceInput}
            onClick={openPriceKeyboard}
            onFocus={openPriceKeyboard}
            autoFocus
            aria-label="New price"
            className="h-11 w-28 rounded-md border border-slate-300 px-2 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
          />
          <button
            type="button"
            onClick={savePrice}
            className="text-sm font-medium text-rose-600 hover:text-rose-700"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditor('none')}
            className="text-sm text-slate-500 hover:text-slate-700"
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
            className="h-11 rounded-md border border-slate-300 px-2 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
          >
            <option value="percent">%</option>
            <option value="fixed">Ksh</option>
          </select>
          <input
            type="text"
            readOnly
            value={discountValue}
            onClick={openDiscountKeyboard}
            onFocus={openDiscountKeyboard}
            autoFocus
            aria-label="Discount amount"
            className="h-11 w-24 rounded-md border border-slate-300 px-2 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
          />
          <button
            type="button"
            onClick={applyDiscountEdit}
            className="text-sm font-medium text-rose-600 hover:text-rose-700"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => setEditor('none')}
            className="text-sm text-slate-500 hover:text-slate-700"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
