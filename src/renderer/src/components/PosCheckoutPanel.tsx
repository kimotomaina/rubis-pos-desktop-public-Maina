import { useEffect, useState } from 'react'
import { useCartStore } from '../stores/cartStore.js'
import { useAuthStore } from '../stores/authStore.js'
import { calculateChange, canCompleteSale, requiresManagerPinForDiscount } from '../lib/checkoutMath.js'
import { formatCurrency } from '../lib/currency.js'
import { isValidKraPinFormat, KRA_PIN_MAX_LENGTH } from '../lib/kraPin.js'
import { useKeyboardStore } from '../stores/keyboardStore.js'
import PaymentModal from './PaymentModal.js'
import type { ManualMpesaEntryInput } from './PaymentModal.js'
import VirtualNumpad from './VirtualNumpad.js'
import type { PaymentMethod } from '../../../main/services/database.js'
import type { Discount } from '../types/shopify.js'

interface PosCheckoutPanelProps {
  /** Opens the Manager PIN gate; calls `onAuthorized` once verified. */
  requestManagerPin: (
    title: string,
    onAuthorized: (managerId: number, managerPin: string) => void
  ) => void
}

/**
 * Quick payment method this panel exposes as a one-tap toggle. Card
 * payments remain fully supported by the cart store/checkout IPC —
 * see this file's doc comment — just not surfaced as a third button
 * here, per Phase 44's Hick's-Law "reduce choices" instruction.
 */
type QuickPaymentMethod = Extract<PaymentMethod, 'cash' | 'mpesa'>

/**
 * Always-visible checkout control panel — the fast-checkout layout's
 * right zone, replacing the old cart-sidebar's totals/checkout button
 * entirely for Cash/M-Pesa sales.
 *
 * Cash and M-Pesa are deliberately the only two quick-toggle options
 * (Hick's Law: fewer choices, faster decisions) — a Card sale still
 * works through the underlying `cartStore.checkout`/`PaymentMethod`
 * contract, which is untouched, it just has no dedicated button here.
 *
 * The M-Pesa branch embeds the existing `PaymentModal` verbatim rather
 * than reimplementing a keypad-driven phone entry: `PaymentModal`
 * already owns the full STK Push → poll-for-confirmation → "Waiting
 * for M-Pesa Confirmation" countdown → retry/cancel flow built over
 * Phases 38–41, and a checkout is only ever recorded once that flow's
 * `onPaid` actually fires. A bare phone-number keypad with an
 * unconditional "Complete Sale" button would record a sale as M-Pesa
 * before Safaricom ever confirmed payment — reusing `PaymentModal`
 * is what keeps that guarantee intact.
 *
 * @param {PosCheckoutPanelProps} props
 * @returns {JSX.Element}
 */
