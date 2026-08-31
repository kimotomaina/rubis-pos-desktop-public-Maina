import { useEffect, useState } from 'react'
import { useCartStore } from '../stores/cartStore'
import { useAuthStore } from '../stores/authStore'
import { calculateChange, canCompleteSale } from '../lib/checkoutMath'
import { formatCurrency } from '../lib/currency'
import { isValidKraPinFormat, KRA_PIN_MAX_LENGTH } from '../lib/kraPin'
import PaymentModal from './PaymentModal'
import type { PaymentMethod } from '../../../main/services/database.js'
import { CloseIcon } from './icons'
import VirtualNumpad from './VirtualNumpad'

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  mpesa: 'M-Pesa',
  card: 'Card'
}

interface CheckoutModalProps {
  onClose: () => void
}

/**
 * Payment-method + tender/reference collection modal, shown when the
 * cashier taps "Checkout" with a non-empty cart.
 *
 * Cash shows a numpad for "Amount Tendered" with a live "Change Due";
 * M-Pesa/Card show a reference-number field instead. "Complete Sale"
 * stays disabled until {@link canCompleteSale} is satisfied.
 *
 * @param {CheckoutModalProps} props
 * @returns {JSX.Element}
 */
export default function CheckoutModal({ onClose }: CheckoutModalProps) {
  const cartTotal = useCartStore((state) => state.getTotal())
  const checkout = useCartStore((state) => state.checkout)
  const checkoutStatus = useCartStore((state) => state.checkoutStatus)
  const checkoutError = useCartStore((state) => state.checkoutError)
  const resetCheckoutStatus = useCartStore((state) => state.resetCheckoutStatus)
  const currentStaff = useAuthStore((state) => state.currentStaff)

  const [method, setMethod] = useState<PaymentMethod | null>(null)
  const [tenderedInput, setTenderedInput] = useState('')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [customerPin, setCustomerPin] = useState('')

  const tenderedAmount = parseFloat(tenderedInput) || 0
  const changeDue = calculateChange(cartTotal, tenderedAmount)
  const trimmedCustomerPin = customerPin.trim()
  const customerPinError =
    trimmedCustomerPin.length > 0 && !isValidKraPinFormat(trimmedCustomerPin)
      ? 'This doesn’t look like a valid KRA PIN (e.g. P051234567Z) — double-check it, or leave it blank for a walk-in receipt.'
      : null

  useEffect(() => {
    if (checkoutStatus === 'synced' || checkoutStatus === 'queued-offline') {
      onClose()
      resetCheckoutStatus()
    }
  }, [checkoutStatus, onClose, resetCheckoutStatus])

  const handleAmountKey = (key: string) => {
    if (key === '⌫') {
      setTenderedInput((prev) => prev.slice(0, -1))
      return
    }
    if (key === '.' && tenderedInput.includes('.')) return
    setTenderedInput((prev) => prev + key)
  }

  const handleSubmit = () => {
    if (!method || !currentStaff) return
    void checkout({
      staffId: currentStaff.id,
      paymentMethod: method,
      tenderedAmount: method === 'cash' ? tenderedAmount : cartTotal,
      changeDue: method === 'cash' ? changeDue : 0,
      referenceNumber: method === 'cash' ? undefined : referenceNumber.trim(),
      customerPin: trimmedCustomerPin || undefined
    })
  }

  /**
   * Called by {@link PaymentModal} once M-Pesa payment is confirmed
   * (STK Push approved or a transaction code verified) — checks out
   * immediately rather than waiting for a separate "Complete Sale"
   * tap, since the payment step already required explicit confirmation.
   */
  const handleMpesaPaid = (mpesaReference: string) => {
    if (!currentStaff) return
    setReferenceNumber(mpesaReference)
    void checkout({
      staffId: currentStaff.id,
      paymentMethod: 'mpesa',
      tenderedAmount: cartTotal,
      changeDue: 0,
      referenceNumber: mpesaReference,
      customerPin: trimmedCustomerPin || undefined
    })
  }

  const canSubmit =
    method !== null &&
    canCompleteSale(method, cartTotal, method === 'cash' ? tenderedAmount : cartTotal, referenceNumber)

  useEffect(() => {
    if (method !== 'cash') return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return
      if (event.key === 'Enter') {
        if (canSubmit && checkoutStatus !== 'submitting') handleSubmit()
        return
      }
      if (event.key === 'Backspace') {
        handleAmountKey('⌫')
        return
      }
      if (event.key === '.' || /^[0-9]$/.test(event.key)) {
        handleAmountKey(event.key)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [method, tenderedInput, canSubmit, checkoutStatus])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] min-h-[75vh] w-full min-w-[75vw] max-w-3xl flex-col rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 p-4">
          <h3 className="text-xl font-semibold text-slate-900">Checkout</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="mb-4 flex justify-between text-3xl font-bold text-slate-900">
            <span>Total</span>
            <span>{formatCurrency(cartTotal)}</span>
          </div>

          <div className="mb-4">
            <label className="mb-1 block text-base font-medium text-slate-600">
              Customer KRA PIN <span className="font-normal text-slate-400">(optional — for a B2B invoice)</span>
            </label>
            <input
              type="text"
              value={customerPin}
              onChange={(e) => setCustomerPin(e.target.value.toUpperCase())}
              maxLength={KRA_PIN_MAX_LENGTH}
              placeholder="P051234567Z"
              className="h-12 w-full rounded-lg border border-slate-300 px-3 text-lg uppercase focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
            />
            {customerPinError && (
              <p className="mt-1 text-sm font-medium text-rose-600">{customerPinError}</p>
            )}
          </div>

          {method === null && (
            <div className="grid grid-cols-3 gap-4">
              {(['cash', 'mpesa', 'card'] as PaymentMethod[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethod(m)}
                  className="h-14 rounded-xl border border-slate-200 text-center text-lg font-semibold text-slate-700 transition active:scale-95 hover:border-rose-300 hover:bg-rose-50"
                >
                  {PAYMENT_LABELS[m]}
                </button>
              ))}
            </div>
          )}

          {method === 'cash' && (
            <div>
              <button
                type="button"
                onClick={() => setMethod(null)}
                className="mb-3 text-base text-slate-500 hover:text-slate-700"
              >
                ← Change payment method
              </button>

              <p className="mb-1 text-base font-medium text-slate-600">
                Amount Tendered
              </p>
              <p className="mb-3 rounded-lg bg-slate-100 px-4 py-3 text-right text-3xl font-mono">
                Ksh {tenderedInput || '0'}
              </p>

              <div className="mb-3 flex justify-between text-base font-medium">
                <span className="text-slate-600">Change Due</span>
                <span className={changeDue > 0 ? 'text-emerald-600' : 'text-slate-400'}>
                  {formatCurrency(changeDue)}
                </span>
              </div>

              {tenderedAmount > 0 && tenderedAmount < cartTotal && (
                <p className="mb-3 text-base font-medium text-rose-600">
                  Insufficient amount
                </p>
              )}

              <VirtualNumpad value={tenderedInput} onChange={setTenderedInput} />
            </div>
          )}

          {method === 'mpesa' && (
            <PaymentModal
              total={cartTotal}
              onPaid={handleMpesaPaid}
              onCancel={() => setMethod(null)}
            />
          )}

          {method === 'card' && (
            <div>
              <button
                type="button"
                onClick={() => setMethod(null)}
                className="mb-3 text-base text-slate-500 hover:text-slate-700"
              >
                ← Change payment method
              </button>

              <label className="mb-1 block text-base font-medium text-slate-600">
                Reference Number
              </label>
              <input
                type="text"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                placeholder="Transaction reference"
                className="h-14 w-full rounded-lg border border-slate-300 px-3 text-xl focus:border-rose-400 focus:outline-none focus:ring-4 focus:ring-rose-100"
              />
            </div>
          )}

          {checkoutStatus === 'error' && (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-base font-medium text-rose-700">
              {checkoutError ?? 'Checkout failed'}
            </p>
          )}

          {(method === 'cash' || method === 'card') && (
            <button
              type="button"
              disabled={!canSubmit || checkoutStatus === 'submitting'}
              onClick={handleSubmit}
              className="mt-4 h-16 w-full rounded-xl bg-rose-600 text-xl font-bold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checkoutStatus === 'submitting' ? 'Processing…' : 'Complete Sale'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
