import { useEffect, useState } from 'react'
import { useCartStore } from '../stores/cartStore'
import { useAuthStore } from '../stores/authStore'
import { calculateChange, canCompleteSale } from '../lib/checkoutMath'
import { formatCurrency } from '../lib/currency'
import PaymentModal from './PaymentModal'
import type { PaymentMethod } from '../../../main/services/database.js'

/** Numpad keys for entering the cash amount tendered. */
const AMOUNT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫']

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
  const currentStaff = useAuthStore((state) => state.currentStaff)

  const [method, setMethod] = useState<PaymentMethod | null>(null)
  const [tenderedInput, setTenderedInput] = useState('')
  const [referenceNumber, setReferenceNumber] = useState('')

  const tenderedAmount = parseFloat(tenderedInput) || 0
  const changeDue = calculateChange(cartTotal, tenderedAmount)

  useEffect(() => {
    if (checkoutStatus === 'synced' || checkoutStatus === 'queued-offline') {
      onClose()
    }
  }, [checkoutStatus, onClose])

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
      referenceNumber: method === 'cash' ? undefined : referenceNumber.trim()
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
      referenceNumber: mpesaReference
    })
  }

  const canSubmit =
    method !== null &&
    canCompleteSale(method, cartTotal, method === 'cash' ? tenderedAmount : cartTotal, referenceNumber)

  useEffect(() => {
    if (method !== 'cash') return

    const handleKeyDown = (event: KeyboardEvent) => {
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
          <h3 className="text-lg font-semibold text-slate-900">Checkout</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div className="mb-4 flex justify-between text-2xl font-bold text-slate-900">
            <span>Total</span>
            <span>{formatCurrency(cartTotal)}</span>
          </div>

          {method === null && (
            <div className="grid grid-cols-3 gap-2">
              {(['cash', 'mpesa', 'card'] as PaymentMethod[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethod(m)}
                  className="rounded-xl border border-slate-200 py-6 text-center font-semibold text-slate-700 transition active:scale-95 hover:border-rose-300 hover:bg-rose-50"
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
                className="mb-3 text-sm text-slate-500 hover:text-slate-700"
              >
                ← Change payment method
              </button>

              <p className="mb-1 text-sm font-medium text-slate-600">
                Amount Tendered
              </p>
              <p className="mb-3 rounded-lg bg-slate-100 px-4 py-3 text-right text-2xl font-mono">
                Ksh {tenderedInput || '0'}
              </p>

              <div className="mb-3 flex justify-between text-sm font-medium">
                <span className="text-slate-600">Change Due</span>
                <span className={changeDue > 0 ? 'text-emerald-600' : 'text-slate-400'}>
                  {formatCurrency(changeDue)}
                </span>
              </div>

              {tenderedAmount > 0 && tenderedAmount < cartTotal && (
                <p className="mb-3 text-sm font-medium text-rose-600">
                  Insufficient amount
                </p>
              )}

              <div className="grid grid-cols-3 gap-2">
                {AMOUNT_KEYS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleAmountKey(key)}
                    className="rounded-xl bg-slate-100 py-3 text-lg font-semibold text-slate-800 transition active:scale-95 hover:bg-slate-200"
                  >
                    {key}
                  </button>
                ))}
              </div>
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
                className="mb-3 text-sm text-slate-500 hover:text-slate-700"
              >
                ← Change payment method
              </button>

              <label className="mb-1 block text-sm font-medium text-slate-600">
                Reference Number
              </label>
              <input
                type="text"
                value={referenceNumber}
                onChange={(e) => setReferenceNumber(e.target.value)}
                placeholder="Transaction reference"
                className="w-full rounded-lg border border-slate-300 px-3 py-3 text-lg focus:border-rose-400 focus:outline-none"
              />
            </div>
          )}

          {checkoutStatus === 'error' && (
            <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700">
              {checkoutError ?? 'Checkout failed'}
            </p>
          )}

          {(method === 'cash' || method === 'card') && (
            <button
              type="button"
              disabled={!canSubmit || checkoutStatus === 'submitting'}
              onClick={handleSubmit}
              className="mt-4 w-full rounded-xl bg-rose-600 py-4 text-lg font-semibold text-white transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {checkoutStatus === 'submitting' ? 'Processing…' : 'Complete Sale'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