export default function PosCheckoutPanel({ requestManagerPin }: PosCheckoutPanelProps) {
  const cartSubtotal = useCartStore((state) => state.getSubtotal())
  const cartTotal = useCartStore((state) => state.getTotal())
  const cartCount = useCartStore((state) => state.getItemCount())
  const cartDiscount = useCartStore((state) => state.cartDiscount)
  const setCartDiscount = useCartStore((state) => state.setCartDiscount)
  const checkout = useCartStore((state) => state.checkout)
  const checkoutStatus = useCartStore((state) => state.checkoutStatus)
  const checkoutError = useCartStore((state) => state.checkoutError)
  const resetCheckoutStatus = useCartStore((state) => state.resetCheckoutStatus)
  const currentStaff = useAuthStore((state) => state.currentStaff)

  const [method, setMethod] = useState<QuickPaymentMethod>('cash')
  const [tenderedInput, setTenderedInput] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [customerPin, setCustomerPin] = useState('')
  const [editingPin, setEditingPin] = useState(false)
  const [showDiscountEditor, setShowDiscountEditor] = useState(false)
  const [discountType, setDiscountType] = useState<Discount['type']>('percent')
  const [discountValue, setDiscountValue] = useState('')

  /** Routes a cart-level discount edit through the Manager PIN gate above the 10% threshold, matching `CartLineItem`'s per-line rule. */
  const applyCartDiscount = () => {
    const value = parseFloat(discountValue)
    if (!Number.isFinite(value) || value <= 0) {
      setCartDiscount(null)
      setShowDiscountEditor(false)
      return
    }
    const discount: Discount = { type: discountType, value }
    const apply = () => {
      setCartDiscount(discount)
      setShowDiscountEditor(false)
    }
    if (requiresManagerPinForDiscount(discount, cartSubtotal)) {
      requestManagerPin('Cart discount over 10%', apply)
    } else {
      apply()
    }
  }

  /**
   * A successful/queued checkout has nothing left to confirm in this
   * always-visible panel (there's no modal to close) — reset the
   * transient inputs and the store's terminal status back to idle so
   * the panel is ready for the next sale.
   */
  useEffect(() => {
    if (checkoutStatus === 'synced' || checkoutStatus === 'queued-offline') {
      setTenderedInput('')
      setCompanyName('')
      setCustomerPin('')
      setMethod('cash')
      resetCheckoutStatus()
    }
  }, [checkoutStatus, resetCheckoutStatus])

  const tenderedAmount = parseFloat(tenderedInput) || 0
  const changeDue = calculateChange(cartTotal, tenderedAmount)
  const trimmedCompanyName = companyName.trim()
  const trimmedCustomerPin = customerPin.trim()
  const customerPinError =
    trimmedCustomerPin.length > 0 && !isValidKraPinFormat(trimmedCustomerPin)
      ? 'Not a valid KRA PIN format (e.g. P051234567Z).'
      : null

  const canSubmitCash =
    cartCount > 0 && canCompleteSale('cash', cartTotal, tenderedAmount) && checkoutStatus !== 'submitting'

  const handleCompleteCashSale = () => {
    if (!currentStaff) return
    void checkout({
      staffId: currentStaff.id,
      paymentMethod: 'cash',
      tenderedAmount,
      changeDue,
      customerPin: trimmedCustomerPin || undefined,
      companyName: trimmedCompanyName || undefined
    })
  }

  /**
   * Called by the embedded `PaymentModal` once Daraja actually confirms
   * the M-Pesa payment — never on mere STK Push acceptance.
   */
  const handleMpesaPaid = (referenceNumber: string, manual?: ManualMpesaEntryInput) => {
    if (!currentStaff) return
    void checkout({
      staffId: currentStaff.id,
      paymentMethod: 'mpesa',
      tenderedAmount: cartTotal,
      changeDue: 0,
      referenceNumber,
      customerPin: trimmedCustomerPin || undefined,
      companyName: trimmedCompanyName || undefined,
      mpesaManual: manual
    })
  }

  return (
    <div className="flex h-full flex-col bg-white">
      {/**
       * The customer row and the TOTAL block's header line used to be two
       * separate bordered sections (phase-142/146: ~57px + ~101px). They
       * share one now — "TOTAL" / the customer summary (tap to edit) /
       * "+ Discount" all on one line — closing most of the checkout
       * aside's ~150-158px shortfall against the 1366x772 design box
       * without touching either action's own behavior.
       */}
      <div className="border-b border-slate-200 bg-slate-50 p-3">
        {editingPin ? (
          <div className="mb-1 flex flex-col gap-2">
            <input
              type="text"
              value={companyName}
              readOnly
              onClick={() =>
                useKeyboardStore.getState().open({
                  value: companyName,
                  onChange: setCompanyName,
                  label: 'Company Name'
                })
              }
              placeholder="Enter Company Name (Optional)"
              aria-label="Company Name"
              className="h-11 w-full rounded-lg border border-slate-300 px-3 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
            />
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={customerPin}
                readOnly
                onClick={() =>
                  useKeyboardStore.getState().open({
                    value: customerPin,
                    onChange: (next) => setCustomerPin(next.toUpperCase()),
                    maxLength: KRA_PIN_MAX_LENGTH,
                    label: 'Customer KRA PIN'
                  })
                }
                maxLength={KRA_PIN_MAX_LENGTH}
                placeholder="P051234567Z"
                aria-label="Customer KRA PIN"
                className="h-11 flex-1 rounded-lg border border-slate-300 px-3 text-lg uppercase focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
              />
              <button
                type="button"
                onClick={() => setEditingPin(false)}
                className="h-11 rounded-lg bg-rose-600 px-4 text-base font-semibold text-white hover:bg-rose-700"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="shrink-0 text-base font-medium text-slate-500">TOTAL</p>
            <button
              type="button"
              onClick={() => setEditingPin(true)}
              className="min-w-0 flex-1 truncate text-center text-sm font-medium text-slate-600 hover:text-rose-600"
            >
              {trimmedCustomerPin || trimmedCompanyName
                ? `${trimmedCustomerPin || 'Walk-in'}${trimmedCompanyName ? ` · ${trimmedCompanyName}` : ''} · Edit Details`
                : 'Walk-in · Add KRA PIN'}
            </button>
            <button
              type="button"
              onClick={() => {
                setDiscountValue(cartDiscount ? String(cartDiscount.value) : '')
                setDiscountType(cartDiscount?.type ?? 'percent')
                setShowDiscountEditor((prev) => !prev)
              }}
              className="shrink-0 text-sm font-medium text-slate-500 hover:text-rose-600"
            >
              {cartDiscount ? 'Edit Discount' : '+ Discount'}
            </button>
          </div>
        )}
        {customerPinError && <p className="mb-1 text-sm font-medium text-rose-600">{customerPinError}</p>}
        {cartDiscount && (
          <p className="mb-1 flex justify-between text-sm text-slate-500">
            <span>Subtotal</span>
            <span>{formatCurrency(cartSubtotal)}</span>
          </p>
        )}
        <p className="text-3xl font-extrabold tabular-nums text-slate-900">{formatCurrency(cartTotal)}</p>

        {showDiscountEditor && (
          <div className="mt-2 flex items-center gap-2 rounded-lg bg-white p-2">
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
              onClick={() =>
                useKeyboardStore
                  .getState()
                  .open({ value: discountValue, onChange: setDiscountValue, label: 'Discount amount', mode: 'decimal' })
              }
              onFocus={() =>
                useKeyboardStore
                  .getState()
                  .open({ value: discountValue, onChange: setDiscountValue, label: 'Discount amount', mode: 'decimal' })
              }
              autoFocus
              aria-label="Discount amount"
              className="h-11 w-24 rounded-md border border-slate-300 px-2 text-lg focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
            />
            <button
              type="button"
              onClick={applyCartDiscount}
              className="text-sm font-medium text-rose-600 hover:text-rose-700"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={() => setShowDiscountEditor(false)}
              className="text-sm text-slate-500 hover:text-slate-700"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {/**
       * At the exact worst-case window (1366x768 @150%, the smallest this
       * app supports) the tightening above alone left zero measured
       * slack against the 1366x772 box — a real pass, but not the >= 8px
       * margin the spec asks to stop at. `p-2` (was `p-3`) and `mb-2`
       * (was `mb-3`, below) reclaim 12px of comfortable margin.
       */}
      <div className="flex-1 overflow-hidden p-2">
        <div className="mb-2 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setMethod('cash')}
            className={`h-14 rounded-xl text-xl font-bold transition active:scale-95 ${
              method === 'cash'
                ? 'bg-rose-600 text-white shadow'
                : 'border border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            CASH
          </button>
          <button
            type="button"
            onClick={() => setMethod('mpesa')}
            className={`h-14 rounded-xl text-xl font-bold transition active:scale-95 ${
              method === 'mpesa'
                ? 'bg-rose-600 text-white shadow'
                : 'border border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
          >
            M-PESA
          </button>
        </div>

        {method === 'cash' ? (
          <div>
            {/**
             * Amount Tendered's label and its display used to stack on
             * separate lines (phase-142: ~96px together); one row, label
             * left and a smaller display right, saves roughly half that
             * without hiding either piece of information.
             */}
            <div className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-slate-100 px-3 py-2">
              <span className="text-base font-medium text-slate-600">Amount Tendered</span>
              <span className="text-xl font-mono">Ksh {tenderedInput || '0'}</span>
            </div>
            <div className="mb-2 flex justify-between text-base font-medium">
              <span className="text-slate-600">Change Due</span>
              <span className={changeDue > 0 ? 'text-emerald-600' : 'text-slate-400'}>
                {formatCurrency(changeDue)}
              </span>
            </div>
            {tenderedAmount > 0 && tenderedAmount < cartTotal && (
              <p className="mb-2 text-base font-medium text-rose-600">Insufficient amount</p>
            )}
            <VirtualNumpad value={tenderedInput} onChange={setTenderedInput} size="compact" />

            <button
              type="button"
              disabled={!canSubmitCash}
              onClick={handleCompleteCashSale}
              className="mt-3 h-16 w-full rounded-xl bg-rose-600 text-2xl font-extrabold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checkoutStatus === 'submitting' ? 'PROCESSING…' : 'COMPLETE SALE'}
            </button>
          </div>
        ) : (
          <PaymentModal total={cartTotal} onPaid={handleMpesaPaid} onCancel={() => setMethod('cash')} />
        )}

        {checkoutStatus === 'error' && (
          <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
            {checkoutError ?? 'Checkout failed'}
          </p>
        )}
      </div>
    </div>
  )
}
